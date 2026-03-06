import { useEffect, useState, useCallback } from "react";
import { create } from "zustand";

interface ToastItem {
  id: number;
  message: string;
  type: "success" | "error" | "info";
}

interface ToastState {
  toasts: ToastItem[];
  _nextId: number;
  add: (message: string, type?: ToastItem["type"]) => void;
  remove: (id: number) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  _nextId: 1,
  add: (message, type = "info") =>
    set((s) => ({
      toasts: [...s.toasts, { id: s._nextId, message, type }],
      _nextId: s._nextId + 1,
    })),
  remove: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  success: (msg: string) => useToastStore.getState().add(msg, "success"),
  error: (msg: string) => useToastStore.getState().add(msg, "error"),
  info: (msg: string) => useToastStore.getState().add(msg, "info"),
};

function ToastItem({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onDismiss, 200);
    }, 2500);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const colors = {
    success: "border-text-green/40 bg-text-green/10 text-text-green",
    error: "border-text-red/40 bg-text-red/10 text-text-red",
    info: "border-accent/40 bg-accent/10 text-accent",
  };

  return (
    <div
      className={`border rounded-md px-3 py-2 text-[12px] font-medium shadow-lg backdrop-blur-sm transition-all duration-200 ${
        colors[item.type]
      } ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}`}
    >
      {item.message}
    </div>
  );
}

export default function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);
  const stableRemove = useCallback((id: number) => remove(id), [remove]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-10 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} item={t} onDismiss={() => stableRemove(t.id)} />
      ))}
    </div>
  );
}
