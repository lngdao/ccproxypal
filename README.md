# ccproxypal

A desktop app (Tauri + React) and CLI tool that routes AI API requests through your Claude Code OAuth subscription — use Claude for free before falling back to a paid API key.

## Features

- **Proxy Server** — Local HTTP proxy compatible with both Anthropic and OpenAI API formats
- **Claude OAuth** — Automatically loads and refreshes Claude Code credentials from Keychain or `~/.claude/.credentials.json`
- **Cloudflare Tunnel** — Expose your local proxy via a public HTTPS URL with one click
- **Telegram Bot** — Control and monitor the proxy remotely via Telegram
- **Analytics** — Track request history, token usage, and estimated savings
- **Spending Limits** — Set hourly/daily/weekly/monthly budget caps for API key fallback

## Desktop App

### Requirements

- [Rust](https://www.rust-lang.org/tools/install)
- [Node.js](https://nodejs.org/) >= 18
- [Bun](https://bun.sh/) (recommended) or npm

### Installation (macOS)

Download the latest `.dmg` from [Releases](https://github.com/longdao/ccproxypal/releases), drag the app to `/Applications`, then remove the quarantine flag before opening:

```bash
sudo xattr -rd com.apple.quarantine /Applications/ccproxypal.app
```

This is required because the app is not notarized by Apple.

### Development

```bash
bun install
bun tauri dev
```

### Build

```bash
bun tauri build
```

## CLI (npm package)

The `npm-pkg/` directory contains a standalone CLI that can be published to npm and used without the desktop app.

### Install & use

```bash
# Print Claude OAuth tokens
npx ccproxypal token

# Start proxy server (default port 8082)
npx ccproxypal serve

# Start proxy + Cloudflare tunnel
npx ccproxypal serve --tunnel

# Custom port
npx ccproxypal serve --port 9000 --tunnel
```

### Prerequisites

```bash
# Authenticate with Claude CLI first
claude auth login

# For tunnel support
brew install cloudflared
```

### Proxy Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions (auto-converted) |
| `GET`  | `/v1/models` | Live model list from Anthropic |
| `GET`  | `/health` | Health check + token status |

### Client Setup

```bash
export ANTHROPIC_BASE_URL=http://localhost:8082
export ANTHROPIC_AUTH_TOKEN=any-dummy-key
```

## How it works

1. Loads Claude Code OAuth credentials
2. Injects the required Claude Code beta headers to access the Anthropic API via OAuth
3. Auto-refreshes the token before expiry (5-minute buffer)
4. On rate limit (429) or auth failure, falls back to a configured Anthropic API key
5. Streams responses in both Anthropic and OpenAI SSE formats

## Tech Stack

| Layer | Tech |
|-------|------|
| Desktop | Tauri v2, React, TypeScript |
| Backend | Rust, Axum, Tokio |
| CLI | Node.js (ESM, zero dependencies) |
| Database | SQLite (analytics) |
| Tunnel | cloudflared |
