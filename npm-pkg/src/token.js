import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

let _cache = null;

/** Inject tokens manually (client mode — no local credentials needed) */
export function setManualToken(accessToken, refreshToken) {
  // 55 min — lets the 5-min buffer trigger a refresh before actual expiry
  _cache = { accessToken, refreshToken, expiresAt: Date.now() + 55 * 60 * 1000 };
}

function loadFromKeychain() {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-a', process.env.USER ?? '', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadFromFile() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
  } catch {
    return null;
  }
}

function loadCredentials() {
  const creds = loadFromKeychain() ?? loadFromFile();
  if (!creds?.claudeAiOauth) {
    throw new Error('No Claude credentials found. Run `claude auth login` first.');
  }
  const { accessToken, refreshToken, expiresAt } = creds.claudeAiOauth;
  return { accessToken, refreshToken, expiresAt };
}

function isExpired(expiresAt) {
  return Date.now() >= expiresAt - EXPIRY_BUFFER_MS;
}

async function doRefresh(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const preview = text.length > 200 ? text.slice(0, 200) : text;
    throw new Error(`Token refresh failed (${res.status}): ${preview}`);
  }
  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function getToken() {
  if (_cache && !isExpired(_cache.expiresAt)) return _cache;

  // Try refresh cached token first
  if (_cache && isExpired(_cache.expiresAt)) {
    try {
      const refreshed = await doRefresh(_cache.refreshToken);
      _cache = refreshed;
      return { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken };
    } catch {
      // Refresh failed — fall through to reload from disk
    }
  }

  // Reload from disk (Claude Code CLI may have updated credentials)
  let creds = loadCredentials();
  if (isExpired(creds.expiresAt)) {
    creds = await doRefresh(creds.refreshToken);
  }
  _cache = creds;
  return { accessToken: creds.accessToken, refreshToken: creds.refreshToken };
}

export function clearTokenCache() {
  _cache = null;
}
