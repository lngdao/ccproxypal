import { useState, useCallback, useEffect } from "react";
import { motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import Dashboard from "./components/Dashboard";
import SettingsPanel from "./components/SettingsPanel";
import AnalyticsPanel from "./components/AnalyticsPanel";
import ClientPanel from "./components/ClientPanel";
import LogPanel from "./components/LogPanel";
import { useLogStore, LogLevel, LogSource } from "./lib/logStore";
import "./App.css";

type Tab = "dashboard" | "client" | "analytics" | "settings";

const tabs: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "client", label: "Client" },
  { id: "analytics", label: "Analytics" },
  { id: "settings", label: "Settings" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [logOpen, setLogOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const logCount = useLogStore((s) => s.logs.length);
  const addLog = useLogStore((s) => s.addLog);

  const handleTabChange = (tab: Tab) => setActiveTab(tab);
  const toggleLog = useCallback(() => setLogOpen((v) => !v), []);

  useEffect(() => {
    getVersion().then(setAppVersion);
  }, []);

  // Listen for backend log events
  useEffect(() => {
    const unlisten = listen<{ level: string; source: string; message: string }>(
      "app-log",
      (event) => {
        const { level, source, message } = event.payload;
        addLog(level as LogLevel, source as LogSource, message);
      }
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [addLog]);

  return (
    <div className="app">
      <header className="app-header" style={{ marginTop: "10px" }}>
        <motion.nav
          className="tab-nav"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`tab-nav-btn ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => handleTabChange(tab.id)}
            >
              {tab.label}
              {activeTab === tab.id && (
                <motion.span
                  className="tab-active-indicator"
                  layoutId="tab-indicator"
                  transition={{ type: "spring", stiffness: 400, damping: 35 }}
                />
              )}
            </button>
          ))}
        </motion.nav>
      </header>

      <main className="app-main">
        <div className="tab-panel" style={{ display: activeTab === "dashboard" ? "block" : "none" }}>
          <Dashboard />
        </div>
        <div className="tab-panel" style={{ display: activeTab === "client" ? "block" : "none" }}>
          <ClientPanel />
        </div>
        <div className="tab-panel" style={{ display: activeTab === "analytics" ? "block" : "none" }}>
          <AnalyticsPanel />
        </div>
        <div className="tab-panel" style={{ display: activeTab === "settings" ? "block" : "none" }}>
          <SettingsPanel />
        </div>
      </main>

      {logOpen && <LogPanel onClose={toggleLog} />}

      <footer className="status-bar">
        <div className="status-bar-left">
          <button className="status-bar-btn" onClick={toggleLog}>
            Log{logCount > 0 ? ` (${logCount})` : ""}
          </button>
        </div>
        <div className="status-bar-right">
          <span className="status-bar-text">ccproxypal{appVersion ? ` v${appVersion}` : ""}</span>
        </div>
      </footer>
    </div>
  );
}
