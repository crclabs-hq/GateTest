"use client";

// The batch auto-fix engine behind the Repo Scan tab. Groups fixable issues
// by file, sends them to /api/scan/fix in batches of 5 so each request fits
// within Vercel's function timeout, and tracks per-file progress the UI
// renders live. Extracted verbatim from AdminPanel.tsx in the god-component
// split — the fetch bodies here are covered by tests/tier-passthrough.test.js
// (every /api/scan/fix call MUST forward `tier`).

import { useState } from "react";
import {
  extractIssuesFromModules,
  type FixableIssue,
  type UnparseableIssue,
  type ModuleLike,
} from "@/app/lib/issue-extractor";

export interface FailedFile {
  file: string;
  issues: string[];
  reason: string;
}

export interface FixResult {
  status: string;
  prUrl?: string;
  prNumber?: number;
  filesFixed?: number;
  issuesFixed?: number;
  message?: string;
  error?: string;
  errors?: string[];
  failedFiles?: FailedFile[];
}

export type FileFixStatus = "pending" | "fixing" | "done" | "timeout" | "failed";

export interface FileProgress {
  file: string;
  status: FileFixStatus;
  error?: string;
}

// Delegates to the shared helper at `website/app/lib/issue-extractor.ts`
// so the admin Command Center and the customer scan page parse module
// findings identically. The `failedOnly` flag is `false` here because the
// admin tooling sometimes pre-filters mods upstream; the helper still does
// the right thing for any module shape the caller hands it.
export function parseIssues(mods: Array<Record<string, unknown>>): FixableIssue[] {
  const moduleLikes: ModuleLike[] = mods.map((m) => ({
    name: m.name as string,
    status: m.status as string,
    details: (m.details as string[]) || [],
  }));
  const { fixable } = extractIssuesFromModules(moduleLikes, { failedOnly: false });
  return fixable;
}

// Returns the unparseable findings the auto-fixer can't act on so the
// operator can triage them by hand. Replaces the silent `.filter(i => i.file)`
// drop that hid 39% of real-world findings from the customer.
export function parseUnparseableIssues(mods: Array<Record<string, unknown>>): UnparseableIssue[] {
  const moduleLikes: ModuleLike[] = mods.map((m) => ({
    name: m.name as string,
    status: m.status as string,
    details: (m.details as string[]) || [],
  }));
  const { unparseable } = extractIssuesFromModules(moduleLikes, { failedOnly: false });
  return unparseable;
}

function buildFileProgress(fixableIssues: FixableIssue[]): FileProgress[] {
  const seen = new Set<string>();
  return fixableIssues
    .filter((i) => i.file && !seen.has(i.file) && seen.add(i.file))
    .map((i) => ({ file: i.file, status: "pending" as FileFixStatus }));
}

function applyFixResultForBatch(progress: FileProgress[], data: FixResult, batchFiles: Set<string>): FileProgress[] {
  const failedSet = new Set<string>((data.failedFiles || []).map((f) => f.file));
  const timeoutSet = new Set<string>();
  for (const e of data.errors || []) {
    const m = e.match(/^([\w./\-@+]+?\.[\w]{1,8}):\s*(request timed out|Anthropic API)/);
    if (m) timeoutSet.add(m[1]);
  }
  return progress.map((fp) => {
    if (!batchFiles.has(fp.file)) return fp;
    if (timeoutSet.has(fp.file)) return { ...fp, status: "timeout", error: "timed out — queued for retry" };
    if (failedSet.has(fp.file)) {
      const ff = (data.failedFiles || []).find((f) => f.file === fp.file);
      return { ...fp, status: "failed", error: ff?.reason || "api error" };
    }
    return { ...fp, status: "done" };
  });
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

  function resetFix() {
    setFixResult(null);
  }

  async function fixIssues(fixable: FixableIssue[]) {
    if (!repoUrl || fixing) return;

    if (fixable.length === 0) {
      onError("No auto-fixable issues found.");
      return;
    }

    const initialProgress = buildFileProgress(fixable);
    setFileProgress(initialProgress);
    setFixing(true);
    setFixResult(null);
    onError("");

    // Group issues by unique file, then process in batches of 5 so each
    // request fits within Vercel's function timeout and the user sees real
    // progress as each batch completes instead of a frozen spinner.
    const BATCH_SIZE = 5;
    const fileMap = new Map<string, FixableIssue[]>();
    for (const issue of fixable) {
      if (!fileMap.has(issue.file)) fileMap.set(issue.file, []);
      fileMap.get(issue.file)!.push(issue);
    }
    const uniqueFiles = [...fileMap.keys()];

    const accumulated: FixResult = {
      status: "complete",
      failedFiles: [],
      errors: [],
      filesFixed: 0,
      issuesFixed: 0,
    };

    for (let start = 0; start < uniqueFiles.length; start += BATCH_SIZE) {
      const batchFiles = uniqueFiles.slice(start, start + BATCH_SIZE);
      const batchSet = new Set(batchFiles);
      const batchIssues = batchFiles.flatMap((f) => fileMap.get(f)!);

      setFileProgress((prev) => prev.map((fp) =>
        batchSet.has(fp.file) && fp.status === "pending" ? { ...fp, status: "fixing" } : fp,
      ));

      try {
        const res = await fetch("/api/scan/fix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl, issues: batchIssues, tier }),
        });
        const data = await res.json() as FixResult;
        accumulated.failedFiles = [...(accumulated.failedFiles ?? []), ...(data.failedFiles ?? [])];
        accumulated.errors = [...(accumulated.errors ?? []), ...(data.errors ?? [])];
        accumulated.filesFixed = (accumulated.filesFixed ?? 0) + (data.filesFixed ?? 0);
        accumulated.issuesFixed = (accumulated.issuesFixed ?? 0) + (data.issuesFixed ?? 0);
        if (data.prUrl) accumulated.prUrl = data.prUrl;
        if (data.prNumber) accumulated.prNumber = data.prNumber;
        setFileProgress((prev) => applyFixResultForBatch(prev, data, batchSet));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "request failed";
        accumulated.errors = [...(accumulated.errors ?? []), `Batch failed: ${msg}`];
        setFileProgress((prev) => prev.map((fp) =>
          batchSet.has(fp.file) && fp.status !== "done" ? { ...fp, status: "failed", error: msg } : fp,
        ));
      }
    }

    setFixResult(accumulated);
    setFixing(false);
  }

  async function retryFailedFiles() {
    if (!fixResult?.failedFiles?.length || !repoUrl) return;

    const BATCH_SIZE = 5;
    const failedFiles = fixResult.failedFiles;
    const retrySet = new Set(failedFiles.map((ff) => ff.file));
    setFileProgress((prev) => prev.map((fp) => retrySet.has(fp.file) ? { ...fp, status: "pending", error: undefined } : fp));
    setFixing(true);
    onError("");

    const accumulated: FixResult = {
      status: "complete",
      failedFiles: [],
      errors: [],
      filesFixed: (fixResult.filesFixed ?? 0),
      issuesFixed: (fixResult.issuesFixed ?? 0),
      prUrl: fixResult.prUrl,
      prNumber: fixResult.prNumber,
    };

    for (let start = 0; start < failedFiles.length; start += BATCH_SIZE) {
      const batch = failedFiles.slice(start, start + BATCH_SIZE);
      const batchSet = new Set(batch.map((ff) => ff.file));
      const batchIssues = batch.flatMap((ff) => ff.issues.map((i) => ({ file: ff.file, issue: i, module: "retry" })));

      setFileProgress((prev) => prev.map((fp) =>
        batchSet.has(fp.file) && fp.status === "pending" ? { ...fp, status: "fixing" } : fp,
      ));

      try {
        const res = await fetch("/api/scan/fix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl, issues: batchIssues, tier }),
        });
        const data = await res.json() as FixResult;
        accumulated.failedFiles = [...(accumulated.failedFiles ?? []), ...(data.failedFiles ?? [])];
        accumulated.errors = [...(accumulated.errors ?? []), ...(data.errors ?? [])];
        accumulated.filesFixed = (accumulated.filesFixed ?? 0) + (data.filesFixed ?? 0);
        accumulated.issuesFixed = (accumulated.issuesFixed ?? 0) + (data.issuesFixed ?? 0);
        if (data.prUrl) accumulated.prUrl = data.prUrl;
        setFileProgress((prev) => applyFixResultForBatch(prev, data, batchSet));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "request failed";
        accumulated.failedFiles = [
          ...(accumulated.failedFiles ?? []),
          ...batch.map((ff) => ({ file: ff.file, issues: ff.issues, reason: msg })),
        ];
        setFileProgress((prev) => prev.map((fp) =>
          batchSet.has(fp.file) && fp.status !== "done" ? { ...fp, status: "failed", error: msg } : fp,
        ));
      }
    }

    setFixResult(accumulated);
    setFixing(false);
  }

  return { fixing, fixResult, fileProgress, fixIssues, retryFailedFiles, resetFix };
}
