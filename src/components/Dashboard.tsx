import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, AppStatus, TelegramStatus } from "../lib/invoke";

function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        backgroundColor: active ? "#22c55e" : "#ef4444",
        marginRight: 8,
        boxShadow: active ? "0 0 6px #22c55e88" : "none",
      }}
    />
  );
}

function formatExpiry(expiresAt: number | null): string {
  if (!expiresAt) return "Unknown";
  const diff = expiresAt - Date.now();
  if (diff <= 0) return "Expired";
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export default function Dashboard() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [cloudflaredAvailable, setCloudflaredAvailable] = useState(true);
  const [copied, setCopied] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const [s, tg] = await Promise.all([api.getStatus(), api.getTelegramStatus()]);
      setStatus(s);
      setTelegramStatus(tg);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    api.isCloudflaredAvailable().then(setCloudflaredAvailable);

    // Poll every 5 seconds
    const interval = setInterval(fetchStatus, 5000);

    // Listen for tunnel URL events
    const unlisten = listen<string>("tunnel-url", (event) => {
      setStatus((prev) =>
        prev ? { ...prev, tunnel_url: event.payload, tunnel_running: true } : prev
      );
    });

    return () => {
      clearInterval(interval);
      unlisten.then((fn) => fn());
    };
  }, [fetchStatus]);

  const withLoading = async (key: string, fn: () => Promise<void>) => {
    setLoading((l) => ({ ...l, [key]: true }));
    setError(null);
    try {
      await fn();
      await fetchStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading((l) => ({ ...l, [key]: false }));
    }
  };

  const toggleProxy = () =>
    withLoading("proxy", async () => {
      if (status?.proxy_running) {
        await api.stopProxy();
      } else {
        await api.startProxy();
      }
    });

  const toggleTunnel = () =>
    withLoading("tunnel", async () => {
      if (status?.tunnel_running) {
        await api.stopTunnel();
      } else {
        await api.startTunnel();
      }
    });

  const toggleTelegram = () =>
    withLoading("telegram", async () => {
      if (status?.telegram_running) {
        await api.stopTelegramBot();
      } else {
        await api.startTelegramBot();
      }
    });

  const refreshToken = () =>
    withLoading("token", async () => {
      await api.refreshToken();
    });

  const copyUrl = () => {
    if (status?.tunnel_url) {
      navigator.clipboard.writeText(status.tunnel_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!status) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="dashboard">
      {error && <div className="error-banner">{error}</div>}

      {/* Proxy Server Card */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <StatusDot active={status.proxy_running} />
            Proxy Server
          </div>
          <button
            className={`btn ${status.proxy_running ? "btn-danger" : "btn-primary"}`}
            onClick={toggleProxy}
            disabled={loading.proxy}
          >
            {loading.proxy ? "..." : status.proxy_running ? "Stop" : "Start"}
          </button>
        </div>
        <div className="card-body">
          <div className="info-row">
            <span className="label">Status</span>
            <span className={`value ${status.proxy_running ? "text-green" : "text-muted"}`}>
              {status.proxy_running ? "Running" : "Stopped"}
            </span>
          </div>
          <div className="info-row">
            <span className="label">Port</span>
            <span className="value mono">{status.proxy_port}</span>
          </div>
          {status.proxy_running && (
            <div className="info-row">
              <span className="label">Endpoint</span>
              <span className="value mono text-green">http://localhost:{status.proxy_port}</span>
            </div>
          )}
        </div>
      </div>

      {/* OAuth Token Card */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <StatusDot active={status.token_valid} />
            Claude OAuth Token
          </div>
          <button
            className="btn btn-secondary"
            onClick={refreshToken}
            disabled={loading.token}
          >
            {loading.token ? "..." : "Refresh"}
          </button>
        </div>
        <div className="card-body">
          <div className="info-row">
            <span className="label">Status</span>
            <span className={`value ${status.token_valid ? "text-green" : "text-red"}`}>
              {status.token_valid ? "Valid" : "Invalid / Expired"}
            </span>
          </div>
          {status.token_expires_at && (
            <div className="info-row">
              <span className="label">Expires in</span>
              <span className={`value ${status.token_valid ? "" : "text-red"}`}>
                {formatExpiry(status.token_expires_at)}
              </span>
            </div>
          )}
          {!status.token_valid && (
            <div className="hint">
              Run <code>claude /login</code> in your terminal to authenticate.
            </div>
          )}
        </div>
      </div>

      {/* Cloudflare Tunnel Card */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <StatusDot active={status.tunnel_running} />
            Cloudflare Tunnel
          </div>
          <button
            className={`btn ${status.tunnel_running ? "btn-danger" : "btn-primary"}`}
            onClick={toggleTunnel}
            disabled={loading.tunnel || !cloudflaredAvailable}
            title={!cloudflaredAvailable ? "cloudflared not installed" : ""}
          >
            {loading.tunnel ? "..." : status.tunnel_running ? "Stop" : "Start"}
          </button>
        </div>
        <div className="card-body">
          {!cloudflaredAvailable && (
            <div className="hint warning">
              cloudflared not found. Install with: <code>brew install cloudflared</code>
            </div>
          )}
          <div className="info-row">
            <span className="label">Status</span>
            <span className={`value ${status.tunnel_running ? "text-green" : "text-muted"}`}>
              {status.tunnel_running
                ? status.tunnel_url
                  ? "Active"
                  : "Starting..."
                : "Stopped"}
            </span>
          </div>
          {status.tunnel_url && (
            <div className="info-row">
              <span className="label">Public URL</span>
              <div className="url-row">
                <span className="value mono text-green tunnel-url">{status.tunnel_url}</span>
                <button className="btn btn-small btn-secondary" onClick={copyUrl}>
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
          )}
          {status.tunnel_url && (
            <div className="hint">
              Set <code>ANTHROPIC_BASE_URL={status.tunnel_url}</code> in your client's environment.
            </div>
          )}
        </div>
      </div>

      {/* Telegram Bot Card */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <StatusDot active={!!status.telegram_running} />
            Telegram Bot
          </div>
          <button
            className={`btn ${status.telegram_running ? "btn-danger" : "btn-primary"}`}
            onClick={toggleTelegram}
            disabled={loading.telegram || !telegramStatus?.bot_token_set}
            title={!telegramStatus?.bot_token_set ? "Configure bot token in Settings → Telegram" : ""}
          >
            {loading.telegram ? "..." : status.telegram_running ? "Stop" : "Start"}
          </button>
        </div>
        <div className="card-body">
          {!telegramStatus?.bot_token_set && (
            <div className="hint warning">
              No bot token configured. Go to Settings → Telegram to set it up.
            </div>
          )}
          <div className="info-row">
            <span className="label">Status</span>
            <span className={`value ${status.telegram_running ? "text-green" : "text-muted"}`}>
              {status.telegram_running ? "Running" : "Stopped"}
            </span>
          </div>
          {telegramStatus && telegramStatus.allowed_users_count > 0 && (
            <div className="info-row">
              <span className="label">Allowed users</span>
              <span className="value">{telegramStatus.allowed_users_count}</span>
            </div>
          )}
          {telegramStatus?.bot_token_set && !status.telegram_running && (
            <div className="hint">
              Users can message your bot with <code>/token</code> to get connection info,
              <code>/refresh</code> to force token refresh.
            </div>
          )}
        </div>
      </div>

      {/* Quick Start */}
      {status.proxy_running && (
        <div className="card card-flat">
          <div className="card-title" style={{ marginBottom: 10 }}>Client Setup</div>
          <p className="hint">Set these environment variables in your client (e.g. <code>~/.zshenv</code>):</p>
          <pre className="code-block">
{`export ANTHROPIC_BASE_URL=${status.tunnel_url || `http://localhost:${status.proxy_port}`}
export ANTHROPIC_AUTH_TOKEN=any-dummy-key`}
          </pre>
        </div>
      )}
    </div>
  );
}
