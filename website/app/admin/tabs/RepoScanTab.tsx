"use client";

import { useState } from "react";
import LiveScanTerminal from "@/app/components/LiveScanTerminal";
import type { UnparseableIssue } from "@/app/lib/issue-extractor";
import { useAutoFix, parseIssues, parseUnparseableIssues } from "./useAutoFix";
import { FixProgressCard, FixResultCard } from "./FixResultCard";
import { GuidancePanel, type GuidanceItem } from "./GuidancePanel";
import { ModuleResults } from "./ModuleResults";

// The "Repo Scan" tab — scan a GitHub repo, auto-fix what's fixable, surface
// the rest for manual triage. Split out of AdminPanel.tsx (the 2,556-line
// god component); the batch fix engine lives in ./useAutoFix.ts.
export function RepoScanTab({ onScanRecorded }: { onScanRecorded: () => void }) {
  const [repoUrl, setRepoUrl] = useState("");
  const [tier, setTier] = useState("quick");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  // Findings whose file location couldn't be parsed — surfaced to the operator
  // instead of being silently dropped by the auto-fixer.
  const [unparseableIssues, setUnparseableIssues] = useState<UnparseableIssue[]>([]);
  const [guidanceLoading, setGuidanceLoading] = useState(false);
  const [guidance, setGuidance] = useState<GuidanceItem[] | null>(null);

  const autoFix = useAutoFix({ repoUrl, tier, onError: setError });
  const { fixing, fixResult, fileProgress, fixIssues, retryFailedFiles } = autoFix;

  const modules = (result?.modules as Array<Record<string, unknown>>) || [];
  const totalIssues = (result?.totalIssues as number) || 0;

  function runScan() {
    if (!repoUrl.includes("github.com")) {
      setError("Enter a valid GitHub repo URL");
      return;
    }
    setScanning(true);
    setResult(null);
    autoFix.resetFix();
    setGuidance(null);
    setUnparseableIssues([]);
    setError("");
  }

  // "Re-fix" path — extract issues from the completed scan result, split into
  // auto-fixable vs manual-review, then hand the fixable set to the engine.
  function refixFromResult() {
    if (!result) return;
    const failedMods = modules.filter((m) => (m.status as string) === "failed");
    // The shared helper guarantees `i.file` is non-empty for every fixable;
    // anything without a parseable file flows into `unparseable` and is
    // surfaced to the operator via the manual-review block in the UI
    // instead of being silently dropped. No `.filter(i => i.file)` here.
    const fixable = parseIssues(failedMods);
    const unparseable = parseUnparseableIssues(failedMods);
    setUnparseableIssues(unparseable);
    if (fixable.length === 0) {
      setError(`No auto-fixable issues. ${unparseable.length} issue(s) need manual review.`);
      return;
    }
    if (unparseable.length > 0) {
      console.info(`[GateTest] ${fixable.length} auto-fixable, ${unparseable.length} need manual review`); // code-quality-ok
    }
    fixIssues(fixable);
  }

  function copyIssues() {
    const failedMods = modules.filter((m) => (m.status as string) === "failed");
    const issueText = failedMods.map((m) => {
      const details = (m.details as string[]) || [];
      return `## ${m.name} (${m.issues} issues)\n${details.map((d) => `- ${d}`).join("\n")}`;
    }).join("\n\n");
    navigator.clipboard.writeText(issueText);
    setError("Issues copied to clipboard");
    setTimeout(() => setError(""), 2000);
  }

  async function loadGuidance() {
    setGuidanceLoading(true);
    setGuidance(null);
    const failedModulesLocal = modules.filter((m) => (m.status as string) === "failed");
    const allIssues = failedModulesLocal.flatMap((m) => {
      const details = (m.details as string[]) || [];
      return details.map((d) => ({ module: m.name as string, detail: d }));
    });
    try {
      const res = await fetch("/api/scan/guidance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issues: allIssues }),
      });
      const data = await res.json();
      setGuidance(data.guidance || []);
    } catch {
      setError("Could not generate guidance");
    } finally {
      setGuidanceLoading(false);
    }
  }

  function exportJson() {
    const data = JSON.stringify({ repoUrl, tier, timestamp: new Date().toISOString(), ...result }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gatetest-${repoUrl.split("/").pop()}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6 mb-6">
        <div className="grid sm:grid-cols-[1fr,auto,auto] gap-3">
          <input
            type="url"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            aria-label="Repository URL"
            className="px-4 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 text-sm w-full"
          />
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            className="px-4 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 focus:border-emerald-500 focus:outline-none text-sm"
          >
            <option value="quick">Quick (41 modules)</option>
            <option value="full">Full (120 modules)</option>
            <option value="scan_fix">Scan + Fix (120 modules + pair-review + architecture)</option>
            <option value="nuclear">Forensic (120 modules + Claude diagnosis + correlation + exec summary)</option>
          </select>
          <button
            onClick={runScan}
            disabled={scanning}
            className="btn-primary px-6 py-3 text-sm disabled:opacity-50"
          >
            {scanning ? "Scanning..." : "Run Scan"}
          </button>
        </div>
        {error && <p className="text-danger text-sm mt-3">{error}</p>}
      </div>

      {scanning && repoUrl && (
        <LiveScanTerminal
          repoUrl={repoUrl}
          tier={tier}
          onComplete={(data) => {
            setResult(data);
            setScanning(false);
            onScanRecorded();
            // Auto-fix: if issues found, automatically trigger fix
            const issues = (data.totalIssues as number) || 0;
            if (issues > 0) {
              const mods = (data.modules as Array<Record<string, unknown>>) || [];
              // parseIssues already returns only the entries the helper
              // could resolve a file for; unparseable findings flow
              // through parseUnparseableIssues for operator visibility.
              const fixable = parseIssues(mods);
              setUnparseableIssues(parseUnparseableIssues(mods));
              if (fixable.length > 0) {
                // Hand pre-extracted issues to the engine so the live
                // progress panel shows — result state isn't updated yet here
                fixIssues(fixable);
              }
            }
          }}
          onError={(err) => {
            setError(err);
            setScanning(false);
          }}
        />
      )}

      {result && !scanning && (
        <div className="space-y-4">
          <div className={`rounded-xl bg-white border shadow-sm p-6 ${totalIssues === 0 ? "border-emerald-300" : "border-amber-300"}`}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-xl font-bold">
                  {totalIssues === 0 ? "All Clear" : `${totalIssues} Issues Found`}
                </h2>
                <p className="text-sm text-gray-500">
                  {modules.length} modules &middot; {result.duration as number}ms
                </p>
              </div>
              <span className={`text-sm font-bold px-3 py-1.5 rounded-full ${
                totalIssues === 0 ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
              }`}>
                {totalIssues === 0 ? "PASSED" : `${totalIssues} ISSUES`}
              </span>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              <button onClick={runScan} className="btn-primary px-4 py-2 text-xs">
                Re-scan
              </button>
              <button onClick={exportJson} className="btn-secondary px-4 py-2 text-xs">
                Export JSON
              </button>
              {totalIssues > 0 && (
                <>
                  {!fixResult && !fixing && (
                    <button
                      onClick={refixFromResult}
                      disabled={fixing}
                      className="btn-primary px-4 py-2 text-xs disabled:opacity-50"
                      style={{ background: "#059669" }}
                    >
                      Re-fix {totalIssues} Issues (AI + PR)
                    </button>
                  )}
                  {fixing && (
                    <span className="text-xs text-accent font-medium animate-pulse">AI fixing issues automatically...</span>
                  )}
                  <button onClick={copyIssues} className="btn-secondary px-4 py-2 text-xs">
                    Copy Issues
                  </button>
                  <button
                    onClick={loadGuidance}
                    disabled={guidanceLoading}
                    className="btn-secondary px-4 py-2 text-xs disabled:opacity-50"
                  >
                    {guidanceLoading ? "Generating..." : "Manual Fix Guide"}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Unparseable findings — surfaced honestly instead of being
              silently dropped by `.filter(i => i.file)`. The auto-fixer
              can't act on these (no file location parseable from the
              finding text), so the operator triages them by hand. */}
          {unparseableIssues.length > 0 && (
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-5 mt-4">
              <h3 className="font-bold text-slate-700 mb-1">
                {unparseableIssues.length} issue{unparseableIssues.length > 1 ? "s" : ""} need manual review
              </h3>
              <p className="text-xs text-slate-500 mb-3">
                No file location could be parsed from the finding text — these
                won&apos;t be in the auto-fix PR.
              </p>
              <ul className="space-y-1 text-xs font-mono text-slate-700 max-h-48 overflow-auto">
                {unparseableIssues.map((u, i) => (
                  <li key={i} className="truncate">
                    <span className="text-slate-400">[{u.module}]</span> {u.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Manual guidance for unfixable issues */}
          {guidance && guidance.length > 0 && (
            <GuidancePanel guidance={guidance} onClose={() => setGuidance(null)} />
          )}

          {/* Fix progress + result */}
          {fixing && <FixProgressCard fileProgress={fileProgress} />}

          {fixResult && (
            <FixResultCard
              fixResult={fixResult}
              fixing={fixing}
              totalIssues={totalIssues}
              onRetry={retryFailedFiles}
            />
          )}

          <ModuleResults modules={modules} />
        </div>
      )}
    </>
  );
}
