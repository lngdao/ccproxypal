import { create } from "zustand";

export type LogLevel = "info" | "warn" | "error" | "debug";
export type LogSource = "app" | "fe" | "be" | "proxy" | "tunnel" | "telegram" | "provider";

export interface LogEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  source: LogSource;
  message: string;
}

interface LogState {
  logs: LogEntry[];
  _nextId: number;
  addLog: (level: LogLevel, source: LogSource, message: string) => void;
  clear: () => void;
}

export const useLogStore = create<LogState>((set) => ({
  logs: [],
  _nextId: 1,
  addLog: (level, source, message) =>
    set((state) => {
      const newLogs = [
        ...state.logs,
        { id: state._nextId, timestamp: Date.now(), level, source, message },
      ];
      return {
        logs: newLogs.length > 500 ? newLogs.slice(-500) : newLogs,
        _nextId: state._nextId + 1,
      };
    }),
  clear: () => set({ logs: [], _nextId: 1 }),
}));

/** Convenience: log from anywhere */
export const log = {
  info: (source: LogSource, msg: string) => useLogStore.getState().addLog("info", source, msg),
  warn: (source: LogSource, msg: string) => useLogStore.getState().addLog("warn", source, msg),
  error: (source: LogSource, msg: string) => useLogStore.getState().addLog("error", source, msg),
  debug: (source: LogSource, msg: string) => useLogStore.getState().addLog("debug", source, msg),
};
