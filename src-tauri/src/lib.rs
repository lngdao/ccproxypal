mod commands;
mod db;
mod oauth;
mod proxy;
mod state;
mod telegram;
mod tunnel;

use commands::*;
use db::init_db;
use state::{AppState, ProxyConfig, TelegramConfig};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_path = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("ccproxypal")
        .join("analytics.db");

    std::fs::create_dir_all(db_path.parent().unwrap()).ok();

    let conn = rusqlite::Connection::open(&db_path).expect("Failed to open SQLite database");
    init_db(&conn).expect("Failed to initialize database");

    // Restore settings from previous session
    let proxy_config: ProxyConfig = db::load_setting(&conn, "proxy_config")
        .ok().flatten().unwrap_or_default();
    let telegram_config: TelegramConfig = db::load_setting(&conn, "telegram_config")
        .ok().flatten().unwrap_or_default();

    let app_state = AppState {
        proxy_handle: std::sync::Mutex::new(None),
        token_cache: std::sync::Arc::new(std::sync::Mutex::new(None)),
        token_pool: std::sync::Arc::new(std::sync::Mutex::new(state::TokenPool::default())),
        tunnel_process: std::sync::Mutex::new(None),
        tunnel_url: std::sync::Mutex::new(None),
        db: std::sync::Mutex::new(conn),
        config: std::sync::Mutex::new(proxy_config),
        telegram_config: std::sync::Mutex::new(telegram_config),
        telegram_handle: std::sync::Mutex::new(None),
        provider_handle: std::sync::Mutex::new(None),
        provider_hub_url: std::sync::Mutex::new(None),
        provider_healthy: std::sync::Arc::new(std::sync::Mutex::new(false)),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_status,
            refresh_token,
            load_token,
            reload_token,
            get_token_details,
            start_proxy,
            stop_proxy,
            start_tunnel,
            stop_tunnel,
            get_tunnel_url,
            is_cloudflared_available,
            get_settings,
            save_settings,
            get_analytics,
            reset_analytics,
            get_budget,
            save_budget,
            // Telegram
            get_telegram_config,
            save_telegram_config,
            start_telegram_bot,
            stop_telegram_bot,
            get_telegram_status,
            // Client mode
            set_token_manually,
            configure_tool,
            remove_tool_config,
            get_tool_config_status,
            // Hub / pool
            get_pool_status,
            start_provider,
            stop_provider,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
