// Pure rules behind the Repo Scan tab's fix engine (./useAutoFix.ts): how
// fixable issues become batches, what one /api/scan/fix response MEANS for
// each file in its batch, and how the batches add up to one result.
//
// Zero imports on purpose. tests/admin-repo-scan-honest.test.js require()s
// this file through Node's type-stripping loader, so the rules the tab runs
// are the rules the tests exercise.
//
// Two defects this file exists to prevent (admin audit, 2026-09-29):
//   - a 500 from /api/scan/fix was read like a success, so every file in
//     the batch was marked "done" and the run ended "partially completed";
//   - /api/scan/fix opens one branch + PR per request and the tab sends one
//     request per 5 files, but only the LAST prUrl was kept, so every other
//     PR the run opened on the customer's repo was invisible.

/** Files per /api/scan/fix request — each request must fit the host's function timeout. */
export const FIX_BATCH_SIZE = 5;

export interface FixIssueInput {
  file: string;
  issue: string;
  module: string;
  line?: number;
}

export interface FileIssues {
  file: string;
  issues: FixIssueInput[];
}

export interface FailedFile {
  file: string;
  issues: string[];
  reason: string;
}

export interface FixPullRequest {
  url: string;
  number?: number;
  branch?: string;
  filesFixed: number;
  files: string[];
}

/** complete: every batch succeeded · partial: some PRs, some failures · failed: no request succeeded · no_fixes: requests succeeded but nothing was written */
export type FixRunStatus = "complete" | "partial" | "failed" | "no_fixes";

export interface FixResult {
  status: FixRunStatus;
  pullRequests: FixPullRequest[];
  /** Branches the route committed fixes to but could not open a PR for. */
  unopenedBranches: string[];
  filesFixed: number;
  issuesFixed: number;
  failedFiles: FailedFile[];
  errors: string[];
  /** Route messages from batches that wrote nothing (no_fixes / api_unavailable). */
  messages: string[];
  batches: number;
  failedBatches: number;
}

export type FileFixStatus = "pending" | "fixing" | "done" | "not_fixed" | "timeout" | "failed";

export interface FileProgress {
  file: string;
  status: FileFixStatus;
  error?: string;
}

/** The fields of an /api/scan/fix response this tab reads. */
export interface FixResponseBody {
  status?: string;
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  filesFixed?: number;
  issuesFixed?: number;
  fixes?: Array<{ file: string; issues?: string[] }>;
  message?: string;
  error?: string;
  errors?: string[];
  failedFiles?: FailedFile[];
}

/** One request's outcome. requestOk=false means the whole batch failed and `reason` says why. */
export interface BatchOutcome {
  requestOk: boolean;
  reason?: string;
  body: FixResponseBody;
}

export function emptyFixResult(): FixResult {
  return {
    status: "complete",
    pullRequests: [],
    unopenedBranches: [],
    filesFixed: 0,
    issuesFixed: 0,
    failedFiles: [],
    errors: [],
    messages: [],
    batches: 0,
    failedBatches: 0,
  };
}

/** Groups issues by file, first-seen order. Issues without a file are dropped here — the caller surfaces them as manual review. */
export function groupIssuesByFile(issues: FixIssueInput[]): FileIssues[] {
  const byFile = new Map<string, FixIssueInput[]>();
  for (const issue of issues) {
    if (!issue.file) continue;
    if (!byFile.has(issue.file)) byFile.set(issue.file, []);
    byFile.get(issue.file)!.push(issue);
  }
  return [...byFile.entries()].map(([file, list]) => ({ file, issues: list }));
}

export function planBatches<T>(items: T[], size: number = FIX_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

/** The route opens at most one PR per request, so this is the most PRs a run can open. */
export function maxPullRequests(fileCount: number, size: number = FIX_BATCH_SIZE): number {
  return Math.ceil(fileCount / size);
}

export function buildFileProgress(groups: FileIssues[]): FileProgress[] {
  return groups.map((g) => ({ file: g.file, status: "pending" }));
}

export function requestFailed(reason: string): BatchOutcome {
  return { requestOk: false, reason, body: {} };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Reads one /api/scan/fix response. A non-2xx status, an unreadable body,
 * or `status: "error"` is a failed request — never a batch of fixed files.
 */
export function readFixResponse(httpOk: boolean, httpStatus: number, body: unknown): BatchOutcome {
  if (!isObject(body)) {
    return requestFailed(`HTTP ${httpStatus} — the fix service returned no readable response`);
  }
  const b = body as FixResponseBody;
  const said = (typeof b.error === "string" && b.error) || (typeof b.message === "string" && b.message) || "";
  if (!httpOk) return { requestOk: false, reason: `HTTP ${httpStatus}${said ? ` — ${said}` : ""}`, body: b };
  if (b.status === "error") return { requestOk: false, reason: said || "the fix service reported an error", body: b };
  return { requestOk: true, body: b };
}

const TIMEOUT_ERROR = /^([\w./\-@+]+?\.[\w]{1,8}):\s*(request timed out|Anthropic API|AI provider)/;

/** Per-file status for one batch. A file is "done" only when the response says it was fixed. */
export function applyBatchToProgress(progress: FileProgress[], outcome: BatchOutcome, batchFiles: Set<string>): FileProgress[] {
  if (!outcome.requestOk) {
    return progress.map((fp) =>
      batchFiles.has(fp.file) && fp.status !== "done" ? { ...fp, status: "failed", error: outcome.reason } : fp,
    );
  }
  const body = outcome.body;
  const failed = new Map((body.failedFiles || []).map((f) => [f.file, f.reason || "fix failed"]));
  const timedOut = new Set<string>();
  for (const e of body.errors || []) {
    const m = typeof e === "string" ? e.match(TIMEOUT_ERROR) : null;
    if (m) timedOut.add(m[1]);
  }
  const listed = Array.isArray(body.fixes) ? new Set(body.fixes.map((f) => f.file)) : null;
  const unsettled = [...batchFiles].filter((f) => !failed.has(f) && !timedOut.has(f));
  // Without a per-file list, a count that covers every unsettled file still
  // proves each one was fixed; a smaller count cannot say which ones.
  const countCoversAll = !listed && (body.filesFixed ?? 0) >= unsettled.length && unsettled.length > 0;
  const notFixedReason = !listed && (body.filesFixed ?? 0) > 0
    ? `${body.filesFixed} of ${unsettled.length} files fixed — the response did not say which`
    : body.message || "no fix was generated for this file";

  return progress.map((fp) => {
    if (!batchFiles.has(fp.file)) return fp;
    if (timedOut.has(fp.file)) return { ...fp, status: "timeout", error: "timed out — queued for retry" };
    if (failed.has(fp.file)) return { ...fp, status: "failed", error: failed.get(fp.file) };
    if (listed ? listed.has(fp.file) : countCoversAll) return { ...fp, status: "done", error: undefined };
    return { ...fp, status: "not_fixed", error: notFixedReason };
  });
}

/** Folds one batch into the run's result. Every PR a batch opens is kept. */
export function mergeBatch(acc: FixResult, outcome: BatchOutcome, batch: FileIssues[]): FixResult {
  const next: FixResult = {
    ...acc,
    pullRequests: [...acc.pullRequests],
    unopenedBranches: [...acc.unopenedBranches],
    failedFiles: [...acc.failedFiles],
    errors: [...acc.errors],
    messages: [...acc.messages],
    batches: acc.batches + 1,
  };
  const batchNo = next.batches;
  if (!outcome.requestOk) {
    next.failedBatches += 1;
    const reason = outcome.reason || "request failed";
    next.errors.push(`Batch ${batchNo} (${batch.length} file${batch.length === 1 ? "" : "s"}) failed: ${reason}`);
    for (const g of batch) next.failedFiles.push({ file: g.file, issues: g.issues.map((i) => i.issue), reason });
    return next;
  }
  const body = outcome.body;
  next.failedFiles.push(...(body.failedFiles || []));
  next.errors.push(...(body.errors || []).filter((e) => typeof e === "string"));
  next.filesFixed += body.filesFixed ?? 0;
  next.issuesFixed += body.issuesFixed ?? 0;
  if (body.prUrl) {
    next.pullRequests.push({
      url: body.prUrl,
      number: body.prNumber,
      branch: body.branch,
      filesFixed: body.filesFixed ?? 0,
      files: Array.isArray(body.fixes) ? body.fixes.map((f) => f.file) : [],
    });
  } else if (body.status === "fixes_committed" && body.branch) {
    next.unopenedBranches.push(body.branch);
  } else if (body.message) {
    next.messages.push(`Batch ${batchNo}: ${body.message}`);
  }
  return next;
}

export function finalizeFixResult(acc: FixResult): FixResult {
  const wroteSomething = acc.pullRequests.length > 0 || acc.unopenedBranches.length > 0;
  let status: FixRunStatus;
  if (acc.batches > 0 && acc.failedBatches === acc.batches) status = "failed";
  else if (!wroteSomething) status = "no_fixes";
  else if (acc.failedBatches > 0 || acc.failedFiles.length > 0 || acc.unopenedBranches.length > 0) status = "partial";
  else status = "complete";
  return { ...acc, status };
}

/** The result a retry starts from: everything already landed, minus the files being retried. */
export function retryBase(prev: FixResult): FixResult {
  return { ...prev, failedFiles: [], errors: [], messages: [], batches: 0, failedBatches: 0 };
}

/**
 * Rebuilds the issue list for failed files. Uses the original issues (with
 * their real module names) when this run still has them; falls back to the
 * route's issue strings otherwise.
 */
export function retryGroups(failedFiles: FailedFile[], originals: Map<string, FixIssueInput[]>): FileIssues[] {
  const seen = new Set<string>();
  const out: FileIssues[] = [];
  for (const ff of failedFiles) {
    if (!ff.file || seen.has(ff.file)) continue;
    seen.add(ff.file);
    const known = originals.get(ff.file) || [];
    const wanted = new Set(ff.issues || []);
    const matched = known.filter((i) => wanted.size === 0 || wanted.has(i.issue));
    const issues = matched.length > 0
      ? matched
      : (ff.issues || []).map((issue) => ({ file: ff.file, issue, module: "retry" }));
    if (issues.length > 0) out.push({ file: ff.file, issues });
  }
  return out;
}

/** One-line headline for the result card. Never says "fixed" unless a PR or branch exists. */
export function fixRunHeadline(r: FixResult): string {
  const prs = r.pullRequests.length;
  const prWord = `${prs} pull request${prs === 1 ? "" : "s"}`;
  switch (r.status) {
    case "complete":
      return `${prWord} opened — ${r.issuesFixed} issue${r.issuesFixed === 1 ? "" : "s"} fixed across ${r.filesFixed} file${r.filesFixed === 1 ? "" : "s"}`;
    case "partial":
      return `Fix partially completed — ${prWord} opened, ${r.failedFiles.length} file${r.failedFiles.length === 1 ? "" : "s"} failed`;
    case "failed":
      return `Fix failed — none of the ${r.batches} request${r.batches === 1 ? "" : "s"} succeeded; nothing was written to the repository`;
    default:
      return r.failedFiles.length > 0
        ? `No fixes were written — ${r.failedFiles.length} file${r.failedFiles.length === 1 ? "" : "s"} failed and the rest came back unchanged`
        : "No fixes were written — the fix service returned no changes";
  }
}
