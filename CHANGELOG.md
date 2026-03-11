# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

#### Proxy Compatibility (synced with Claude CLI v2.1.72)
- **User-Agent rotation** — Bumped from `2.1.66–2.1.70` to `2.1.68–2.1.72` to match current Claude CLI version
- **Model normalize** — Generalized Cursor-style regex to handle any version (`4.5`, `4.6`, future `5.0+`) instead of hardcoded `4.5`; added `max` effort level (Opus 4.6)
- **Static model list** — Added `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-opus-4-0` to fallback `/v1/models` response
- **Cost estimate** — Granular per-model pricing: separate matches for `opus-4-6`, `opus-4-5/4-1/4-0`, `sonnet-4-6` instead of broad `contains("opus")`
- **Body preparation** — `output_config` and `thinking` fields always passthrough (standard API fields); `context_management` only stripped when `strip_unsupported_fields` is enabled

## [0.3.0] - 2026-03-07

### Added

#### CLI Hub Mode & Anti-Ban
- **`save-token` command** — `ccproxypal save-token <token>` saves setup token to `~/.config/ccproxypal/token` (shared between app and CLI)
- **`host` command** — One-command hub hosting: starts proxy + Cloudflare tunnel + token pool; prints pool status every 30s; prints `ccproxypal provide` command for contributors
- **Hub endpoints in CLI** — `/hub/provide`, `/hub/status`, `/hub/revoke` with optional secret authentication; `serve --secret <s>` enables hub mode
- **Token pool (CLI)** — `TokenPool` class mirroring Rust app: round-robin distribution, health tracking, exponential backoff (30s → 5m cap), stale entry pruning
- **Anti-ban system (CLI)** — Header spoofing (Claude Code version rotation 2.1.66–2.1.70, platform variation), tool injection (8 Claude Code tools), system prompt rewrite with `cache_control`, force streaming, strip unsupported fields (`reasoning_budget`, `context_management`), beta flag merging — no timing delays
- **Circuit breaker (CLI)** — 3 consecutive errors trips the breaker; escalating cooldowns (1–5 min, then 30 min after 5 trips); auto-recovery on success
- **Ban detection (CLI)** — Analyzes upstream responses for auth rejection (401/403), rate limiting (429), overload (529), and abuse keywords
- **SSE-to-JSON reassembly (CLI)** — Collects forced-streaming SSE events back into a complete message JSON for non-streaming clients

#### Pool Staleness System
- **DNS pre-check** — Provider push validates hub URL via `tokio::net::lookup_host` before first request; clear error on DNS failure
- **Stale badge in Pool UI** — Unhealthy entries that haven't pushed in 10+ minutes show "Stale" status badge

### Changed
- **Pool staleness logic** — Healthy entries are never pruned regardless of age; only unhealthy entries are checked for staleness (10 min skip threshold, 30 min prune threshold)
- **CLI `provide` interval** — Default push interval changed from 300s to 120s; faster retry (30s) when unhealthy
- **CLI token loading** — Unified 3-source chain: memory cache → `CCPROXYPAL_TOKEN` env var → `~/.config/ccproxypal/token` file
- **CLI pool-aware routing** — `callAnthropic()` tries pool token first, then local token, with fallback chain on 401

### Fixed
- **"Host to Pool" Stop button disabled** — Stop button was incorrectly disabled when providing because it checked `!hubUrl || !token_valid`; now only applies disabled state when not already providing
- **Pool ghost entries** — Disconnected providers no longer persist forever; unhealthy entries pruned after 30 min of no push

## [0.2.0] - 2026-03-06

### Added

#### UI/UX Rework & Tailwind Migration
- **Tailwind CSS v4** — Migrated from 853 lines of vanilla CSS (`App.css`) to Tailwind utility classes via `@tailwindcss/vite` plugin; new `index.css` with CSS custom properties for theme tokens (`--color-bg`, `--color-accent`, etc.)
- **Shared UI component library** (`src/components/ui/`)
  - `Button` — Variant-based (primary/danger/secondary/ghost) with loading spinner overlay that preserves button width
  - `Card`, `CardHeader`, `CardTitle` — Base card component
  - `StepCard` — Numbered step card with completed (green checkmark) and disabled states
  - `StatusDot`, `StatusBadge` — Pulsing green/red dot indicator with label
  - `InfoRow` — Label-value row for status display
  - `Input`, `TextArea` — Styled form inputs with label/hint support
  - `SegmentedControl` — Generic segmented toggle replacing all tab-nav/mode-switch patterns
  - `Toast` — Bottom-right auto-dismiss toast system with Zustand store (success/error/info types)
- **Sidebar icon rail** (`App.tsx`) — 48px sidebar with icon navigation (Proxy, Analytics, Settings), resizable log panel with drag handle, log toggle with unread badge
- **ProxyPanel** (`src/components/ProxyPanel.tsx`) — Unified panel replacing `Dashboard.tsx` + `ClientPanel.tsx` with 3-mode `SegmentedControl`:
  - **Solo**: Step 1 (OAuth + Proxy) with token copy buttons + Step 2 (Configure Dev Tools)
  - **Hub Host**: Steps 1-4 (Proxy, Tunnel, Token Pool, Telegram Bot)
  - **Hub Consumer**: Step 1 (Connect to Hub) + Step 2 (Configure Dev Tools)
- **OAuth Refresh button** — "Refresh" button next to Copy Access Token / Copy Refresh Token; calls Anthropic's `/v1/oauth/token` endpoint to force-refresh the access token
- **`reload_token` Tauri command** — Force-refreshes OAuth token via API; preserves original `expires_at` when Anthropic returns the same access token (prevents inflated expiry display)

#### Telegram Bot Remote Control
- New commands: `/start_proxy`, `/stop_proxy`, `/tunnel`, `/pool`, `/usage`
- Push notifications via `send_notification()` public function
- `app_handle: Option<tauri::AppHandle>` added to `BotContext`

#### Native OS Notifications
- `tauri-plugin-notification` integration for desktop push notifications
- `notify_telegram()`, `notify_os()`, `notify_all()` helper functions in `commands.rs`

### Changed
- **AnalyticsPanel** — Rewritten with Tailwind; `SegmentedControl` for period selection; 2x4 stat cards with colored borders; 2-step button confirmation for reset (replaces `confirm()` dialog)
- **SettingsPanel** — Rewritten with Tailwind; 4 card sections + collapsible Telegram integrations; sticky save button with backdrop blur
- **LogPanel** — Rewritten with Tailwind; log level filter buttons (INFO/WARN/ERROR/DEBUG); source filter dropdown; auto-scroll toggle; accepts `height` prop for resizable panel
- **Status bar** — Simplified to version display only (removed duplicate log button since sidebar has log icon)
- **OpenCode config format** — Fixed path from `config.json` to `opencode.json`; uses `provider.anthropic.options.baseURL` format (was incorrectly using Claude Code's `env.ANTHROPIC_BASE_URL`)
- **Error banner** — Auto-dismisses after 8 seconds; `withLoading` calls `fetchStatus()` in `finally` block so UI always updates after errors

### Fixed
- **Rust Send trait errors** — 5 instances of `MutexGuard` held across `.await` in telegram.rs; fixed by scoping all mutex operations in blocks that drop the guard before async calls
- **OAuth expiry display inflation** — `reload_token` now preserves original `expires_at` when Anthropic returns the same access token (refresh endpoint returns full TTL, not remaining time)
- **Analytics reset not clearing UI** — Added `setSummary(null)` before reload; replaced `confirm()` with 2-step button (Tauri webview `confirm()` unreliable)
- **Token refresh failure leaves stale state** — On refresh failure: clears token cache, clears keychain entry (`security delete-generic-password`), deletes `~/.claude/.credentials.json`; stops proxy server; UI shows "claude auth login" hint
- **`fetchStatus` not called after errors** — Moved from `try` to `finally` in `withLoading`, ensuring UI updates after proxy stop on token failure

### Removed
- `src/App.css` — Replaced by `src/index.css` (Tailwind)
- `src/components/Dashboard.tsx` — Merged into `ProxyPanel.tsx`
- `src/components/ClientPanel.tsx` — Merged into `ProxyPanel.tsx`

## [0.1.5] - 2026-03-06

### Added
- **Status bar** — Bottom status bar with log panel toggle (left) and app name/version (right)
- **Log panel** — Realtime log overlay showing timestamped, color-coded entries from all backend services (proxy, OAuth, tunnel, telegram); auto-scroll, clear, and close controls
- **Log system** — Zustand-based `logStore` with `app-log` Tauri event bridge; backend `eprintln!` replaced with `app.emit("app-log", ...)` throughout proxy, OAuth, and command layers

### Fixed
- **Port bind failure silent success** — `start_proxy` now waits for TCP bind result via oneshot channel before returning; returns actual error (e.g. "address already in use") instead of false success
- **Backend logs not visible** — All `eprintln!` in proxy/OAuth code replaced with Tauri event emissions; 429/401/403 errors, token refresh status, and network errors now appear in the log panel
- **Token cache nulled on refresh failure** — Removed `*token_cache = None` on 401 refresh failure that caused cascading "No API key available" errors for all subsequent requests
- **Concurrent refresh token race** — Multiple simultaneous requests no longer all attempt to refresh with the same rotating refresh_token; checks if cache was already updated by a concurrent request before refreshing
- **Manual token fake expiry** — `set_token_manually` now decodes the JWT `exp` claim for real expiry instead of hardcoding `now + 55 min`
- **OAuth error message** — When OAuth fails (e.g. 403 "not allowed for this organization") and no API key is configured, the error now includes the actual Anthropic error body instead of generic "No API key available"
- **OAuth error body truncation** — Removed 200-char limit on refresh token error body; full error is now logged and propagated

### Changed
- **Tab rendering** — All tabs are now always mounted (CSS `display` toggle) instead of conditional rendering, ensuring realtime updates across inactive tabs
- **Default settings** — `strip_unsupported_fields` now defaults to `true`

## [0.1.4] - 2026-03-06

### Fixed
- **CLI (npm-pkg) Cursor compatibility** — Aligned with desktop app: skip user messages with empty content; filter tools with null/empty names (Cursor placeholders); strip `context_management` and invalid tools from request body; 401 retry with token refresh
- **CLI manual token** — TTL set to 55 minutes (same as app) so refresh triggers before expiry

### Changed
- **Client tab** — Removed green notification message when copying Cursor API Base URL

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
