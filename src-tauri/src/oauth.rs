use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::path::PathBuf;

use crate::state::TokenInfo;

const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";

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

/// Remove stale credentials from keychain and credentials file.
pub async fn clear_credentials() {
    let username = std::env::var("USER").unwrap_or_default();
    let _ = tokio::process::Command::new("security")
        .args(["delete-generic-password", "-a", &username, "-s", "Claude Code-credentials"])
        .output()
        .await;
    let _ = tokio::fs::remove_file(credentials_file_path()).await;
}

/// Refresh the OAuth access token using the refresh token
pub async fn refresh_token(refresh_token_value: &str) -> Result<TokenInfo> {
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token_value,
        "client_id": CLAUDE_CLIENT_ID,
    });

    let response = client
        .post(ANTHROPIC_TOKEN_URL)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&payload)
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
///
/// Strategy:
/// 1. If cached token is still valid → use it
/// 2. If cached token expired → try refresh
/// 3. If refresh fails → reload from disk (Claude Code CLI may have updated credentials)
/// 4. If reloaded token is expired → try refresh with the new refresh token
pub async fn get_valid_token(cached: Option<TokenInfo>) -> Result<TokenInfo> {
    if let Some(ref token) = cached {
        if !token.is_expired() {
            return Ok(token.clone());
        }
        // Token expired — try refresh
        match refresh_token(&token.refresh_token).await {
            Ok(refreshed) => return Ok(refreshed),
            Err(e) => {
                eprintln!("[ccproxypal] Token refresh failed, reloading from disk: {}", e);
                // Fall through to reload from disk
            }
        }
    }

    // Reload from disk — Claude Code CLI may have stored fresh credentials
    let disk_token = load_credentials().await?;

    // If the disk token has a different refresh token than what we tried, or we had no cache
    let already_tried = cached.as_ref().map(|c| c.refresh_token.as_str());
    let disk_is_different = already_tried.map_or(true, |tried| tried != disk_token.refresh_token);

    if !disk_token.is_expired() {
        return Ok(disk_token);
    }

    // Only attempt refresh with disk token if it's different from what we already tried
    if disk_is_different {
        return refresh_token(&disk_token.refresh_token).await;
    }

    Err(anyhow!(
        "OAuth token expired and refresh failed. Please run 'claude auth login' to re-authenticate."
    ))
}
