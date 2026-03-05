# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-03-06

### Fixed
- **Cloudflare Tunnel on macOS app build** — GUI apps launch without Homebrew in PATH; now uses `which`/`where` first, then checks known install paths (`/opt/homebrew/bin`, `/usr/local/bin`, `/snap/bin`, Windows `Program Files`) before failing
- **Windows tunnel** — Added `CREATE_NO_WINDOW` flag to prevent console window flashing when spawning `cloudflared`
- **Windows error message** — Shows download link instead of `brew install` on Windows

## [0.1.2] - 2026-03-05

### Fixed
- **Client mode 401 retry** — When Anthropic rejects an expired access_token with 401, the proxy now automatically refreshes using the refresh_token and retries the request instead of falling back to API key
- **OAuth refresh endpoint** — Fixed token refresh URL to `https://console.anthropic.com/oauth/token` with correct `application/x-www-form-urlencoded` format
- **`context_management` field** — Added "Strip unsupported fields" setting to remove Claude Code-internal fields (e.g. `context_management`) rejected by the Anthropic OAuth API; fixes "No API key available and Claude Code OAuth failed" errors when using the proxy locally

### Changed
- **Client tab** — Removed checkmark indicator and "configured successfully" notice after tool configuration
- **Settings tab** — "Save Settings" button now has fixed min-width to prevent layout shift on state change; removed stray hint text next to button; improved hint text for "Strip unsupported fields" option

## [0.1.1] - 2026-03-05

### Fixed
- **Analytics streaming tokens** — Token usage (input/output) was recorded as 0 for streaming requests; now correctly parsed from SSE `message_start`/`message_delta` events
- **Linux ARM64 CI** — Switched `reqwest` from `native-tls` to `rustls-tls` to fix `openssl-sys` cross-compilation failure
- **macOS x86_64 CI** — Replaced deprecated `macos-13` runner with `macos-latest` (cross-compiles to `x86_64-apple-darwin`)

### Changed
- **UI overhaul** — Dashboard, Client, and Settings tabs redesigned with consistent card layout, improved typography and spacing
- **Tab transitions** — Replaced horizontal slide with blur-fade animation; removed staggered card entrance animations
- **App header** — Centered tab navigation, solid background, white separator; removed redundant app title from custom header
- **Settings tab** — Sticky "Save Settings" button at bottom; improved section hierarchy, labels, and hints; styled bot command badges
- **Analytics tab** — Recent requests table now paginated (20 per page) instead of showing all records
- **Dashboard tab** — Removed "Client Setup" section; refined OAuth hint message
- **macOS scroll** — Disabled rubber-band bounce via CSS `overscroll-behavior: none`; hidden scrollbars on all scrollable areas

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
