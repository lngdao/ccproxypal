use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::path::PathBuf;

use crate::state::TokenInfo;

const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL: &str = "https://console.anthropic.com/oauth/token";

#[derive(Debug, Deserialize)]
struct ClaudeAiOauth {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: String,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct ClaudeCredentials {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: ClaudeAiOauth,
}

#[derive(Debug, Deserialize)]
struct TokenRefreshResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
}

fn credentials_file_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("~"));
    home.join(".claude").join(".credentials.json")
}

/// Read credentials from macOS Keychain via `security` CLI
async fn load_from_keychain() -> Result<ClaudeCredentials> {
    let username = std::env::var("USER").unwrap_or_default();
    let output = tokio::process::Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            &username,
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .await?;

    if !output.status.success() {
        return Err(anyhow!("Keychain lookup failed"));
    }

    let json = String::from_utf8(output.stdout)?.trim().to_string();
    if json.is_empty() {
        return Err(anyhow!("Empty keychain result"));
    }

    let creds: ClaudeCredentials = serde_json::from_str(&json)?;
    Ok(creds)
}

/// Read credentials from ~/.claude/.credentials.json
async fn load_from_file() -> Result<ClaudeCredentials> {
    let path = credentials_file_path();
    let content = tokio::fs::read_to_string(&path).await?;
    let creds: ClaudeCredentials = serde_json::from_str(&content)?;
    Ok(creds)
}

/// Load credentials from Keychain (preferred) or file fallback
pub async fn load_credentials() -> Result<TokenInfo> {
    let creds = match load_from_keychain().await {
        Ok(c) => c,
        Err(_) => load_from_file()
            .await
            .map_err(|_| anyhow!("No Claude credentials found. Please run 'claude auth login' first."))?,
    };

    Ok(TokenInfo {
        access_token: creds.claude_ai_oauth.access_token,
        refresh_token: creds.claude_ai_oauth.refresh_token,
        expires_at: creds.claude_ai_oauth.expires_at,
    })
}

/// Refresh the OAuth access token using the refresh token
pub async fn refresh_token(refresh_token_value: &str) -> Result<TokenInfo> {
    let client = reqwest::Client::new();
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token_value),
        ("client_id", CLAUDE_CLIENT_ID),
    ];

    let response = client
        .post(ANTHROPIC_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&params)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("Token refresh failed ({}): {}", status, body));
    }

    let data: TokenRefreshResponse = response.json().await?;
    let expires_at = chrono::Utc::now().timestamp_millis() + data.expires_in * 1000;

    Ok(TokenInfo {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at,
    })
}

/// Get a valid (non-expired) token, refreshing if needed.
/// Takes optional cached token, returns updated token.
pub async fn get_valid_token(cached: Option<TokenInfo>) -> Result<TokenInfo> {
    if let Some(token) = cached {
        if !token.is_expired() {
            return Ok(token);
        }
        // Token expired — refresh
        return refresh_token(&token.refresh_token.clone()).await;
    }

    // No cached token — load from disk
    let token = load_credentials().await?;
    if token.is_expired() {
        return refresh_token(&token.refresh_token.clone()).await;
    }
    Ok(token)
}
