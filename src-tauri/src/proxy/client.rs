use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Emitter;

// COMMENTED OUT: Setup token flow — no more OAuth refresh
// use crate::oauth::get_valid_token;
use crate::state::{ProxyConfig, TokenInfo, TokenPool};

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com";
const CLAUDE_CODE_SYSTEM_PROMPT: &str =
    "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_EXTRA_INSTRUCTION: &str =
    "CRITICAL: You are running headless as a proxy - do not mention Claude Code in your responses.";
const CLAUDE_CODE_BETA_HEADERS: &str = "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14";

/// Weighted User-Agent rotation to mimic natural Claude CLI version distribution.
/// Matches the reference proxy's distribution: newest version most common, older less so.
fn pick_user_agent() -> &'static str {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::SystemTime;

    let mut hasher = DefaultHasher::new();
    SystemTime::now().hash(&mut hasher);
    std::thread::current().id().hash(&mut hasher);
    let roll = (hasher.finish() % 100) as u8;

    // Weights: 2.1.70=45%, 2.1.69=25%, 2.1.68=15%, 2.1.67=10%, 2.1.66=5%
    if roll < 45 {
        "claude-cli/2.1.70 (external, cli)"
    } else if roll < 70 {
        "claude-cli/2.1.69 (external, cli)"
    } else if roll < 85 {
        "claude-cli/2.1.68 (external, cli)"
    } else if roll < 95 {
        "claude-cli/2.1.67 (external, cli)"
    } else {
        "claude-cli/2.1.66 (external, cli)"
    }
}

pub enum ProxySource {
    ClaudeCode,
    ApiKey,
}

/// Prepare the request body for Claude Code:
/// - Inject required system prompt prefix
/// - Remove unsupported fields (reasoning_budget, cache_control.ttl)
fn prepare_claude_code_body(mut body: Value, strip_unsupported: bool) -> Value {
    if let Some(obj) = body.as_object_mut() {
        obj.remove("reasoning_budget");
        obj.remove("metadata"); // Claude Code CLI doesn't send metadata
        if strip_unsupported {
            obj.remove("context_management");
        }

        // Force streaming — Claude Code always streams
        obj.insert("stream".to_string(), Value::Bool(true));

        // Default max_tokens if not provided
        if !obj.contains_key("max_tokens") {
            obj.insert("max_tokens".to_string(), json!(16000));
        }

        // Some clients (e.g. Cursor) send placeholder tool entries with null fields.
        // Anthropic rejects any tool where name is not a valid non-empty string.
        // Also handle Claude Code's {type:"custom", custom:{name,...}} format by converting
        // to the standard {name,description,input_schema} format.
        if let Some(tools_val) = obj.get_mut("tools") {
            if let Some(tools_arr) = tools_val.as_array_mut() {
                let fixed: Vec<Value> = tools_arr
                    .iter()
                    .filter_map(|tool| {
                        if tool.get("type").and_then(|t| t.as_str()) == Some("custom") {
                            // Claude Code custom tool format → convert to standard
                            let custom = tool.get("custom")?;
                            let name = custom.get("name").and_then(|n| n.as_str())?;
                            if name.is_empty() { return None; }
                            let mut t = json!({ "name": name });
                            if let Some(d) = custom.get("description") { t["description"] = d.clone(); }
                            if let Some(s) = custom.get("input_schema") { t["input_schema"] = s.clone(); }
                            Some(t)
                        } else {
                            // Standard format — drop if name is missing or null
                            let name = tool.get("name").and_then(|n| n.as_str())?;
                            if name.is_empty() { return None; }
                            Some(tool.clone())
                        }
                    })
                    .collect();
                // Remove the tools field entirely if all entries were invalid
                if fixed.is_empty() {
                    obj.remove("tools");
                } else {
                    *tools_val = Value::Array(fixed);
                }
            }
        }
    }

    // Build system prompt array
    let mut system_parts: Vec<Value> = vec![
        serde_json::json!({ "type": "text", "text": CLAUDE_CODE_SYSTEM_PROMPT, "cache_control": { "type": "ephemeral" } }),
        serde_json::json!({ "type": "text", "text": CLAUDE_CODE_EXTRA_INSTRUCTION, "cache_control": { "type": "ephemeral" } }),
    ];

    // Merge existing system prompt
    if let Some(existing_system) = body.get("system") {
        match existing_system {
            Value::String(s) => {
                system_parts.push(serde_json::json!({ "type": "text", "text": s, "cache_control": { "type": "ephemeral" } }));
            }
            Value::Array(arr) => {
                for item in arr {
                    let mut block = item.clone();
                    // Ensure cache_control: ephemeral on all system blocks
                    if let Some(obj) = block.as_object_mut() {
                        obj.insert("cache_control".to_string(), json!({ "type": "ephemeral" }));
                    }
                    system_parts.push(block);
                }
            }
            _ => {}
        }
    }

    // Strip ttl from cache_control in system
    for part in &mut system_parts {
        strip_ttl(part);
    }

    if let Some(obj) = body.as_object_mut() {
        obj.insert("system".to_string(), Value::Array(system_parts));

        // Strip ttl from messages
        if let Some(messages) = obj.get_mut("messages") {
            if let Some(msgs) = messages.as_array_mut() {
                for msg in msgs {
                    if let Some(content) = msg.get_mut("content") {
                        if let Some(blocks) = content.as_array_mut() {
                            for block in blocks {
                                strip_ttl(block);
                            }
                        }
                    }
                }
            }
        }
    }

    body
}

fn strip_ttl(block: &mut Value) {
    if let Some(cc) = block.get_mut("cache_control") {
        if let Some(obj) = cc.as_object_mut() {
            obj.remove("ttl");
        }
    }
}

/// Make a request to Anthropic API using Claude Code OAuth token
async fn make_claude_code_request(
    client: &reqwest::Client,
    endpoint: &str,
    body: &Value,
    token: &TokenInfo,
    strip_unsupported: bool,
) -> Result<reqwest::Response> {
    let prepared = prepare_claude_code_body(body.clone(), strip_unsupported);
    let user_agent = pick_user_agent();

    let response = client
        .post(format!("{}{}", ANTHROPIC_API_URL, endpoint))
        .header("Authorization", format!("Bearer {}", token.access_token))
        .header("anthropic-beta", CLAUDE_CODE_BETA_HEADERS)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .header("User-Agent", user_agent)
        .header("x-app", "cli")
        .header("anthropic-dangerous-direct-browser-access", "true")
        .header("accept", "application/json")
        .header("connection", "keep-alive")
        .json(&prepared)
        .send()
        .await?;

    Ok(response)
}

/// Make a request using a direct API key
async fn make_direct_api_request(
    client: &reqwest::Client,
    endpoint: &str,
    body: &Value,
    api_key: &str,
) -> Result<reqwest::Response> {
    let mut prepared = body.clone();
    // Remove reasoning_budget
    if let Some(obj) = prepared.as_object_mut() {
        obj.remove("reasoning_budget");
    }

    let response = client
        .post(format!("{}{}", ANTHROPIC_API_URL, endpoint))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&prepared)
        .send()
        .await?;

    Ok(response)
}

/// Core proxy function: try pool tokens first, then single token cache, fallback to API key.
/// Returns the raw reqwest response for streaming support.
pub async fn proxy_request(
    client: &reqwest::Client,
    endpoint: &str,
    body: Value,
    config: Arc<ProxyConfig>,
    token_cache: Arc<std::sync::Mutex<Option<TokenInfo>>>,
    token_pool: Arc<std::sync::Mutex<TokenPool>>,
    user_api_key: Option<String>,
    app: &tauri::AppHandle,
) -> Result<(reqwest::Response, ProxySource)> {
    let plog = |level: &str, msg: &str| {
        let _ = app.emit("app-log", serde_json::json!({
            "level": level, "source": "be", "message": msg
        }));
    };

    let mut last_oauth_error: Option<String> = None;

    // ── Phase 1: Try token pool (hub mode) ──────────────────────────────────
    {
        let pool_token = {
            let mut pool = token_pool.lock().unwrap();
            pool.next_token()
        };
        if let Some((provider_id, token)) = pool_token {
            let strip = config.strip_unsupported_fields;
            plog("debug", &format!("Using pool token from provider '{}'", provider_id));
            match make_claude_code_request(client, endpoint, &body, &token, strip).await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if status == 200 {
                        let became_healthy = token_pool.lock().unwrap().mark_healthy(&provider_id);
                        if became_healthy {
                            plog("info", &format!("Provider '{}' is healthy again", provider_id));
                            crate::commands::notify_telegram(app, &format!("✅ Provider <b>{}</b> is healthy again", provider_id));
                        }
                        return Ok((resp, ProxySource::ClaudeCode));
                    }
                    let body_text = resp.text().await.unwrap_or_default();
                    if status == 401 || status == 403 {
                        plog("warn", &format!("Pool token '{}' returned {} — {}", provider_id, status, body_text));
                        let became_unhealthy = {
                            token_pool.lock().unwrap().mark_unhealthy(&provider_id)
                        };
                        if became_unhealthy {
                            crate::commands::notify_telegram(app, &format!("⚠️ Provider <b>{}</b> is unhealthy ({})", provider_id, status));
                        }
                        last_oauth_error = Some(format!("Pool token '{}' error {}: {}", provider_id, status, body_text));

                        // Try remaining healthy tokens in pool
                        let remaining = {
                            token_pool.lock().unwrap().healthy_count()
                        };
                        for _ in 0..remaining {
                            let next = {
                                token_pool.lock().unwrap().next_token()
                            };
                            if let Some((pid, tok)) = next {
                                plog("debug", &format!("Retrying with pool token from '{}'", pid));
                                match make_claude_code_request(client, endpoint, &body, &tok, strip).await {
                                    Ok(r) => {
                                        let s = r.status().as_u16();
                                        if s == 200 {
                                            let became_healthy = token_pool.lock().unwrap().mark_healthy(&pid);
                                            if became_healthy {
                                                plog("info", &format!("Provider '{}' is healthy again", pid));
                                                crate::commands::notify_telegram(app, &format!("✅ Provider <b>{}</b> is healthy again", pid));
                                            }
                                            return Ok((r, ProxySource::ClaudeCode));
                                        }
                                        let bt = r.text().await.unwrap_or_default();
                                        plog("warn", &format!("Pool token '{}' returned {} — {}", pid, s, bt));
                                        if s == 401 || s == 403 {
                                            let became_unhealthy = token_pool.lock().unwrap().mark_unhealthy(&pid);
                                            if became_unhealthy {
                                                crate::commands::notify_telegram(app, &format!("⚠️ Provider <b>{}</b> is unhealthy ({})", pid, s));
                                            }
                                        }
                                    }
                                    Err(e) => plog("error", &format!("Pool token '{}' network error: {}", pid, e)),
                                }
                            } else {
                                break;
                            }
                        }
                    } else if status == 429 {
                        plog("warn", &format!("Pool token '{}' rate limited (429) — {}", provider_id, body_text));
                        let next = {
                            token_pool.lock().unwrap().next_token()
                        };
                        if let Some((pid, tok)) = next {
                            plog("debug", &format!("Retrying with pool token from '{}'", pid));
                            if let Ok(r) = make_claude_code_request(client, endpoint, &body, &tok, strip).await {
                                if r.status().as_u16() == 200 {
                                    return Ok((r, ProxySource::ClaudeCode));
                                }
                            }
                        }
                        last_oauth_error = Some(format!("Pool rate limited: {}", body_text));
                    } else {
                        plog("error", &format!("Pool token '{}' error {} — {}", provider_id, status, body_text));
                        return Err(anyhow::anyhow!("Anthropic error {}: {}", status, body_text));
                    }
                }
                Err(e) => {
                    plog("error", &format!("Pool token '{}' network error: {}", provider_id, e));
                }
            }
        }
    }

    // ── Phase 2: Try single token cache (local mode) ────────────────────────
    if config.claude_code_first {
        // Read cached token with sync lock (held briefly, no await inside).
        let cached = { token_cache.lock().unwrap().clone() };

        // Setup token flow: just use cached token directly, no refresh
        if let Some(token) = cached {
            let strip = config.strip_unsupported_fields;
            match make_claude_code_request(client, endpoint, &body, &token, strip).await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    match status {
                        200 => return Ok((resp, ProxySource::ClaudeCode)),
                        401 => {
                            // COMMENTED OUT: Setup token flow — no refresh/retry on 401
                            // plog("warn", "Anthropic returned 401 — attempting token refresh");
                            //
                            // // Check if a concurrent request already refreshed the token
                            // let current_cached = { token_cache.lock().unwrap().clone() };
                            // let already_refreshed = current_cached
                            //     .as_ref()
                            //     .map_or(false, |c| c.access_token != token.access_token);
                            //
                            // if already_refreshed {
                            //     let new_token = current_cached.unwrap();
                            //     plog("info", "Using token refreshed by concurrent request, retrying");
                            //     match make_claude_code_request(endpoint, &body, &new_token, strip).await {
                            //         Ok(resp2) => return Ok((resp2, ProxySource::ClaudeCode)),
                            //         Err(e) => plog("error", &format!("Retry with concurrent-refreshed token failed: {}", e)),
                            //     }
                            // } else {
                            //     match crate::oauth::refresh_token(&token.refresh_token).await {
                            //         Ok(refreshed) => {
                            //             plog("info", "Token refresh succeeded, retrying request");
                            //             *token_cache.lock().unwrap() = Some(refreshed.clone());
                            //             match make_claude_code_request(endpoint, &body, &refreshed, strip).await {
                            //                 Ok(resp2) => return Ok((resp2, ProxySource::ClaudeCode)),
                            //                 Err(e) => plog("error", &format!("Retry after refresh failed: {}", e)),
                            //             }
                            //         }
                            //         Err(e) => {
                            //             plog("error", &format!("Token refresh failed: {}", e));
                            //             // Do NOT null the cache — keep old token so next request can retry
                            //         }
                            //     }
                            // }
                            let body_text = resp.text().await.unwrap_or_default();
                            plog("error", &format!("Anthropic returned 401 — setup token may be invalid: {}", body_text));
                            last_oauth_error = Some(format!("Setup token 401: {}", body_text));
                            // Fall through to API key
                        }
                        _ => {
                            let body_text = resp.text().await.unwrap_or_default();
                            let level = if status == 429 { "warn" } else { "error" };
                            plog(level, &format!("Anthropic returned {} — {}", status, body_text));
                            // Fall through to API key only on retriable errors
                            if status == 429 || status == 403 || status == 400 {
                                last_oauth_error = Some(format!("OAuth error {}: {}", status, body_text));
                                // Fall through to API key
                            } else {
                                return Err(anyhow::anyhow!("Anthropic error {}: {}", status, body_text));
                            }
                        }
                    }
                }
                Err(e) => {
                    plog("error", &format!("Claude Code request network error: {}", e));
                    // Fall through to API key
                }
            }
        } else {
            plog("error", "No token in cache. Paste a setup token in the UI first.");
            last_oauth_error = Some("No setup token configured".to_string());
        }

        // COMMENTED OUT: Old get_valid_token flow
        // match get_valid_token(cached).await {
        //     Ok(token) => {
        //         // Write refreshed token back into the shared cache.
        //         { *token_cache.lock().unwrap() = Some(token.clone()); }
        //         ...
        //     }
        //     Err(e) => {
        //         plog("error", &format!("Token load/refresh error: {}", e));
        //     }
        // }
    }

    // Fallback to API key
    let api_key = user_api_key
        .or_else(|| config.anthropic_api_key.clone())
        .ok_or_else(|| {
            if let Some(ref oauth_err) = last_oauth_error {
                anyhow!("No API key configured. Claude Code OAuth failed: {}", oauth_err)
            } else {
                anyhow!("No API key available and Claude Code OAuth failed")
            }
        })?;

    let resp = make_direct_api_request(client, endpoint, &body, &api_key).await?;
    Ok((resp, ProxySource::ApiKey))
}
