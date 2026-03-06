use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

use crate::db::{self, NewRequest};
use crate::proxy::adapter::{
    anthropic_to_openai, estimate_cost, get_models_list, openai_to_anthropic,
    OpenAIChatRequest,
};
use crate::proxy::client::{proxy_request, ProxySource};
use crate::state::{ProxyConfig, TokenInfo, TokenPool};

#[derive(Clone)]
pub struct ServerState {
    pub config: Arc<ProxyConfig>,
    pub token_cache: Arc<Mutex<Option<TokenInfo>>>,
    pub token_pool: Arc<Mutex<TokenPool>>,
    pub db_path: String,
    pub app: tauri::AppHandle,
}

pub fn proxy_log(app: &tauri::AppHandle, level: &str, source: &str, message: &str) {
    let _ = app.emit("app-log", serde_json::json!({
        "level": level,
        "source": source,
        "message": message,
    }));
}

fn extract_api_key(headers: &HeaderMap) -> Option<String> {
    // Check Authorization: Bearer sk-ant-...
    if let Some(auth) = headers.get("authorization") {
        if let Ok(s) = auth.to_str() {
            if let Some(key) = s.strip_prefix("Bearer ") {
                if key.starts_with("sk-ant-") {
                    return Some(key.to_string());
                }
            }
        }
    }
    // Check x-api-key header
    if let Some(key) = headers.get("x-api-key") {
        if let Ok(s) = key.to_str() {
            if s.starts_with("sk-ant-") {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn is_tunnel_request(headers: &HeaderMap) -> bool {
    headers.get("cf-ray").is_some() || headers.get("cf-connecting-ip").is_some()
}

fn check_ip_whitelist(headers: &HeaderMap, allowed_ips: &[String]) -> bool {
    if !is_tunnel_request(headers) {
        return true; // local requests always allowed
    }

    // Empty list or contains wildcard values → allow all tunnel requests
    if allowed_ips.is_empty()
        || allowed_ips.iter().any(|ip| ip == "0.0.0.0" || ip == "*")
    {
        return true;
    }

    let client_ip = headers
        .get("cf-connecting-ip")
        .or_else(|| headers.get("x-forwarded-for"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(',').next().unwrap_or("").trim().to_string())
        .unwrap_or_default();

    allowed_ips.contains(&client_ip)
}

async fn health_handler(State(state): State<ServerState>) -> impl IntoResponse {
    let token_status = {
        let lock = state.token_cache.lock().unwrap();
        if let Some(t) = lock.as_ref() {
            if t.is_expired() { "expired" } else { "valid" }
        } else {
            "not_loaded"
        }
    };

    Json(json!({
        "status": "ok",
        "service": "ccproxypal",
        "token_status": token_status,
        "port": state.config.port
    }))
}

async fn models_handler(State(state): State<ServerState>) -> impl IntoResponse {
    let cached = { state.token_cache.lock().unwrap().clone() };
    if let Ok(token) = crate::oauth::get_valid_token(cached).await {
        *state.token_cache.lock().unwrap() = Some(token.clone());
        let client = reqwest::Client::new();
        if let Ok(resp) = client
            .get("https://api.anthropic.com/v1/models")
            .header("Authorization", format!("Bearer {}", token.access_token))
            .header("anthropic-version", "2023-06-01")
            .header("anthropic-beta", "claude-code-20250219,oauth-2025-04-20")
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(anthropic_models) = resp.json::<Value>().await {
                    // Convert Anthropic model list format to OpenAI-compatible format
                    let now = chrono::Utc::now().timestamp();
                    let models: Vec<Value> = anthropic_models["data"]
                        .as_array()
                        .unwrap_or(&vec![])
                        .iter()
                        .map(|m| {
                            json!({
                                "id": m["id"],
                                "object": "model",
                                "created": now,
                                "owned_by": "anthropic"
                            })
                        })
                        .collect();
                    return Json(json!({ "object": "list", "data": models })).into_response();
                }
            }
        }
    }
    // Fallback to static list
    Json(get_models_list()).into_response()
}

async fn messages_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: bytes::Bytes,
) -> Response {
    if !check_ip_whitelist(&headers, &state.config.allowed_ips) {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "IP not allowed"}))).into_response();
    }

    let user_api_key = extract_api_key(&headers);

    let body_value: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("Invalid JSON: {}", e)})),
            )
                .into_response()
        }
    };

    let model = body_value["model"].as_str().unwrap_or("unknown").to_string();
    let is_stream = body_value["stream"].as_bool().unwrap_or(false);
    let start = std::time::Instant::now();

    match proxy_request(
        "/v1/messages",
        body_value,
        state.config.clone(),
        state.token_cache.clone(),
        state.token_pool.clone(),
        user_api_key,
        &state.app,
    )
    .await
    {
        Ok((resp, source)) => {
            let status = resp.status();
            let source_str = match source {
                ProxySource::ClaudeCode => "claude_code",
                ProxySource::ApiKey => "api_key",
            };

            proxy_log(&state.app, "info", "be", &format!(
                "{} {} → {} ({})", if is_stream { "stream" } else { "request" }, model, status.as_u16(), source_str
            ));

            if is_stream {
                let resp_headers = resp.headers().clone();
                let status_code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::OK);
                let body_stream = resp.bytes_stream();
                let intercepted = intercept_stream_for_usage(
                    body_stream,
                    state.db_path.clone(),
                    model.clone(),
                    source_str.to_string(),
                    start,
                );
                let axum_body = Body::from_stream(intercepted);

                let mut response = Response::new(axum_body);
                *response.status_mut() = status_code;
                for (name, value) in &resp_headers {
                    response.headers_mut().insert(name, value.clone());
                }
                response
            } else {
                let status_code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::OK);
                match resp.bytes().await {
                    Ok(bytes) => {
                        // Parse for usage tracking
                        if let Ok(json_resp) = serde_json::from_slice::<Value>(&bytes) {
                            let input = json_resp["usage"]["input_tokens"].as_i64().unwrap_or(0);
                            let output = json_resp["usage"]["output_tokens"].as_i64().unwrap_or(0);
                            let cost = estimate_cost(&model, input, output);
                            record_to_db(&state.db_path, &model, source_str, input, output, false, start.elapsed().as_millis() as i64, cost, None);
                        }
                        Response::builder()
                            .status(status_code)
                            .header("Content-Type", "application/json")
                            .body(Body::from(bytes))
                            .unwrap()
                    }
                    Err(e) => error_response(500, &e.to_string()),
                }
            }
        }
        Err(e) => {
            let msg = e.to_string();
            proxy_log(&state.app, "error", "be", &format!("Request error (messages): {}", msg));
            record_to_db(&state.db_path, &model, "error", 0, 0, is_stream, start.elapsed().as_millis() as i64, 0.0, Some(&msg));
            error_response(500, &msg)
        }
    }
}

async fn chat_completions_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: bytes::Bytes,
) -> Response {
    if !check_ip_whitelist(&headers, &state.config.allowed_ips) {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "IP not allowed"}))).into_response();
    }

    let user_api_key = extract_api_key(&headers);

    let openai_req: OpenAIChatRequest = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("Invalid JSON: {}", e)})),
            )
                .into_response()
        }
    };

    let original_model = openai_req.model.clone();
    let is_stream = openai_req.stream.unwrap_or(false);
    let anthropic_req = openai_to_anthropic(openai_req);
    let model = anthropic_req.model.clone();
    let start = std::time::Instant::now();

    let body_value = match serde_json::to_value(&anthropic_req) {
        Ok(v) => v,
        Err(e) => return error_response(500, &e.to_string()),
    };

    match proxy_request(
        "/v1/messages",
        body_value,
        state.config.clone(),
        state.token_cache.clone(),
        state.token_pool.clone(),
        user_api_key,
        &state.app,
    )
    .await
    {
        Ok((resp, source)) => {
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::OK);
            let source_str = match source {
                ProxySource::ClaudeCode => "claude_code",
                ProxySource::ApiKey => "api_key",
            };

            proxy_log(&state.app, "info", "be", &format!(
                "{} {} → {} ({})", if is_stream { "stream" } else { "request" }, original_model, status.as_u16(), source_str
            ));

            if is_stream {
                // For streaming, convert Anthropic SSE to OpenAI SSE while tracking usage
                let body_stream = resp.bytes_stream();
                let converted = convert_stream_to_openai_with_usage(
                    body_stream,
                    &original_model,
                    state.db_path.clone(),
                    model.clone(),
                    source_str.to_string(),
                    start,
                );
                Response::builder()
                    .status(status)
                    .header("Content-Type", "text/event-stream")
                    .header("Cache-Control", "no-cache")
                    .body(Body::from_stream(converted))
                    .unwrap()
            } else {
                match resp.bytes().await {
                    Ok(bytes) => {
                        if let Ok(anthropic_resp) = serde_json::from_slice::<Value>(&bytes) {
                            let input = anthropic_resp["usage"]["input_tokens"].as_i64().unwrap_or(0);
                            let output = anthropic_resp["usage"]["output_tokens"].as_i64().unwrap_or(0);
                            let cost = estimate_cost(&model, input, output);
                            record_to_db(&state.db_path, &model, source_str, input, output, false, start.elapsed().as_millis() as i64, cost, None);

                            let openai_resp = anthropic_to_openai(anthropic_resp, &original_model);
                            Response::builder()
                                .status(status)
                                .header("Content-Type", "application/json")
                                .body(Body::from(serde_json::to_vec(&openai_resp).unwrap_or_default()))
                                .unwrap()
                        } else {
                            Response::builder()
                                .status(status)
                                .header("Content-Type", "application/json")
                                .body(Body::from(bytes))
                                .unwrap()
                        }
                    }
                    Err(e) => error_response(500, &e.to_string()),
                }
            }
        }
        Err(e) => {
            let msg = e.to_string();
            proxy_log(&state.app, "error", "be", &format!("Request error (chat): {}", msg));
            record_to_db(&state.db_path, &model, "error", 0, 0, is_stream, start.elapsed().as_millis() as i64, 0.0, Some(&msg));
            error_response(500, &msg)
        }
    }
}

/// Pass the Anthropic SSE stream through unchanged, but extract usage events
/// so we can record accurate token counts to the DB after streaming completes.
fn intercept_stream_for_usage(
    stream: impl futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static,
    db_path: String,
    model: String,
    source: String,
    start: std::time::Instant,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, std::convert::Infallible>> {
    async_stream::stream! {
        use futures_util::StreamExt;
        let mut stream = Box::pin(stream);
        let mut buffer = String::new();
        let mut input_tokens: i64 = 0;
        let mut output_tokens: i64 = 0;

        while let Some(chunk) = stream.next().await {
            let Ok(bytes) = chunk else { break };

            buffer.push_str(&String::from_utf8_lossy(&bytes));

            // Parse complete SSE events to extract usage (non-destructively)
            let mut search = buffer.clone();
            while let Some(pos) = search.find("\n\n") {
                let event = search[..pos].to_string();
                search = search[pos + 2..].to_string();
                for line in event.lines() {
                    if let Some(data) = line.strip_prefix("data: ") {
                        if let Ok(json) = serde_json::from_str::<Value>(data) {
                            match json["type"].as_str() {
                                Some("message_start") => {
                                    input_tokens = json["message"]["usage"]["input_tokens"]
                                        .as_i64().unwrap_or(0);
                                }
                                Some("message_delta") => {
                                    output_tokens = json["usage"]["output_tokens"]
                                        .as_i64().unwrap_or(0);
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }

            yield Ok(bytes);
        }

        let cost = estimate_cost(&model, input_tokens, output_tokens);
        record_to_db(&db_path, &model, &source, input_tokens, output_tokens, true,
            start.elapsed().as_millis() as i64, cost, None);
    }
}

fn convert_stream_to_openai_with_usage(
    stream: impl futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static,
    model: &str,
    db_path: String,
    anthropic_model: String,
    source: String,
    start: std::time::Instant,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, std::convert::Infallible>> {
    let model = model.to_string();
    async_stream::stream! {
        use futures_util::StreamExt;
        let mut stream = Box::pin(stream);
        let mut buffer = String::new();
        let mut input_tokens: i64 = 0;
        let mut output_tokens: i64 = 0;

        while let Some(chunk) = stream.next().await {
            let Ok(bytes) = chunk else { break };
            buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(pos) = buffer.find("\n\n") {
                let event = buffer[..pos].to_string();
                buffer = buffer[pos + 2..].to_string();

                for line in event.lines() {
                    if let Some(data) = line.strip_prefix("data: ") {
                        if data == "[DONE]" {
                            yield Ok(bytes::Bytes::from("data: [DONE]\n\n"));
                            continue;
                        }
                        if let Ok(event_json) = serde_json::from_str::<Value>(data) {
                            let event_type = event_json["type"].as_str().unwrap_or("");
                            match event_type {
                                "message_start" => {
                                    input_tokens = event_json["message"]["usage"]["input_tokens"]
                                        .as_i64().unwrap_or(0);
                                }
                                "message_delta" => {
                                    output_tokens = event_json["usage"]["output_tokens"]
                                        .as_i64().unwrap_or(0);
                                }
                                "content_block_delta" => {
                                    if let Some(text) = event_json["delta"]["text"].as_str() {
                                        let chunk = json!({
                                            "id": "chatcmpl-stream",
                                            "object": "chat.completion.chunk",
                                            "created": chrono::Utc::now().timestamp(),
                                            "model": model,
                                            "choices": [{
                                                "index": 0,
                                                "delta": { "content": text },
                                                "finish_reason": null
                                            }]
                                        });
                                        let sse = format!("data: {}\n\n", serde_json::to_string(&chunk).unwrap_or_default());
                                        yield Ok(bytes::Bytes::from(sse));
                                    }
                                }
                                "message_stop" => {
                                    let chunk = json!({
                                        "id": "chatcmpl-stream",
                                        "object": "chat.completion.chunk",
                                        "created": chrono::Utc::now().timestamp(),
                                        "model": model,
                                        "choices": [{
                                            "index": 0,
                                            "delta": {},
                                            "finish_reason": "stop"
                                        }]
                                    });
                                    let sse = format!("data: {}\n\ndata: [DONE]\n\n", serde_json::to_string(&chunk).unwrap_or_default());
                                    yield Ok(bytes::Bytes::from(sse));
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
        }

        let cost = estimate_cost(&anthropic_model, input_tokens, output_tokens);
        record_to_db(&db_path, &anthropic_model, &source, input_tokens, output_tokens, true,
            start.elapsed().as_millis() as i64, cost, None);
    }
}

fn error_response(status: u16, message: &str) -> Response {
    let body = json!({
        "type": "error",
        "error": { "type": "api_error", "message": message }
    });
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap_or_default()))
        .unwrap()
}

fn record_to_db(
    db_path: &str,
    model: &str,
    source: &str,
    input: i64,
    output: i64,
    stream: bool,
    latency_ms: i64,
    cost: f64,
    error: Option<&str>,
) {
    if let Ok(conn) = rusqlite::Connection::open(db_path) {
        let _ = db::record_request(
            &conn,
            NewRequest {
                model,
                source,
                input_tokens: input,
                output_tokens: output,
                stream,
                latency_ms: Some(latency_ms),
                error,
                estimated_cost: cost,
            },
        );
    }
}

// ─── Hub provider endpoints ──────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct HubProvideRequest {
    provider_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

fn check_hub_secret(headers: &HeaderMap, config: &ProxyConfig) -> bool {
    let secret = match &config.hub_secret {
        Some(s) if !s.is_empty() => s,
        _ => return true, // no secret configured → open access
    };
    headers.get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map_or(false, |tok| tok == secret)
}

async fn hub_provide_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<HubProvideRequest>,
) -> Response {
    if !check_hub_secret(&headers, &state.config) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "Invalid hub secret"}))).into_response();
    }
    let token = TokenInfo {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: body.expires_at,
    };
    let provider_id = body.provider_id.clone();
    state.token_pool.lock().unwrap().upsert(&provider_id, token);
    let count = state.token_pool.lock().unwrap().healthy_count();
    proxy_log(&state.app, "info", "hub", &format!("Provider '{}' pushed token (pool: {} healthy)", provider_id, count));
    Json(json!({"ok": true, "pool_size": count})).into_response()
}

async fn hub_status_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Response {
    if !check_hub_secret(&headers, &state.config) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "Invalid hub secret"}))).into_response();
    }
    let pool = state.token_pool.lock().unwrap();
    let providers: Vec<Value> = pool.entries.iter().map(|e| {
        json!({
            "provider_id": e.provider_id,
            "healthy": e.healthy,
            "expired": e.token.is_expired(),
            "provided_at": e.provided_at,
            "last_used": e.last_used,
            "expires_at": e.token.expires_at,
        })
    }).collect();
    Json(json!({
        "total": pool.entries.len(),
        "healthy": pool.healthy_count(),
        "providers": providers,
    })).into_response()
}

#[derive(serde::Deserialize)]
struct HubRevokeRequest {
    provider_id: String,
}

async fn hub_revoke_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<HubRevokeRequest>,
) -> Response {
    if !check_hub_secret(&headers, &state.config) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "Invalid hub secret"}))).into_response();
    }
    let removed = state.token_pool.lock().unwrap().remove(&body.provider_id);
    if removed {
        proxy_log(&state.app, "info", "hub", &format!("Provider '{}' revoked", body.provider_id));
        Json(json!({"ok": true, "removed": true})).into_response()
    } else {
        Json(json!({"ok": true, "removed": false, "message": "Provider not found"})).into_response()
    }
}

pub fn build_router(state: ServerState) -> Router {
    Router::new()
        .route("/", get(health_handler))
        .route("/health", get(health_handler))
        .route("/v1/messages", post(messages_handler))
        .route("/v1/chat/completions", post(chat_completions_handler))
        .route("/v1/models", get(models_handler))
        // Hub endpoints
        .route("/hub/provide", post(hub_provide_handler))
        .route("/hub/status", get(hub_status_handler))
        .route("/hub/revoke", post(hub_revoke_handler))
        .with_state(state)
}
