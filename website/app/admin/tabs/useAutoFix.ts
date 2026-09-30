"use client";

// The batch fix engine behind the Repo Scan tab. Groups fixable issues by
// file and sends them in batches of FIX_BATCH_SIZE so each request fits the
// host's function timeout. /api/scan/fix opens one branch + PR per request,
// so a run can open several PRs — every one is collected (./auto-fix-logic).
//
// It only ever runs when the operator clicks the fix button: it writes
// branches and pull requests to the scanned repository, so a completed scan
// never starts it (admin audit 2026-09-29).
//
// First fix run and "Retry failed" share one batch loop (runFixBatches) and
// one fetch, which tests/tier-passthrough.test.js checks forwards `tier`.

import { useRef, useState } from "react";
import {
  extractIssuesFromModules,
  type FixableIssue,
  type UnparseableIssue,
  type ModuleLike,
} from "@/app/lib/issue-extractor";
import {
  FIX_BATCH_SIZE,
  applyBatchToProgress,
  buildFileProgress,
  emptyFixResult,
  finalizeFixResult,
  groupIssuesByFile,
  mergeBatch,
  planBatches,
  readFixResponse,
  requestFailed,
  retryBase,
  retryGroups,
  type BatchOutcome,
  type FileIssues,
  type FileProgress,
  type FixResult,
} from "./auto-fix-logic";

export type { FixResult, FileProgress } from "./auto-fix-logic";

function toModuleLikes(mods: Array<Record<string, unknown>>): ModuleLike[] {
  return mods.map((m) => ({
    name: m.name as string,
    status: m.status as string,
    details: (m.details as string[]) || [],
  }));
}

// Delegates to the shared helper at `website/app/lib/issue-extractor.ts`
// so the admin Command Center and the customer scan page parse module
// findings identically. `failedOnly: false` because the admin tooling
// sometimes pre-filters mods upstream.
export function parseIssues(mods: Array<Record<string, unknown>>): FixableIssue[] {
  return extractIssuesFromModules(toModuleLikes(mods), { failedOnly: false }).fixable;
}

// The findings the fixer can't act on (no parseable file), surfaced to the
// operator for manual triage instead of being silently dropped.
export function parseUnparseableIssues(mods: Array<Record<string, unknown>>): UnparseableIssue[] {
  return extractIssuesFromModules(toModuleLikes(mods), { failedOnly: false }).unparseable;
}

export function useAutoFix({
  repoUrl,
  tier,
  onError,
}: {
  repoUrl: string;
  tier: string;
  onError: (msg: string) => void;
}) {
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState<FixResult | null>(null);
  const [fileProgress, setFileProgress] = useState<FileProgress[]>([]);
  // The issues this run started from, by file — a retry re-sends them with
  // their real module names instead of a placeholder.
  const originals = useRef<Map<string, FixableIssue[]>>(new Map());

  function resetFix() {
    setFixResult(null);
    setFileProgress([]);
    originals.current = new Map();
  }

  async function postFixBatch(issues: FixableIssue[]): Promise<BatchOutcome> {
    try {
      const res = await fetch("/api/scan/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, issues, tier }),
      });
      const body: unknown = await res.json().catch(() => null);
      return readFixResponse(res.ok, res.status, body);
    } catch (err) {
      return requestFailed(err instanceof Error ? err.message : "request failed");
    }
  }

  async function runFixBatches(groups: FileIssues[], base: FixResult) {
    setFixing(true);
    onError("");
    let acc = base;
    for (const batch of planBatches(groups, FIX_BATCH_SIZE)) {
      const batchFiles = new Set(batch.map((g) => g.file));
      setFileProgress((prev) => prev.map((fp) =>
        batchFiles.has(fp.file) && fp.status === "pending" ? { ...fp, status: "fixing" } : fp,
      ));
      const outcome = await postFixBatch(batch.flatMap((g) => g.issues));
      acc = mergeBatch(acc, outcome, batch);
      setFileProgress((prev) => applyBatchToProgress(prev, outcome, batchFiles));
    }
    setFixResult(finalizeFixResult(acc));
    setFixing(false);
  }

  async function fixIssues(fixable: FixableIssue[]) {
    if (!repoUrl || fixing) return;
    const groups = groupIssuesByFile(fixable);
    if (groups.length === 0) {
      onError("No auto-fixable issues found.");
      return;
    }
    originals.current = new Map(groups.map((g) => [g.file, g.issues]));
    setFileProgress(buildFileProgress(groups));
    setFixResult(null);
    await runFixBatches(groups, emptyFixResult());
  }

  async function retryFailedFiles() {
    if (!fixResult?.failedFiles.length || !repoUrl || fixing) return;
    const groups = retryGroups(fixResult.failedFiles, originals.current);
    if (groups.length === 0) return;
    const retrying = new Set(groups.map((g) => g.file));
    setFileProgress((prev) => {
      const known = new Set(prev.map((fp) => fp.file));
      const reset = prev.map((fp) => retrying.has(fp.file) ? { ...fp, status: "pending" as const, error: undefined } : fp);
      return [...reset, ...buildFileProgress(groups.filter((g) => !known.has(g.file)))];
    });
    await runFixBatches(groups, retryBase(fixResult));
  }

  return { fixing, fixResult, fileProgress, fixIssues, retryFailedFiles, resetFix };
}
