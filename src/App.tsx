import { useState } from "react";
import Dashboard from "./components/Dashboard";
import SettingsPanel from "./components/SettingsPanel";
import AnalyticsPanel from "./components/AnalyticsPanel";
import "./App.css";

type Tab = "dashboard" | "analytics" | "settings";

const tabs: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "analytics", label: "Analytics" },
  { id: "settings", label: "Settings" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <span className="app-icon">⚡</span>
          ccproxypal
        </div>
        <nav className="tab-nav">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`tab-nav-btn ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="app-main">
        {activeTab === "dashboard" && <Dashboard />}
        {activeTab === "analytics" && <AnalyticsPanel />}
        {activeTab === "settings" && <SettingsPanel />}
      </main>
    </div>
  );
}
