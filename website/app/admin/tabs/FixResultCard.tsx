"use client";

import type { FixResult, FileProgress } from "./useAutoFix";

// Live per-file progress while the batch fixer runs. This is the "live
// progress panel" the auto-fix flow always tracked (pending → fixing →
// done/timeout/failed per file) but never rendered — restored during the
// god-component split so the operator sees batches land instead of a bare
// spinner.
export function FixProgressCard({ fileProgress }: { fileProgress: FileProgress[] }) {
  return (
    <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6">
      <div className="text-center mb-4">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="font-medium">AI is reading your code and generating fixes...</p>
        <p className="text-xs text-gray-500 mt-1">This may take 30-60 seconds depending on the number of issues</p>
      </div>
      {fileProgress.length > 0 && (
        <ul className="max-h-48 overflow-y-auto space-y-1 border-t border-gray-100 pt-3">
          {fileProgress.map((fp) => (
            <li key={fp.file} className="flex items-center gap-2 text-xs font-mono">
              <span className={
                fp.status === "done" ? "text-emerald-600" :
                fp.status === "fixing" ? "text-accent animate-pulse" :
                fp.status === "failed" ? "text-red-600" :
                fp.status === "timeout" ? "text-amber-600" :
                "text-gray-400"
              }>
                {fp.status === "done" ? "✓" : fp.status === "fixing" ? "…" : fp.status === "failed" ? "✗" : fp.status === "timeout" ? "⏱" : "·"}
              </span>
              <span className="truncate text-gray-700">{fp.file}</span>
              {fp.error && <span className="text-gray-400 truncate">— {fp.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FixResultCard({
  fixResult,
  fixing,
  totalIssues,
  onRetry,
}: {
  fixResult: FixResult;
  fixing: boolean;
  totalIssues: number;
  onRetry: () => void;
}) {
  return (
    <div className={`rounded-xl bg-white border shadow-sm p-5 ${fixResult.prUrl ? "border-emerald-300" : "border-gray-200"}`}>
      {fixResult.prUrl ? (
        <>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-success text-lg">&#10003;</span>
            <h3 className="font-bold">Pull Request Created</h3>
          </div>
          <p className="text-sm text-gray-500 mb-3">
            Fixed <strong>{fixResult.issuesFixed} issues</strong> across {fixResult.filesFixed} files
            {totalIssues > (fixResult.issuesFixed || 0) && (
              <> — <strong>{totalIssues - (fixResult.issuesFixed || 0)} remaining</strong> need manual review (not auto-fixable)</>
            )}.
          </p>
          <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700 mb-3">
            <strong>Important:</strong> Fixes are on a new branch &mdash; <strong>main still has all {totalIssues} issues</strong> until you merge the PR. Re-scanning main will show the same issues. After merging, re-scan to verify.
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={fixResult.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary px-4 py-2 text-xs"
              style={{ background: "#059669" }}
            >
              View PR on GitHub &rarr;
            </a>
            <a
              href={`${fixResult.prUrl}/files`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary px-4 py-2 text-xs"
            >
              View Changes
            </a>
          </div>
        </>
      ) : fixResult.status === "api_unavailable" ? (
        <>
          <p className="font-semibold text-warning text-sm">Anthropic API Temporarily Degraded</p>
          <p className="text-sm text-gray-500 mt-1">{fixResult.message}</p>
          {fixResult.failedFiles && fixResult.failedFiles.length > 0 && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-500">
                <strong className="text-gray-900">{fixResult.failedFiles.length}</strong> file{fixResult.failedFiles.length !== 1 ? "s" : ""} queued for retry
              </p>
              <button
                onClick={onRetry}
                disabled={fixing}
                className="btn-primary px-4 py-2 text-xs font-semibold"
              >
                {fixing ? "Retrying..." : "Retry Failed"}
              </button>
            </div>
          )}
        </>
      ) : fixResult.status === "no_fixes" ? (
        <>
          <p className="text-sm text-gray-500">{fixResult.message || "No fixes could be generated"}</p>
          {fixResult.failedFiles && fixResult.failedFiles.length > 0 && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-500">{fixResult.failedFiles.length} network failure{fixResult.failedFiles.length !== 1 ? "s" : ""}</p>
              <button
                onClick={onRetry}
                disabled={fixing}
                className="btn-primary px-4 py-2 text-xs font-semibold"
              >
                {fixing ? "Retrying..." : "Retry Failed"}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="font-medium text-accent">{fixResult.error || "Fix partially completed"}</p>
          {fixResult.errors && fixResult.errors.length > 0 && (
            <ul className="mt-2 text-xs text-gray-500 space-y-1">
              {fixResult.errors.map((e, i) => <li key={i}>&rarr; {e}</li>)}
            </ul>
          )}
          {fixResult.failedFiles && fixResult.failedFiles.length > 0 && (
            <div className="mt-3 flex items-center justify-between gap-3 pt-3 border-t border-gray-100">
              <p className="text-xs text-gray-500">
                <strong className="text-gray-900">{fixResult.failedFiles.length}</strong> additional file{fixResult.failedFiles.length !== 1 ? "s" : ""} failed with API errors
              </p>
              <button
                onClick={onRetry}
                disabled={fixing}
                className="btn-secondary px-4 py-2 text-xs font-semibold"
              >
                {fixing ? "Retrying..." : "Retry Failed"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
