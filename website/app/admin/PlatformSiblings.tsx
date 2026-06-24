"use client";

/**
 * Platform Siblings health widget — shown inside the admin command center.
 *
 * Renders three cards (Vapron, Gluecron, GateTest) each surfacing up/down,
 * latency, and last-updated. Fetched from /api/admin/platform-siblings which
 * aggregates the public /api/platform-status endpoint on each sibling with
 * a 3s timeout and 30s server-side cache.
 */

import { useCallback, useEffect, useState } from "react";

type SiblingStatus = "up" | "down" | "unreachable";

interface SiblingResult {
  id: "vapron" | "gluecron" | "gatetest";
  name: string;
  url: string;
  status: SiblingStatus;
  healthy: boolean;
  latency_ms: number | null;
  version: string | null;
  commit: string | null;
  last_updated: string | null;
  error: string | null;
  checked_at: string;
}

interface AggregateReport {
  siblings: SiblingResult[];
  generated_at: string;
  cached: boolean;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function statusPalette(status: SiblingStatus) {
  switch (status) {
    case "up":
      return {
        dot: "bg-emerald-400",
        pulse: "bg-emerald-400/40",
        text: "text-emerald-300",
        label: "UP",
        border: "border-emerald-500/20",
      };
    case "down":
      return {
        dot: "bg-amber-400",
        pulse: "bg-amber-400/40",
        text: "text-amber-300",
        label: "DOWN",
        border: "border-amber-500/20",
      };
    case "unreachable":
    default:
      return {
        dot: "bg-red-400",
        pulse: "bg-red-400/40",
        text: "text-red-300",
        label: "UNREACHABLE",
        border: "border-red-500/20",
      };
  }
}

export default function PlatformSiblings() {
  const [report, setReport] = useState<AggregateReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/admin/platform-siblings", { cache: "no-store" });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as AggregateReport;
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Refresh every 30s (matches server cache TTL).
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <div className="rounded-xl bg-white/[0.04] border border-white/8 p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-bold text-white">Platform Family</h3>
          <p className="text-xs text-white/40">
            Live health across Vapron, Gluecron, and GateTest.
            {report?.cached && <span className="ml-1">(cached)</span>}
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-lg bg-white/5 text-white/60 border border-white/10 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50"
        >
          {loading && !report ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-300 mb-3">
          Could not load sibling health: <span className="font-mono">{error}</span>
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {(report?.siblings ?? [
          { id: "vapron" as const, name: "Vapron" },
          { id: "gluecron" as const, name: "Gluecron" },
          { id: "gatetest" as const, name: "GateTest" },
        ]).map((s) => {
          const full = "status" in s ? (s as SiblingResult) : null;
          const palette = full ? statusPalette(full.status) : statusPalette("unreachable");
          return (
            <div
              key={s.id}
              className={`rounded-lg bg-[#0a0a12] border ${full ? palette.border : "border-white/10"} p-4`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-white">{s.name}</span>
                {full ? (
                  <span className="flex items-center gap-1.5">
                    <span className="relative flex h-2 w-2">
                      <span
                        className={`animate-ping absolute inline-flex h-full w-full rounded-full ${palette.pulse} opacity-75`}
                      />
                      <span className={`relative inline-flex rounded-full h-2 w-2 ${palette.dot}`} />
                    </span>
                    <span className={`text-[10px] font-bold font-mono ${palette.text}`}>
                      {palette.label}
                    </span>
                  </span>
                ) : (
                  <span className="text-[10px] font-bold font-mono text-white/30">—</span>
                )}
              </div>

              <dl className="space-y-1 text-xs">
                <div className="flex items-center justify-between">
                  <dt className="text-white/40">Latency</dt>
                  <dd className="font-mono text-white/70">
                    {full?.latency_ms != null ? `${full.latency_ms}ms` : "—"}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-white/40">Last seen</dt>
                  <dd className="font-mono text-white/70" title={full?.last_updated ?? undefined}>
                    {full ? formatRelative(full.last_updated || full.checked_at) : "—"}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-white/40">Version</dt>
                  <dd className="font-mono text-white/70 truncate max-w-[140px]" title={full?.version ?? undefined}>
                    {full?.version ?? "—"}
                  </dd>
                </div>
                {full?.commit && (
                  <div className="flex items-center justify-between">
                    <dt className="text-white/40">Commit</dt>
                    <dd className="font-mono text-white/70">{full.commit.slice(0, 7)}</dd>
                  </div>
                )}
                {full?.error && (
                  <div className="pt-1 mt-1 border-t border-white/5">
                    <p className="text-[11px] text-red-300 font-mono truncate" title={full.error}>
                      {full.error}
                    </p>
                  </div>
                )}
              </dl>
            </div>
          );
        })}
      </div>

      {report?.generated_at && (
        <p className="text-[10px] text-white/30 mt-3 font-mono">
          Generated {formatRelative(report.generated_at)}
        </p>
      )}
    </div>
  );
}
