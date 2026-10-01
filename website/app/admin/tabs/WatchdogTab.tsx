"use client";

import { useState, useEffect, useCallback } from "react";
import { WatchdogBriefing } from "./WatchdogBriefing";
import { WatchdogPanel } from "./WatchdogPanel";

// The "Watchdog" tab — CI health monitor + scheduled flywheel in one panel.

interface WatchRow {
  id: number;
  owner_login: string;
  target_type: string;
  target: string;
  interval_minutes: number;
  enabled: boolean;
  last_checked_at: string | null;
  last_status: string | null;
  last_issue_count: number | null;
  auto_fix_enabled: boolean;
  created_at: string;
}

// Parse a JSON body without losing the HTTP status when the body is not JSON.
async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const d = await res.json();
    return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
  } catch { /* error-ok — non-JSON body; the caller still reports res.status */
    return {};
  }
}

// "HTTP 401: unauthorized" — status plus the server's own reason.
function httpFailure(res: Response, data: Record<string, unknown>): string {
  const reason = data.error || data.message || res.statusText || "no reason given";
  return `HTTP ${res.status}: ${String(reason)}`;
}

export function WatchdogTab() {
  const [watches, setWatches] = useState<WatchRow[]>([]);
  const [watchesLoading, setWatchesLoading] = useState(false);
  const [watchTarget, setWatchTarget] = useState("");
  const [watchType, setWatchType] = useState<"repo" | "server">("repo");
  const [watchInterval, setWatchInterval] = useState(15);
  const [watchAutoFix, setWatchAutoFix] = useState(true);
  const [watchError, setWatchError] = useState("");
  const [watchAdding, setWatchAdding] = useState(false);
  // A failed read is shown as a failed read — never as the previous list or
  // as "No watches yet" (CLAUDE.md doctrine 1: ok / found / NOT CHECKED).
  const [watchesLoadError, setWatchesLoadError] = useState("");
  const [rowActionError, setRowActionError] = useState("");
  const [tickRunning, setTickRunning] = useState(false);
  const [tickOutcome, setTickOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  const loadWatches = useCallback(async () => {
    setWatchesLoading(true);
    try {
      const res = await fetch("/api/watches");
      const data = await readJsonBody(res);
      if (!res.ok) {
        setWatchesLoadError(`Could not load watches — ${httpFailure(res, data)}`);
        return;
      }
      setWatchesLoadError("");
      setWatches(Array.isArray(data.watches) ? (data.watches as WatchRow[]) : []);
    } catch (err) {
      setWatchesLoadError(`Could not load watches — ${err instanceof Error ? err.message : "network error"}`);
    } finally {
      setWatchesLoading(false);
    }
  }, []);

  async function rowAction(label: string, url: string, init: RequestInit) {
    setRowActionError("");
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const data = await readJsonBody(res);
        setRowActionError(`${label} failed — ${httpFailure(res, data)}`);
      }
    } catch (err) {
      setRowActionError(`${label} failed — ${err instanceof Error ? err.message : "network error"}`);
    }
    await loadWatches();
  }

  async function runTick() {
    setTickRunning(true);
    setTickOutcome(null);
    try {
      // POST: the tick spends scan + AI budget, so the admin-session path
      // runs the same-origin check (requireAdminRoute mutating) server-side.
      const res = await fetch("/api/watches/tick", { method: "POST" });
      const data = await readJsonBody(res);
      if (!res.ok) {
        setTickOutcome({ ok: false, text: `Tick failed — ${httpFailure(res, data)}` });
        return;
      }
      if (typeof data.checked !== "number") {
        setTickOutcome({ ok: false, text: `Tick not confirmed — HTTP ${res.status} response had no "checked" count` });
        return;
      }
      const results = Array.isArray(data.results) ? (data.results as Array<{ target?: string; outcome?: string }>) : [];
      const lines = results.map((r) => `${r.target ?? "?"}: ${r.outcome ?? "?"}`).join(", ");
      setTickOutcome({
        ok: true,
        text: `Tick ran — checked ${data.checked} due watch${data.checked === 1 ? "" : "es"}${lines ? ` (${lines})` : ""}.`,
      });
      await loadWatches();
    } catch (err) {
      setTickOutcome({ ok: false, text: `Tick failed — ${err instanceof Error ? err.message : "network error"}` });
    } finally {
      setTickRunning(false);
    }
  }

  useEffect(() => {
    loadWatches();
  }, [loadWatches]);

  async function addWatch() {
    setWatchError("");
    setWatchAdding(true);
    try {
      const res = await fetch("/api/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_type: watchType,
          target: watchTarget.trim(),
          interval_minutes: watchInterval,
          auto_fix_enabled: watchAutoFix,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setWatchError(data.error || "Failed to add watch"); return; }
      setWatchTarget("");
      await loadWatches();
    } catch (err) {
      setWatchError(err instanceof Error ? err.message : "Error");
    } finally {
      setWatchAdding(false);
    }
  }

  return (
    <>
      {/* Section 0: Intelligence briefing — fleet status, anomalies, AI diagnoses */}
      <WatchdogBriefing />

      {/* Section 1: CI Health Monitor (GitHub Actions status) */}
      <WatchdogPanel />

      {/* Section 2: Scheduled Flywheel (database-backed watches) */}
      <div className="mt-6 space-y-4">
        {/* Add watch form */}
        <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6">
          <h3 className="font-bold text-gray-900 mb-1 flex items-center gap-2">
            <span className="text-xl">🔄</span> Scheduled Flywheel
          </h3>
          <p className="text-xs text-gray-500 mb-4">
            GateTest scans a repo or server every N minutes and auto-fixes issues. Uses quick-tier scans for health checks.
          </p>
          <div className="grid sm:grid-cols-[auto,1fr,auto,auto,auto] gap-3 items-end">
            <select
              value={watchType}
              onChange={(e) => setWatchType(e.target.value as "repo" | "server")}
              className="px-3 py-2.5 rounded-lg border border-gray-300 bg-white text-gray-900 text-sm focus:border-emerald-500 focus:outline-none"
            >
              <option value="repo">Repo</option>
              <option value="server">Server</option>
            </select>
            <input
              type="text"
              value={watchTarget}
              onChange={(e) => {
                let v = e.target.value;
                // Auto-strip full GitHub/Gluecron URLs to owner/repo format
                if (watchType === "repo") {
                  const m = v.match(/(?:github\.com|gluecron\.com)\/([^/\s]+\/[^/\s?#]+)/);
                  if (m) v = m[1].replace(/\.git$/, "");
                }
                setWatchTarget(v);
              }}
              placeholder={watchType === "repo" ? "owner/repo or paste GitHub URL" : "https://example.com"}
              className="px-4 py-2.5 rounded-lg border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 text-sm focus:border-emerald-500 focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={watchInterval}
                onChange={(e) => setWatchInterval(Number(e.target.value))}
                min={5} max={1440}
                className="w-20 px-3 py-2.5 rounded-lg border border-gray-300 bg-white text-gray-900 text-sm focus:border-emerald-500 focus:outline-none text-center"
              />
              <span className="text-gray-500 text-xs whitespace-nowrap">min</span>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
              <input
                type="checkbox"
                checked={watchAutoFix}
                onChange={(e) => setWatchAutoFix(e.target.checked)}
                className="w-4 h-4 accent-emerald-500"
              />
              Auto-fix
            </label>
            <button
              disabled={watchAdding || !watchTarget.trim()}
              onClick={addWatch}
              className="btn-primary px-4 py-2.5 text-sm disabled:opacity-50"
            >
              {watchAdding ? "Adding..." : "Add Watch"}
            </button>
          </div>
          {watchError && <p className="text-red-600 text-xs mt-3">{watchError}</p>}
        </div>

        {/* Watch list */}
        <div className="rounded-xl bg-white border border-gray-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
            <span className="font-semibold text-gray-900 text-sm">Active Watches</span>
            <button onClick={loadWatches} className="text-xs text-gray-400 hover:text-emerald-600 transition-colors">↻ Refresh</button>
          </div>
          {rowActionError && (
            <p role="alert" className="px-5 py-3 text-xs text-red-700 bg-red-50 border-b border-red-200">{rowActionError}</p>
          )}
          {watchesLoading ? (
            <div className="p-8 text-center text-gray-400">Loading...</div>
          ) : watchesLoadError ? (
            <div role="alert" className="p-8 text-center text-red-700 text-sm">{watchesLoadError}</div>
          ) : watches.length === 0 ? (
            <div className="p-8 text-center text-gray-400">No watches yet. Add one above to start the flywheel.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="text-left px-4 py-3 text-gray-500 font-medium">Target</th>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium">Every</th>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium">Status</th>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium">Issues</th>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium">Auto-fix</th>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium">Last check</th>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {watches.map((w) => (
                    <tr key={w.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <span className="text-xs text-gray-400 mr-1">{w.target_type}</span>
                        <span className="text-gray-900 font-medium">{w.target}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-500">{w.interval_minutes}m</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          !w.enabled ? "bg-gray-100 text-gray-400" :
                          w.last_status === "healthy" ? "bg-emerald-100 text-emerald-700" :
                          w.last_status === "degraded" ? "bg-amber-100 text-amber-700" :
                          w.last_status === "down" ? "bg-red-100 text-red-700" :
                          "bg-gray-100 text-gray-400"
                        }`}>
                          {!w.enabled ? "paused" : w.last_status || "pending"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500">{w.last_issue_count ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium ${w.auto_fix_enabled ? "text-emerald-600" : "text-gray-400"}`}>
                          {w.auto_fix_enabled ? "✓ on" : "off"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {w.last_checked_at ? new Date(w.last_checked_at).toLocaleString() : "never"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => rowAction(w.enabled ? "Pause" : "Resume", `/api/watches?id=${w.id}`, {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ enabled: !w.enabled }),
                            })}
                            className="text-xs text-gray-400 hover:text-emerald-600 transition-colors"
                          >
                            {w.enabled ? "Pause" : "Resume"}
                          </button>
                          <button
                            onClick={async () => {
                              if (!confirm(`Remove watch for ${w.target}?`)) return;
                              await rowAction("Remove", `/api/watches?id=${w.id}`, { method: "DELETE" });
                            }}
                            className="text-xs text-gray-400 hover:text-red-600 transition-colors"
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Manual tick */}
        <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold text-gray-900 text-sm">Manual Tick</p>
              <p className="text-xs text-gray-500 mt-0.5">Force a watchdog cycle now — scans all due targets immediately.</p>
            </div>
            <button
              onClick={runTick}
              disabled={tickRunning}
              className="btn-primary px-4 py-2.5 text-sm disabled:opacity-50"
            >
              {tickRunning ? "Running..." : "Run Tick Now"}
            </button>
          </div>
          {tickOutcome && (
            <p
              role={tickOutcome.ok ? "status" : "alert"}
              className={`text-xs mt-3 ${tickOutcome.ok ? "text-emerald-700" : "text-red-700"}`}
            >
              {tickOutcome.text}
            </p>
          )}
          <p className="text-xs text-gray-400 mt-3">
            In production a scheduler on Tallrig must hit <code className="font-mono text-emerald-700">/api/watches/tick</code> (GET or POST) every ~5 min with{" "}
            <code className="font-mono text-emerald-700">Authorization: Bearer $CRON_SECRET</code>. This is <strong>not</strong> automatic —
            we left Vercel Cron behind, and if nothing is scheduled, watches never run at all.
          </p>
        </div>
      </div>
    </>
  );
}
