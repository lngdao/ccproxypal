import { useEffect, useRef } from "react";
import { useLogStore, LogEntry, LogLevel } from "../lib/logStore";

const levelColor: Record<LogLevel, string> = {
  info: "var(--text-green)",
  warn: "var(--text-amber)",
  error: "var(--text-red)",
  debug: "var(--text-muted)",
};

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export default function LogPanel({ onClose }: { onClose: () => void }) {
  const logs = useLogStore((s) => s.logs);
  const clear = useLogStore((s) => s.clear);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  return (
    <div className="log-panel">
      <div className="log-panel-header">
        <span className="log-panel-title">Log</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-small btn-secondary" onClick={clear}>
            Clear
          </button>
          <button className="btn btn-small btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="log-panel-body">
        {logs.length === 0 && (
          <div className="empty-state" style={{ padding: 16 }}>No logs yet</div>
        )}
        {logs.map((entry: LogEntry) => (
          <div key={entry.id} className="log-entry">
            <span className="log-time">{formatTime(entry.timestamp)}</span>
            <span className="log-level" style={{ color: levelColor[entry.level] }}>
              {entry.level.toUpperCase().padEnd(5)}
            </span>
            <span className="log-source">[{entry.source}]</span>
            <span className="log-msg">{entry.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
