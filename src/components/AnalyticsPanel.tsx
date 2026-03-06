import { useEffect, useState } from "react";
import { api, AnalyticsSummary, RequestRecord } from "../lib/invoke";
import SegmentedControl from "./ui/SegmentedControl";
import Card from "./ui/Card";
import Button from "./ui/Button";

type Period = "hour" | "day" | "week" | "month" | "all";

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "hour", label: "Hour" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "all", label: "All" },
];

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

const SOURCE_COLORS: Record<string, string> = {
  claude_code: "text-text-green bg-text-green/10 border-text-green/20",
  api_key: "text-text-amber bg-text-amber/10 border-text-amber/20",
  error: "text-text-red bg-text-red/10 border-text-red/20",
};

const SOURCE_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  api_key: "API Key",
  error: "Error",
};

function SourceBadge({ source }: { source: RequestRecord["source"] }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold border ${SOURCE_COLORS[source]}`}
    >
      {SOURCE_LABELS[source]}
    </span>
  );
}

interface StatCardProps {
  value: string | number;
  label: string;
  accent?: "green" | "amber" | "red";
}

function StatCard({ value, label, accent }: StatCardProps) {
  const borderColors = {
    green: "border-l-text-green",
    amber: "border-l-text-amber",
    red: "border-l-text-red",
  };

  return (
    <div
      className={`bg-bg-card border border-border rounded-lg p-3 border-l-[3px] ${
        accent ? borderColors[accent] : "border-l-border"
      }`}
    >
      <div className="text-[18px] font-bold text-text-primary font-mono">
        {value}
      </div>
      <div className="text-[11px] text-text-muted mt-0.5">{label}</div>
    </div>
  );
}

const PAGE_SIZE = 20;

export default function AnalyticsPanel() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [period, setPeriod] = useState<Period>("day");
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [page, setPage] = useState(0);

  const load = async (p: Period) => {
    setLoading(true);
    try {
      const data = await api.getAnalytics(p, 500);
      setSummary(data);
      setPage(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(period);
  }, [period]);

  const handleReset = async () => {
    setResetting(true);
    try {
      await api.resetAnalytics();
      setSummary(null);
      await load(period);
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  };

  return (
    <div className="p-5 space-y-4 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <SegmentedControl
          options={PERIOD_OPTIONS}
          value={period}
          onChange={setPeriod}
          size="sm"
        />
        {confirmReset ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-text-muted">Are you sure?</span>
            <Button variant="danger" size="sm" loading={resetting} onClick={handleReset}>
              Confirm
            </Button>
            <Button size="sm" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="danger" size="sm" onClick={() => setConfirmReset(true)}>
            Reset
          </Button>
        )}
      </div>

      {loading || !summary ? (
        <div className="flex items-center justify-center h-40 text-text-muted text-sm">
          Loading...
        </div>
      ) : (
        <>
          {/* Stats grid — 2 rows of 4 */}
          <div className="grid grid-cols-4 gap-3">
            <StatCard value={summary.total_requests} label="Total Requests" />
            <StatCard
              value={summary.claude_code_requests}
              label="Claude Code"
              accent="green"
            />
            <StatCard
              value={summary.api_key_requests}
              label="API Key (Paid)"
              accent="amber"
            />
            <StatCard
              value={summary.error_requests}
              label="Errors"
              accent="red"
            />
            <StatCard
              value={formatTokens(summary.total_input_tokens)}
              label="Input Tokens"
            />
            <StatCard
              value={formatTokens(summary.total_output_tokens)}
              label="Output Tokens"
            />
            <StatCard
              value={formatCost(summary.total_cost)}
              label="Paid Cost"
              accent="red"
            />
            <StatCard
              value={formatCost(summary.estimated_savings)}
              label="Estimated Savings"
              accent="green"
            />
          </div>

          {/* Request table */}
          <Card>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[13px] font-semibold text-text-primary">
                Recent Requests ({summary.requests.length})
              </span>
            </div>

            {summary.requests.length === 0 ? (
              <div className="text-center py-8 text-text-muted text-sm">
                No requests yet. Start the proxy and make some API calls.
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border text-left">
                        <th className="py-2 px-2 text-text-muted font-medium sticky top-0 bg-bg-card">
                          Time
                        </th>
                        <th className="py-2 px-2 text-text-muted font-medium sticky top-0 bg-bg-card">
                          Model
                        </th>
                        <th className="py-2 px-2 text-text-muted font-medium sticky top-0 bg-bg-card">
                          Source
                        </th>
                        <th className="py-2 px-2 text-text-muted font-medium sticky top-0 bg-bg-card">
                          In
                        </th>
                        <th className="py-2 px-2 text-text-muted font-medium sticky top-0 bg-bg-card">
                          Out
                        </th>
                        <th className="py-2 px-2 text-text-muted font-medium sticky top-0 bg-bg-card">
                          Cost
                        </th>
                        <th className="py-2 px-2 text-text-muted font-medium sticky top-0 bg-bg-card">
                          Latency
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.requests
                        .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
                        .map((req) => (
                          <tr
                            key={req.id}
                            className={`border-b border-border/30 hover:bg-bg-hover/30 ${
                              req.source === "error" ? "bg-text-red/5" : ""
                            }`}
                          >
                            <td className="py-1.5 px-2 font-mono text-[11px] text-text-muted whitespace-nowrap">
                              {formatTime(req.timestamp)}
                            </td>
                            <td className="py-1.5 px-2 font-mono text-[11px] max-w-[140px] truncate">
                              {req.model}
                            </td>
                            <td className="py-1.5 px-2">
                              <SourceBadge source={req.source} />
                            </td>
                            <td className="py-1.5 px-2 font-mono">
                              {formatTokens(req.input_tokens)}
                            </td>
                            <td className="py-1.5 px-2 font-mono">
                              {formatTokens(req.output_tokens)}
                            </td>
                            <td className="py-1.5 px-2 font-mono">
                              {formatCost(req.estimated_cost)}
                            </td>
                            <td className="py-1.5 px-2 font-mono">
                              {req.latency_ms != null
                                ? `${req.latency_ms}ms`
                                : "\u2014"}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {(() => {
                  const totalPages = Math.ceil(
                    summary.requests.length / PAGE_SIZE
                  );
                  if (totalPages <= 1) return null;
                  return (
                    <div className="flex items-center justify-between pt-3">
                      <Button
                        size="sm"
                        onClick={() => setPage((p) => p - 1)}
                        disabled={page === 0}
                      >
                        Prev
                      </Button>
                      <span className="text-[11px] text-text-muted">
                        Page {page + 1} of {totalPages}
                      </span>
                      <Button
                        size="sm"
                        onClick={() => setPage((p) => p + 1)}
                        disabled={page >= totalPages - 1}
                      >
                        Next
                      </Button>
                    </div>
                  );
                })()}
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
