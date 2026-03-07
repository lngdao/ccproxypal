import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import ProxyPanel from "./components/ProxyPanel";
import ToolsPanel from "./components/ToolsPanel";
import PoolPanel from "./components/PoolPanel";
import SettingsPanel from "./components/SettingsPanel";
import AnalyticsPanel from "./components/AnalyticsPanel";
import LogPanel from "./components/LogPanel";
import ToastContainer from "./components/ui/Toast";
import { useLogStore, LogLevel, LogSource } from "./lib/logStore";

type Tab = "proxy" | "tools" | "pool" | "analytics" | "settings";
type Mode = "solo" | "hub-host" | "hub-consumer";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  {
    id: "proxy",
    label: "Proxy",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path
          d="M10 3L3 7v6l7 4 7-4V7l-7-4z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M3 7l7 4m0 0l7-4m-7 4v7" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    id: "pool",
    label: "Pool",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="6" r="3" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="5" cy="14" r="2.5" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="15" cy="14" r="2.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 9v2.5M7.5 12l-1 0M12.5 12l1 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "tools",
    label: "Tools",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path
          d="M12.5 3.5a3.5 3.5 0 0 1 4 4l-1.5 1.5-4-4L12.5 3.5z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M11 5L3.5 12.5a1.5 1.5 0 0 0 0 2.12l1.88 1.88a1.5 1.5 0 0 0 2.12 0L15 9"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    id: "analytics",
    label: "Analytics",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path
          d="M3 17V10M8 17V6M13 17V8M18 17V3"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: "settings",
    label: "Settings",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M10 2v2m0 12v2M3.5 5l1.4 1.4m10.2 7.2l1.4 1.4M2 10h2m12 0h2M3.5 15l1.4-1.4m10.2-7.2l1.4-1.4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("proxy");
  const [logOpen, setLogOpen] = useState(false);
  const [logHeight, setLogHeight] = useState(240);
  const [appVersion, setAppVersion] = useState("");
  const [mode, setMode] = useState<Mode>("solo");
  const [hubUrl, setHubUrl] = useState("");
  const [hubSecret, setHubSecret] = useState("");
  const logCount = useLogStore((s) => s.logs.length);
  const addLog = useLogStore((s) => s.addLog);
  const resizing = useRef(false);

  const toggleLog = useCallback(() => setLogOpen((v) => !v), []);

  useEffect(() => {
    getVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    const unlisten = listen<{
      level: string;
      source: string;
      message: string;
    }>("app-log", (event) => {
      const { level, source, message } = event.payload;
      addLog(level as LogLevel, source as LogSource, message);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [addLog]);

  // Resize handler for log panel
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    const startY = e.clientY;
    const startH = logHeight;

    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const delta = startY - ev.clientY;
      setLogHeight(Math.max(120, Math.min(500, startH + delta)));
    };
    const onUp = () => {
      resizing.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [logHeight]);

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      {/* Sidebar */}
      <aside className="flex flex-col items-center w-[48px] bg-bg-elevated border-r border-border shrink-0">
        <div className="flex flex-col items-center gap-1 pt-3 flex-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex items-center justify-center w-9 h-9 rounded-lg cursor-pointer transition-colors group ${
                activeTab === tab.id
                  ? "text-text-primary bg-bg-hover"
                  : "text-text-muted hover:text-text-primary hover:bg-bg-hover/50"
              }`}
              title={tab.label}
            >
              {activeTab === tab.id && (
                <motion.div
                  layoutId="sidebar-indicator"
                  className="absolute left-0 top-1 bottom-1 w-[2px] bg-accent rounded-r"
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              )}
              {tab.icon}
            </button>
          ))}
        </div>

        {/* Bottom: log toggle */}
        <div className="pb-2">
          <button
            onClick={toggleLog}
            className={`relative flex items-center justify-center w-9 h-9 rounded-lg cursor-pointer transition-colors ${
              logOpen
                ? "text-accent bg-accent/10"
                : "text-text-muted hover:text-text-primary hover:bg-bg-hover/50"
            }`}
            title={`Log${logCount > 0 ? ` (${logCount})` : ""}`}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M3 4h12M3 7h8M3 10h10M3 13h6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            {logCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-accent text-[9px] text-white font-bold px-0.5">
                {logCount > 99 ? "99+" : logCount}
              </span>
            )}
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Content */}
        <main className="flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="h-full"
            >
              {activeTab === "proxy" && (
                <ProxyPanel
                  mode={mode}
                  onModeChange={setMode}
                  hubUrl={hubUrl}
                  onHubUrlChange={setHubUrl}
                  hubSecret={hubSecret}
                  onHubSecretChange={setHubSecret}
                />
              )}
              {activeTab === "tools" && (
                <ToolsPanel mode={mode} hubUrl={hubUrl} />
              )}
              {activeTab === "pool" && <PoolPanel />}
              {activeTab === "analytics" && <AnalyticsPanel />}
              {activeTab === "settings" && <SettingsPanel />}
            </motion.div>
          </AnimatePresence>
        </main>

        {/* Log panel */}
        {logOpen && (
          <>
            <div
              className="h-1 cursor-row-resize bg-border/50 hover:bg-accent/50 transition-colors shrink-0"
              onMouseDown={handleResizeStart}
            />
            <LogPanel onClose={toggleLog} height={logHeight} />
          </>
        )}

        {/* Status bar */}
        <footer className="flex items-center justify-end h-[26px] px-3 bg-bg-elevated border-t border-border text-[11px] shrink-0">
          <span className="text-text-muted font-mono">
            ccproxypal{appVersion ? ` v${appVersion}` : ""}
          </span>
        </footer>
      </div>

      <ToastContainer />
    </div>
  );
}
