import { useEffect, useState } from "react";
import { api, AnalyticsSummary, RequestRecord } from "../lib/invoke";

type Period = "hour" | "day" | "week" | "month" | "all";

function formatCost(cost: number) {
  if (cost === 0) return "$0.00";
  if (cost < 0.001) return `$${cost.toFixed(6)}`;
  return `$${cost.toFixed(4)}`;
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleString();
}

function SourceBadge({ source }: { source: RequestRecord["source"] }) {
  const colors: Record<string, string> = {
    claude_code: "#22c55e",
    api_key: "#f59e0b",
    error: "#ef4444",
  };
  const labels: Record<string, string> = {
    claude_code: "Claude Code",
    api_key: "API Key",
    error: "Error",
  };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        backgroundColor: colors[source] + "22",
        color: colors[source],
        border: `1px solid ${colors[source]}44`,
      }}
    >
      {labels[source]}
    </span>
  );
}

export default function AnalyticsPanel() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [period, setPeriod] = useState<Period>("day");
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = async (p: Period) => {
    setLoading(true);
    try {
      const data = await api.getAnalytics(p, 100);
      setSummary(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(period);
  }, [period]);

  const handleReset = async () => {
    if (!confirm("Reset all analytics data? This cannot be undone.")) return;
    setResetting(true);
    await api.resetAnalytics();
    await load(period);
    setResetting(false);
  };

  return (
    <div className="analytics">
      {/* Period selector */}
      <div className="period-row">
        <div className="period-tabs">
          {(["hour", "day", "week", "month", "all"] as Period[]).map((p) => (
            <button
              key={p}
              className={`tab-btn ${period === p ? "active" : ""}`}
              onClick={() => setPeriod(p)}
            >
              {p === "all" ? "All time" : `Last ${p}`}
            </button>
          ))}
        </div>
        <button
          className="btn btn-small btn-danger"
          onClick={handleReset}
          disabled={resetting}
        >
          {resetting ? "..." : "Reset"}
        </button>
      </div>

      {loading || !summary ? (
        <div className="loading">Loading...</div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-value">{summary.total_requests}</div>
              <div className="stat-label">Total Requests</div>
            </div>
            <div className="stat-card green">
              <div className="stat-value">{summary.claude_code_requests}</div>
              <div className="stat-label">Claude Code (Free)</div>
            </div>
            <div className="stat-card amber">
              <div className="stat-value">{summary.api_key_requests}</div>
              <div className="stat-label">API Key (Paid)</div>
            </div>
            <div className="stat-card red">
              <div className="stat-value">{summary.error_requests}</div>
              <div className="stat-label">Errors</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{formatTokens(summary.total_input_tokens)}</div>
              <div className="stat-label">Input Tokens</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{formatTokens(summary.total_output_tokens)}</div>
              <div className="stat-label">Output Tokens</div>
            </div>
            <div className="stat-card red">
              <div className="stat-value">{formatCost(summary.total_cost)}</div>
              <div className="stat-label">Paid Cost</div>
            </div>
            <div className="stat-card green">
              <div className="stat-value">{formatCost(summary.estimated_savings)}</div>
              <div className="stat-label">Estimated Savings</div>
            </div>
          </div>

          {/* Requests table */}
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-title" style={{ marginBottom: 12 }}>
              Recent Requests ({summary.requests.length})
            </div>
            {summary.requests.length === 0 ? (
              <div className="empty-state">No requests yet. Start the proxy and make some API calls.</div>
            ) : (
              <div className="table-wrapper">
                <table className="requests-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Model</th>
                      <th>Source</th>
                      <th>In</th>
                      <th>Out</th>
                      <th>Cost</th>
                      <th>Latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.requests.map((req) => (
                      <tr key={req.id} className={req.source === "error" ? "row-error" : ""}>
                        <td className="mono" style={{ fontSize: 11 }}>
                          {formatTime(req.timestamp)}
                        </td>
                        <td className="mono" style={{ fontSize: 11, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {req.model}
                        </td>
                        <td>
                          <SourceBadge source={req.source} />
                        </td>
                        <td className="mono">{formatTokens(req.input_tokens)}</td>
                        <td className="mono">{formatTokens(req.output_tokens)}</td>
                        <td className="mono">{formatCost(req.estimated_cost)}</td>
                        <td className="mono">
                          {req.latency_ms != null ? `${req.latency_ms}ms` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
