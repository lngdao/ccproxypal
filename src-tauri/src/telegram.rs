/// Telegram bot using long-polling against the Bot API directly (no heavy deps).
/// Supported commands:
///   /start   - welcome message
///   /status  - proxy/tunnel/token status
///   /token   - get fresh access token (for connecting to the proxy)
///   /url     - get the current tunnel URL
///   /refresh - force refresh the OAuth token
///   /help    - list commands
use anyhow::{anyhow, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

use crate::oauth::get_valid_token;
use crate::state::TokenInfo;

const TG_API: &str = "https://api.telegram.org/bot";

// ─── Telegram API types ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TgUpdate {
    update_id: i64,
    message: Option<TgMessage>,
}

#[derive(Debug, Deserialize)]
struct TgMessage {
    message_id: i64,
    from: Option<TgUser>,
    chat: TgChat,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TgUser {
    id: i64,
    username: Option<String>,
    first_name: String,
}

#[derive(Debug, Deserialize)]
struct TgChat {
    id: i64,
}

#[derive(Debug, Deserialize)]
struct TgResponse<T> {
    ok: bool,
    result: Option<T>,
    description: Option<String>,
}

// ─── Bot context passed into the polling loop ─────────────────────────────

pub struct BotContext {
    pub bot_token: String,
    pub allowed_user_ids: Vec<i64>,
    pub token_cache: Arc<Mutex<Option<TokenInfo>>>,
    /// Latest tunnel URL
    pub tunnel_url: Arc<Mutex<Option<String>>>,
    /// Proxy port
    pub proxy_port: u16,
    /// Whether the proxy is currently running
    pub proxy_running: Arc<Mutex<bool>>,
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

async fn tg_get<T: for<'de> serde::Deserialize<'de>>(
    client: &reqwest::Client,
    bot_token: &str,
    method: &str,
    params: Value,
) -> Result<T> {
    let url = format!("{}{}/{}", TG_API, bot_token, method);
    let resp = client
        .post(&url)
        .json(&params)
        .send()
        .await?
        .json::<TgResponse<T>>()
        .await?;

    if !resp.ok {
        return Err(anyhow!(
            "Telegram API error: {}",
            resp.description.unwrap_or_default()
        ));
    }
    resp.result.ok_or_else(|| anyhow!("Empty result"))
}

async fn send_message(
    client: &reqwest::Client,
    bot_token: &str,
    chat_id: i64,
    text: &str,
) -> Result<()> {
    let _: Value = tg_get(
        client,
        bot_token,
        "sendMessage",
        json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML"
        }),
    )
    .await?;
    Ok(())
}

async fn get_updates(
    client: &reqwest::Client,
    bot_token: &str,
    offset: i64,
) -> Result<Vec<TgUpdate>> {
    tg_get(
        client,
        bot_token,
        "getUpdates",
        json!({
            "offset": offset,
            "timeout": 30,
            "allowed_updates": ["message"]
        }),
    )
    .await
}

// ─── Command handlers ─────────────────────────────────────────────────────

fn format_expiry(expires_at: i64) -> String {
    let diff_ms = expires_at - chrono::Utc::now().timestamp_millis();
    if diff_ms <= 0 {
        return "Expired".to_string();
    }
    let minutes = diff_ms / 60000;
    let hours = minutes / 60;
    if hours > 0 {
        format!("{}h {}m", hours, minutes % 60)
    } else {
        format!("{}m", minutes)
    }
}

async fn handle_status(ctx: &BotContext, chat_id: i64, client: &reqwest::Client) {
    let (token_valid, expiry_str) = {
        let token_lock = ctx.token_cache.lock().unwrap();
        if let Some(t) = token_lock.as_ref() {
            (!t.is_expired(), format_expiry(t.expires_at))
        } else {
            (false, "Not loaded".to_string())
        }
    };

    let tunnel_url = ctx.tunnel_url.lock().unwrap().clone()
        .unwrap_or_else(|| "Not running".to_string());

    let proxy_running = *ctx.proxy_running.lock().unwrap();

    let text = format!(
        "🖥 <b>ccproxypal Status</b>\n\n\
        Proxy: {}\n\
        Token: {} (expires: {})\n\
        Tunnel: <code>{}</code>",
        if proxy_running { "✅ Running" } else { "❌ Stopped" },
        if token_valid { "✅ Valid" } else { "❌ Invalid" },
        expiry_str,
        tunnel_url
    );

    let _ = send_message(client, &ctx.bot_token, chat_id, &text).await;
}

async fn handle_token(ctx: &BotContext, chat_id: i64, client: &reqwest::Client) {
    let cached = { ctx.token_cache.lock().unwrap().clone() };
    match get_valid_token(cached).await {
        Ok(token) => {
            { *ctx.token_cache.lock().unwrap() = Some(token.clone()); }

            let tunnel_url = { ctx.tunnel_url.lock().unwrap().clone() };
            let base_url = tunnel_url.unwrap_or_else(|| format!("http://localhost:{}", ctx.proxy_port));

            let text = format!(
                "🔑 <b>Token refreshed</b>\n\n\
                Set these in your <code>~/.zshenv</code>:\n\n\
                <code>export ANTHROPIC_BASE_URL={}</code>\n\
                <code>export ANTHROPIC_AUTH_TOKEN=proxy-key</code>\n\n\
                <i>Token expires in: {}</i>",
                base_url,
                format_expiry(token.expires_at)
            );
            let _ = send_message(client, &ctx.bot_token, chat_id, &text).await;
        }
        Err(e) => {
            let _ = send_message(
                client,
                &ctx.bot_token,
                chat_id,
                &format!("❌ Failed to get token: {}", e),
            )
            .await;
        }
    }
}

async fn handle_url(ctx: &BotContext, chat_id: i64, client: &reqwest::Client) {
    let tunnel_url = { ctx.tunnel_url.lock().unwrap().clone() };
    let base_url = tunnel_url.unwrap_or_else(|| format!("http://localhost:{}", ctx.proxy_port));

    let text = format!(
        "🌐 <b>Proxy URL</b>\n\n\
        <code>{}</code>\n\n\
        Use with:\n\
        <code>export ANTHROPIC_BASE_URL={}</code>\n\
        <code>export ANTHROPIC_AUTH_TOKEN=any-key</code>",
        base_url, base_url
    );
    let _ = send_message(client, &ctx.bot_token, chat_id, &text).await;
}

async fn handle_refresh(ctx: &BotContext, chat_id: i64, client: &reqwest::Client) {
    let _ = send_message(client, &ctx.bot_token, chat_id, "🔄 Refreshing token...").await;
    let stale = {
        ctx.token_cache.lock().unwrap().clone().map(|mut t| { t.expires_at = 0; t })
    };
    match get_valid_token(stale).await {
        Ok(token) => {
            let expiry = format_expiry(token.expires_at);
            { *ctx.token_cache.lock().unwrap() = Some(token); }
            let _ = send_message(
                client,
                &ctx.bot_token,
                chat_id,
                &format!("✅ Token refreshed successfully!\nExpires in: {}", expiry),
            )
            .await;
        }
        Err(e) => {
            let _ = send_message(
                client,
                &ctx.bot_token,
                chat_id,
                &format!("❌ Refresh failed: {}", e),
            )
            .await;
        }
    }
}

const HELP_TEXT: &str = "🤖 <b>ccproxypal Bot</b>\n\n\
Available commands:\n\
/status  — proxy, token, tunnel status\n\
/token   — get connection info + fresh token\n\
/url     — get the proxy URL\n\
/refresh — force refresh OAuth token\n\
/help    — show this message";

// ─── Command registration ─────────────────────────────────────────────────

/// Register bot commands with Telegram so they appear in autocomplete menu
async fn register_commands(client: &reqwest::Client, bot_token: &str) {
    let commands = json!([
        { "command": "status",  "description": "Proxy / token / tunnel status" },
        { "command": "token",   "description": "Get connection info + refresh token" },
        { "command": "url",     "description": "Get current proxy / tunnel URL" },
        { "command": "refresh", "description": "Force refresh OAuth token" },
        { "command": "help",    "description": "List all commands" },
    ]);

    match tg_get::<Value>(client, bot_token, "setMyCommands", json!({ "commands": commands })).await {
        Ok(_) => println!("Telegram: bot commands registered"),
        Err(e) => eprintln!("Telegram: failed to register commands: {}", e),
    }
}

// ─── Main polling loop ─────────────────────────────────────────────────────

/// Run the Telegram bot polling loop. Call this in a tokio::spawn.
pub async fn run_bot(ctx: BotContext) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(40))
        .build()
        .unwrap();

    // Register commands for autocomplete on every bot start
    register_commands(&client, &ctx.bot_token).await;

    let mut offset: i64 = 0;

    println!("Telegram bot started");

    loop {
        match get_updates(&client, &ctx.bot_token, offset).await {
            Err(e) => {
                eprintln!("Telegram getUpdates error: {}", e);
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
            Ok(updates) => {
                for update in updates {
                    offset = offset.max(update.update_id + 1);

                    let Some(msg) = update.message else { continue };
                    let Some(ref from) = msg.from else { continue };
                    let chat_id = msg.chat.id;
                    let user_id = from.id;
                    let text = msg.text.clone().unwrap_or_default();

                    // Access control
                    if !ctx.allowed_user_ids.is_empty()
                        && !ctx.allowed_user_ids.contains(&user_id)
                    {
                        let _ = send_message(
                            &client,
                            &ctx.bot_token,
                            chat_id,
                            &format!(
                                "⛔ Access denied. Your user ID is <code>{}</code>.\nAsk the proxy owner to add you.",
                                user_id
                            ),
                        )
                        .await;
                        continue;
                    }

                    let cmd = text.split_whitespace().next().unwrap_or("").to_lowercase();
                    println!(
                        "Telegram: {} ({}) → {}",
                        from.first_name,
                        user_id,
                        cmd
                    );

                    match cmd.as_str() {
                        "/start" => {
                            let _ = send_message(
                                &client,
                                &ctx.bot_token,
                                chat_id,
                                &format!("👋 Hello, {}!\n\n{}", from.first_name, HELP_TEXT),
                            )
                            .await;
                        }
                        "/help" => {
                            let _ = send_message(&client, &ctx.bot_token, chat_id, HELP_TEXT)
                                .await;
                        }
                        "/status" => handle_status(&ctx, chat_id, &client).await,
                        "/token" => handle_token(&ctx, chat_id, &client).await,
                        "/url" => handle_url(&ctx, chat_id, &client).await,
                        "/refresh" => handle_refresh(&ctx, chat_id, &client).await,
                        _ => {
                            if !text.is_empty() {
                                let _ = send_message(
                                    &client,
                                    &ctx.bot_token,
                                    chat_id,
                                    "Unknown command. Use /help to see available commands.",
                                )
                                .await;
                            }
                        }
                    }
                }
            }
        }
    }
}
