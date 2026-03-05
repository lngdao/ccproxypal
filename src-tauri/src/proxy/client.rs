use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::oauth::get_valid_token;
use crate::state::{ProxyConfig, TokenInfo};

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com";
const CLAUDE_CODE_SYSTEM_PROMPT: &str =
    "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_EXTRA_INSTRUCTION: &str =
    "CRITICAL: You are running headless as a proxy - do not mention Claude Code in your responses.";
const CLAUDE_CODE_BETA_HEADERS: &str = "claude-code-20250219,oauth-2025-04-20";
const CLAUDE_USER_AGENT: &str = "claude-code/1.0.85";

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
        if strip_unsupported {
            obj.remove("context_management");
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
        serde_json::json!({ "type": "text", "text": CLAUDE_CODE_SYSTEM_PROMPT }),
        serde_json::json!({ "type": "text", "text": CLAUDE_CODE_EXTRA_INSTRUCTION }),
    ];

    // Merge existing system prompt
    if let Some(existing_system) = body.get("system") {
        match existing_system {
            Value::String(s) => {
                system_parts.push(serde_json::json!({ "type": "text", "text": s }));
            }
            Value::Array(arr) => {
                for item in arr {
                    system_parts.push(item.clone());
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
    endpoint: &str,
    body: &Value,
    token: &TokenInfo,
    strip_unsupported: bool,
) -> Result<reqwest::Response> {
    let prepared = prepare_claude_code_body(body.clone(), strip_unsupported);
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{}{}", ANTHROPIC_API_URL, endpoint))
        .header("Authorization", format!("Bearer {}", token.access_token))
        .header("anthropic-beta", CLAUDE_CODE_BETA_HEADERS)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .header("User-Agent", CLAUDE_USER_AGENT)
        .json(&prepared)
        .send()
        .await?;

    Ok(response)
}

/// Make a request using a direct API key
async fn make_direct_api_request(
    endpoint: &str,
    body: &Value,
    api_key: &str,
) -> Result<reqwest::Response> {
    let mut prepared = body.clone();
    // Remove reasoning_budget
    if let Some(obj) = prepared.as_object_mut() {
        obj.remove("reasoning_budget");
    }

    let client = reqwest::Client::new();
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

/// Core proxy function: try Claude Code OAuth first, fallback to API key.
/// Returns the raw reqwest response for streaming support.
pub async fn proxy_request(
    endpoint: &str,
    body: Value,
    config: Arc<ProxyConfig>,
    token_cache: Arc<std::sync::Mutex<Option<TokenInfo>>>,
    user_api_key: Option<String>,
) -> Result<(reqwest::Response, ProxySource)> {
    if config.claude_code_first {
        // Read cached token with sync lock (held briefly, no await inside).
        let cached = { token_cache.lock().unwrap().clone() };

        match get_valid_token(cached).await {
            Ok(token) => {
                // Write refreshed token back into the shared cache.
                { *token_cache.lock().unwrap() = Some(token.clone()); }

                let strip = config.strip_unsupported_fields;
                match make_claude_code_request(endpoint, &body, &token, strip).await {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        match status {
                            200 => return Ok((resp, ProxySource::ClaudeCode)),
                            401 => {
                                eprintln!("[ccproxypal] Anthropic returned 401 — access_token rejected, attempting refresh");
                                match crate::oauth::refresh_token(&token.refresh_token).await {
                                    Ok(refreshed) => {
                                        eprintln!("[ccproxypal] Token refresh succeeded, retrying request");
                                        *token_cache.lock().unwrap() = Some(refreshed.clone());
                                        match make_claude_code_request(endpoint, &body, &refreshed, strip).await {
                                            Ok(resp2) => return Ok((resp2, ProxySource::ClaudeCode)),
                                            Err(e) => eprintln!("[ccproxypal] Retry after refresh failed: {}", e),
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("[ccproxypal] Token refresh failed: {}", e);
                                        *token_cache.lock().unwrap() = None;
                                    }
                                }
                                // Fall through to API key
                            }
                            _ => {
                                // For 400/403/429/5xx — log the body so we can debug
                                let body_text = resp.text().await.unwrap_or_default();
                                eprintln!("[ccproxypal] Anthropic returned {} — body: {}", status, &body_text[..body_text.len().min(500)]);
                                // Fall through to API key only on retriable errors
                                if status == 429 || status == 403 || status == 400 {
                                    // Fall through to API key
                                } else {
                                    // For other statuses (e.g. 200 range edge cases, 5xx), return as error
                                    return Err(anyhow::anyhow!("Anthropic error {}: {}", status, &body_text[..body_text.len().min(200)]));
                                }
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[ccproxypal] Claude Code request network error: {}", e);
                        // Fall through to API key
                    }
                }
            }
            Err(e) => {
                eprintln!("Token load/refresh error: {}", e);
                // Fall through to API key
            }
        }
    }

    // Fallback to API key
    let api_key = user_api_key
        .or_else(|| config.anthropic_api_key.clone())
        .ok_or_else(|| anyhow!("No API key available and Claude Code OAuth failed"))?;

    let resp = make_direct_api_request(endpoint, &body, &api_key).await?;
    Ok((resp, ProxySource::ApiKey))
}
