# ccproxypal

Local proxy server that routes AI API requests through your Claude Code OAuth subscription.

Zero dependencies. Node.js 18+ only.

## Commands

### `token` — Print OAuth tokens

```bash
npx ccproxypal token
```

Output:
```json
{ "accessToken": "sk-ant-oau01-...", "refreshToken": "..." }
```

---

### `serve` — Start the proxy server

**Host mode** (uses local Claude credentials):
```bash
npx ccproxypal serve
npx ccproxypal serve --tunnel          # + Cloudflare public URL
npx ccproxypal serve --port 9000
```

**Client mode** (tokens provided externally — no local credentials needed):
```bash
npx ccproxypal serve \
  --access-token sk-ant-oau01-... \
  --refresh-token ...
```

With tunnel:
```bash
npx ccproxypal serve \
  --access-token sk-ant-... \
  --refresh-token ... \
  --tunnel
```

---

### `configure` — Configure tools to use the proxy

```bash
# List available tools
npx ccproxypal configure

# Configure (writes ANTHROPIC_BASE_URL to tool's config file)
npx ccproxypal configure claude-code
npx ccproxypal configure opencode

# Custom URL (e.g. tunnel)
npx ccproxypal configure claude-code --url https://xxxx.trycloudflare.com

# Custom port
npx ccproxypal configure claude-code --port 9000

# Remove config
npx ccproxypal configure remove claude-code
npx ccproxypal configure remove opencode
```

**Supported tools:**

| Tool | Config file |
|------|-------------|
| `claude-code` | `~/.claude/settings.json` |
| `opencode` | `~/.config/opencode/config.json` |

For **Cursor**: copy the proxy URL and paste into *Settings → Models → API Base URL*.

---

## Proxy Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions (auto-converted) |
| `GET`  | `/v1/models` | Live model list from Anthropic |
| `GET`  | `/health` | Health + token status |

## Prerequisites

```bash
# Host mode: authenticate with Claude CLI
claude auth login

# Tunnel support
brew install cloudflared
```

## Publish

```bash
cd npm-pkg
npm login
npm publish
```
