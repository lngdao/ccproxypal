use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

use crate::db::{self, NewRequest};
use crate::proxy::adapter::{
    self, anthropic_to_openai, estimate_cost, get_models_list, openai_to_anthropic,
    OpenAIChatRequest,
};
use crate::proxy::client::{proxy_request, ProxySource};
use crate::state::{ProxyConfig, TokenInfo};

#[derive(Clone)]
pub struct ServerState {
    pub config: Arc<ProxyConfig>,
    /// Shared with AppState — same Arc, so UI token refresh is visible here instantly.
    pub token_cache: Arc<Mutex<Option<TokenInfo>>>,
    pub db_path: String,
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

async fn models_handler() -> impl IntoResponse {
    Json(get_models_list())
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
        user_api_key,
    )
    .await
    {
        Ok((resp, source)) => {
            let status = resp.status();
            let source_str = match source {
                ProxySource::ClaudeCode => "claude_code",
                ProxySource::ApiKey => "api_key",
            };

            if is_stream {
                // Stream the response body directly
                record_to_db(&state.db_path, &model, source_str, 0, 0, is_stream, start.elapsed().as_millis() as i64, 0.0, None);

                let resp_headers = resp.headers().clone();
                let status_code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::OK);
                let body_stream = resp.bytes_stream();
                let axum_body = Body::from_stream(body_stream);

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
            record_to_db(&state.db_path, &model, "error", 0, 0, is_stream, start.elapsed().as_millis() as i64, 0.0, Some(&e.to_string()));
            error_response(500, &e.to_string())
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
        user_api_key,
    )
    .await
    {
        Ok((resp, source)) => {
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::OK);
            let source_str = match source {
                ProxySource::ClaudeCode => "claude_code",
                ProxySource::ApiKey => "api_key",
            };

            if is_stream {
                record_to_db(&state.db_path, &model, source_str, 0, 0, true, start.elapsed().as_millis() as i64, 0.0, None);
                // For streaming, convert Anthropic SSE to OpenAI SSE
                let body_stream = resp.bytes_stream();
                let converted = convert_stream_to_openai(body_stream, &original_model);
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
            record_to_db(&state.db_path, &model, "error", 0, 0, is_stream, start.elapsed().as_millis() as i64, 0.0, Some(&e.to_string()));
            error_response(500, &e.to_string())
        }
    }
}

fn convert_stream_to_openai(
    stream: impl futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static,
    model: &str,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, std::convert::Infallible>> {
    let model = model.to_string();
    async_stream::stream! {
        use futures_util::StreamExt;
        let mut stream = Box::pin(stream);
        let mut buffer = String::new();

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

pub fn build_router(state: ServerState) -> Router {
    Router::new()
        .route("/", get(health_handler))
        .route("/health", get(health_handler))
        .route("/v1/messages", post(messages_handler))
        .route("/v1/chat/completions", post(chat_completions_handler))
        .route("/v1/models", get(models_handler))
        .with_state(state)
}
