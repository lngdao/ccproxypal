import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const TOKEN_PATH = join(homedir(), '.config', 'ccproxypal', 'token');

let _cache = null;

/** Inject token into memory cache */
export function setManualToken(accessToken) {
  _cache = { accessToken, refreshToken: '', expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 };
}

/** Save token to disk (~/.config/ccproxypal/token) */
export function saveTokenToDisk(accessToken) {
  const dir = dirname(TOKEN_PATH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(TOKEN_PATH, accessToken.trim(), { mode: 0o600 });
}

/** Load token from disk */
function loadFromConfigFile() {
  try {
    const token = readFileSync(TOKEN_PATH, 'utf8').trim();
    if (!token) return null;
    return { accessToken: token, refreshToken: '', expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 };
  } catch {
    return null;
  }
}

/** Get token from cache → env → disk. Throws if none found. */
export async function getToken() {
  if (_cache) return _cache;

  const envToken = process.env.CCPROXYPAL_TOKEN;
  if (envToken) {
    _cache = { accessToken: envToken, refreshToken: '', expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 };
    return _cache;
  }

  const fileCreds = loadFromConfigFile();
  if (fileCreds) {
    _cache = fileCreds;
    return _cache;
  }

  throw new Error('No setup token found. Run: ccproxypal save-token <token>');
}

export function clearTokenCache() {
  _cache = null;
}
