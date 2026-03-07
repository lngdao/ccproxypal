import { useEffect, useState, useCallback, useRef } from "react";
import { api, PoolStatus } from "../lib/invoke";
import Card, { CardTitle } from "./ui/Card";
import { StatusBadge } from "./ui/StatusDot";

export default function PoolPanel() {
  const [poolStatus, setPoolStatus] = useState<PoolStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const setErrorWithAutoDismiss = (msg: string, ms = 8000) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), ms);
  };

  const fetchPool = useCallback(async () => {
    try {
      const pool = await api.getPoolStatus();
      setPoolStatus(pool);
    } catch (e) {
      setErrorWithAutoDismiss(String(e));
    }
  }, []);

  useEffect(() => {
    fetchPool();
    const interval = setInterval(fetchPool, 5000);
    return () => clearInterval(interval);
  }, [fetchPool]);

  return (
    <div className="p-5 space-y-4 max-w-2xl mx-auto">
      {error && (
        <div className="bg-text-red/10 border border-text-red/30 text-text-red text-[12px] px-3 py-2 rounded-md">
          {error}
        </div>
      )}

      <Card>
        <CardTitle>Token Pool</CardTitle>
        <div className="mt-3 space-y-2">
          {poolStatus && poolStatus.total > 0 ? (
            <>
              <div className="text-[11px] text-text-muted mb-2">
                {poolStatus.healthy}/{poolStatus.total} healthy providers
              </div>
              {poolStatus.entries.map((entry) => (
                <div
                  key={entry.provider_id}
                  className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0"
                >
                  <div className="flex items-center gap-2">
                    <StatusBadge
                      active={entry.healthy && !entry.expired && !entry.stale}
                      label={entry.provider_id}
                    />
                  </div>
                  <span className="text-[11px] text-text-muted">
                    {entry.expired
                      ? "Expired"
                      : entry.stale
                        ? "Stale"
                        : !entry.healthy
                          ? "Unhealthy"
                          : "Active"}
                  </span>
                </div>
              ))}
            </>
          ) : (
            <p className="text-[11px] text-text-muted">
              No tokens in pool. Use "Host to Pool" in Proxy tab or run <code>npx ccproxypal provide --hub &lt;url&gt;</code> to add tokens.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
