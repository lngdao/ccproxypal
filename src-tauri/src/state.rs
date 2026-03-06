use std::sync::Mutex;
use tokio::task::JoinHandle;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenInfo {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64, // Unix milliseconds
}

impl TokenInfo {
    pub fn is_expired(&self) -> bool {
        let buffer_ms = 5 * 60 * 1000; // 5 minute buffer
        chrono::Utc::now().timestamp_millis() >= self.expires_at - buffer_ms
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub port: u16,
    pub claude_code_first: bool,
    pub anthropic_api_key: Option<String>,
    pub openai_api_key: Option<String>,
    pub openai_base_url: String,
    pub allowed_ips: Vec<String>,
    pub budget_hourly: Option<f64>,
    pub budget_daily: Option<f64>,
    pub budget_weekly: Option<f64>,
    pub budget_monthly: Option<f64>,
    /// Strip fields unsupported by the Anthropic OAuth API (e.g. context_management).
    /// Enable if you get "Extra inputs are not permitted" errors.
    pub strip_unsupported_fields: bool,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            port: 8082,
            claude_code_first: true,
            anthropic_api_key: None,
            openai_api_key: None,
            openai_base_url: "https://api.openai.com".to_string(),
            allowed_ips: vec!["0.0.0.0".to_string()],
            budget_hourly: None,
            budget_daily: None,
            budget_weekly: None,
            budget_monthly: None,
            strip_unsupported_fields: true,
        }
    }
}

pub struct ProxyServerHandle {
    pub shutdown_tx: tokio::sync::oneshot::Sender<()>,
    pub _join: JoinHandle<()>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramConfig {
    pub bot_token: Option<String>,
    /// Telegram user IDs allowed to interact with the bot
    pub allowed_user_ids: Vec<i64>,
    pub enabled: bool,
}

impl Default for TelegramConfig {
    fn default() -> Self {
        Self {
            bot_token: None,
            allowed_user_ids: Vec::new(),
            enabled: false,
        }
    }
}

pub struct AppState {
    pub proxy_handle: Mutex<Option<ProxyServerHandle>>,
    /// Shared Arc — same object passed to the proxy server so UI refresh
    /// and in-flight requests always see the same token.
    pub token_cache: Arc<Mutex<Option<TokenInfo>>>,
    pub tunnel_process: Mutex<Option<std::process::Child>>,
    pub tunnel_url: Mutex<Option<String>>,
    pub db: Mutex<rusqlite::Connection>,
    pub config: Mutex<ProxyConfig>,
    pub telegram_config: Mutex<TelegramConfig>,
    pub telegram_handle: Mutex<Option<JoinHandle<()>>>,
}
