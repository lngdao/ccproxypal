import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, AppStatus, ToolConfigStatus } from "../lib/invoke";
import { log } from "../lib/logStore";

interface Tool {
  id: keyof ToolConfigStatus;
  name: string;
  path: string;
}

const TOOLS: Tool[] = [
  { id: "claude_code", name: "Claude Code", path: "~/.claude/settings.json" },
  { id: "opencode", name: "OpenCode", path: "~/.config/opencode/config.json" },
];

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

export default function ClientPanel() {
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [toolStatus, setToolStatus] = useState<ToolConfigStatus | null>(null);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const [s, ts] = await Promise.all([api.getStatus(), api.getToolConfigStatus()]);
      setStatus(s);
      setToolStatus(ts);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    fetchStatus();
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
    setNotice(null);
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

  const handleStart = () =>
    withLoading("proxy", async () => {
      if (!accessToken.trim() || !refreshToken.trim()) {
        throw new Error("Please enter both Access Token and Refresh Token.");
      }
      log.info("app", "Setting token manually...");
      await api.setTokenManually(accessToken.trim(), refreshToken.trim());
      log.info("proxy", "Starting proxy server...");
      await api.startProxy();
    });

  const handleStop = () =>
    withLoading("proxy", async () => {
      log.info("proxy", "Stopping proxy server...");
      await api.stopProxy();
    });

  const handleConfigure = (toolId: string) =>
    withLoading(`tool_${toolId}`, async () => {
      log.info("app", `Configuring tool: ${toolId}`);
      await api.configureTool(toolId);
    });

  const handleRemove = (toolId: string) =>
    withLoading(`tool_${toolId}`, async () => {
      log.info("app", `Removing tool config: ${toolId}`);
      await api.removeToolConfig(toolId);
    });

  const proxyUrl = status?.tunnel_url || `http://localhost:${status?.proxy_port ?? 8082}`;
  const isRunning = !!status?.proxy_running;

  return (
    <div className="client-panel">
      {error && <div className="error-banner">{error}</div>}
      {notice && (
        <div className="error-banner" style={{ background: "#052e16", borderColor: "#166534", color: "#86efac" }}>
          {notice}
        </div>
      )}

      {/* Proxy Card */}
      <div className="dash-card">
        <div className="dash-card-header">
          <div className="dash-card-title">
            <StatusDot active={isRunning} />
            Proxy Server
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {isRunning && (
              <span style={{ fontSize: 11, color: "var(--text-green)", fontFamily: "var(--font-mono)" }}>
                :{status?.proxy_port}
              </span>
            )}
            {isRunning ? (
              <button className="btn btn-danger" onClick={handleStop} disabled={loading.proxy}>
                {loading.proxy ? "..." : "Stop"}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={handleStart}
                disabled={loading.proxy || !accessToken.trim() || !refreshToken.trim()}
              >
                {loading.proxy ? "Starting..." : "Start"}
              </button>
            )}
          </div>
        </div>

        <div className="client-token-section">
          <div className="client-field">
            <label>Access Token</label>
            <input
              type="password"
              placeholder="sk-ant-oau01-..."
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              disabled={isRunning}
            />
          </div>
          <div className="client-field">
            <label>Refresh Token</label>
            <input
              type="password"
              placeholder="Refresh token..."
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              disabled={isRunning}
            />
          </div>
        </div>

        {isRunning && (
          <div className="dash-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
            <span className="dash-label">Endpoint</span>
            <span className="mono text-green" style={{ fontSize: 12 }}>{proxyUrl}</span>
          </div>
        )}
      </div>

      {/* Configure Tools Card */}
      <div className="dash-card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="dash-card-header" style={{ padding: "12px 16px 10px", borderBottom: "1px solid var(--border)" }}>
          <div className="dash-card-title" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.6px", color: "var(--text-muted)", fontWeight: 600 }}>
            Configure Tools
          </div>
          {isRunning && (
            <span style={{ fontSize: 11, color: "var(--text-green)", fontFamily: "var(--font-mono)" }}>
              → {proxyUrl}
            </span>
          )}
        </div>

        {!isRunning && (
          <div style={{ padding: "0 16px 16px 16px", borderBottom: "1px solid var(--border)" }}>
            <span className="hint warning" style={{ margin: 0 }}>Start the proxy first before configuring tools.</span>
          </div>
        )}

        {TOOLS.map((tool) => {
          const isConfigured = toolStatus?.[tool.id] ?? false;
          const isLoading = loading[`tool_${tool.id}`];
          return (
            <div key={tool.id} className="client-tool-row">
              <div className="tool-info">
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{tool.name}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>{tool.path}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                {isConfigured && (
                  <button className="btn btn-small btn-danger" disabled={isLoading} onClick={() => handleRemove(tool.id)}>
                    {isLoading ? "..." : "Remove"}
                  </button>
                )}
                <button
                  className="btn btn-small btn-secondary"
                  disabled={!isRunning || isLoading}
                  onClick={() => handleConfigure(tool.id)}
                >
                  {isLoading ? "..." : isConfigured ? "Update" : "Configure"}
                </button>
              </div>
            </div>
          );
        })}

        {/* Cursor */}
        <div className="client-tool-row" style={{ borderBottom: "none" }}>
          <div className="tool-info">
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>Cursor</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Settings → Models → API Base URL (requires HTTPS — enable Tunnel first)</div>
          </div>
          <button
            className="btn btn-small btn-secondary"
            disabled={!isRunning || !status?.tunnel_url}
            title={!status?.tunnel_url ? "Enable Cloudflare Tunnel first — Cursor requires HTTPS" : undefined}
            onClick={() => {
              const cursorUrl = `${proxyUrl}/v1`;
              navigator.clipboard.writeText(cursorUrl);
            }}
          >
            Copy URL
          </button>
        </div>
      </div>
    </div>
  );
}
