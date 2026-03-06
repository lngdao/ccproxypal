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

// ─── Token Pool ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolEntry {
    pub provider_id: String,
    pub token: TokenInfo,
    pub healthy: bool,
    pub provided_at: i64,       // Unix ms — when token was pushed
    pub last_used: Option<i64>, // Unix ms — last time this token was used
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPool {
    pub entries: Vec<PoolEntry>,
    pub next_index: usize,
}

impl Default for TokenPool {
    fn default() -> Self {
        Self { entries: Vec::new(), next_index: 0 }
    }
}

impl TokenPool {
    /// Pick the next healthy, non-expired token via round-robin.
    pub fn next_token(&mut self) -> Option<(String, TokenInfo)> {
        let healthy: Vec<usize> = self.entries.iter().enumerate()
            .filter(|(_, e)| e.healthy && !e.token.is_expired())
            .map(|(i, _)| i)
            .collect();
        if healthy.is_empty() { return None; }

        let idx = self.next_index % healthy.len();
        self.next_index = self.next_index.wrapping_add(1);
        let entry = &mut self.entries[healthy[idx]];
        entry.last_used = Some(chrono::Utc::now().timestamp_millis());
        Some((entry.provider_id.clone(), entry.token.clone()))
    }

    /// Add or update a provider's token.
    pub fn upsert(&mut self, provider_id: &str, token: TokenInfo) {
        let now = chrono::Utc::now().timestamp_millis();
        if let Some(entry) = self.entries.iter_mut().find(|e| e.provider_id == provider_id) {
            entry.token = token;
            entry.healthy = true;
            entry.provided_at = now;
        } else {
            self.entries.push(PoolEntry {
                provider_id: provider_id.to_string(),
                token,
                healthy: true,
                provided_at: now,
                last_used: None,
            });
        }
    }

    /// Remove a provider's token.
    pub fn remove(&mut self, provider_id: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.provider_id != provider_id);
        self.entries.len() < before
    }

    /// Mark a provider's token as unhealthy.
    pub fn mark_unhealthy(&mut self, provider_id: &str) {
        if let Some(entry) = self.entries.iter_mut().find(|e| e.provider_id == provider_id) {
            entry.healthy = false;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn healthy_count(&self) -> usize {
        self.entries.iter().filter(|e| e.healthy && !e.token.is_expired()).count()
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
    /// Shared secret for hub provider API authentication.
    #[serde(default)]
    pub hub_secret: Option<String>,
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
            hub_secret: None,
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
    /// Hub token pool — multiple provider tokens for round-robin distribution.
    pub token_pool: Arc<Mutex<TokenPool>>,
    pub tunnel_process: Mutex<Option<std::process::Child>>,
    pub tunnel_url: Mutex<Option<String>>,
    pub db: Mutex<rusqlite::Connection>,
    pub config: Mutex<ProxyConfig>,
    pub telegram_config: Mutex<TelegramConfig>,
    pub telegram_handle: Mutex<Option<JoinHandle<()>>>,
    /// Provider agent — pushes local token to a remote hub periodically.
    pub provider_handle: Mutex<Option<JoinHandle<()>>>,
    pub provider_hub_url: Mutex<Option<String>>,
}
