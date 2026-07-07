"use client";

import { useState, useEffect, useCallback } from "react";

// Watchdog Panel — multi-repo CI health + batch scan-and-fix

interface RepoInfo {
  id: number;
  full_name: string;
  name: string;
  html_url: string;
  private: boolean;
  pushed_at: string;
  pushedAgeDays: number | null;
  default_branch: string;
  latestRun: { conclusion: string | null; status: string; created_at: string; html_url: string; head_branch: string; name: string } | null;
  latestRunAgeDays: number | null;
  ciStatus: "passing" | "failing" | "pending" | "none" | "stale";
}

// Anything older than this on the default branch is treated as stale —
// the operator should never auto-fix code whose last CI signal is from
// months ago, because the file under that finding has probably already
// moved on and the fix loop would patch the wrong line.
const STALE_RUN_DAYS = 30;

interface RepoScanState {
  status: "idle" | "scanning" | "fixing" | "done" | "error";
  prUrl?: string;
  error?: string;
  issues?: number;
}

export function WatchdogPanel() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "failing">("failing");
  const [scanStates, setScanStates] = useState<Record<string, RepoScanState>>({});
  const [batchRunning, setBatchRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/repos");
      if (!res.ok) {
        const d = await res.json();
        setError(d.error || `HTTP ${res.status}`);
        return;
      }
      const d = await res.json();
      setRepos(d.repos || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load repos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function scanAndFix(repo: RepoInfo) {
    // Guard rail — if the operator is single-clicking a stale repo, make sure
    // they meant it. The scan itself is always fresh, but a "Fix PR" against
    // a repo that hasn't been touched in months is almost certainly not what
    // they want (file may have moved, branch may be dead, etc.).
    if (repo.ciStatus === "stale") {
      const ageNote = repo.latestRunAgeDays !== null
        ? `Last CI run: ${repo.latestRunAgeDays} days ago.`
        : (repo.pushedAgeDays !== null ? `Last push: ${repo.pushedAgeDays} days ago.` : "Repo looks inactive.");
      const ok = window.confirm(
        `${repo.full_name} is marked STALE.\n\n${ageNote}\n\n` +
        `A fresh scan will run, but auto-fix on stale code can target lines that have already moved. ` +
        `Proceed anyway?`
      );
      if (!ok) return;
    }
    setScanStates((s) => ({ ...s, [repo.full_name]: { status: "scanning" } }));
    try {
      // Step 1: scan
      const scanRes = await fetch("/api/scan/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: repo.html_url, tier: "full" }),
      });
      const scanData = await scanRes.json();
      const issues = (scanData.totalIssues as number) || 0;

      if (issues === 0) {
        setScanStates((s) => ({ ...s, [repo.full_name]: { status: "done", issues: 0 } }));
        return;
      }

      // Step 2: fix
      setScanStates((s) => ({ ...s, [repo.full_name]: { status: "fixing", issues } }));
      const fixableIssues = (scanData.fixableIssues as Array<{ file: string; issue: string; module: string }>) || [];

      if (fixableIssues.length === 0) {
        setScanStates((s) => ({ ...s, [repo.full_name]: { status: "done", issues, error: "No auto-fixable issues" } }));
        return;
      }

      const fixRes = await fetch("/api/scan/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: repo.html_url, issues: fixableIssues, tier: "full" }),
      });
      const fixData = await fixRes.json();
      setScanStates((s) => ({
        ...s,
        [repo.full_name]: {
          status: "done",
          issues,
          prUrl: fixData.prUrl,
          error: fixData.prUrl ? undefined : (fixData.error || fixData.message),
        },
      }));
      // Refresh repo list so CI status reflects any changes
      void load();
    } catch (err) {
      setScanStates((s) => ({
        ...s,
        [repo.full_name]: { status: "error", error: err instanceof Error ? err.message : "Failed" },
      }));
    }
  }

  async function fixAllFailing() {
    // Batch fix ONLY touches repos whose latest CI run is on the default branch
    // AND was within STALE_RUN_DAYS. Anything older is excluded — the operator
    // can still click "Scan & Fix" on a stale repo individually (which triggers
    // a confirm prompt), but they can never get there via the batch button.
    const failing = repos.filter(
      (r) =>
        r.ciStatus === "failing" &&
        (r.latestRunAgeDays === null || r.latestRunAgeDays <= STALE_RUN_DAYS)
    );
    setBatchRunning(true);
    for (const repo of failing) {
      const current = scanStates[repo.full_name];
      if (current?.status === "scanning" || current?.status === "fixing") continue;
      await scanAndFix(repo);
    }
    setBatchRunning(false);
  }

  const displayed = filter === "failing" ? repos.filter((r) => r.ciStatus === "failing") : repos;
  const failCount = repos.filter(
    (r) =>
      r.ciStatus === "failing" &&
      (r.latestRunAgeDays === null || r.latestRunAgeDays <= STALE_RUN_DAYS)
  ).length;
  const staleCount = repos.filter((r) => r.ciStatus === "stale").length;
  const passCount = repos.filter((r) => r.ciStatus === "passing").length;

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">CI Watchdog</h2>
            <p className="text-xs text-gray-500 mt-0.5">All your repos. Failing ones first. GateTest fixes them.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} disabled={loading} className="btn-secondary px-3 py-2 text-xs disabled:opacity-50">
              {loading ? "Loading…" : "Refresh"}
            </button>
            {failCount > 0 && (
              <button
                onClick={fixAllFailing}
                disabled={batchRunning || loading}
                className="btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-50"
                style={{ background: "#059669" }}
              >
                {batchRunning ? "Fixing…" : `⚡ Fix All ${failCount} Failing`}
              </button>
            )}
          </div>
        </div>

        {/* Stats row */}
        {!loading && repos.length > 0 && (
          <div className="flex items-center gap-4 text-xs flex-wrap">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-400" />
              <span className="text-gray-700"><strong className="text-red-600">{failCount}</strong> failing (recent)</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span className="text-gray-700"><strong className="text-emerald-600">{passCount}</strong> passing</span>
            </span>
            {staleCount > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-gray-400" />
                <span className="text-gray-700"><strong className="text-gray-600">{staleCount}</strong> stale ({STALE_RUN_DAYS}+ days)</span>
              </span>
            )}
            <span className="text-gray-400">{repos.length} total repos</span>
          </div>
        )}
      </div>

      {/* Filter tabs */}
      {!loading && repos.length > 0 && (
        <div className="flex gap-1">
          {(["failing", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                filter === f
                  ? "bg-gray-200 text-gray-900"
                  : "text-gray-400 hover:text-gray-700"
              }`}
            >
              {f === "failing" ? `Failing (${failCount})` : `All repos (${repos.length})`}
            </button>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700">
          <strong>Could not load repos:</strong> {error}
          {error.includes("token") && (
            <p className="mt-2 text-xs text-red-700/70">Set <code className="font-mono">GATETEST_GITHUB_TOKEN</code> or <code className="font-mono">GITHUB_TOKEN</code> in your Vercel environment variables.</p>
          )}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="rounded-xl bg-white border border-gray-200 shadow-sm p-4 animate-pulse">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-gray-200" />
                <div className="h-4 bg-gray-200 rounded w-48" />
                <div className="ml-auto h-3 bg-gray-200 rounded w-20" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Repo list */}
      {!loading && displayed.length === 0 && !error && (
        <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-8 text-center text-gray-400">
          {filter === "failing" ? "No failing workflows — all green! 🎉" : "No repos found."}
        </div>
      )}

      {!loading && displayed.map((repo) => {
        const state = scanStates[repo.full_name];
        const isWorking = state?.status === "scanning" || state?.status === "fixing";

        const ciDot =
          repo.ciStatus === "failing" ? "bg-red-400" :
          repo.ciStatus === "passing" ? "bg-emerald-400" :
          repo.ciStatus === "pending" ? "bg-amber-400 animate-pulse" :
          repo.ciStatus === "stale" ? "bg-gray-400" :
          "bg-gray-300";

        const ciLabel =
          repo.ciStatus === "failing" ? "FAILING" :
          repo.ciStatus === "passing" ? "PASSING" :
          repo.ciStatus === "pending" ? "PENDING" :
          repo.ciStatus === "stale" ? "STALE" : "NO CI";

        const ciColor =
          repo.ciStatus === "failing" ? "text-red-600" :
          repo.ciStatus === "passing" ? "text-emerald-600" :
          repo.ciStatus === "pending" ? "text-amber-600" :
          repo.ciStatus === "stale" ? "text-gray-500" : "text-gray-400";

        // Human age — "today", "3 days ago", "47 days ago". The April-dated
        // surprises Craig flagged surface here, prominently, so the operator
        // can never miss them.
        const ageLabel =
          repo.latestRunAgeDays === null ? null :
          repo.latestRunAgeDays === 0 ? "today" :
          repo.latestRunAgeDays === 1 ? "yesterday" :
          `${repo.latestRunAgeDays} days ago`;

        return (
          <div
            key={repo.id}
            className={`rounded-xl bg-white border shadow-sm p-4 ${
              repo.ciStatus === "failing" ? "border-l-4 border-l-red-500 border-red-200" :
              repo.ciStatus === "passing" ? "border-l-4 border-l-emerald-500 border-emerald-200" :
              repo.ciStatus === "stale" ? "border-l-4 border-l-gray-400 border-gray-200 opacity-80" : "border-gray-200"
            }`}
          >
            <div className="flex flex-wrap items-center gap-3">
              {/* Status dot */}
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${ciDot}`} />

              {/* Repo name */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={repo.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-sm font-semibold text-gray-900 hover:text-emerald-700 transition-colors"
                  >
                    {repo.full_name}
                  </a>
                  {repo.private && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">private</span>
                  )}
                  <span className={`text-[11px] font-bold font-mono ${ciColor}`}>{ciLabel}</span>
                </div>
                {repo.latestRun && (
                  <div className={`text-xs mt-0.5 flex items-center gap-2 flex-wrap ${
                    repo.ciStatus === "stale" ? "text-amber-700 font-medium" : "text-gray-400"
                  }`}>
                    <span>{repo.latestRun.name}</span>
                    <span>·</span>
                    <span>{repo.latestRun.head_branch}</span>
                    <span>·</span>
                    <span>{new Date(repo.latestRun.created_at).toLocaleDateString()}{ageLabel ? ` (${ageLabel})` : ""}</span>
                    <a href={repo.latestRun.html_url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                      view run →
                    </a>
                  </div>
                )}
                {!repo.latestRun && repo.pushedAgeDays !== null && repo.pushedAgeDays > 60 && (
                  <div className="text-xs text-amber-700 font-medium mt-0.5">
                    no CI · last push {repo.pushedAgeDays} days ago
                  </div>
                )}
              </div>

              {/* Action area */}
              <div className="flex items-center gap-2 shrink-0">
                {/* Scan state feedback */}
                {state?.status === "scanning" && (
                  <span className="text-xs text-teal-700 font-medium animate-pulse">Scanning…</span>
                )}
                {state?.status === "fixing" && (
                  <span className="text-xs text-emerald-600 animate-pulse font-medium">AI fixing {state.issues} issues…</span>
                )}
                {state?.status === "done" && state.prUrl && (
                  <a
                    href={state.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs px-3 py-1.5 rounded-lg bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors font-medium"
                  >
                    View Fix PR →
                  </a>
                )}
                {state?.status === "done" && !state.prUrl && state.issues === 0 && (
                  <span className="text-xs text-emerald-600 font-medium">✓ No issues found</span>
                )}
                {state?.status === "done" && !state.prUrl && (state.issues || 0) > 0 && (
                  <span className="text-xs text-gray-400">{state.error || "No auto-fixable issues"}</span>
                )}
                {state?.status === "error" && (
                  <span className="text-xs text-red-600">{state.error}</span>
                )}

                {/* Scan button */}
                {!isWorking && (
                  <button
                    onClick={() => scanAndFix(repo)}
                    disabled={isWorking}
                    className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    {state?.status === "done" ? "Re-scan" : "Scan & Fix"}
                  </button>
                )}

                {isWorking && (
                  <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
