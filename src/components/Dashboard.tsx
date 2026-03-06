import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, AppStatus, TelegramStatus, TokenDetails } from "../lib/invoke";
import { log } from "../lib/logStore";

function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      className={active ? "status-dot-active" : ""}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        backgroundColor: active ? "#22c55e" : "#ef4444",
        marginRight: 7,
        flexShrink: 0,
      }}
    />
  );
}

function StatusBadge({ active, label }: { active: boolean; label: string }) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      fontSize: 12,
      fontWeight: 500,
      color: active ? "var(--text-green)" : "var(--text-muted)",
    }}>
      <StatusDot active={active} />
      {label}
    </span>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="dash-row">
      <span className="dash-label">{label}</span>
      <span className="dash-value">{children}</span>
    </div>
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
  const [tokenDetails, setTokenDetails] = useState<TokenDetails | null>(null);
  const [copiedToken, setCopiedToken] = useState<"access" | "refresh" | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const [s, tg] = await Promise.all([api.getStatus(), api.getTelegramStatus()]);
      setStatus(s);
      setTelegramStatus(tg);
      if (s.token_valid) {
        const details = await api.getTokenDetails();
        setTokenDetails(details);
      } else {
        setTokenDetails(null);
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    api.isCloudflaredAvailable().then(setCloudflaredAvailable);
    const interval = setInterval(fetchStatus, 5000);
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
      const msg = String(e);
      setError(msg);
      log.error("app", msg);
    } finally {
      setLoading((l) => ({ ...l, [key]: false }));
    }
  };

  const toggleProxy = () =>
    withLoading("proxy", async () => {
      if (status?.proxy_running) {
        await api.stopProxy();
        log.info("proxy", "Proxy stopped");
      } else {
        if (!status?.token_valid) {
          const tokenResult = await api.loadToken();
          if (!tokenResult.valid) {
            throw new Error(
              tokenResult.error ||
                "Failed to connect OAuth. Please run `claude auth login` in your terminal first."
            );
          }
          log.info("app", "OAuth token loaded");
        }
        await api.startProxy();
        log.info("proxy", `Proxy started on port ${status?.proxy_port}`);
      }
    });

  const toggleTunnel = () =>
    withLoading("tunnel", async () => {
      if (status?.tunnel_running) {
        await api.stopTunnel();
        log.info("tunnel", "Tunnel stopped");
      } else {
        await api.startTunnel();
        log.info("tunnel", "Tunnel starting...");
      }
    });

  const toggleTelegram = () =>
    withLoading("telegram", async () => {
      if (status?.telegram_running) {
        await api.stopTelegramBot();
        log.info("telegram", "Telegram bot stopped");
      } else {
        await api.startTelegramBot();
        log.info("telegram", "Telegram bot started");
      }
    });

  const copyUrl = () => {
    if (status?.tunnel_url) {
      navigator.clipboard.writeText(status.tunnel_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const copyToken = (type: "access" | "refresh") => {
    const value = type === "access" ? tokenDetails?.access_token : tokenDetails?.refresh_token;
    if (value) {
      navigator.clipboard.writeText(value);
      setCopiedToken(type);
      setTimeout(() => setCopiedToken(null), 2000);
    }
  };

  if (!status) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="dashboard">
      {error && <div className="error-banner">{error}</div>}

      {/* Proxy Server */}
      <div className="dash-card">
        <div className="dash-card-header">
          <div className="dash-card-title">
            <StatusDot active={status.proxy_running} />
            Proxy Server
          </div>
          <button
            className={`btn ${status.proxy_running ? "btn-danger" : "btn-primary"}`}
            onClick={toggleProxy}
            disabled={loading.proxy || loading.token}
          >
            {loading.proxy || loading.token ? "..." : status.proxy_running ? "Stop" : "Start"}
          </button>
        </div>

        <InfoRow label="Status">
          <StatusBadge active={status.proxy_running} label={status.proxy_running ? "Running" : "Stopped"} />
        </InfoRow>

        <InfoRow label="Port">
          <span className="mono" style={{ fontSize: 13 }}>{status.proxy_port}</span>
        </InfoRow>

        {status.proxy_running && (
          <InfoRow label="Endpoint">
            <span className="mono text-green" style={{ fontSize: 12 }}>http://localhost:{status.proxy_port}</span>
          </InfoRow>
        )}

        <div className="dash-divider" />

        <InfoRow label="Claude OAuth">
          <StatusBadge
            active={status.token_valid}
            label={
              status.token_valid
                ? status.token_expires_at
                  ? `Valid · expires ${formatExpiry(status.token_expires_at)}`
                  : "Valid"
                : "Not connected"
            }
          />
        </InfoRow>

        {status.token_valid && tokenDetails && (
          <div className="dash-row">
            <span className="dash-label" />
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn btn-small btn-secondary" onClick={() => copyToken("access")}>
                {copiedToken === "access" ? "Copied!" : "Copy Access Token"}
              </button>
              <button className="btn btn-small btn-secondary" onClick={() => copyToken("refresh")}>
                {copiedToken === "refresh" ? "Copied!" : "Copy Refresh Token"}
              </button>
            </div>
          </div>
        )}

        {!status.token_valid && !status.proxy_running && (
          <div className="dash-row">
            <span className="dash-label" />
            <span className="hint" style={{ margin: 0 }}>
              If not logged in, run <code>claude auth login</code> first, then click <strong>Start</strong>
            </span>
          </div>
        )}
      </div>

      {/* Cloudflare Tunnel */}
      <div className="dash-card">
        <div className="dash-card-header">
          <div className="dash-card-title">
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

        {!cloudflaredAvailable && (
          <div className="dash-row">
            <span className="dash-label" />
            <span className="hint warning" style={{ margin: 0 }}>
              cloudflared not found — <code>brew install cloudflared</code>
            </span>
          </div>
        )}

        <InfoRow label="Status">
          <StatusBadge
            active={status.tunnel_running}
            label={status.tunnel_running ? (status.tunnel_url ? "Active" : "Starting...") : "Stopped"}
          />
        </InfoRow>

        {status.tunnel_url && (
          <InfoRow label="Public URL">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span className="mono text-green tunnel-url" style={{ fontSize: 11 }}>{status.tunnel_url}</span>
              <button className="btn btn-small btn-secondary" onClick={copyUrl} style={{ flexShrink: 0 }}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </InfoRow>
        )}
      </div>

      {/* Telegram Bot */}
      <div className="dash-card">
        <div className="dash-card-header">
          <div className="dash-card-title">
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

        {!telegramStatus?.bot_token_set && (
          <div className="dash-row">
            <span className="dash-label" />
            <span className="hint warning" style={{ margin: 0 }}>
              No bot token — configure in Settings → Telegram
            </span>
          </div>
        )}

        <InfoRow label="Status">
          <StatusBadge active={!!status.telegram_running} label={status.telegram_running ? "Running" : "Stopped"} />
        </InfoRow>

        {telegramStatus && telegramStatus.allowed_users_count > 0 && (
          <InfoRow label="Allowed users">
            <span style={{ fontSize: 13 }}>{telegramStatus.allowed_users_count}</span>
          </InfoRow>
        )}
      </div>
    </div>
  );
}
