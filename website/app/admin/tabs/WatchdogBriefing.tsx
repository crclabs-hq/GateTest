"use client";

import { useState, useEffect, useCallback } from "react";

// Watchdog Briefing — fleet status + anomalies + AI diagnoses (last 24h)

interface BriefingStats {
  watchesEnabled: number;
  healthy: number;
  degraded: number;
  down: number;
  scans24h: number;
  anomalies24h: number;
  prsOpened24h: number;
  fixesFailed24h: number;
  diagnoses24h: number;
}

export function WatchdogBriefing() {
  const [markdown, setMarkdown] = useState("");
  const [stats, setStats] = useState<BriefingStats | null>(null);
  const [briefingError, setBriefingError] = useState("");
  const [briefingLoading, setBriefingLoading] = useState(true);

  const loadBriefing = useCallback(async () => {
    setBriefingLoading(true);
    setBriefingError("");
    try {
      const res = await fetch("/api/admin/watchdog/briefing");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMarkdown(data.markdown || "");
      setStats(data.stats || null);
    } catch (err) {
      setBriefingError(err instanceof Error ? err.message : "Failed to load briefing");
    } finally {
      setBriefingLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBriefing();
  }, [loadBriefing]);

  return (
    <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6 mb-6">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-bold text-gray-900 flex items-center gap-2">
          <span className="text-xl">🧠</span> Watchdog Briefing
        </h3>
        <button
          onClick={loadBriefing}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:border-emerald-500 hover:text-emerald-700 transition-colors"
        >
          Refresh
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Last 24h across every watch: anomalies, status transitions, auto-fix outcomes, and Claude root-cause
        diagnoses written by the tick&apos;s intelligence layer.
      </p>

      {briefingLoading ? (
        <div className="p-6 text-center text-gray-400 text-sm">Loading briefing…</div>
      ) : briefingError ? (
        <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm">
          Briefing unavailable: {briefingError}
        </div>
      ) : (
        <>
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-center">
                <div className="text-lg font-bold text-emerald-700">{stats.healthy}</div>
                <div className="text-[11px] text-emerald-700/70">healthy</div>
              </div>
              <div className={`rounded-lg px-3 py-2 text-center border ${stats.degraded + stats.down > 0 ? "bg-red-50 border-red-200" : "bg-gray-50 border-gray-200"}`}>
                <div className={`text-lg font-bold ${stats.degraded + stats.down > 0 ? "text-red-700" : "text-gray-500"}`}>{stats.degraded + stats.down}</div>
                <div className={`text-[11px] ${stats.degraded + stats.down > 0 ? "text-red-700/70" : "text-gray-400"}`}>degraded / down</div>
              </div>
              <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-center">
                <div className="text-lg font-bold text-gray-700">{stats.anomalies24h}</div>
                <div className="text-[11px] text-gray-500">anomalies 24h</div>
              </div>
              <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-center">
                <div className="text-lg font-bold text-gray-700">{stats.prsOpened24h}</div>
                <div className="text-[11px] text-gray-500">fix PRs 24h</div>
              </div>
              <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-center">
                <div className="text-lg font-bold text-gray-700">{stats.diagnoses24h}</div>
                <div className="text-[11px] text-gray-500">AI diagnoses 24h</div>
              </div>
            </div>
          )}
          <pre className="whitespace-pre-wrap text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-4 font-mono leading-relaxed max-h-96 overflow-y-auto">
            {markdown || "No briefing data yet — the first tick will populate it."}
          </pre>
        </>
      )}
    </div>
  );
}
