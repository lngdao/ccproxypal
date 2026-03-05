import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, AppStatus, ToolConfigStatus } from "../lib/invoke";

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
        width: 10,
        height: 10,
        borderRadius: "50%",
        backgroundColor: active ? "#22c55e" : "#ef4444",
        marginRight: 8,
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
  const [success, setSuccess] = useState<string | null>(null);

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
    setSuccess(null);
    try {
      await fn();
      await fetchStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading((l) => ({ ...l, [key]: false }));
    }
  };

  const handleStart = () =>
    withLoading("proxy", async () => {
      if (!accessToken.trim() || !refreshToken.trim()) {
        throw new Error("Please enter both Access Token and Refresh Token.");
      }
      await api.setTokenManually(accessToken.trim(), refreshToken.trim());
      await api.startProxy();
    });

  const handleStop = () =>
    withLoading("proxy", async () => {
      await api.stopProxy();
    });

  const handleConfigure = (toolId: string) =>
    withLoading(`tool_${toolId}`, async () => {
      await api.configureTool(toolId);
      setSuccess(`${TOOLS.find((t) => t.id === toolId)?.name} configured!`);
    });

  const handleRemove = (toolId: string) =>
    withLoading(`tool_${toolId}`, async () => {
      await api.removeToolConfig(toolId);
    });

  const proxyUrl = status?.tunnel_url || `http://localhost:${status?.proxy_port ?? 8082}`;

  return (
    <div className="client-panel">
      {error && <div className="error-banner">{error}</div>}
      {success && (
        <div
          className="error-banner"
          style={{ background: "#052e16", borderColor: "#166534", color: "#86efac" }}
        >
          {success}
        </div>
      )}

      {/* Token Input Card */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <StatusDot active={!!status?.proxy_running} />
            Proxy Server
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {status?.proxy_running && (
              <span className="proxy-badge running">:{status.proxy_port}</span>
            )}
            {status?.proxy_running ? (
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

        <div className="card-body">
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label>Access Token</label>
            <input
              type="password"
              placeholder="sk-ant-oau01-..."
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              disabled={!!status?.proxy_running}
            />
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Refresh Token</label>
            <input
              type="password"
              placeholder="Refresh token..."
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              disabled={!!status?.proxy_running}
            />
          </div>

          {status?.proxy_running && (
            <div className="info-row" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
              <span className="label">Endpoint</span>
              <span className="value mono text-green">{proxyUrl}</span>
            </div>
          )}
        </div>
      </div>

      {/* Tool Configuration Card */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Configure Tools</div>
          {status?.proxy_running && (
            <span className="proxy-badge running" style={{ fontSize: 11 }}>
              → {proxyUrl}
            </span>
          )}
        </div>
        <div className="card-body">
          {!status?.proxy_running && (
            <div className="hint warning" style={{ marginBottom: 10 }}>
              Start the proxy first before configuring tools.
            </div>
          )}

          <div className="tools-grid">
            {TOOLS.map((tool) => {
              const isConfigured = toolStatus?.[tool.id] ?? false;
              const isLoading = loading[`tool_${tool.id}`];
              return (
                <div key={tool.id} className={`tool-row ${isConfigured ? "configured" : ""}`}>
                  <div className="tool-info">
                    <div className="tool-name">{tool.name}</div>
                    <div className="tool-path">{tool.path}</div>
                  </div>
                  {isConfigured && <span className="tool-badge">✓ Configured</span>}
                  {isConfigured && (
                    <button
                      className="btn btn-small btn-danger"
                      disabled={isLoading}
                      onClick={() => handleRemove(tool.id)}
                    >
                      {isLoading ? "..." : "Remove"}
                    </button>
                  )}
                  <button
                    className="btn btn-small btn-secondary"
                    disabled={!status?.proxy_running || isLoading}
                    onClick={() => handleConfigure(tool.id)}
                  >
                    {isLoading ? "..." : isConfigured ? "Update" : "Configure"}
                  </button>
                </div>
              );
            })}

            {/* Cursor — manual */}
            <div className="tool-row">
              <div className="tool-info">
                <div className="tool-name">Cursor</div>
                <div className="tool-path">Settings → Models → API Base URL</div>
              </div>
              <button
                className="btn btn-small btn-secondary"
                disabled={!status?.proxy_running}
                onClick={() => {
                  navigator.clipboard.writeText(proxyUrl);
                  setSuccess(`Copied ${proxyUrl} — paste into Cursor Settings → Models → API Base URL`);
                }}
              >
                Copy URL
              </button>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
