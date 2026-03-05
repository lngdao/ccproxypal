use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{self, AnalyticsSummary, BudgetSettings};
use crate::oauth::get_valid_token;
use crate::proxy::server::{build_router, ServerState};
use crate::state::{AppState, ProxyConfig, ProxyServerHandle, TelegramConfig, TokenInfo};
use crate::telegram::{run_bot, BotContext};
use crate::tunnel;

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
pub async fn refresh_token(state: State<'_, AppState>) -> Result<TokenStatus, String> {
    let cached = { state.token_cache.lock().unwrap().clone() };
    match get_valid_token(cached).await {
        Ok(token) => {
            let expires_at = token.expires_at;
            *state.token_cache.lock().unwrap() = Some(token);
            // token_cache is an Arc shared with the proxy server —
            // the proxy server sees the updated token immediately.
            Ok(TokenStatus {
                valid: true,
                expires_at: Some(expires_at),
                error: None,
            })
        }
        Err(e) => Ok(TokenStatus {
            valid: false,
            expires_at: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn load_token(state: State<'_, AppState>) -> Result<TokenStatus, String> {
    refresh_token(state).await
}

// ─── Proxy server ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_proxy(state: State<'_, AppState>) -> Result<String, String> {
    let mut handle_lock = state.proxy_handle.lock().unwrap();
    if handle_lock.is_some() {
        return Ok("Proxy already running".to_string());
    }

    let config = state.config.lock().unwrap().clone();
    let port = config.port;

    let db_path = {
        let db = state.db.lock().unwrap();
        db.path().map(|p| p.to_string()).unwrap_or_else(|| "ccproxypal.db".to_string())
    };

    let server_state = ServerState {
        config: Arc::new(config),
        // Share the SAME Arc — UI refresh_token and proxy server both see the same token.
        token_cache: state.token_cache.clone(),
        db_path,
    };

    let router = build_router(server_state);
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let join = tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Failed to bind proxy on port {}: {}", port, e);
                return;
            }
        };
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .ok();
    });

    *handle_lock = Some(ProxyServerHandle {
        shutdown_tx,
        _join: join,
    });

    Ok(format!("Proxy started on port {}", port))
}

#[tauri::command]
pub async fn stop_proxy(state: State<'_, AppState>) -> Result<String, String> {
    let mut handle_lock = state.proxy_handle.lock().unwrap();
    if let Some(handle) = handle_lock.take() {
        let _ = handle.shutdown_tx.send(());
        Ok("Proxy stopped".to_string())
    } else {
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
        return Ok("Tunnel already running".to_string());
    }

    let port = state.config.lock().unwrap().port;
    let app_clone = app.clone();

    let child = tunnel::start_tunnel(port, move |url| {
        // Persist URL into AppState so get_status() can read it
        let app_state = app_clone.state::<AppState>();
        *app_state.tunnel_url.lock().unwrap() = Some(url.clone());
        let _ = app_clone.emit("tunnel-url", url);
    })
    .map_err(|e| e.to_string())?;

    *proc_lock = Some(child);
    Ok("Tunnel starting...".to_string())
}

#[tauri::command]
pub async fn stop_tunnel(state: State<'_, AppState>) -> Result<String, String> {
    let mut proc_lock = state.tunnel_process.lock().unwrap();
    if let Some(mut child) = proc_lock.take() {
        tunnel::stop_tunnel(&mut child).map_err(|e| e.to_string())?;
        *state.tunnel_url.lock().unwrap() = None;
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
    state: State<'_, AppState>,
    config: ProxyConfig,
) -> Result<String, String> {
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
pub async fn reset_analytics(state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.db.lock().unwrap();
    db::reset_analytics(&conn).map_err(|e| e.to_string())?;
    Ok("Analytics reset".to_string())
}

#[tauri::command]
pub async fn get_budget(state: State<'_, AppState>) -> Result<BudgetSettings, String> {
    let conn = state.db.lock().unwrap();
    db::get_budget(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_budget(
    state: State<'_, AppState>,
    budget: BudgetSettings,
) -> Result<String, String> {
    let conn = state.db.lock().unwrap();
    db::save_budget(&conn, &budget).map_err(|e| e.to_string())?;
    Ok("Budget saved".to_string())
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_telegram_config(state: State<'_, AppState>) -> Result<TelegramConfig, String> {
    Ok(state.telegram_config.lock().unwrap().clone())
}

#[tauri::command]
pub async fn save_telegram_config(
    state: State<'_, AppState>,
    config: TelegramConfig,
) -> Result<String, String> {
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
        return Ok("Telegram bot already running".to_string());
    }

    let cfg = state.telegram_config.lock().unwrap().clone();
    let bot_token = cfg
        .bot_token
        .clone()
        .ok_or("No Telegram bot token configured")?;

    if !cfg.enabled {
        return Err("Telegram bot is not enabled in settings".to_string());
    }

    let port = state.config.lock().unwrap().port;

    // Share the same token_cache Arc as AppState and the proxy server.
    let token_cache = state.token_cache.clone();
    let proxy_running = Arc::new(std::sync::Mutex::new(
        state.proxy_handle.lock().unwrap().is_some(),
    ));

    // Use the app handle to access tunnel_url from state inside the bot
    let app_clone = app.clone();

    let ctx = BotContext {
        bot_token,
        allowed_user_ids: cfg.allowed_user_ids,
        token_cache: token_cache.clone(),
        tunnel_url: {
            // Create a shared tunnel_url Arc that syncs from state
            let url = state.tunnel_url.lock().unwrap().clone();
            Arc::new(std::sync::Mutex::new(url))
        },
        proxy_port: port,
        proxy_running,
    };

    let tunnel_url_shared = ctx.tunnel_url.clone();

    let join = tokio::spawn(async move {
        // Keep tunnel_url in sync from AppState every 10 seconds.
        // (token_cache is already a shared Arc — no sync needed for tokens.)
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
    Ok("Telegram bot started".to_string())
}

#[tauri::command]
pub async fn stop_telegram_bot(state: State<'_, AppState>) -> Result<String, String> {
    let mut handle_lock = state.telegram_handle.lock().unwrap();
    if let Some(handle) = handle_lock.take() {
        handle.abort();
        Ok("Telegram bot stopped".to_string())
    } else {
        Ok("Telegram bot was not running".to_string())
    }
}
