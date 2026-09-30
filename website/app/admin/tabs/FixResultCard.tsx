"use client";

import type { FixResult, FileProgress, FileFixStatus } from "./auto-fix-logic";
import { fixRunHeadline } from "./auto-fix-logic";

const STATUS_GLYPH: Record<FileFixStatus, string> = {
  pending: "·",
  fixing: "…",
  done: "✓",
  not_fixed: "–",
  timeout: "⏱",
  failed: "✗",
};

const STATUS_CLASS: Record<FileFixStatus, string> = {
  pending: "text-gray-400",
  fixing: "text-accent animate-pulse",
  done: "text-success",
  not_fixed: "text-gray-500",
  timeout: "text-warning",
  failed: "text-danger",
};

const STATUS_WORD: Record<FileFixStatus, string> = {
  pending: "waiting",
  fixing: "sending",
  done: "fixed",
  not_fixed: "not fixed",
  timeout: "timed out",
  failed: "failed",
};

function FileProgressList({ fileProgress }: { fileProgress: FileProgress[] }) {
  if (fileProgress.length === 0) return null;
  return (
    <ul className="max-h-60 overflow-y-auto space-y-1 border-t border-gray-100 pt-3">
      {fileProgress.map((fp) => (
        <li key={fp.file} className="flex items-center gap-2 text-xs font-mono">
          <span className={STATUS_CLASS[fp.status]} aria-label={STATUS_WORD[fp.status]}>
            {STATUS_GLYPH[fp.status]}
          </span>
          <span className="truncate text-gray-700">{fp.file}</span>
          {fp.error && <span className="text-gray-500 truncate">— {fp.error}</span>}
        </li>
      ))}
    </ul>
  );
}

// Live per-file progress while the batch fixer runs: pending → sending →
// fixed / not fixed / timed out / failed, per file, as each batch returns.
export function FixProgressCard({ fileProgress }: { fileProgress: FileProgress[] }) {
  const settled = fileProgress.filter((fp) => fp.status !== "pending" && fp.status !== "fixing").length;
  return (
    <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6" role="status">
      <div className="text-center mb-4">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="font-medium">Generating fixes and opening pull requests…</p>
        <p className="text-xs text-gray-500 mt-1">
          {settled} of {fileProgress.length} files answered · each batch of files opens its own pull request
        </p>
      </div>
      <FileProgressList fileProgress={fileProgress} />
    </div>
  );
}

const HEADLINE_BADGE: Record<FixResult["status"], { cls: string; word: string }> = {
  complete: { cls: "ok", word: "PRs opened" },
  partial: { cls: "warn", word: "Partial" },
  failed: { cls: "bad", word: "Failed" },
  no_fixes: { cls: "muted", word: "Nothing written" },
};

export function FixResultCard({
  fixResult,
  fileProgress,
  fixing,
  totalIssues,
  onRetry,
}: {
  fixResult: FixResult;
  fileProgress: FileProgress[];
  fixing: boolean;
  totalIssues: number;
  onRetry: () => void;
}) {
  const badge = HEADLINE_BADGE[fixResult.status];
  const prs = fixResult.pullRequests;
  const failed = fixResult.failedFiles;
  return (
    <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-bold">{fixRunHeadline(fixResult)}</h3>
        <span className={`gt-admin-badge ${badge.cls} shrink-0`}>{badge.word}</span>
      </div>

      {prs.length > 0 && (
        <div>
          <p className="text-xs text-gray-500 mb-2">
            Fixes are on new branches — the default branch still has all {totalIssues} issues until these are merged. Re-scan after merging.
          </p>
          <ul className="space-y-2">
            {prs.map((pr) => (
              <li key={pr.url} className="flex flex-wrap items-center gap-2 text-sm">
                <a href={pr.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline">
                  {pr.number ? `PR #${pr.number}` : pr.url}
                </a>
                <span className="text-xs text-gray-500">
                  {pr.filesFixed} file{pr.filesFixed === 1 ? "" : "s"}{pr.branch ? ` · ${pr.branch}` : ""}
                </span>
                <a href={`${pr.url}/files`} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-600 underline">
                  View changes
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {fixResult.unopenedBranches.length > 0 && (
        <div className="text-xs text-gray-700">
          <p className="font-semibold mb-1">Committed to a branch, but no pull request was opened:</p>
          <ul className="font-mono space-y-0.5">
            {fixResult.unopenedBranches.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </div>
      )}

      {fixResult.messages.length > 0 && (
        <ul className="text-xs text-gray-600 space-y-1">
          {fixResult.messages.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      )}

      {failed.length > 0 && (
        <div className="pt-3 border-t border-gray-100">
          <div className="flex items-center justify-between gap-3 mb-2">
            <p className="text-xs text-gray-700">
              <strong className="text-danger">{failed.length}</strong> file{failed.length === 1 ? "" : "s"} not fixed because a request failed
            </p>
            <button onClick={onRetry} disabled={fixing} className="btn-secondary px-4 py-2 text-xs font-semibold disabled:opacity-50">
              {fixing ? "Retrying…" : "Retry failed files"}
            </button>
          </div>
          <ul className="max-h-48 overflow-y-auto space-y-1 text-xs font-mono">
            {failed.map((f, i) => (
              <li key={`${f.file}-${i}`} className="truncate">
                <span className="text-danger">✗</span> <span className="text-gray-700">{f.file}</span>{" "}
                <span className="text-gray-500">— {f.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {fixResult.errors.length > 0 && (
        <details className="text-xs text-gray-600">
          <summary className="cursor-pointer">{fixResult.errors.length} error message{fixResult.errors.length === 1 ? "" : "s"} from the fix service</summary>
          <ul className="mt-2 space-y-1">
            {fixResult.errors.map((e, i) => <li key={i}>&rarr; {e}</li>)}
          </ul>
        </details>
      )}

      {fileProgress.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-600">Per-file outcome ({fileProgress.length} files)</summary>
          <div className="mt-2"><FileProgressList fileProgress={fileProgress} /></div>
        </details>
      )}
    </div>
  );
}
