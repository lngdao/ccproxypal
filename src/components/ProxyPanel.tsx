import { useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  AppStatus,
  TelegramStatus,
  TokenDetails,
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

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: "solo", label: "Solo" },
  { value: "hub-host", label: "Hub Host" },
  { value: "hub-consumer", label: "Hub Consumer" },
];

interface ProxyPanelProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  hubUrl: string;
  onHubUrlChange: (url: string) => void;
  hubSecret: string;
  onHubSecretChange: (secret: string) => void;
}

export default function ProxyPanel({
  mode,
  onModeChange,
  hubUrl,
  onHubUrlChange,
  hubSecret,
  onHubSecretChange,
}: ProxyPanelProps) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null);
  const [tokenDetails, setTokenDetails] = useState<TokenDetails | null>(null);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const [setupToken, setSetupToken] = useState("");
  const [cloudflaredAvailable, setCloudflaredAvailable] = useState(true);
  const [showTokenModal, setShowTokenModal] = useState(false);

  const setErrorWithAutoDismiss = (msg: string, ms = 8000) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), ms);
  };

  const fetchStatus = useCallback(async () => {
    try {
      const [s, tg] = await Promise.all([
        api.getStatus(),
        api.getTelegramStatus(),
      ]);
      setStatus(s);
      setTelegramStatus(tg);
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

  // --- Hub Host: host token to pool ---
  const handleStartProvider = () =>
    withLoading("provider", async () => {
      if (!hubUrl.trim()) throw new Error("Enter a hub URL first.");
      log.info("provider", `Hosting token to ${hubUrl.trim()}`);
      await api.startProvider(hubUrl.trim(), hubSecret.trim() || undefined);
    });

  const handleStopProvider = () =>
    withLoading("provider", async () => {
      log.info("provider", "Stopping host...");
      await api.stopProvider();
    });

  const handleSaveToken = () =>
    withLoading("saveToken", async () => {
      if (!setupToken.trim()) throw new Error("Paste a setup token first.");
      await api.setTokenManually(setupToken.trim());
      toast.success("Token saved");
      setSetupToken("");
    });

  // --- Hub Consumer: save URL + secret ---
  const handleSaveHubConfig = () => {
    if (!hubUrl.trim()) {
      toast.error("Enter a hub URL first");
      return;
    }
    toast.success("Saved");
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  };

  const isRunning = !!status?.proxy_running;
  const isProviding = !!status?.provider_running;

  if (!status) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        Loading...
      </div>
    );
  }

  const showToken = mode !== "hub-consumer";

  const maskedToken = tokenDetails?.access_token
    ? (() => {
        const t = tokenDetails.access_token!;
        if (t.length <= 10) return t;
        return `${t.slice(0, 6)}${"*".repeat(Math.min(t.length - 10, 20))}${t.slice(-4)}`;
      })()
    : null;

  return (
    <div className="p-5 space-y-4 max-w-2xl mx-auto">
      {/* Header: Mode selector + Token */}
      <div className="flex items-center justify-between gap-3">
        <SegmentedControl options={MODE_OPTIONS} value={mode} onChange={onModeChange} />
        {showToken && (
          <>
            {status.token_valid && maskedToken ? (
              <button
                onClick={() => setShowTokenModal(true)}
                className="font-mono text-[11px] text-text-muted hover:text-text-primary truncate max-w-[180px] cursor-pointer transition-colors"
                title="Click to change token"
              >
                {maskedToken}
              </button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setShowTokenModal(true)}
              >
                Set Token
              </Button>
            )}
          </>
        )}
      </div>

      {/* Token Modal */}
      {showTokenModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => {
            setShowTokenModal(false);
            setSetupToken("");
          }}
        >
          <div
            className="bg-bg-card border border-border rounded-lg p-5 w-full max-w-sm shadow-lg space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[14px] font-semibold text-text-primary">
              {status.token_valid ? "Change Token" : "Set Token"}
            </div>
            <Input
              type="password"
              placeholder="Run: claude setup-token"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              autoFocus
            />
            <p className="text-[11px] text-text-muted">
              Paste the setup token from <code>claude setup-token</code>.
            </p>
            <div className="flex items-center justify-between gap-2">
              {status.token_valid && tokenDetails?.access_token ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => copyToClipboard(tokenDetails.access_token!, "Token")}
                >
                  Copy Token
                </Button>
              ) : (
                <div />
              )}
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowTokenModal(false);
                    setSetupToken("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={loading.saveToken}
                  disabled={!setupToken.trim()}
                  onClick={async () => {
                    await handleSaveToken();
                    setShowTokenModal(false);
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-text-red/10 border border-text-red/30 text-text-red text-[12px] px-3 py-2 rounded-md">
          {error}
        </div>
      )}

      {/* SOLO MODE */}
      {mode === "solo" && (
        <StepCard
          step={1}
          title="Proxy Server"
          completed={isRunning}
          headerRight={
            <Button
              variant={isRunning ? "danger" : "primary"}
              size="sm"
              loading={loading.proxy}
              disabled={!status.token_valid && !isRunning}
              onClick={toggleProxy}
              title={!status.token_valid && !isRunning ? "Set a token first" : ""}
            >
              {isRunning ? "Stop" : "Start"}
            </Button>
          }
        >
          <div className="space-y-2">
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
          </div>
        </StepCard>
      )}

      {/* HUB HOST MODE */}
      {mode === "hub-host" && (
        <>
          {/* Step 1: Proxy Server */}
          <StepCard
            step={1}
            title="Proxy Server"
            completed={isRunning}
            headerRight={
              <Button
                variant={isRunning ? "danger" : "primary"}
                size="sm"
                loading={loading.proxy}
                disabled={!status.token_valid && !isRunning}
                onClick={toggleProxy}
                title={!status.token_valid && !isRunning ? "Set a token first" : ""}
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
            </div>
          </StepCard>

          {/* Step 2: Cloudflare Tunnel */}
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

          {/* Step 3: Host to Pool */}
          <StepCard
            step={3}
            title="Host to Pool"
            completed={isProviding && status.provider_healthy}
            headerRight={
              <Button
                variant={isProviding ? "danger" : "primary"}
                size="sm"
                loading={loading.provider}
                disabled={!isProviding && (!hubUrl.trim() || !status.token_valid)}
                onClick={isProviding ? handleStopProvider : handleStartProvider}
                title={!hubUrl.trim() ? "Enter a hub URL first" : !status.token_valid ? "Set a token first" : ""}
              >
                {isProviding ? "Stop" : "Host"}
              </Button>
            }
          >
            <div className="space-y-3">
              <Input
                label="Hub URL"
                placeholder={status.tunnel_url || "https://xxxx.trycloudflare.com"}
                value={hubUrl}
                onChange={(e) => onHubUrlChange(e.target.value)}
                disabled={isProviding}
              />
              <Input
                label="Hub Secret"
                type="password"
                placeholder="Leave blank if no secret"
                value={hubSecret}
                onChange={(e) => onHubSecretChange(e.target.value)}
                disabled={isProviding}
                hint="Shared secret for the hub"
              />
              {isProviding && status.provider_hub_url && (
                <InfoRow label="Hosting to">
                  <span className="font-mono text-[10px] text-text-green truncate max-w-[200px]">
                    {status.provider_hub_url}
                  </span>
                </InfoRow>
              )}
              {isProviding && !status.provider_healthy && (
                <p className="text-[11px] text-text-red">
                  Push failed — check Log for details.
                </p>
              )}
              <p className="text-[11px] text-text-muted">
                Adds your token to the hub pool for round-robin load balancing.
              </p>
            </div>
          </StepCard>

          {/* Step 4: Telegram Bot */}
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
        <StepCard
          step={1}
          title="Hub Connection"
          completed={!!hubUrl.trim()}
          headerRight={
            <Button
              variant="primary"
              size="sm"
              disabled={!hubUrl.trim()}
              onClick={handleSaveHubConfig}
            >
              Save
            </Button>
          }
        >
          <div className="space-y-3">
            <Input
              label="Hub / Tunnel URL"
              placeholder="https://xxxx.trycloudflare.com"
              value={hubUrl}
              onChange={(e) => onHubUrlChange(e.target.value)}
            />
            <Input
              label="Hub Secret"
              type="password"
              placeholder="Leave blank if no secret"
              value={hubSecret}
              onChange={(e) => onHubSecretChange(e.target.value)}
              hint="Shared secret set by the hub host"
            />
            {hubUrl.trim() && (
              <InfoRow label="Status">
                <StatusBadge active={true} label="Configured" />
              </InfoRow>
            )}
            <p className="text-[11px] text-text-muted">
              Enter the hub URL shared by the host. Configure dev tools in the Tools tab to point at this hub.
            </p>
          </div>
        </StepCard>
      )}
    </div>
  );
}
