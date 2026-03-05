import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Dashboard from "./components/Dashboard";
import SettingsPanel from "./components/SettingsPanel";
import AnalyticsPanel from "./components/AnalyticsPanel";
import ClientPanel from "./components/ClientPanel";
import "./App.css";

type Tab = "dashboard" | "client" | "analytics" | "settings";

const tabs: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "client", label: "Client" },
  { id: "analytics", label: "Analytics" },
  { id: "settings", label: "Settings" },
];

const tabVariants = {
  enter: { opacity: 0, filter: "blur(6px)", scale: 0.99 },
  center: { opacity: 1, filter: "blur(0px)", scale: 1 },
  exit: { opacity: 0, filter: "blur(6px)", scale: 0.99 },
};

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");

  const handleTabChange = (tab: Tab) => setActiveTab(tab);

  return (
    <div className="app">
      <header className="app-header">
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
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            variants={tabVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.18 }}
          >
            {activeTab === "dashboard" && <Dashboard />}
            {activeTab === "client" && <ClientPanel />}
            {activeTab === "analytics" && <AnalyticsPanel />}
            {activeTab === "settings" && <SettingsPanel />}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
