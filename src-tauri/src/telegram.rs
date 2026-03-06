/// Telegram bot using long-polling against the Bot API directly (no heavy deps).
/// Supported commands:
///   /start   - welcome message
///   /status  - proxy/tunnel/token/pool status
///   /start_proxy - start proxy remotely
///   /stop_proxy  - stop proxy remotely
///   /tunnel  - start/stop tunnel remotely
///   /pool    - show token pool health
///   /usage   - today's usage summary
///   /help    - list commands
///
/// Push notifications:
///   - Token expired / about to expire
///   - Proxy stopped unexpectedly
///   - Budget threshold reached
///   - New provider connected / provider expired
///   - Error rate spike
use anyhow::{anyhow, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

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
    #[allow(dead_code)]
    message_id: i64,
    from: Option<TgUser>,
    chat: TgChat,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TgUser {
    id: i64,
    #[allow(dead_code)]
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
    /// App handle for invoking commands
    pub app_handle: Option<tauri::AppHandle>,
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

async fn handle_pool(ctx: &BotContext, chat_id: i64, client: &reqwest::Client) {
    if let Some(ref app) = ctx.app_handle {
        use tauri::Manager;
        let state = app.state::<crate::state::AppState>();
        let text = {
            let pool = state.token_pool.lock().unwrap();
            if pool.entries.is_empty() {
                "📦 <b>Token Pool</b>\n\nNo providers connected.".to_string()
            } else {
                let mut lines = vec![format!("📦 <b>Token Pool</b> ({}/{} healthy)\n", pool.healthy_count(), pool.entries.len())];
                for entry in &pool.entries {
                    let status = if entry.token.is_expired() {
                        "❌ Expired"
                    } else if !entry.healthy {
                        "⚠️ Unhealthy"
                    } else {
                        "✅ Healthy"
                    };
                    lines.push(format!(
                        "• <code>{}</code> {} (expires: {})",
                        entry.provider_id,
                        status,
                        format_expiry(entry.token.expires_at)
                    ));
                }
                lines.join("\n")
            }
        };
        let _ = send_message(client, &ctx.bot_token, chat_id, &text).await;
    } else {
        let _ = send_message(client, &ctx.bot_token, chat_id, "📦 Pool info unavailable").await;
    }
}

async fn handle_usage(ctx: &BotContext, chat_id: i64, client: &reqwest::Client) {
    if let Some(ref app) = ctx.app_handle {
        use tauri::Manager;
        let state = app.state::<crate::state::AppState>();
        let text = {
            let conn = state.db.lock().unwrap();
            match crate::db::get_analytics(&conn, "day", 0) {
                Ok(summary) => {
                    format!(
                        "📊 <b>Today's Usage</b>\n\n\
                        Total requests: {}\n\
                        Claude Code: {} | API Key: {} | Errors: {}\n\
                        Input tokens: {} | Output: {}\n\
                        Paid cost: ${:.4}\n\
                        Estimated savings: ${:.4}",
                        summary.total_requests,
                        summary.claude_code_requests,
                        summary.api_key_requests,
                        summary.error_requests,
                        summary.total_input_tokens,
                        summary.total_output_tokens,
                        summary.total_cost,
                        summary.estimated_savings,
                    )
                }
                Err(e) => {
                    format!("❌ Failed to get usage: {}", e)
                }
            }
        };
        let _ = send_message(client, &ctx.bot_token, chat_id, &text).await;
    } else {
        let _ = send_message(client, &ctx.bot_token, chat_id, "📊 Usage info unavailable").await;
    }
}

async fn handle_start_proxy(ctx: &BotContext, chat_id: i64, client: &reqwest::Client) {
    let is_running = *ctx.proxy_running.lock().unwrap();
    if is_running {
        let _ = send_message(client, &ctx.bot_token, chat_id, "⚠️ Proxy is already running").await;
        return;
    }
    if let Some(ref app) = ctx.app_handle {
        // Load token first if needed
        let token_valid = {
            let lock = ctx.token_cache.lock().unwrap();
            lock.as_ref().map(|t| !t.is_expired()).unwrap_or(false)
        };
        if !token_valid {
            let cached = ctx.token_cache.lock().unwrap().clone();
            match get_valid_token(cached).await {
                Ok(token) => {
                    *ctx.token_cache.lock().unwrap() = Some(token);
                }
                Err(e) => {
                    let _ = send_message(client, &ctx.bot_token, chat_id, &format!("❌ Cannot load token: {}", e)).await;
                    return;
                }
            }
        }

        use tauri::Manager;
        let state = app.state::<crate::state::AppState>();

        // Gather all needed data from locks, then drop them
        let (config, db_path, token_cache, token_pool) = {
            let config = state.config.lock().unwrap().clone();
            let db_path = state.db.lock().unwrap()
                .path().map(|p| p.to_string())
                .unwrap_or_else(|| "ccproxypal.db".to_string());
            (config, db_path, state.token_cache.clone(), state.token_pool.clone())
        };

        let port = config.port;
        let server_state = crate::proxy::server::ServerState {
            config: Arc::new(config),
            token_cache,
            token_pool,
            db_path,
            app: app.clone(),
        };

        let router = crate::proxy::server::build_router(server_state);
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let app_clone = app.clone();

        let join = tokio::spawn(async move {
            let listener = match tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await {
                Ok(l) => l,
                Err(e) => {
                    crate::commands::emit_log(&app_clone, "error", "proxy", &format!("Bind failed: {}", e));
                    return;
                }
            };
            crate::commands::emit_log(&app_clone, "info", "proxy", &format!("Listening on 0.0.0.0:{}", port));
            axum::serve(listener, router)
                .with_graceful_shutdown(async { let _ = shutdown_rx.await; })
                .await
                .ok();
        });

        {
            let mut handle_lock = state.proxy_handle.lock().unwrap();
            *handle_lock = Some(crate::state::ProxyServerHandle { shutdown_tx, _join: join });
            *ctx.proxy_running.lock().unwrap() = true;
        }

        let _ = send_message(client, &ctx.bot_token, chat_id, &format!("✅ Proxy started on port {}", port)).await;
    } else {
        let _ = send_message(client, &ctx.bot_token, chat_id, "❌ Cannot start proxy remotely").await;
    }
}

async fn handle_stop_proxy(ctx: &BotContext, chat_id: i64, client: &reqwest::Client) {
    let is_running = *ctx.proxy_running.lock().unwrap();
    if !is_running {
        let _ = send_message(client, &ctx.bot_token, chat_id, "⚠️ Proxy is not running").await;
        return;
    }
    if let Some(ref app) = ctx.app_handle {
        use tauri::Manager;
        let state = app.state::<crate::state::AppState>();
        let stopped = {
            let mut handle_lock = state.proxy_handle.lock().unwrap();
            if let Some(handle) = handle_lock.take() {
                let _ = handle.shutdown_tx.send(());
                *ctx.proxy_running.lock().unwrap() = false;
                true
            } else {
                false
            }
        };
        if stopped {
            crate::commands::emit_log(app, "info", "proxy", "Proxy stopped via Telegram");
            let _ = send_message(client, &ctx.bot_token, chat_id, "✅ Proxy stopped").await;
        }
    }
}

async fn handle_tunnel(ctx: &BotContext, chat_id: i64, client: &reqwest::Client) {
    let tunnel_running = ctx.tunnel_url.lock().unwrap().is_some();
    if tunnel_running {
        // Stop tunnel
        if let Some(ref app) = ctx.app_handle {
            use tauri::Manager;
            let state = app.state::<crate::state::AppState>();
            let stopped = {
                let mut proc_lock = state.tunnel_process.lock().unwrap();
                if let Some(mut child) = proc_lock.take() {
                    let _ = crate::tunnel::stop_tunnel(&mut child);
                    *state.tunnel_url.lock().unwrap() = None;
                    *ctx.tunnel_url.lock().unwrap() = None;
                    true
                } else {
                    false
                }
            };
            if stopped {
                let _ = send_message(client, &ctx.bot_token, chat_id, "✅ Tunnel stopped").await;
                return;
            }
        }
        let _ = send_message(client, &ctx.bot_token, chat_id, "⚠️ Could not stop tunnel").await;
    } else {
        // Start tunnel
        if let Some(ref app) = ctx.app_handle {
            use tauri::Manager;
            let state = app.state::<crate::state::AppState>();
            let port = state.config.lock().unwrap().port;
            let app_clone = app.clone();
            let tunnel_url_ref = ctx.tunnel_url.clone();

            let result = crate::tunnel::start_tunnel(port, move |url| {
                let s = app_clone.state::<crate::state::AppState>();
                *s.tunnel_url.lock().unwrap() = Some(url.clone());
                *tunnel_url_ref.lock().unwrap() = Some(url.clone());
                let _ = app_clone.emit("tunnel-url", url);
            });

            match result {
                Ok(child) => {
                    *state.tunnel_process.lock().unwrap() = Some(child);
                    let _ = send_message(client, &ctx.bot_token, chat_id, "✅ Tunnel starting...").await;
                }
                Err(e) => {
                    let _ = send_message(client, &ctx.bot_token, chat_id, &format!("❌ Tunnel failed: {}", e)).await;
                }
            }
        } else {
            let _ = send_message(client, &ctx.bot_token, chat_id, "❌ Cannot manage tunnel remotely").await;
        }
    }
}

const HELP_TEXT: &str = "🤖 <b>ccproxypal Bot</b>\n\n\
Available commands:\n\
/status  — proxy, token, tunnel status\n\
/start_proxy — start proxy remotely\n\
/stop_proxy  — stop proxy remotely\n\
/tunnel  — toggle tunnel on/off\n\
/pool    — show token pool health\n\
/usage   — today's usage summary\n\
/token   — get connection info + fresh token\n\
/url     — get the proxy URL\n\
/refresh — force refresh OAuth token\n\
/help    — show this message";

// ─── Command registration ─────────────────────────────────────────────────

async fn register_commands(client: &reqwest::Client, bot_token: &str) {
    let commands = json!([
        { "command": "status",      "description": "Proxy / token / tunnel status" },
        { "command": "start_proxy", "description": "Start the proxy server" },
        { "command": "stop_proxy",  "description": "Stop the proxy server" },
        { "command": "tunnel",      "description": "Toggle Cloudflare tunnel" },
        { "command": "pool",        "description": "Show token pool health" },
        { "command": "usage",       "description": "Today's usage summary" },
        { "command": "token",       "description": "Get connection info + refresh token" },
        { "command": "url",         "description": "Get current proxy / tunnel URL" },
        { "command": "refresh",     "description": "Force refresh OAuth token" },
        { "command": "help",        "description": "List all commands" },
    ]);

    match tg_get::<Value>(client, bot_token, "setMyCommands", json!({ "commands": commands })).await {
        Ok(_) => println!("Telegram: bot commands registered"),
        Err(e) => eprintln!("Telegram: failed to register commands: {}", e),
    }
}

// ─── Push notification helper ─────────────────────────────────────────────

/// Send a push notification to all allowed users.
/// Called from other parts of the app (proxy errors, token expiry, etc.)
pub async fn send_notification(bot_token: &str, allowed_user_ids: &[i64], message: &str) {
    let client = reqwest::Client::new();
    for &user_id in allowed_user_ids {
        let _ = send_message(&client, bot_token, user_id, message).await;
    }
}

// ─── Main polling loop ─────────────────────────────────────────────────────

/// Run the Telegram bot polling loop. Call this in a tokio::spawn.
pub async fn run_bot(ctx: BotContext) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(40))
        .build()
        .unwrap();

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
                        "/pool" => handle_pool(&ctx, chat_id, &client).await,
                        "/usage" => handle_usage(&ctx, chat_id, &client).await,
                        "/start_proxy" => handle_start_proxy(&ctx, chat_id, &client).await,
                        "/stop_proxy" => handle_stop_proxy(&ctx, chat_id, &client).await,
                        "/tunnel" => handle_tunnel(&ctx, chat_id, &client).await,
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
