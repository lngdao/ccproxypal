# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-03-05

### Added

#### Desktop App (Tauri)
- **Proxy Server** — Local HTTP proxy on configurable port (default 8082) supporting both Anthropic and OpenAI API formats
- **Claude OAuth** — Automatic credential loading from macOS Keychain or `~/.claude/.credentials.json` with auto-refresh
- **Dashboard tab** — Single-card view combining proxy server status and Claude OAuth state; copy Access Token / Refresh Token buttons
- **Client tab** — Start proxy using externally provided tokens (no local credentials required); configure Claude Code, OpenCode, and Cursor to use the proxy
- **Tool configuration** — Write/remove `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` and `~/.config/opencode/config.json`
- **Analytics tab** — Request history, token usage, cost tracking, and estimated savings by period
- **Settings tab** — Proxy port, API keys (Anthropic/OpenAI fallback), spending limits, IP allowlist, Telegram bot
- **Cloudflare Tunnel** — One-click public HTTPS URL via `cloudflared`
- **Telegram Bot** — Remote status/token control via Telegram
- **Animated UI** — Tab blur-fade transitions using framer-motion; pulsing status dots

#### npm Package (`ccproxypal`)
- `npx ccproxypal token` — Print Claude OAuth tokens as JSON (auto-refresh if expired)
- `npx ccproxypal serve` — Start proxy server (host mode, uses local credentials)
- `npx ccproxypal serve --access-token ... --refresh-token ...` — Client mode with provided tokens
- `npx ccproxypal serve --tunnel` — Start proxy + Cloudflare tunnel
- `npx ccproxypal serve --port <port>` — Custom port
- `npx ccproxypal configure <tool>` — Write proxy URL to tool config file
- `npx ccproxypal configure <tool> --url <url>` — Configure with custom URL
- `npx ccproxypal configure remove <tool>` — Remove proxy config from tool
- Supported tools: `claude-code`, `opencode`
- Zero runtime dependencies (Node.js 18+ built-ins + native fetch)
