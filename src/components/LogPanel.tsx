import { useEffect, useRef, useState, useCallback } from "react";
import { useLogStore, LogEntry, LogLevel, LogSource } from "../lib/logStore";
import Button from "./ui/Button";

const LEVEL_COLORS: Record<LogLevel, string> = {
  info: "text-text-green",
  warn: "text-text-amber",
  error: "text-text-red",
  debug: "text-text-muted",
};

const ALL_LEVELS: LogLevel[] = ["info", "warn", "error", "debug"];
const ALL_SOURCES: LogSource[] = [
  "app",
  "fe",
  "be",
  "proxy",
  "tunnel",
  "telegram",
  "provider",
];

function formatTime(ts: number) {
  const d = new Date(ts);
  return (
    d.toLocaleTimeString("en-GB", { hour12: false }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

export default function LogPanel({
  onClose,
  height,
}: {
  onClose: () => void;
  height: number;
}) {
  const logs = useLogStore((s) => s.logs);
  const clear = useLogStore((s) => s.clear);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [levelFilter, setLevelFilter] = useState<Set<LogLevel>>(
    new Set(ALL_LEVELS)
  );
  const [sourceFilter, setSourceFilter] = useState<LogSource | "all">("all");

  const toggleLevel = useCallback((level: LogLevel) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        if (next.size > 1) next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }, []);

  const filtered = logs.filter(
    (entry) =>
      levelFilter.has(entry.level) &&
      (sourceFilter === "all" || entry.source === sourceFilter)
  );

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [filtered.length, autoScroll]);

  return (
    <div
      className="bg-bg-elevated border-t border-border flex flex-col shrink-0"
      style={{ height }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-text-secondary">
            Log
          </span>

          {/* Level filters */}
          <div className="flex gap-0.5 ml-2">
            {ALL_LEVELS.map((level) => (
              <button
                key={level}
                onClick={() => toggleLevel(level)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium cursor-pointer transition-colors ${
                  levelFilter.has(level)
                    ? `${LEVEL_COLORS[level]} bg-bg-hover`
                    : "text-text-muted/40 hover:text-text-muted"
                }`}
              >
                {level.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Source filter */}
          <select
            value={sourceFilter}
            onChange={(e) =>
              setSourceFilter(e.target.value as LogSource | "all")
            }
            className="bg-bg-elevated border border-border rounded px-1.5 py-0.5 text-[10px] text-text-muted outline-none cursor-pointer"
          >
            <option value="all">All sources</option>
            {ALL_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setAutoScroll((v) => !v)}
            className={`px-1.5 py-0.5 rounded text-[10px] cursor-pointer transition-colors ${
              autoScroll
                ? "text-accent bg-accent/10"
                : "text-text-muted hover:text-text-primary"
            }`}
            title={autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
          >
            Auto
          </button>
          <Button size="sm" onClick={clear}>
            Clear
          </Button>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto font-mono text-[11px] px-3 py-1">
        {filtered.length === 0 && (
          <div className="text-text-muted text-center py-4">No logs</div>
        )}
        {filtered.map((entry: LogEntry) => (
          <div
            key={entry.id}
            className="flex gap-3 py-[1px] hover:bg-bg-hover/20"
          >
            <span className="text-text-muted whitespace-nowrap shrink-0">
              {formatTime(entry.timestamp)}
            </span>
            <span
              className={`w-[42px] shrink-0 ${LEVEL_COLORS[entry.level]}`}
            >
              {entry.level.toUpperCase().padEnd(5)}
            </span>
            <span className="text-accent shrink-0 w-[70px] truncate">
              [{entry.source}]
            </span>
            <span className="text-text-primary break-all">{entry.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
