use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Normalize Cursor-style model names to Anthropic API model names.
/// e.g. "claude-4.5-opus-high" → "claude-opus-4-5"
pub fn normalize_model_name(model: &str) -> (String, Option<String>) {
    // Cursor patterns: claude-4.5-{opus|sonnet|haiku}-{high|medium|low} etc.
    let re = Regex::new(r"^claude-4\.5-(opus|sonnet|haiku)(?:-(high|medium|low))?(?:-thinking)?$")
        .unwrap();
    if let Some(caps) = re.captures(model) {
        let model_type = &caps[1];
        let budget = caps.get(2).map(|m| m.as_str().to_string());
        return (format!("claude-{}-4-5", model_type), budget);
    }

    // claude-3-7-sonnet → claude-3-7-sonnet-20250219 style passthrough
    (model.to_string(), None)
}

// ─── OpenAI types ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct OpenAIMessage {
    pub role: String,
    pub content: Option<Value>,
    pub tool_calls: Option<Vec<OpenAIToolCall>>,
    pub tool_call_id: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct OpenAIToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: OpenAIFunction,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct OpenAIFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct OpenAIChatRequest {
    pub model: String,
    pub messages: Vec<OpenAIMessage>,
    pub max_tokens: Option<i64>,
    pub temperature: Option<f64>,
    pub stream: Option<bool>,
    pub tools: Option<Vec<Value>>,
    pub tool_choice: Option<Value>,
    pub stop: Option<Value>,
    pub top_p: Option<f64>,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, Value>,
}

// ─── Anthropic types ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AnthropicRequest {
    pub model: String,
    pub max_tokens: i64,
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_budget: Option<Value>,
}

/// Convert an OpenAI chat request body to Anthropic Messages API format
pub fn openai_to_anthropic(openai: OpenAIChatRequest) -> AnthropicRequest {
    let (model, _budget) = normalize_model_name(&openai.model);

    let mut system_parts: Vec<String> = Vec::new();
    let mut messages: Vec<Value> = Vec::new();

    for msg in &openai.messages {
        match msg.role.as_str() {
            "system" => {
                if let Some(content) = &msg.content {
                    system_parts.push(content_to_string(content));
                }
            }
            "user" => {
                let content = convert_user_content(&msg.content);
                // Skip user messages with empty content — Anthropic rejects them
                let is_empty = match &content {
                    Value::String(s) => s.trim().is_empty(),
                    Value::Array(a) => a.is_empty(),
                    Value::Null => true,
                    _ => false,
                };
                if is_empty {
                    continue;
                }
                messages.push(json!({ "role": "user", "content": content }));
            }
            "assistant" => {
                if let Some(tool_calls) = &msg.tool_calls {
                    let mut content: Vec<Value> = Vec::new();
                    if let Some(text) = &msg.content {
                        let s = content_to_string(text);
                        if !s.is_empty() {
                            content.push(json!({ "type": "text", "text": s }));
                        }
                    }
                    for tc in tool_calls {
                        content.push(json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.function.name,
                            "input": serde_json::from_str::<Value>(&tc.function.arguments)
                                .unwrap_or(json!({}))
                        }));
                    }
                    messages.push(json!({ "role": "assistant", "content": content }));
                } else {
                    let content = convert_user_content(&msg.content);
                    messages.push(json!({ "role": "assistant", "content": content }));
                }
            }
            "tool" => {
                let tool_result = json!({
                    "type": "tool_result",
                    "tool_use_id": msg.tool_call_id.clone().unwrap_or_default(),
                    "content": msg.content.clone().unwrap_or(json!(""))
                });
                // Append to last user message or create new user message
                if let Some(last) = messages.last_mut() {
                    if last["role"] == "user" {
                        if let Some(arr) = last["content"].as_array_mut() {
                            arr.push(tool_result);
                            continue;
                        }
                    }
                }
                messages.push(json!({ "role": "user", "content": [tool_result] }));
            }
            _ => {}
        }
    }

    let system = if system_parts.is_empty() {
        None
    } else {
        Some(json!(system_parts.join("\n\n")))
    };

    // Convert OpenAI tools to Anthropic format
    let tools = openai.tools.map(|tools| {
        tools
            .into_iter()
            .map(|t| {
                json!({
                    "name": t["function"]["name"],
                    "description": t["function"]["description"],
                    "input_schema": t["function"]["parameters"]
                })
            })
            .collect::<Vec<_>>()
    });

    // Convert stop to stop_sequences
    let stop_sequences = openai.stop.and_then(|s| match s {
        Value::String(s) => Some(vec![s]),
        Value::Array(a) => Some(
            a.into_iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
        ),
        _ => None,
    });

    AnthropicRequest {
        model,
        max_tokens: openai.max_tokens.unwrap_or(4096),
        messages,
        system,
        temperature: openai.temperature,
        stream: openai.stream,
        tools,
        tool_choice: openai.tool_choice,
        stop_sequences,
        top_p: openai.top_p,
        reasoning_budget: None,
    }
}

fn content_to_string(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| {
                if p["type"] == "text" {
                    p["text"].as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn convert_user_content(content: &Option<Value>) -> Value {
    match content {
        None => Value::Null,
        Some(Value::Null) => Value::Null,
        Some(Value::String(s)) => json!(s),
        Some(Value::Array(parts)) => {
            let converted: Vec<Value> = parts
                .iter()
                .filter_map(|p| match p["type"].as_str() {
                    Some("text") => Some(json!({ "type": "text", "text": p["text"] })),
                    Some("image_url") => {
                        let url = p["image_url"]["url"].as_str().unwrap_or("");
                        if url.starts_with("data:") {
                            // base64 data URL
                            let parts: Vec<&str> = url.splitn(2, ',').collect();
                            if parts.len() == 2 {
                                let media_type = parts[0]
                                    .trim_start_matches("data:")
                                    .trim_end_matches(";base64");
                                Some(json!({
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": media_type,
                                        "data": parts[1]
                                    }
                                }))
                            } else {
                                None
                            }
                        } else {
                            Some(json!({
                                "type": "image",
                                "source": { "type": "url", "url": url }
                            }))
                        }
                    }
                    _ => None,
                })
                .collect();
            json!(converted)
        }
        Some(other) => other.clone(),
    }
}

/// Convert Anthropic response to OpenAI format
pub fn anthropic_to_openai(anthropic: Value, model: &str) -> Value {
    let content = anthropic["content"].as_array();
    let mut text_content = String::new();
    let mut tool_calls: Vec<Value> = Vec::new();

    if let Some(blocks) = content {
        for (i, block) in blocks.iter().enumerate() {
            match block["type"].as_str() {
                Some("text") => {
                    text_content.push_str(block["text"].as_str().unwrap_or(""));
                }
                Some("tool_use") => {
                    tool_calls.push(json!({
                        "id": block["id"],
                        "type": "function",
                        "index": i,
                        "function": {
                            "name": block["name"],
                            "arguments": serde_json::to_string(&block["input"]).unwrap_or_default()
                        }
                    }));
                }
                _ => {}
            }
        }
    }

    let stop_reason = anthropic["stop_reason"].as_str().unwrap_or("stop");
    let finish_reason = if !tool_calls.is_empty() {
        "tool_calls"
    } else if stop_reason == "max_tokens" {
        "length"
    } else {
        "stop"
    };

    json!({
        "id": anthropic["id"],
        "object": "chat.completion",
        "created": chrono::Utc::now().timestamp(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": if text_content.is_empty() { Value::Null } else { json!(text_content) },
                "tool_calls": if tool_calls.is_empty() { Value::Null } else { json!(tool_calls) }
            },
            "finish_reason": finish_reason
        }],
        "usage": {
            "prompt_tokens": anthropic["usage"]["input_tokens"],
            "completion_tokens": anthropic["usage"]["output_tokens"],
            "total_tokens": anthropic["usage"]["input_tokens"].as_i64().unwrap_or(0)
                + anthropic["usage"]["output_tokens"].as_i64().unwrap_or(0)
        }
    })
}

/// Static list of supported models
pub fn get_models_list() -> Value {
    json!({
        "object": "list",
        "data": [
            {"id": "claude-opus-4-5", "object": "model", "created": 1700000000, "owned_by": "anthropic"},
            {"id": "claude-sonnet-4-5", "object": "model", "created": 1700000000, "owned_by": "anthropic"},
            {"id": "claude-haiku-4-5", "object": "model", "created": 1700000000, "owned_by": "anthropic"},
            {"id": "claude-opus-4-1", "object": "model", "created": 1700000000, "owned_by": "anthropic"},
            {"id": "claude-sonnet-4-0", "object": "model", "created": 1700000000, "owned_by": "anthropic"},
            {"id": "claude-3-7-sonnet-20250219", "object": "model", "created": 1700000000, "owned_by": "anthropic"},
            {"id": "claude-3-5-haiku-20241022", "object": "model", "created": 1700000000, "owned_by": "anthropic"},
        ]
    })
}

/// Estimate cost for a given model and token counts ($/MTok)
pub fn estimate_cost(model: &str, input_tokens: i64, output_tokens: i64) -> f64 {
    let (input_price, output_price) = if model.contains("opus") {
        (15.0_f64, 75.0_f64)
    } else if model.contains("sonnet") {
        (3.0_f64, 15.0_f64)
    } else if model.contains("haiku") {
        (1.0_f64, 5.0_f64)
    } else {
        (3.0_f64, 15.0_f64)
    };

    (input_tokens as f64 / 1_000_000.0) * input_price
        + (output_tokens as f64 / 1_000_000.0) * output_price
}
