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
        // COMMENTED OUT: Setup tokens (~1 year) don't need expiry checks
        // let buffer_ms = 5 * 60 * 1000; // 5 minute buffer
        // chrono::Utc::now().timestamp_millis() >= self.expires_at - buffer_ms
        false
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
    /// When this entry was last marked unhealthy (Unix ms). Used for retry backoff.
    #[serde(default)]
    pub unhealthy_since: Option<i64>,
    /// Consecutive retry failures while unhealthy. Controls exponential backoff.
    #[serde(default)]
    pub retry_count: u32,
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
    /// Exponential backoff for unhealthy retry: 30s, 1m, 2m, 4m, cap 5m.
    fn retry_cooldown_ms(retry_count: u32) -> i64 {
        let base: i64 = 30_000; // 30 seconds
        let max: i64 = 5 * 60 * 1000; // 5 minutes
        (base << retry_count.min(10)).min(max)
    }

    /// Provider staleness TTL: if an unhealthy provider hasn't pushed in 10 minutes,
    /// consider it abandoned and prune. Healthy providers are never pruned — their
    /// token still works regardless of push frequency.
    const UNHEALTHY_STALE_TTL_MS: i64 = 10 * 60 * 1000;

    /// Pick the next eligible, non-expired token via round-robin.
    /// Healthy tokens are always eligible. Unhealthy tokens become eligible
    /// after an exponential backoff (30s → 1m → 2m → 4m → cap 5m),
    /// but only if the provider is still actively pushing (not stale).
    pub fn next_token(&mut self) -> Option<(String, TokenInfo)> {
        let now = chrono::Utc::now().timestamp_millis();
        let eligible: Vec<usize> = self.entries.iter().enumerate()
            .filter(|(_, e)| {
                if e.token.is_expired() { return false; }
                if e.healthy { return true; }
                // Unhealthy + stale (no push in 10 min) → skip entirely
                if now - e.provided_at > Self::UNHEALTHY_STALE_TTL_MS { return false; }
                // Unhealthy but provider still active → eligible after backoff
                e.unhealthy_since
                    .map(|since| now - since >= Self::retry_cooldown_ms(e.retry_count))
                    .unwrap_or(false)
            })
            .map(|(i, _)| i)
            .collect();
        if eligible.is_empty() { return None; }

        let idx = self.next_index % eligible.len();
        self.next_index = self.next_index.wrapping_add(1);
        let entry = &mut self.entries[eligible[idx]];
        entry.last_used = Some(now);
        Some((entry.provider_id.clone(), entry.token.clone()))
    }

    /// Add or update a provider's token.
    /// Does NOT reset healthy status — only consumer success (mark_healthy) can restore health.
    /// But when an unhealthy provider pushes a new token, resets backoff so it gets
    /// retried sooner (provider self-reporting "I'm still active").
    pub fn upsert(&mut self, provider_id: &str, token: TokenInfo) {
        let now = chrono::Utc::now().timestamp_millis();
        if let Some(entry) = self.entries.iter_mut().find(|e| e.provider_id == provider_id) {
            let token_changed = entry.token.access_token != token.access_token;
            entry.token = token;
            entry.provided_at = now;
            // Don't touch entry.healthy — only mark_healthy can restore it.
            // But if unhealthy and provider pushed a new token, reset backoff
            // so consumer retries sooner (30s instead of waiting full backoff).
            if !entry.healthy && token_changed {
                entry.retry_count = 0;
                entry.unhealthy_since = Some(now);
            }
        } else {
            self.entries.push(PoolEntry {
                provider_id: provider_id.to_string(),
                token,
                healthy: true,
                provided_at: now,
                last_used: None,
                unhealthy_since: None,
                retry_count: 0,
            });
        }
    }

    /// Remove a provider's token.
    pub fn remove(&mut self, provider_id: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.provider_id != provider_id);
        self.entries.len() < before
    }

    /// Mark a provider's token as unhealthy. Returns true if this is a transition (was healthy).
    /// On repeated failures, increments retry_count for exponential backoff.
    pub fn mark_unhealthy(&mut self, provider_id: &str) -> bool {
        let now = chrono::Utc::now().timestamp_millis();
        if let Some(entry) = self.entries.iter_mut().find(|e| e.provider_id == provider_id) {
            entry.unhealthy_since = Some(now);
            if entry.healthy {
                entry.healthy = false;
                entry.retry_count = 0;
                return true; // transition: healthy → unhealthy
            } else {
                // Already unhealthy — bump retry count for longer backoff
                entry.retry_count = entry.retry_count.saturating_add(1);
            }
        }
        false
    }

    /// Mark a provider's token as healthy (after consumer success). Returns true if this is a transition (was unhealthy).
    pub fn mark_healthy(&mut self, provider_id: &str) -> bool {
        if let Some(entry) = self.entries.iter_mut().find(|e| e.provider_id == provider_id) {
            entry.unhealthy_since = None;
            entry.retry_count = 0;
            if !entry.healthy {
                entry.healthy = true;
                return true; // transition: unhealthy → healthy
            }
        }
        false
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn healthy_count(&self) -> usize {
        self.entries.iter().filter(|e| {
            e.healthy && !e.token.is_expired()
        }).count()
    }

    /// Remove entries that are unhealthy AND haven't pushed in 30 minutes.
    /// Healthy entries are never pruned — their token still works.
    pub fn prune_stale(&mut self) {
        let now = chrono::Utc::now().timestamp_millis();
        let ttl = 30 * 60 * 1000_i64;
        self.entries.retain(|e| e.healthy || now - e.provided_at <= ttl);
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
    /// Whether the last provider push succeeded.
    pub provider_healthy: Arc<Mutex<bool>>,
}
