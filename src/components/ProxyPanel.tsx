import { useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  AppStatus,
  TelegramStatus,
  TokenDetails,
  PoolStatus,
  ToolConfigStatus,
} from "../lib/invoke";
import { log } from "../lib/logStore";
import { toast } from "./ui/Toast";
import SegmentedControl from "./ui/SegmentedControl";
import StepCard from "./ui/StepCard";
import { StatusBadge } from "./ui/StatusDot";
import InfoRow from "./ui/InfoRow";
import Button from "./ui/Button";
import Input from "./ui/Input";

type Mode = "solo" | "hub-host" | "hub-consumer";

interface Tool {
  id: keyof ToolConfigStatus;
  name: string;
  path: string;
}

const TOOLS: Tool[] = [
  { id: "claude_code", name: "Claude Code", path: "~/.claude/settings.json" },
  { id: "opencode", name: "OpenCode", path: "~/.config/opencode/opencode.json" },
];

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: "solo", label: "Solo" },
  { value: "hub-host", label: "Hub Host" },
  { value: "hub-consumer", label: "Hub Consumer" },
];

function formatExpiry(expiresAt: number | null): string {
  if (!expiresAt) return "Unknown";
  const diff = expiresAt - Date.now();
  if (diff <= 0) return "Expired";
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export default function ProxyPanel() {
  const [mode, setMode] = useState<Mode>("solo");
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null);
  const [tokenDetails, setTokenDetails] = useState<TokenDetails | null>(null);
  const [poolStatus, setPoolStatus] = useState<PoolStatus | null>(null);
  const [toolStatus, setToolStatus] = useState<ToolConfigStatus | null>(null);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const setErrorWithAutoDismiss = (msg: string, ms = 8000) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), ms);
  };
  const [cloudflaredAvailable, setCloudflaredAvailable] = useState(true);

  // Hub consumer fields
  const [hubUrl, setHubUrl] = useState("");
  const [hubSecret, setHubSecret] = useState("");

  const fetchStatus = useCallback(async () => {
    try {
      const [s, tg, pool, ts] = await Promise.all([
        api.getStatus(),
        api.getTelegramStatus(),
        api.getPoolStatus(),
        api.getToolConfigStatus(),
      ]);
      setStatus(s);
      setTelegramStatus(tg);
      setPoolStatus(pool);
      setToolStatus(ts);
      if (s.token_valid) {
        const details = await api.getTokenDetails();
        setTokenDetails(details);
      } else {
        setTokenDetails(null);
      }
    } catch (e) {
      setErrorWithAutoDismiss(String(e));
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    api.isCloudflaredAvailable().then(setCloudflaredAvailable);
    const interval = setInterval(fetchStatus, 5000);
    const unlisten = listen<string>("tunnel-url", (event) => {
      setStatus((prev) =>
        prev
          ? { ...prev, tunnel_url: event.payload, tunnel_running: true }
          : prev
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
    } catch (e) {
      const msg = String(e);
      setErrorWithAutoDismiss(msg);
      log.error("app", msg);
    } finally {
      await fetchStatus();
      setLoading((l) => ({ ...l, [key]: false }));
    }
  };

  // --- Proxy actions ---
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
              "Failed to connect OAuth. Run `claude auth login` first."
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

  // --- Hub consumer actions ---
  const handleStartProvider = () =>
    withLoading("provider", async () => {
      if (!hubUrl.trim()) throw new Error("Enter a hub URL first.");
      log.info("provider", `Starting provider -> ${hubUrl.trim()}`);
      await api.startProvider(hubUrl.trim(), hubSecret.trim() || undefined);
    });

  const handleStopProvider = () =>
    withLoading("provider", async () => {
      log.info("provider", "Stopping provider...");
      await api.stopProvider();
    });

  // --- Tool config ---
  const proxyUrl =
    status?.tunnel_url || `http://localhost:${status?.proxy_port ?? 8082}`;
  const isRunning = !!status?.proxy_running;
  const isProviding = !!status?.provider_running;
  const targetUrl = mode === "hub-consumer" ? hubUrl.trim() : proxyUrl;
  const canConfigure =
    mode === "hub-consumer" ? !!hubUrl.trim() : isRunning;

  const handleConfigure = (toolId: string) =>
    withLoading(`tool_${toolId}`, async () => {
      const url = mode === "hub-consumer" ? hubUrl.trim() : undefined;
      log.info("app", `Configuring ${toolId}${url ? ` -> ${url}` : ""}`);
      await api.configureTool(toolId, url);
    });

  const handleRemove = (toolId: string) =>
    withLoading(`tool_${toolId}`, async () => {
      log.info("app", `Removing tool config: ${toolId}`);
      await api.removeToolConfig(toolId);
    });

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  };

  if (!status) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        Loading...
      </div>
    );
  }

  return (
    <div className="p-5 space-y-4 max-w-2xl mx-auto">
      {/* Mode selector */}
      <div className="flex items-center justify-between">
        <SegmentedControl options={MODE_OPTIONS} value={mode} onChange={setMode} />
      </div>

      {error && (
        <div className="bg-text-red/10 border border-text-red/30 text-text-red text-[12px] px-3 py-2 rounded-md">
          {error}
        </div>
      )}

      {/* SOLO MODE */}
      {mode === "solo" && (
        <>
          <StepCard
            step={1}
            title="OAuth & Proxy Server"
            completed={isRunning}
            headerRight={
              <Button
                variant={isRunning ? "danger" : "primary"}
                size="sm"
                loading={loading.proxy}
                onClick={toggleProxy}
              >
                {isRunning ? "Stop" : "Start"}
              </Button>
            }
          >
            <div className="space-y-1">
              <InfoRow label="Status">
                <StatusBadge
                  active={isRunning}
                  label={isRunning ? "Running" : "Stopped"}
                />
              </InfoRow>
              {isRunning && (
                <>
                  <InfoRow label="Port">
                    <span className="font-mono text-[12px]">
                      {status.proxy_port}
                    </span>
                  </InfoRow>
                  <InfoRow label="Endpoint">
                    <span className="font-mono text-[11px] text-text-green">
                      http://localhost:{status.proxy_port}
                    </span>
                  </InfoRow>
                </>
              )}
              <InfoRow label="Claude OAuth">
                <StatusBadge
                  active={status.token_valid}
                  label={
                    status.token_valid
                      ? status.token_expires_at
                        ? `Valid - expires ${formatExpiry(status.token_expires_at)}`
                        : "Valid"
                      : "Not connected"
                  }
                />
              </InfoRow>
              {status.token_valid && tokenDetails && (
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={() =>
                      copyToClipboard(
                        tokenDetails.access_token!,
                        "Access token"
                      )
                    }
                  >
                    Copy Access Token
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      copyToClipboard(
                        tokenDetails.refresh_token!,
                        "Refresh token"
                      )
                    }
                  >
                    Copy Refresh Token
                  </Button>
                  <Button
                    size="sm"
                    loading={loading.reload}
                    onClick={() =>
                      withLoading("reload", async () => {
                        const result = await api.reloadToken();
                        if (result.valid) {
                          toast.success("Token refreshed");
                        } else {
                          // Token refresh failed → stop proxy so user sees "claude auth login" hint
                          if (status?.proxy_running) {
                            await api.stopProxy();
                            log.info("proxy", "Proxy stopped due to token refresh failure");
                          }
                          throw new Error(result.error || "Token refresh failed");
                        }
                      })
                    }
                  >
                    Refresh
                  </Button>
                </div>
              )}
              {!status.token_valid && !isRunning && (
                <p className="text-[11px] text-text-muted pt-1">
                  Run <code>claude auth login</code> first, then click{" "}
                  <strong>Start</strong>
                </p>
              )}
            </div>
          </StepCard>

          <StepCard
            step={2}
            title="Configure Dev Tools"
            disabled={!isRunning}
            completed={
              isRunning &&
              !!(toolStatus?.claude_code || toolStatus?.opencode)
            }
          >
            <ToolList
              tools={TOOLS}
              toolStatus={toolStatus}
              canConfigure={canConfigure}
              targetUrl={targetUrl}
              mode={mode}
              tunnelUrl={status.tunnel_url}
              loading={loading}
              onConfigure={handleConfigure}
              onRemove={handleRemove}
              onCopy={copyToClipboard}
            />
          </StepCard>
        </>
      )}

      {/* HUB HOST MODE */}
      {mode === "hub-host" && (
        <>
          <StepCard
            step={1}
            title="Proxy Server"
            completed={isRunning}
            headerRight={
              <Button
                variant={isRunning ? "danger" : "primary"}
                size="sm"
                loading={loading.proxy}
                onClick={toggleProxy}
              >
                {isRunning ? "Stop" : "Start"}
              </Button>
            }
          >
            <div className="space-y-1">
              <InfoRow label="Status">
                <StatusBadge
                  active={isRunning}
                  label={isRunning ? "Running" : "Stopped"}
                />
              </InfoRow>
              {isRunning && (
                <>
                  <InfoRow label="Port">
                    <span className="font-mono text-[12px]">
                      {status.proxy_port}
                    </span>
                  </InfoRow>
                  <InfoRow label="Endpoint">
                    <span className="font-mono text-[11px] text-text-green">
                      http://localhost:{status.proxy_port}
                    </span>
                  </InfoRow>
                </>
              )}
              <InfoRow label="OAuth">
                <StatusBadge
                  active={status.token_valid}
                  label={
                    status.token_valid
                      ? `Valid - ${formatExpiry(status.token_expires_at)}`
                      : "Not connected"
                  }
                />
              </InfoRow>
            </div>
          </StepCard>

          <StepCard
            step={2}
            title="Cloudflare Tunnel"
            disabled={!isRunning}
            completed={!!status.tunnel_url}
            headerRight={
              <Button
                variant={status.tunnel_running ? "danger" : "primary"}
                size="sm"
                loading={loading.tunnel}
                disabled={!cloudflaredAvailable || !isRunning}
                onClick={toggleTunnel}
                title={
                  !cloudflaredAvailable ? "cloudflared not installed" : ""
                }
              >
                {status.tunnel_running ? "Stop" : "Start"}
              </Button>
            }
          >
            <div className="space-y-1">
              {!cloudflaredAvailable && (
                <p className="text-[11px] text-text-amber">
                  cloudflared not found. Install: <code>brew install cloudflared</code>
                </p>
              )}
              <InfoRow label="Status">
                <StatusBadge
                  active={status.tunnel_running}
                  label={
                    status.tunnel_running
                      ? status.tunnel_url
                        ? "Active"
                        : "Starting..."
                      : "Stopped"
                  }
                />
              </InfoRow>
              {status.tunnel_url && (
                <InfoRow label="Public URL">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-text-green truncate max-w-[200px]">
                      {status.tunnel_url}
                    </span>
                    <Button
                      size="sm"
                      onClick={() =>
                        copyToClipboard(status.tunnel_url!, "Tunnel URL")
                      }
                    >
                      Copy
                    </Button>
                  </div>
                </InfoRow>
              )}
            </div>
          </StepCard>

          <StepCard
            step={3}
            title="Token Pool"
            disabled={!isRunning}
            completed={!!poolStatus && poolStatus.healthy > 0}
          >
            <div className="space-y-2">
              {poolStatus && poolStatus.total > 0 ? (
                <>
                  <div className="text-[11px] text-text-muted mb-2">
                    {poolStatus.healthy}/{poolStatus.total} healthy providers
                  </div>
                  {poolStatus.entries.map((entry) => (
                    <div
                      key={entry.provider_id}
                      className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0"
                    >
                      <div className="flex items-center gap-2">
                        <StatusBadge
                          active={entry.healthy && !entry.expired}
                          label={entry.provider_id}
                        />
                      </div>
                      <span className="text-[11px] text-text-muted">
                        {entry.expired
                          ? "Expired"
                          : !entry.healthy
                            ? "Unhealthy"
                            : `expires ${formatExpiry(entry.expires_at)}`}
                      </span>
                    </div>
                  ))}
                </>
              ) : (
                <p className="text-[11px] text-text-muted">
                  No providers connected.{" "}
                  {status.tunnel_url ? (
                    <>
                      Run{" "}
                      <code>
                        npx ccproxypal provide --hub {status.tunnel_url}
                      </code>
                    </>
                  ) : (
                    "Start a tunnel first, then share the URL with providers."
                  )}
                </p>
              )}
            </div>
          </StepCard>

          {/* Telegram in Hub Host mode */}
          <StepCard
            step={4}
            title="Telegram Bot"
            disabled={!isRunning}
            completed={!!status.telegram_running}
            headerRight={
              <Button
                variant={status.telegram_running ? "danger" : "primary"}
                size="sm"
                loading={loading.telegram}
                disabled={!telegramStatus?.bot_token_set || !isRunning}
                onClick={toggleTelegram}
                title={
                  !telegramStatus?.bot_token_set
                    ? "Configure bot token in Settings"
                    : ""
                }
              >
                {status.telegram_running ? "Stop" : "Start"}
              </Button>
            }
          >
            <div className="space-y-1">
              <InfoRow label="Status">
                <StatusBadge
                  active={!!status.telegram_running}
                  label={status.telegram_running ? "Running" : "Stopped"}
                />
              </InfoRow>
              {!telegramStatus?.bot_token_set && (
                <p className="text-[11px] text-text-amber">
                  No bot token configured. Set it in Settings.
                </p>
              )}
            </div>
          </StepCard>
        </>
      )}

      {/* HUB CONSUMER MODE */}
      {mode === "hub-consumer" && (
        <>
          <StepCard
            step={1}
            title="Connect to Hub"
            completed={isProviding}
            headerRight={
              isProviding ? (
                <Button
                  variant="danger"
                  size="sm"
                  loading={loading.provider}
                  onClick={handleStopProvider}
                >
                  Stop Provider
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  loading={loading.provider}
                  disabled={!hubUrl.trim() || !status.token_valid}
                  onClick={handleStartProvider}
                  title={
                    !status.token_valid
                      ? "Switch to Solo mode and start proxy first to load your token"
                      : ""
                  }
                >
                  Provide Token
                </Button>
              )
            }
          >
            <div className="space-y-3">
              <Input
                label="Hub / Tunnel URL"
                placeholder="https://xxxx.trycloudflare.com"
                value={hubUrl}
                onChange={(e) => setHubUrl(e.target.value)}
                disabled={isProviding}
              />
              <Input
                label="Hub Secret"
                type="password"
                placeholder="Leave blank if no secret"
                value={hubSecret}
                onChange={(e) => setHubSecret(e.target.value)}
                disabled={isProviding}
                hint="Optional shared secret for hub authentication"
              />
              {isProviding && (
                <InfoRow label="Connected to">
                  <span className="font-mono text-[11px] text-text-green">
                    {status.provider_hub_url}
                  </span>
                </InfoRow>
              )}
              <div className="space-y-1.5">
                {!status.token_valid && (
                  <p className="text-[11px] text-text-amber">
                    No token loaded. Switch to Solo mode and start the proxy to
                    load your OAuth token first.
                  </p>
                )}
                <p className="text-[11px] text-text-muted">
                  Pushes your local OAuth token to the hub every 5 minutes so
                  others can use it.
                </p>
              </div>
            </div>
          </StepCard>

          <StepCard
            step={2}
            title="Configure Dev Tools"
            disabled={!hubUrl.trim()}
            completed={
              !!hubUrl.trim() &&
              !!(toolStatus?.claude_code || toolStatus?.opencode)
            }
          >
            <ToolList
              tools={TOOLS}
              toolStatus={toolStatus}
              canConfigure={canConfigure}
              targetUrl={targetUrl}
              mode={mode}
              tunnelUrl={status.tunnel_url}
              loading={loading}
              onConfigure={handleConfigure}
              onRemove={handleRemove}
              onCopy={copyToClipboard}
            />
          </StepCard>
        </>
      )}
    </div>
  );
}

// --- Tool List sub-component ---
function ToolList({
  tools,
  toolStatus,
  canConfigure,
  targetUrl,
  mode,
  tunnelUrl,
  loading,
  onConfigure,
  onRemove,
  onCopy,
}: {
  tools: Tool[];
  toolStatus: ToolConfigStatus | null;
  canConfigure: boolean;
  targetUrl: string;
  mode: Mode;
  tunnelUrl: string | null;
  loading: Record<string, boolean>;
  onConfigure: (id: string) => void;
  onRemove: (id: string) => void;
  onCopy: (text: string, label: string) => void;
}) {
  return (
    <div className="space-y-0.5">
      {canConfigure && (
        <div className="text-[10px] font-mono text-text-green mb-2 truncate">
          {"->"} {targetUrl}
        </div>
      )}
      {!canConfigure && (
        <p className="text-[11px] text-text-amber mb-2">
          {mode === "hub-consumer"
            ? "Enter a hub URL above to configure tools."
            : "Start the proxy first before configuring tools."}
        </p>
      )}
      {tools.map((tool) => {
        const configured = toolStatus?.[tool.id] ?? false;
        const isLoading = loading[`tool_${tool.id}`];
        return (
          <div
            key={tool.id}
            className="mt-2 flex items-center justify-between py-2 border-b border-border/40 last:border-0"
          >
            <div>
              <div className="text-[13px] font-medium text-text-primary">
                {tool.name}
              </div>
              <div className="text-[10px] font-mono text-text-muted mt-0.5">
                {tool.path}
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {configured && (
                <Button
                  variant="danger"
                  size="sm"
                  loading={isLoading}
                  onClick={() => onRemove(tool.id)}
                >
                  Remove
                </Button>
              )}
              <Button
                size="sm"
                disabled={!canConfigure}
                loading={isLoading}
                onClick={() => onConfigure(tool.id)}
              >
                {configured ? "Update" : "Configure"}
              </Button>
            </div>
          </div>
        );
      })}
      {/* Cursor */}
      <div className="flex items-center justify-between py-2">
        <div>
          <div className="text-[13px] font-medium text-text-primary">
            Cursor
          </div>
          <div className="text-[10px] text-text-muted mt-0.5">
            {mode === "hub-consumer"
              ? "Settings -> Models -> API Base URL"
              : "Requires HTTPS (Tunnel)"}
          </div>
        </div>
        <Button
          size="sm"
          disabled={
            !canConfigure ||
            (mode !== "hub-consumer" && !tunnelUrl)
          }
          title={
            mode !== "hub-consumer" && !tunnelUrl
              ? "Enable Cloudflare Tunnel first"
              : undefined
          }
          onClick={() => onCopy(`${targetUrl}/v1`, "Cursor URL")}
        >
          Copy URL
        </Button>
      </div>
    </div>
  );
}
