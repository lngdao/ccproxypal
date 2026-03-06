use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{self, AnalyticsSummary, BudgetSettings};
use crate::oauth::get_valid_token;
use crate::proxy::server::{build_router, ServerState};
use crate::state::{AppState, ProxyConfig, ProxyServerHandle, TelegramConfig, TokenInfo};
use crate::telegram::{run_bot, BotContext};
use crate::tunnel;

// ─── Logging helper ──────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct LogEvent {
    pub level: String,
    pub source: String,
    pub message: String,
}

pub fn emit_log(app: &AppHandle, level: &str, source: &str, message: &str) {
    let event = LogEvent {
        level: level.to_string(),
        source: source.to_string(),
        message: message.to_string(),
    };
    let _ = app.emit("app-log", event);
}

// ─── Status ──────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct AppStatus {
    pub proxy_running: bool,
    pub proxy_port: u16,
    pub token_valid: bool,
    pub token_expires_at: Option<i64>,
    pub tunnel_running: bool,
    pub tunnel_url: Option<String>,
    pub telegram_running: bool,
}

#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> Result<AppStatus, String> {
    let proxy_running = state.proxy_handle.lock().unwrap().is_some();
    let proxy_port = state.config.lock().unwrap().port;

    let (token_valid, token_expires_at) = {
        let lock = state.token_cache.lock().unwrap();
        if let Some(t) = lock.as_ref() {
            (!t.is_expired(), Some(t.expires_at))
        } else {
            (false, None)
        }
    };

    let tunnel_running = state.tunnel_process.lock().unwrap().is_some();
    let tunnel_url = state.tunnel_url.lock().unwrap().clone();
    let telegram_running = state.telegram_handle.lock().unwrap().is_some();

    Ok(AppStatus {
        proxy_running,
        proxy_port,
        token_valid,
        token_expires_at,
        tunnel_running,
        tunnel_url,
        telegram_running,
    })
}

// ─── Token ───────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct TokenStatus {
    pub valid: bool,
    pub expires_at: Option<i64>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn refresh_token(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TokenStatus, String> {
    emit_log(&app, "info", "app", "Refreshing OAuth token...");
    let cached = { state.token_cache.lock().unwrap().clone() };
    match get_valid_token(cached).await {
        Ok(token) => {
            let expires_at = token.expires_at;
            *state.token_cache.lock().unwrap() = Some(token);
            emit_log(&app, "info", "app", &format!("OAuth token valid, expires at {}", expires_at));
            Ok(TokenStatus {
                valid: true,
                expires_at: Some(expires_at),
                error: None,
            })
        }
        Err(e) => {
            let msg = e.to_string();
            emit_log(&app, "error", "app", &format!("OAuth token refresh failed: {}", msg));
            Ok(TokenStatus {
                valid: false,
                expires_at: None,
                error: Some(msg),
            })
        }
    }
}

#[tauri::command]
pub async fn load_token(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TokenStatus, String> {
    emit_log(&app, "info", "app", "Loading OAuth token from credentials...");
    refresh_token(app, state).await
}

#[derive(serde::Serialize)]
pub struct TokenDetails {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
}

#[tauri::command]
pub async fn get_token_details(state: State<'_, AppState>) -> Result<TokenDetails, String> {
    let lock = state.token_cache.lock().unwrap();
    match lock.as_ref() {
        Some(t) => Ok(TokenDetails {
            access_token: Some(t.access_token.clone()),
            refresh_token: Some(t.refresh_token.clone()),
        }),
        None => Ok(TokenDetails {
            access_token: None,
            refresh_token: None,
        }),
    }
}

// ─── Proxy server ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_proxy(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    {
        let handle_lock = state.proxy_handle.lock().unwrap();
        if handle_lock.is_some() {
            emit_log(&app, "warn", "proxy", "Proxy already running");
            return Ok("Proxy already running".to_string());
        }
    }

    let config = state.config.lock().unwrap().clone();
    let port = config.port;

    emit_log(&app, "info", "proxy", &format!("Starting proxy server on port {}...", port));

    let db_path = {
        let db = state.db.lock().unwrap();
        db.path().map(|p| p.to_string()).unwrap_or_else(|| "ccproxypal.db".to_string())
    };

    let server_state = ServerState {
        config: Arc::new(config),
        token_cache: state.token_cache.clone(),
        db_path,
        app: app.clone(),
    };

    let router = build_router(server_state);
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let (bind_tx, bind_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let app_clone = app.clone();

    let join = tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await {
            Ok(l) => {
                let _ = bind_tx.send(Ok(()));
                l
            }
            Err(e) => {
                let msg = format!("Failed to bind on port {}: {}", port, e);
                emit_log(&app_clone, "error", "proxy", &msg);
                let _ = bind_tx.send(Err(msg));
                return;
            }
        };
        emit_log(&app_clone, "info", "proxy", &format!("Listening on 0.0.0.0:{}", port));
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .ok();
        emit_log(&app_clone, "info", "proxy", "Server shut down");
    });

    match bind_rx.await {
        Ok(Ok(())) => {
            let mut handle_lock = state.proxy_handle.lock().unwrap();
            *handle_lock = Some(ProxyServerHandle {
                shutdown_tx,
                _join: join,
            });
            emit_log(&app, "info", "proxy", &format!("Proxy started on port {}", port));
            Ok(format!("Proxy started on port {}", port))
        }
        Ok(Err(msg)) => Err(msg),
        Err(_) => {
            let msg = "Proxy task exited unexpectedly".to_string();
            emit_log(&app, "error", "proxy", &msg);
            Err(msg)
        }
    }
}

#[tauri::command]
pub async fn stop_proxy(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut handle_lock = state.proxy_handle.lock().unwrap();
    if let Some(handle) = handle_lock.take() {
        let _ = handle.shutdown_tx.send(());
        emit_log(&app, "info", "proxy", "Proxy stopped");
        Ok("Proxy stopped".to_string())
    } else {
        emit_log(&app, "warn", "proxy", "Proxy was not running");
        Ok("Proxy was not running".to_string())
    }
}

// ─── Tunnel ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_tunnel(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut proc_lock = state.tunnel_process.lock().unwrap();
    if proc_lock.is_some() {
        emit_log(&app, "warn", "tunnel", "Tunnel already running");
        return Ok("Tunnel already running".to_string());
    }

    let port = state.config.lock().unwrap().port;
    emit_log(&app, "info", "tunnel", &format!("Starting cloudflare tunnel for port {}...", port));
    let app_clone = app.clone();

    let child = tunnel::start_tunnel(port, move |url| {
        let app_state = app_clone.state::<AppState>();
        *app_state.tunnel_url.lock().unwrap() = Some(url.clone());
        emit_log(&app_clone, "info", "tunnel", &format!("Tunnel URL: {}", url));
        let _ = app_clone.emit("tunnel-url", url);
    })
    .map_err(|e| {
        let msg = e.to_string();
        emit_log(&app, "error", "tunnel", &format!("Failed to start tunnel: {}", msg));
        msg
    })?;

    *proc_lock = Some(child);
    emit_log(&app, "info", "tunnel", "Tunnel process started, waiting for URL...");
    Ok("Tunnel starting...".to_string())
}

#[tauri::command]
pub async fn stop_tunnel(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut proc_lock = state.tunnel_process.lock().unwrap();
    if let Some(mut child) = proc_lock.take() {
        tunnel::stop_tunnel(&mut child).map_err(|e| {
            let msg = e.to_string();
            emit_log(&app, "error", "tunnel", &format!("Failed to stop tunnel: {}", msg));
            msg
        })?;
        *state.tunnel_url.lock().unwrap() = None;
        emit_log(&app, "info", "tunnel", "Tunnel stopped");
        Ok("Tunnel stopped".to_string())
    } else {
        Ok("Tunnel was not running".to_string())
    }
}

#[tauri::command]
pub async fn get_tunnel_url(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.tunnel_url.lock().unwrap().clone())
}

#[tauri::command]
pub fn is_cloudflared_available() -> bool {
    tunnel::is_cloudflared_available()
}

// ─── Settings ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<ProxyConfig, String> {
    Ok(state.config.lock().unwrap().clone())
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    config: ProxyConfig,
) -> Result<String, String> {
    emit_log(&app, "info", "app", &format!("Settings saved (port={}, strip_unsupported={})", config.port, config.strip_unsupported_fields));
    *state.config.lock().unwrap() = config;
    Ok("Settings saved".to_string())
}

// ─── Analytics ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_analytics(
    state: State<'_, AppState>,
    period: Option<String>,
    limit: Option<usize>,
) -> Result<AnalyticsSummary, String> {
    let period = period.as_deref().unwrap_or("all");
    let limit = limit.unwrap_or(100);
    let conn = state.db.lock().unwrap();
    db::get_analytics(&conn, period, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reset_analytics(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let conn = state.db.lock().unwrap();
    db::reset_analytics(&conn).map_err(|e| e.to_string())?;
    emit_log(&app, "info", "app", "Analytics data reset");
    Ok("Analytics reset".to_string())
}

#[tauri::command]
pub async fn get_budget(state: State<'_, AppState>) -> Result<BudgetSettings, String> {
    let conn = state.db.lock().unwrap();
    db::get_budget(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_budget(
    app: AppHandle,
    state: State<'_, AppState>,
    budget: BudgetSettings,
) -> Result<String, String> {
    let conn = state.db.lock().unwrap();
    db::save_budget(&conn, &budget).map_err(|e| e.to_string())?;
    emit_log(&app, "info", "app", "Budget settings saved");
    Ok("Budget saved".to_string())
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_telegram_config(state: State<'_, AppState>) -> Result<TelegramConfig, String> {
    Ok(state.telegram_config.lock().unwrap().clone())
}

#[tauri::command]
pub async fn save_telegram_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: TelegramConfig,
) -> Result<String, String> {
    emit_log(&app, "info", "telegram", &format!("Telegram config saved (enabled={}, users={})", config.enabled, config.allowed_user_ids.len()));
    *state.telegram_config.lock().unwrap() = config;
    Ok("Telegram config saved".to_string())
}

#[derive(serde::Serialize)]
pub struct TelegramStatus {
    pub running: bool,
    pub bot_token_set: bool,
    pub allowed_users_count: usize,
}

#[tauri::command]
pub async fn get_telegram_status(state: State<'_, AppState>) -> Result<TelegramStatus, String> {
    let cfg = state.telegram_config.lock().unwrap().clone();
    let running = state.telegram_handle.lock().unwrap().is_some();
    Ok(TelegramStatus {
        running,
        bot_token_set: cfg.bot_token.is_some(),
        allowed_users_count: cfg.allowed_user_ids.len(),
    })
}

#[tauri::command]
pub async fn start_telegram_bot(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut handle_lock = state.telegram_handle.lock().unwrap();
    if handle_lock.is_some() {
        emit_log(&app, "warn", "telegram", "Telegram bot already running");
        return Ok("Telegram bot already running".to_string());
    }

    let cfg = state.telegram_config.lock().unwrap().clone();
    let bot_token = cfg
        .bot_token
        .clone()
        .ok_or("No Telegram bot token configured")?;

    if !cfg.enabled {
        emit_log(&app, "error", "telegram", "Telegram bot is not enabled in settings");
        return Err("Telegram bot is not enabled in settings".to_string());
    }

    let port = state.config.lock().unwrap().port;
    emit_log(&app, "info", "telegram", "Starting Telegram bot...");

    let token_cache = state.token_cache.clone();
    let proxy_running = Arc::new(std::sync::Mutex::new(
        state.proxy_handle.lock().unwrap().is_some(),
    ));

    let app_clone = app.clone();

    let ctx = BotContext {
        bot_token,
        allowed_user_ids: cfg.allowed_user_ids,
        token_cache: token_cache.clone(),
        tunnel_url: {
            let url = state.tunnel_url.lock().unwrap().clone();
            Arc::new(std::sync::Mutex::new(url))
        },
        proxy_port: port,
        proxy_running,
    };

    let tunnel_url_shared = ctx.tunnel_url.clone();

    let join = tokio::spawn(async move {
        let sync_app = app_clone.clone();
        tokio::spawn(async move {
            loop {
                let state = sync_app.state::<AppState>();
                let url = state.tunnel_url.lock().unwrap().clone();
                *tunnel_url_shared.lock().unwrap() = url;
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            }
        });

        run_bot(ctx).await;
    });

    *handle_lock = Some(join);
    emit_log(&app, "info", "telegram", "Telegram bot started");
    Ok("Telegram bot started".to_string())
}

#[tauri::command]
pub async fn stop_telegram_bot(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut handle_lock = state.telegram_handle.lock().unwrap();
    if let Some(handle) = handle_lock.take() {
        handle.abort();
        emit_log(&app, "info", "telegram", "Telegram bot stopped");
        Ok("Telegram bot stopped".to_string())
    } else {
        Ok("Telegram bot was not running".to_string())
    }
}

/// ─── Client mode: manual token injection ─────────────────────────────────────

/// Decode a base64url-encoded JWT payload and return the `exp` claim in milliseconds.
fn parse_jwt_expiry_ms(token: &str) -> Option<i64> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let payload_b64 = token.splitn(3, '.').nth(1)?;
    let payload = URL_SAFE_NO_PAD.decode(payload_b64).ok()?;
    let json: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    let exp = json["exp"].as_i64()?;
    Some(exp * 1000) // seconds → milliseconds
}

#[tauri::command]
pub async fn set_token_manually(
    app: AppHandle,
    state: State<'_, AppState>,
    access_token: String,
    refresh_token: String,
) -> Result<String, String> {
    // Try to read real expiry from JWT; fall back to 55-minute assumption
    let expires_at = parse_jwt_expiry_ms(&access_token)
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis() + 55 * 60 * 1000);

    let expires_in_min = (expires_at - chrono::Utc::now().timestamp_millis()) / 60_000;
    let token = crate::state::TokenInfo { access_token, refresh_token, expires_at };
    *state.token_cache.lock().unwrap() = Some(token);
    emit_log(&app, "info", "app", &format!("Token set manually (expires in ~{}m)", expires_in_min));
    Ok("Token set successfully".to_string())
}

// ─── Tool configuration ───────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ToolConfigStatus {
    pub claude_code: bool,
    pub opencode: bool,
}

#[tauri::command]
pub async fn get_tool_config_status(state: State<'_, AppState>) -> Result<ToolConfigStatus, String> {
    let proxy_url = {
        let tunnel = state.tunnel_url.lock().unwrap().clone();
        let port = state.config.lock().unwrap().port;
        tunnel.unwrap_or_else(|| format!("http://localhost:{}", port))
    };

    let claude_code = check_tool_configured("claude_code", &proxy_url).await;
    let opencode = check_tool_configured("opencode", &proxy_url).await;

    Ok(ToolConfigStatus { claude_code, opencode })
}

async fn check_tool_configured(tool: &str, proxy_url: &str) -> bool {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return false,
    };
    let path = match tool {
        "claude_code" => home.join(".claude").join("settings.json"),
        "opencode" => home.join(".config").join("opencode").join("config.json"),
        _ => return false,
    };
    if !path.exists() {
        return false;
    }
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(c) => c,
        Err(_) => return false,
    };
    content.contains(proxy_url)
}

#[tauri::command]
pub async fn configure_tool(
    app: AppHandle,
    state: State<'_, AppState>,
    tool: String,
) -> Result<String, String> {
    let proxy_url = {
        let tunnel = state.tunnel_url.lock().unwrap().clone();
        let port = state.config.lock().unwrap().port;
        tunnel.unwrap_or_else(|| format!("http://localhost:{}", port))
    };

    let home = dirs::home_dir().ok_or("Cannot find home directory")?;

    let result = match tool.as_str() {
        "claude_code" => {
            let path = home.join(".claude").join("settings.json");
            write_env_to_json(&path, &proxy_url).await
        }
        "opencode" => {
            let path = home.join(".config").join("opencode").join("config.json");
            write_env_to_json(&path, &proxy_url).await
        }
        _ => Err(format!("Unknown tool: {}", tool)),
    };

    match &result {
        Ok(msg) => emit_log(&app, "info", "app", &format!("Tool '{}' configured: {}", tool, msg)),
        Err(msg) => emit_log(&app, "error", "app", &format!("Failed to configure '{}': {}", tool, msg)),
    }

    result
}

#[tauri::command]
pub async fn remove_tool_config(app: AppHandle, tool: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let path = match tool.as_str() {
        "claude_code" => home.join(".claude").join("settings.json"),
        "opencode" => home.join(".config").join("opencode").join("config.json"),
        _ => return Err(format!("Unknown tool: {}", tool)),
    };

    if !path.exists() {
        return Ok("Nothing to remove".to_string());
    }

    let content = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    let mut settings: serde_json::Value =
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}));

    if let Some(env) = settings.get_mut("env").and_then(|e| e.as_object_mut()) {
        env.remove("ANTHROPIC_BASE_URL");
        env.remove("ANTHROPIC_AUTH_TOKEN");
        if env.is_empty() {
            settings.as_object_mut().unwrap().remove("env");
        }
    }

    tokio::fs::write(&path, serde_json::to_string_pretty(&settings).unwrap())
        .await
        .map_err(|e| e.to_string())?;

    emit_log(&app, "info", "app", &format!("Tool '{}' config removed", tool));
    Ok("Config removed".to_string())
}

async fn write_env_to_json(path: &std::path::Path, proxy_url: &str) -> Result<String, String> {
    let mut settings: serde_json::Value = if path.exists() {
        let content = tokio::fs::read_to_string(path).await.unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if settings.get("env").is_none() {
        settings["env"] = serde_json::json!({});
    }
    settings["env"]["ANTHROPIC_BASE_URL"] = serde_json::Value::String(proxy_url.to_string());
    settings["env"]["ANTHROPIC_AUTH_TOKEN"] = serde_json::Value::String("any-dummy-key".to_string());

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    tokio::fs::write(path, serde_json::to_string_pretty(&settings).unwrap())
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("Configured successfully: {}", path.display()))
}
