"use client";

import { useState } from "react";
import LiveScanTerminal from "@/app/components/LiveScanTerminal";
import type { UnparseableIssue } from "@/app/lib/issue-extractor";
import { TIERS } from "@/app/lib/checkout-tiers";
import { readJsonBody, repoScanTierKeys, scanTierLabel } from "@/app/lib/scan-outcome";
import { useAutoFix, parseIssues, parseUnparseableIssues } from "./useAutoFix";
import { maxPullRequests } from "./auto-fix-logic";
import { FixProgressCard, FixResultCard } from "./FixResultCard";
import { GuidancePanel, type GuidanceItem } from "./GuidancePanel";
import { ModuleResults } from "./ModuleResults";

// Tier options come from the checkout tier table — never a typed module count.
const TIER_OPTIONS = repoScanTierKeys(TIERS).map((key) => ({ key, label: scanTierLabel(key, TIERS) }));

// The "Repo Scan" tab — scan a repo, then (only when the operator clicks)
// open fix PRs for what's fixable; the rest is surfaced for manual triage.
// Scanning never writes to the repository: the fixer opens branches and
// pull requests on it, so it runs from an explicit button, never on its own
// after a scan (admin audit 2026-09-29).
export function RepoScanTab({ onScanRecorded }: { onScanRecorded: () => void }) {
  const [repoUrl, setRepoUrl] = useState("");
  const [tier, setTier] = useState("quick");
  // The repo + tier the current result belongs to. The fixer targets these,
  // not whatever is in the inputs now — editing the URL after a scan must
  // never send one repo's findings to another repo.
  const [scanned, setScanned] = useState<{ repoUrl: string; tier: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Findings whose file location couldn't be parsed — surfaced to the
  // operator instead of being silently dropped by the fixer.
  const [unparseableIssues, setUnparseableIssues] = useState<UnparseableIssue[]>([]);
  const [guidanceLoading, setGuidanceLoading] = useState(false);
  const [guidance, setGuidance] = useState<GuidanceItem[] | null>(null);

  const autoFix = useAutoFix({ repoUrl: scanned?.repoUrl || "", tier: scanned?.tier || tier, onError: setError });
  const { fixing, fixResult, fileProgress, fixIssues, retryFailedFiles } = autoFix;

  const modules = (result?.modules as Array<Record<string, unknown>>) || [];
  const totalIssues = (result?.totalIssues as number) || 0;
  const scanFailed = !!result && result.status !== "complete";
  const failedMods = modules.filter((m) => (m.status as string) === "failed");
  const fixable = scanFailed ? [] : parseIssues(failedMods);
  const fixableFiles = new Set(fixable.map((i) => i.file)).size;
  const repoName = (scanned?.repoUrl || repoUrl).replace(/^https?:\/\/[^/]+\//, "");

  function runScan() {
    if (!repoUrl.includes("github.com")) {
      setError("Enter a valid GitHub repo URL");
      return;
    }
    setScanned({ repoUrl, tier });
    setScanning(true);
    setResult(null);
    autoFix.resetFix();
    setGuidance(null);
    setUnparseableIssues([]);
    setError("");
    setNotice("");
  }

  // The ONLY way the fixer starts: the operator clicks the fix button.
  function startFix() {
    if (!result || scanFailed) return;
    if (fixable.length === 0) {
      setError(`No auto-fixable issues. ${unparseableIssues.length} issue(s) need manual review.`);
      return;
    }
    void fixIssues(fixable);
  }

  function flashNotice(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 2500);
  }

  async function copyIssues() {
    const issueText = failedMods.map((m) => {
      const details = (m.details as string[]) || [];
      return `## ${m.name} (${m.issues} issues)\n${details.map((d) => `- ${d}`).join("\n")}`;
    }).join("\n\n");
    try {
      await navigator.clipboard.writeText(issueText);
      setError("");
      flashNotice(`Copied ${totalIssues} issue${totalIssues === 1 ? "" : "s"} to the clipboard`);
    } catch {
      setError("Could not copy — the browser refused clipboard access");
    }
  }

  async function loadGuidance() {
    setGuidanceLoading(true);
    setGuidance(null);
    const allIssues = failedMods.flatMap((m) => {
      const details = (m.details as string[]) || [];
      return details.map((d) => ({ module: m.name as string, detail: d }));
    });
    try {
      const res = await fetch("/api/scan/guidance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issues: allIssues }),
      });
      const data = await readJsonBody(res) as { guidance?: GuidanceItem[]; error?: string } | null;
      if (!res.ok || !data || !Array.isArray(data.guidance)) {
        setError(`Could not generate guidance — ${data?.error || `HTTP ${res.status}`}`);
        return;
      }
      setGuidance(data.guidance);
    } catch {
      setError("Could not generate guidance — the request failed");
    } finally {
      setGuidanceLoading(false);
    }
  }

  function exportJson() {
    const data = JSON.stringify({ repoUrl: scanned?.repoUrl || repoUrl, tier: scanned?.tier || tier, timestamp: new Date().toISOString(), ...result }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gatetest-${repoName.split("/").pop()}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const headline = scanFailed ? "Scan failed" : totalIssues === 0 ? "All Clear" : `${totalIssues} Issues Found`;
  const badge = scanFailed ? { cls: "bad", word: "FAILED" } : totalIssues === 0 ? { cls: "ok", word: "PASSED" } : { cls: "warn", word: `${totalIssues} ISSUES` };
  const prCap = maxPullRequests(fixableFiles);

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
            aria-label="Scan tier"
            className="px-4 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 focus:border-emerald-500 focus:outline-none text-sm"
          >
            {TIER_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
          <button
            onClick={runScan}
            disabled={scanning || fixing}
            className="btn-primary px-6 py-3 text-sm disabled:opacity-50"
          >
            {scanning ? "Scanning..." : "Run Scan"}
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">Scanning only reads the repository. Nothing is written to it unless you click the fix button.</p>
        {error && <p className="text-danger text-sm mt-3" role="alert">{error}</p>}
        {notice && <p className="text-success text-sm mt-3" role="status">{notice}</p>}
      </div>

      {scanning && scanned && (
        <LiveScanTerminal
          repoUrl={scanned.repoUrl}
          tier={scanned.tier}
          onComplete={(data) => {
            setResult(data);
            setScanning(false);
            onScanRecorded();
            // Surface the findings the fixer can't act on. Nothing is fixed
            // here — fixing waits for the operator's click (startFix).
            if (data.status === "complete") {
              const mods = (data.modules as Array<Record<string, unknown>>) || [];
              setUnparseableIssues(parseUnparseableIssues(mods.filter((m) => m.status === "failed")));
            }
          }}
          onError={(err) => {
            setError(`Scan failed — ${err}`);
            setScanning(false);
          }}
        />
      )}

      {result && !scanning && (
        <div className="space-y-4">
          <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-xl font-bold">{headline}</h2>
                <p className="text-sm text-gray-500">
                  {scanFailed
                    ? String(result.error || "The scan did not finish.")
                    : <>{repoName} &middot; {modules.length} modules &middot; {result.duration as number}ms</>}
                </p>
              </div>
              <span className={`gt-admin-badge ${badge.cls}`}>{badge.word}</span>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={runScan} disabled={fixing} className="btn-primary px-4 py-2 text-xs disabled:opacity-50">
                Re-scan
              </button>
              <button onClick={exportJson} className="btn-secondary px-4 py-2 text-xs">
                Export JSON
              </button>
              {!scanFailed && totalIssues > 0 && (
                <>
                  {!fixResult && !fixing && fixableFiles > 0 && (
                    <button onClick={startFix} className="btn-primary px-4 py-2 text-xs">
                      Fix {fixableFiles} file{fixableFiles === 1 ? "" : "s"} — opens up to {prCap} PR{prCap === 1 ? "" : "s"} on {repoName}
                    </button>
                  )}
                  {fixing && (
                    <span className="text-xs text-accent font-medium animate-pulse" role="status">Opening fix pull requests…</span>
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

          {/* Unparseable findings — surfaced instead of silently dropped.
              The fixer can't act on these (no file location parseable from
              the finding text), so the operator triages them by hand. */}
          {unparseableIssues.length > 0 && (
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-5 mt-4">
              <h3 className="font-bold text-slate-700 mb-1">
                {unparseableIssues.length} issue{unparseableIssues.length > 1 ? "s" : ""} need manual review
              </h3>
              <p className="text-xs text-slate-500 mb-3">
                No file location could be parsed from the finding text — these
                won&apos;t be in any fix PR.
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

          {fixResult && !fixing && (
            <FixResultCard
              fixResult={fixResult}
              fileProgress={fileProgress}
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
