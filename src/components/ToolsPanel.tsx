import { useEffect, useState, useCallback, useRef } from "react";
import {
  api,
  AppStatus,
  ToolConfigStatus,
} from "../lib/invoke";
import { log } from "../lib/logStore";
import { toast } from "./ui/Toast";
import Card, { CardTitle } from "./ui/Card";
import Button from "./ui/Button";

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

interface ToolsPanelProps {
  mode: Mode;
  hubUrl: string;
}

export default function ToolsPanel({ mode, hubUrl }: ToolsPanelProps) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [toolStatus, setToolStatus] = useState<ToolConfigStatus | null>(null);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const setErrorWithAutoDismiss = (msg: string, ms = 8000) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), ms);
  };

  const fetchStatus = useCallback(async () => {
    try {
      const [s, ts] = await Promise.all([
        api.getStatus(),
        api.getToolConfigStatus(),
      ]);
      setStatus(s);
      setToolStatus(ts);
    } catch (e) {
      setErrorWithAutoDismiss(String(e));
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
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

  const isRunning = !!status?.proxy_running;
  const proxyUrl =
    status?.tunnel_url || `http://localhost:${status?.proxy_port ?? 8082}`;
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
      {error && (
        <div className="bg-text-red/10 border border-text-red/30 text-text-red text-[12px] px-3 py-2 rounded-md">
          {error}
        </div>
      )}

      {/* Configure Dev Tools */}
      <Card>
        <CardTitle>Configure Dev Tools</CardTitle>
        <div className="mt-3 space-y-0.5">
          {canConfigure && (
            <div className="text-[10px] font-mono text-text-green mb-2 truncate">
              {"->"} {targetUrl}
            </div>
          )}
          {!canConfigure && (
            <p className="text-[11px] text-text-amber mb-2">
              {mode === "hub-consumer"
                ? "Enter a hub URL in Proxy tab to configure tools."
                : "Start the proxy first before configuring tools."}
            </p>
          )}
          {TOOLS.map((tool) => {
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
                      onClick={() => handleRemove(tool.id)}
                    >
                      Remove
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={!canConfigure}
                    loading={isLoading}
                    onClick={() => handleConfigure(tool.id)}
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
                (mode !== "hub-consumer" && !status.tunnel_url)
              }
              title={
                mode !== "hub-consumer" && !status.tunnel_url
                  ? "Enable Cloudflare Tunnel first"
                  : undefined
              }
              onClick={() => copyToClipboard(`${targetUrl}/v1`, "Cursor URL")}
            >
              Copy URL
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
