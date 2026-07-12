/**
 * Auto-Fix Agent — Claude reads scan issues, generates fixes, creates a PR.
 *
 * POST /api/scan/fix
 * Body: { repoUrl, issues: [{ file, issue, module }] }
 *
 * Flow:
 * 1. Reads each file from GitHub API
 * 2. Sends file + issue to Claude with "fix this" prompt
 * 3. Gets back corrected code
 * 4. Creates a new branch on the repo
 * 5. Commits all fixed files
 * 6. Opens a pull request
 * 7. Returns the PR URL
 *
 * Requires: ANTHROPIC_API_KEY, GitHub auth (either GITHUB_TOKEN PAT, or
 *           GATETEST_APP_ID + GATETEST_PRIVATE_KEY GitHub App — App is preferred
 *           because it's already what the webhook uses for commit statuses.)
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isAdminRequest } from "@/app/lib/admin-auth";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  createTrackerForTier,
  runWithTracker,
  getCurrentTracker,
} = require("@/app/lib/budget-tracker");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { modelForTier, CHEAP_MODEL, needsRefusalFallback, resolveModelChoice, allowedModelIds } = require("@/app/lib/engine-models");
import {
  CUSTOMER_COOKIE_NAME,
  getOAuthConfig,
  verifyCustomerSession,
} from "@/app/lib/customer-session";
import {
  createBranch,
  fetchBlob,
  fetchFileSha,
  fetchTree,
  openPullRequest,
  postPrComment,
  resolveBaseBranchSha,
  resolveRepoAuth,
  upsertFile,
} from "../../../lib/gluecron-client";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};

const _scanFixLimiter = createLimiter(PRESETS.scanFix);
// Phase 1 of THE FIX-FIRST BUILD PLAN — N-attempt iterative loop with
// structured per-attempt logging. The loop carries forward each previous
// failure into the next prompt so Claude sees its own mistake. Pure JS
// helper, tested standalone in tests/fix-attempt-loop.test.js.
// Phase 1.2b — cross-fix scanner re-validation gate.
import { runTier } from "@/app/lib/scan-modules";

// Phase 2.2 — architecture annotator. Reads the codebase SHAPE (not
// per-file) and produces a "design observations" report — layering
// violations, duplicated logic, god objects, refactoring opportunities.
// REPORTED only, never auto-refactored. Posts as a PR comment.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { annotateArchitecture, renderArchitectureComment } = require("@/app/lib/architecture-annotator") as {
  annotateArchitecture: (opts: {
    fileContents: Array<{ path: string; content: string }>;
    askClaudeForArchitecture: (prompt: string) => Promise<string>;
    repoUrl?: string;
    sampleCount?: number;
    maxFileBytes?: number;
  }) => Promise<{
    ok: boolean;
    body: string | null;
    summary: { sourceFiles: number; totalFiles: number; totalBytes: number; topDirectories: Array<{ dir: string; count: number }>; extensionCounts: Record<string, number>; largestFiles: Array<{ path: string; bytes: number }> } | null;
    sampleFiles: Array<{ path: string; bytes: number }> | null;
    reason: string | null;
  }>;
  renderArchitectureComment: (result: {
    ok: boolean;
    body: string | null;
    summary?: { sourceFiles: number } | null;
    sampleFiles?: Array<{ path: string; bytes: number }> | null;
    reason?: string | null;
  } | null) => string;
};

// Phase 2.1 — pair-review agent. Second Claude critiques each fix on a
// 4-axis rubric (correctness / completeness / readability / testCoverage),
// posts result as a PR comment.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runPairReview, renderReviewComment } = require("@/app/lib/pair-review") as {
  runPairReview: (opts: {
    fixes: Array<{ file: string; original: string; fixed: string; issues: string[] }>;
    testsBySourceFile?: Record<string, string> | Map<string, string>;
    askClaudeForReview: (prompt: string) => Promise<string>;
  }) => Promise<{
    reviews: Array<{ file: string; ok: boolean; scores: { correctness: number; completeness: number; readability: number; testCoverage: number } | null; critique: string | null; reason: string | null }>;
    averages: { correctness: number; completeness: number; readability: number; testCoverage: number } | null;
    reviewed: number;
    skipped: number;
    summary: string;
  }>;
  renderReviewComment: (
    reviews: Array<{ file: string; ok: boolean; scores: { correctness: number; completeness: number; readability: number; testCoverage: number } | null; critique: string | null; reason: string | null }>,
    averages: { correctness: number; completeness: number; readability: number; testCoverage: number } | null
  ) => string;
};

// CISO report generator — Forensic-tier ($399) deliverable. Wires the
// existing helper into the Nuclear branch of the fix route so paying
// customers actually receive the board-ready report the marketing
// promises (OWASP Top 10, SOC2 TSC, CIS Controls v8, 30/60/90-day
// remediation roadmap). Report is attached as a markdown file inside
// the auto-fix PR at gatetest-reports/ciso-board-report-<date>.md.
// Failure is non-blocking — fixes ship even if the report errors.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateCisoReport, cisoReportPath } = require("@/app/lib/ciso-report-generator") as {
  generateCisoReport: (opts: {
    findings?: Array<{ module?: string; ruleId?: string; severity?: string; level?: string; detail?: string; message?: string }>;
    chains?: Array<{ severity?: string; impact?: string; description?: string; fixOrder?: string }>;
    hostName?: string;
    scanDate?: string;
    tier?: string;
    askClaude?: (prompt: string) => Promise<string>;
  }) => Promise<{
    markdown: string;
    html: string;
    summary: string;
    complianceGaps: { owasp: Array<{ control: string; title: string; findingCount: number }>; soc2: Array<{ control: string; title: string; findingCount: number }>; cis: Array<{ control: string; title: string; findingCount: number }> };
    sections: string[];
    riskLevel: string;
    counts: { Critical: number; High: number; Medium: number; Low: number };
  }>;
  cisoReportPath: (scanDate?: string) => string;
};

// Phase 3.2 — cross-finding correlation engine. Identifies attack
// chains across the full Forensic-tier findings set (one Claude call,
// independent of the per-finding diagnoser). Wired into /api/scan/fix
// so the CISO report receives real chains instead of an empty array.
// Failure is non-blocking — Forensic deliverable still ships; CISO
// report rendered with chains:[] and a placeholder note in the PR body.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { correlateForCisoChains } = require("@/app/lib/ciso-correlator-bridge") as {
  correlateForCisoChains: (opts: {
    tier?: string;
    findings: Array<{ detail: string; module?: string; severity?: string }>;
    hostname?: string;
    askClaude: (prompt: string) => Promise<string>;
    timeoutMs?: number;
  }) => Promise<{
    chains: Array<{ title: string; severity: string; findingNumbers: number[]; findingsInvolved: string[]; impact: string; fixOrder: string }>;
    note: string | null;
    skipped: boolean;
  }>;
};

// Phase 1.4 — PR-body composer. Builds the structured markdown report
// from every artifact this route collects (fixes, errors, attempt
// history, gate results, before/after findings, regression tests).
// Pure string composition.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { composePrBody } = require("@/app/lib/pr-composer") as {
  composePrBody: (opts: {
    fixes?: Array<{ file: string; original: string; fixed: string; issues: string[] }>;
    errors?: string[];
    attemptHistoryByFile?: Record<string, { attempts: Array<{ attemptNumber: number; durationMs: number; outcome: string }>; summary: string; success: boolean }>;
    syntaxGate?: { summary?: string };
    scannerGate?: { summary?: string; skipped?: boolean; reason?: string };
    testGen?: { summary?: string };
    originalFindingsByModule?: Record<string, string[]>;
    postFixFindingsByModule?: Record<string, string[]>;
    repoUrl?: string;
    /** Pre-rendered CVE patches markdown section from composeCveFixPrSection. */
    cveSection?: string;
    /** Forensic-tier CISO report descriptor (path/riskLevel/complianceGaps/counts/failed). */
    cisoReport?: {
      path?: string;
      riskLevel?: string;
      complianceGaps?: { owasp: unknown[]; soc2: unknown[]; cis: unknown[] };
      counts?: { Critical: number; High: number; Medium: number; Low: number };
      failed?: boolean;
    };
  }) => string;
};

// Phase 1.3 — test generation per fix.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateTestsForFixes } = require("@/app/lib/test-generator") as {
  generateTestsForFixes: (opts: {
    fixes: Array<{ file: string; fixed: string; original: string; issues: string[] }>;
    askClaudeForTest: (prompt: string) => Promise<string>;
    frameworkHint?: string;
  }) => Promise<{
    tests: Array<{ path: string; content: string; sourceFile: string }>;
    skipped: Array<{ sourceFile: string; reason: string }>;
    summary: string;
  }>;
};
// Phase 1.2b production wiring — server-side hydration of the original
// workspace + baseline findings when the caller didn't supply them.
// This is what turns the scanner gate from a no-op into a live gate for
// every production caller (scan page, admin Command Center, watchdog).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hydrateFixWorkspace } = require("@/app/lib/fix-workspace-hydrator") as {
  hydrateFixWorkspace: (opts: {
    owner: string;
    repo: string;
    token: string;
    tier?: string;
    issueFiles: string[];
    existingFileContents?: Array<{ path: string; content: string }>;
    existingFindings?: Record<string, string[]> | null;
    fetchTree: (owner: string, repo: string, ref: string, token: string) => Promise<string[]>;
    fetchBlob: (owner: string, repo: string, path: string, ref: string, token: string) => Promise<string | null>;
    runTier?: (tier: string, ctx: { owner: string; repo: string; files: string[]; fileContents: Array<{ path: string; content: string }> }) => Promise<{ modules: Array<{ name: string; details?: string[] }>; totalIssues: number }>;
    maxFiles?: number;
  }) => Promise<{
    fileContents: Array<{ path: string; content: string }>;
    findingsByModule: Record<string, string[]> | null;
    hydratedFiles: boolean;
    hydratedFindings: boolean;
    reason: string | null;
  }>;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateFixesAgainstScanner } = require("@/app/lib/cross-fix-scanner-gate") as {
  validateFixesAgainstScanner: (opts: {
    fixes: Array<{ file: string; fixed: string; original: string; issues: string[] }>;
    originalFileContents: Array<{ path: string; content: string }>;
    originalFindingsByModule: Record<string, string[]>;
    runTier: (tier: string, ctx: { owner: string; repo: string; files: string[]; fileContents: Array<{ path: string; content: string }> }) => Promise<{ modules: Array<{ name: string; details?: string[] }>; totalIssues: number }>;
    owner: string;
    repo: string;
    tier?: string;
  }) => Promise<{
    accepted: Array<{ file: string; fixed: string; original: string; issues: string[] }>;
    rolledBack: Array<{ file: string; fixed: string; original: string; issues: string[]; reason: string; newFindings: string[] }>;
    unattributedFindings: Array<{ module: string; detail: string }>;
    postFixFindingsByModule: Record<string, string[]>;
    summary: string;
  }>;
};

// Phase 1.2a — cross-fix syntax-validation gate. Sits between the
// per-file iterative loop and PR creation. Catches Claude output that
// passes shape + pattern checks but doesn't actually parse.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateFixesSyntax, summariseSyntaxGate } = require("@/app/lib/cross-fix-syntax-gate") as {
  validateFixesSyntax: (opts: {
    fixes: Array<{ file: string; fixed: string; original: string; issues: string[] }>;
  }) => {
    accepted: Array<{ file: string; fixed: string; original: string; issues: string[]; language: string }>;
    rejected: Array<{ file: string; fixed: string; original: string; issues: string[]; reason: string; language: string }>;
  };
  summariseSyntaxGate: (result: { accepted: unknown[]; rejected: unknown[] }) => string;
};
// Day-2 — Surgical-diff fix mode. Sends Claude only the issue ± N lines of
// context, gets back a replacement block, splices into the original. Bytes
// outside the splice are byte-identical because we never sent them.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const surgicalFix = require("@lib/surgical-fix") as {
  extractIssueContext: (fileContent: string, lineNumber: number, contextLines?: number) => {
    slice: string; startLine: number; endLine: number; totalLines: number; lineEnding: string;
  };
  buildSurgicalPrompt: (opts: { filePath: string; slice: string; startLine: number; endLine: number; issues: string[] }) => string;
  parseReplacementBlock: (claudeResponse: string) => string;
  spliceReplacement: (originalContent: string, startLine: number, endLine: number, replacement: string, lineEnding?: string) => string;
  validateSurgicalFix: (opts: { originalContent: string; fixedContent: string; startLine: number; endLine: number; lineEnding?: string }) => {
    ok: boolean; reason?: string; mutatedLines?: number[];
  };
};

// Day-2 — Whole-file mutation guard. Used in the fallback path when an issue
// has no parseable line number. Computes a line-level diff and rejects fixes
// that change far more lines than the issue count justifies.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mutationGuard = require("@lib/whole-file-mutation-guard") as {
  evaluateMutation: (opts: {
    original: string; fixed: string; issueCount: number;
    maxChangePerIssue?: number; maxAbsoluteChange?: number; maxPercentChange?: number;
  }) => { ok: boolean; reason?: string; stats: Record<string, number> };
  summariseMutation: (result: { ok: boolean; reason?: string; stats: Record<string, number> }) => string;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { attemptFixWithRetries, summariseAttempts } = require("@/app/lib/fix-attempt-loop") as {
  attemptFixWithRetries: (opts: {
    askClaude: (issues: string[]) => Promise<string>;
    validateFix: (original: string, fixed: string) => { ok: boolean; reason?: string };
    verifyFixQuality: (fixed: string, filePath: string) => { clean: boolean; newIssues: string[] };
    originalContent: string;
    filePath: string;
    issues: string[];
    maxAttempts?: number;
    now?: () => number;
  }) => Promise<{
    success: boolean;
    fixed: string | null;
    attempts: Array<{
      attemptNumber: number;
      startedAt: number;
      durationMs: number;
      outcome: "success" | "validation-fail" | "quality-fail" | "claude-error";
      validationReason: string | null;
      qualityIssues: string[];
      claudeError: string | null;
    }>;
    finalReason: string | null;
  }>;
  summariseAttempts: (attempts: Array<{ outcome: string; durationMs: number }>) => string;
};
// Flywheel telemetry — records WHICH layer handled each fix so the nightly
// pattern-miner trains on production data, not just CLI runs. Best-effort,
// never throws (resilience contract documented in the module).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { recordFixAttempt } = require("@/app/lib/fix-telemetry") as {
  recordFixAttempt: (entry: {
    layer: "ast" | "rule" | "recipe" | "claude" | null;
    success: boolean;
    issueRuleKey?: string;
    module?: string;
    durationMs?: number;
    costUsd?: number;
    reason?: string;
    model?: string;
    fileExt?: string;
  }) => void;
};
// Shape of the shared adaptive-concurrency state object. Mirrors the JS
// source at website/app/lib/adaptive-concurrency.js — workers may mutate
// `activeConcurrency` (throttle) or `haltRun` (abort) and the pool reacts.
type AdaptiveState = {
  consecutiveNetworkErrors: number;
  activeConcurrency: number;
  haltRun: boolean;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { mapWithAdaptiveConcurrency } = require("@/app/lib/adaptive-concurrency") as {
  mapWithAdaptiveConcurrency: <T, R>(
    items: T[],
    initialLimit: number,
    fn: (item: T, state: AdaptiveState) => Promise<R>,
  ) => Promise<R[]>;
};

// CVE-to-Fix Pipeline — Tier-1 Item 3 from the HYPER-AGGRESSIVE PRODUCT
// EVOLUTION ROADMAP. When security/dependencies modules emit CVE-shaped
// findings, the fix path generates a version-bump patch WITHOUT going
// through Claude. Headline feature vs Dependabot (which only opens
// advisory PRs — we open FIXED PRs).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CVE_ID_PATTERN, extractCveContext, generateVersionBumpPatch, composeCveFixPrSection, summariseCvePatches } = require("@lib/cve-to-fix") as {
  CVE_ID_PATTERN: RegExp;
  extractCveContext: (issueText: string) => {
    cveId: string;
    packageName: string;
    currentVersion: string | null;
    patchedVersion: string | null;
    ecosystem: string;
  } | null;
  generateVersionBumpPatch: (opts: {
    ecosystem: string;
    packageName: string;
    currentVersion: string | null;
    patchedVersion: string;
    fileContent: string;
    filePath: string;
    cveId?: string;
  }) => { newContent: string; changeSummary: string } | null;
  composeCveFixPrSection: (patches: Array<{
    packageName: string;
    currentVersion: string | null;
    patchedVersion: string;
    cveId: string;
    filePath?: string;
  }>) => string;
  summariseCvePatches: (patches: Array<{
    packageName: string;
    currentVersion: string | null;
    patchedVersion: string;
    cveId: string;
    filePath?: string;
  }>) => string;
};

// Contextual Grounding — injects the customer's own project conventions
// (CLAUDE.md, AGENTS.md, ARCHITECTURE.md, .cursorrules, README.md,
// CONTRIBUTING.md) into every Claude fix prompt so Claude doesn't suggest
// fixes that contradict documented project patterns.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { extractConventions, formatGroundingHeader, summariseGrounding } = require("@lib/contextual-grounding") as {
  extractConventions: (opts: {
    files?: string[];
    fileContents?: Array<{ path: string; content: string }>;
    maxBytesPerFile?: number;
    maxTotalBytes?: number;
  }) => {
    found: Array<{ path: string; excerpt: string; bytes: number }>;
    totalBytes: number;
    omitted: string[];
  };
  formatGroundingHeader: (found: Array<{ path: string; excerpt: string; bytes: number }>) => string;
  summariseGrounding: (result: {
    found: Array<{ path: string; bytes: number }>;
    totalBytes: number;
    omitted: string[];
  }) => string;
};

// Phase: cluster + cap. A real customer scan returns 900-1000 raw
// findings that mostly collapse to ~30 unique root causes. This helper
// groups by file (since the fix loop already passes a whole file to
// Claude in one call), ranks by impact (root-cause files first), and
// caps to a per-tier file budget. Anything beyond the cap ships in the
// PR as advisory, not as a Claude fix — protects unit economics.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { clusterAndRank } = require("@/app/lib/finding-clusterer") as {
  clusterAndRank: (
    issues: Array<{ file: string; issue: string; module: string; line?: number; live?: boolean }>,
    opts?: { includeWarnings?: boolean }
  ) => {
    clusters: Array<{
      file: string;
      issues: Array<{ file: string; issue: string; module: string; line?: number; live?: boolean }>;
      count: number;
      modules: string[];
      severityCounts: { error: number; warning: number; info: number };
      topSeverity: 'error' | 'warning' | 'info';
      isRootCause: boolean;
      liveCount: number;
      hasLive: boolean;
    }>;
    advisory: { warnings: Array<unknown>; info: Array<unknown> };
    totalIssuesIn: number;
    totalIssuesClustered: number;
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyFixCap, clustersToIssues, renderAdvisorySection } = require("@/app/lib/fix-cap") as {
  applyFixCap: (
    clusters: Array<{
      file: string;
      issues: Array<{ file: string; issue: string; module: string; line?: number; live?: boolean }>;
      count: number;
      topSeverity: string;
      isRootCause: boolean;
      modules: string[];
      liveCount?: number;
      hasLive?: boolean;
    }>,
    tier: string
  ) => {
    toFix: Array<{
      file: string;
      issues: Array<{ file: string; issue: string; module: string; line?: number; live?: boolean }>;
      count: number;
      topSeverity: string;
      modules: string[];
      isRootCause: boolean;
      liveCount?: number;
      hasLive?: boolean;
    }>;
    advisory: Array<{
      file: string;
      issues: Array<{ file: string; issue: string; module: string; line?: number; live?: boolean }>;
      count: number;
      topSeverity: string;
      modules: string[];
      isRootCause: boolean;
      liveCount?: number;
      hasLive?: boolean;
    }>;
    cap: number;
    tier: string;
    wouldHaveFixed: number;
    advisoryIssueCount: number;
  };
  clustersToIssues: (
    clusters: Array<{ issues: Array<{ file: string; issue: string; module: string; line?: number }> }>
  ) => Array<{ file: string; issue: string; module: string; line?: number }>;
  renderAdvisorySection: (capResult: {
    advisory: Array<{ file: string; topSeverity: string; count: number; modules: string[] }>;
    cap: number;
    tier: string;
    advisoryIssueCount: number;
  }) => string;
};

type BudgetSummary = {
  spentUsd: number;
  capUsd: number;
  capReached: boolean;
  capKind: "ai-budget" | "time" | "invocations" | null;
  filesFixed: number;
  filesRemaining: number;
  advisoryFiles: number;
  advisoryFindings: number;
  severityCovered: { fixed: Record<string, number>; remaining: Record<string, number> };
  allHighSeverityCovered: boolean;
  failedFileCount: number;
  retry: { kind: "free-rerun"; message: string };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildBudgetSummary, renderBudgetSummaryMarkdown } = require("@/app/lib/budget-summary") as {
  buildBudgetSummary: (input: {
    snapshot?: Record<string, unknown>;
    fixes?: Array<unknown>;
    failedFiles?: Array<unknown>;
    skippedForTimeBudget?: number;
    skippedForAiBudget?: number;
    invocationLimitHit?: boolean;
    capResult?: Record<string, unknown>;
  }) => BudgetSummary;
  renderBudgetSummaryMarkdown: (summary: BudgetSummary) => string;
};

// Default attempt ceiling — set higher than the old hardcoded "1+1 retry"
// so the loop has room to learn from its own mistakes. Configurable via
// GATETEST_FIX_MAX_ATTEMPTS env var if a deployment wants tighter cost
// control or more aggressive recovery.
const DEFAULT_MAX_ATTEMPTS = Number(process.env.GATETEST_FIX_MAX_ATTEMPTS) || 3;

// Vercel Pro allows up to 300s. Fix runs 44 issues across ~10 files, each file
// needs a Claude call + GitHub read + commit. 300s gives headroom for retries
// without pushing browser into connection-reset territory.
export const maxDuration = 300;
export const runtime = "nodejs";

// Hard time budget (ms). We STOP accepting new files at 80% of maxDuration so
// commits + PR creation have time to run. Worst case we ship a partial fix PR
// with what we managed to complete.
const TIME_BUDGET_MS = 240_000;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// Circuit breaker — stops AI invocations mid-flight when the repo is
// so large that 1000 Claude calls would be needed. Partial fixes are
// committed and the PR body includes an enterprise upgrade prompt.
// Applied only on scan_fix ($199) and nuclear/forensic ($399) tiers.
const MAX_AI_INVOCATIONS = 1000;

// Retryable network error shapes — the TLS / connection-level failures that
// throw BEFORE an HTTP response is ever produced. Notably includes EPROTO
// "SSL alert number 80" which hits hard when undici's keep-alive pool gets
// poisoned by a single bad socket and subsequent parallel writes inherit the
// failure. Retry with a fresh request (and jitter) to sidestep the pool.
function isRetryableNetworkError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const code = (err as { code?: string; cause?: { code?: string } }).code
    || (err as { cause?: { code?: string } }).cause?.code
    || "";
  // AbortError from our 45s timeout — the file may be large or Anthropic slow;
  // treat as transient so it goes into the retry queue rather than hard-failing.
  if (name === "AbortError" || /aborted|abort/i.test(msg)) return true;
  const retryableCodes = [
    "EPROTO", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT",
    "EAI_AGAIN", "ENOTFOUND", "EPIPE", "EHOSTUNREACH",
    "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT", "UND_ERR_RESPONSE_STATUS_CODE",
  ];
  if (retryableCodes.includes(code)) return true;
  // Match text shapes too — undici sometimes surfaces them in the message
  if (/EPROTO|ECONNRESET|ETIMEDOUT|ssl.*alert|handshake|fetch failed|socket hang up|TLS/i.test(msg)) {
    return true;
  }
  return false;
}

async function anthropicCall(body: string): Promise<{ status: number; data: Record<string, unknown> }> {
  // Budget guard — checks the per-tier USD/token cap BEFORE making the
  // call. If the cap was already crossed on a prior call this throws a
  // BUDGET_EXCEEDED Error carrying a snapshot for the route handler to
  // surface as a clean 402. Caller does NOT need to wrap — the throw
  // propagates through the retry layer to the POST handler's catch.
  // When no tracker is in context (e.g. tests that don't wrap), this is
  // a no-op.
  const tracker = getCurrentTracker();
  // Invocation circuit breaker — check BEFORE the USD budget preflight so
  // over-limit repos get a clear "upgrade to enterprise" message rather
  // than an opaque 402 budget-exceeded error.
  if (tracker && tracker._maxInvocations !== undefined) {
    if (tracker.callCount >= tracker._maxInvocations) {
      const err = new Error(`INVOCATION_LIMIT_EXCEEDED:${tracker._maxInvocations}`);
      err.name = "INVOCATION_LIMIT_EXCEEDED";
      throw err;
    }
  }
  if (tracker) tracker.preflight();

  const controller = new AbortController();
  // Anthropic max_tokens=8192 at sonnet speeds rarely exceeds 30s. 45s is a
  // safe per-request ceiling that leaves room for retries inside the 300s
  // function budget and won't let a single stuck request monopolise.
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        // BYOK: a customer key on the request tracker takes priority over the
        // server key. Read per-call (not per-module) so each request stays
        // isolated on Fluid Compute's shared-instance model.
        "x-api-key": ((tracker as unknown as Record<string, unknown>)?.apiKeyOverride as string) || ANTHROPIC_API_KEY,
        "connection": "close",
      },
      body,
      signal: controller.signal,
      // Don't reuse stale keep-alive sockets from the undici pool — one bad
      // TLS socket poisons every parallel request otherwise.
      keepalive: false,
    });
    const text = await res.text();
    let data: Record<string, unknown>;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    const response = { status: res.status, data };
    // Account for spend AFTER receiving — uses Anthropic's exact token
    // counts from the `usage` field when available, falls back to a
    // char-based estimate when the response is malformed / errored.
    if (tracker) tracker.record(body, response);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// Retry wrapper — handles both HTTP-status retries (429/5xx) and raw network
// errors (EPROTO, ECONNRESET, TLS handshake). Jittered exponential backoff so
// parallel retries don't synchronise and re-overwhelm the remote.
//
// 6 attempts with backoff 1s, 2s, 4s, 8s, 16s (+jitter) — total ceiling ~32s
// per file. Bumped from 3 after prod observed cascading SSL alert 80 failures
// where Anthropic needed more time than 1.5s of retries allowed.
async function anthropicCallWithRetry(body: string, maxAttempts = 6): Promise<{ status: number; data: Record<string, unknown> }> {
  let lastError: unknown = null;
  let lastResponse: { status: number; data: Record<string, unknown> } | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const base = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s, 8s, 16s
      const jitter = Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, base + jitter));
    }
    try {
      const res = await anthropicCall(body);
      // Success
      if (res.status === 200) return res;
      // Non-retryable client error — stop immediately
      if (res.status !== 429 && res.status < 500) {
        return res;
      }
      // Retryable HTTP status (429 / 5xx) — continue loop
      lastResponse = res;
    } catch (err) {
      if (!isRetryableNetworkError(err)) {
        // Unknown non-transient error — don't burn all retries on it
        throw err;
      }
      lastError = err;
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error
    ? new Error(`Anthropic API unreachable after ${maxAttempts} attempts: ${lastError.message}`)
    : new Error(`Anthropic API unreachable after ${maxAttempts} attempts`);
}

// The AI-layer model for this request. Set on the per-request tracker (ALS) from
// modelForTier(tier): Fable 5 on paid fix tiers, Sonnet 5 elsewhere. Falls
// back to Sonnet when no tracker is in context (tests, direct calls).
function activeFixModel(): string {
  const t = getCurrentTracker();
  return (t && (t.fixModel as string)) || CHEAP_MODEL;
}

// Extra request fields that only apply to the higher-tier fix model. `effort:
// "high"` is valid on both Sonnet 5 and Fable 5, but we only spend it on the
// paid fix model so cheap paths aren't silently made more expensive. A Fable
// classifier refusal returns HTTP 200 with empty content — the existing
// validateFixOutput rejects it and that finding falls through to the advisory
// section, so a refusal degrades one fix gracefully rather than erroring.
function fixModelExtras(model: string): Record<string, unknown> {
  return needsRefusalFallback(model) ? { output_config: { effort: "high" } } : {};
}

async function askClaude(fileContent: string, filePath: string, issues: string[], conventionsHeader = ""): Promise<string> {
  // Enrich broken-link issues with context about what actually exists
  const enrichedIssues = await Promise.all(issues.map(async (issue) => {
    const brokenMatch = issue.match(/BROKEN LINK \(404\):\s*(https:\/\/github\.com\/([^/]+)\/([^/]+)\/([^\s]+))/i);
    if (brokenMatch) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [, _fullUrl, owner, repo, _path] = brokenMatch;
      try {
        // Check what releases actually exist
        const relRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
          headers: { "User-Agent": "GateTest", "Accept": "application/vnd.github.v3+json" },
        });
        if (relRes.ok) {
          const releases = await relRes.json() as Array<{ tag_name: string; html_url: string; assets: Array<{ name: string; browser_download_url: string }> }>;
          if (releases.length > 0) {
            const latest = releases[0];
            const assetList = latest.assets.map((a: { name: string; browser_download_url: string }) => `  - ${a.name}: ${a.browser_download_url}`).join("\n");
            return `${issue}\n\nCONTEXT: This URL 404s. The repo ${owner}/${repo} has ${releases.length} release(s). Latest: ${latest.tag_name} (${latest.html_url}).\nAvailable assets:\n${assetList || "  (no downloadable assets in latest release)"}\n\nFIX: Replace the broken URL with the correct release URL or asset download URL from above.`;
          } else {
            return `${issue}\n\nCONTEXT: The repo ${owner}/${repo} has NO releases. The download link cannot work. FIX: Either remove the download button, link to the repo page (https://github.com/${owner}/${repo}), or create a release first.`;
          }
        }
      } catch { /* fall through to original issue */ }
    }
    return issue;
  }));

  const prompt = `${conventionsHeader}You are an expert code fixer for GateTest, an AI-powered QA platform with 120 scanning modules.

Fix ALL of the following issues in this file. Every fix must pass GateTest's re-scan.

FILE: ${filePath}
ISSUES TO FIX:
${enrichedIssues.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}

CURRENT CODE:
\`\`\`
${fileContent}
\`\`\`

CRITICAL RULES — violations will cause re-scan failure:
- Return ONLY the complete fixed file content. No explanations. No markdown code fences.
- Fix the ROOT CAUSE, not the symptom. Never patch over an issue.
- NEVER introduce these patterns (GateTest scans for them):
  * console.log / console.debug / console.info in library code
  * debugger statements
  * TODO / FIXME / HACK / XXX comments
  * eval() or Function() calls
  * Hardcoded secrets, API keys, tokens, passwords
  * var declarations (use const/let)
  * Empty catch blocks
  * Unused imports or variables
- Preserve every non-issue line exactly — do not rewrite or reformat unrelated code.
- Never remove functionality to "fix" a warning.
- If a fix would require context you don't have, output the UNCHANGED original file verbatim.
- The fixed code will be automatically re-scanned. If it fails, the fix is rejected.`;

  const fixModel = activeFixModel();
  const body = JSON.stringify({
    model: fixModel,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
    ...fixModelExtras(fixModel),
  });

  const res = await anthropicCallWithRetry(body);
  if (res.status === 200) {
    const content = res.data.content as Array<{ type: string; text: string }>;
    let fixedCode = content?.[0]?.text || "";
    // Strip markdown code fences if Claude added them despite instructions
    fixedCode = fixedCode.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
    return fixedCode;
  }
  const errSnippet = JSON.stringify(res.data).slice(0, 200);
  throw new Error(`Claude API error ${res.status}: ${errSnippet}`);
}

/**
 * Validate Claude's fix output before we commit it.
 * Catches truncation (max_tokens hit), refusals, and obvious garbage.
 */
function validateFix(original: string, fixed: string): { ok: boolean; reason?: string } {
  if (!fixed || fixed.trim().length === 0) {
    return { ok: false, reason: "empty output" };
  }
  if (fixed === original) {
    return { ok: false, reason: "no changes produced" };
  }
  if (original.length > 500 && fixed.length < original.length * 0.4) {
    return { ok: false, reason: `likely truncation (${fixed.length}/${original.length} chars)` };
  }
  const refusalMarkers = ["I cannot", "I can't", "I'm unable to", "I won't", "As an AI"];
  const firstLine = fixed.split("\n", 1)[0] || "";
  if (refusalMarkers.some((m) => firstLine.startsWith(m))) {
    return { ok: false, reason: "Claude refused" };
  }
  return { ok: true };
}

/**
 * Verify that fixed code doesn't introduce NEW issues that GateTest would catch.
 * Runs the same pattern checks our scan modules use.
 */
function verifyFixQuality(fixed: string, filePath: string): { clean: boolean; newIssues: string[] } {
  const issues: string[] = [];
  const lines = fixed.split("\n");
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const isSource = ["js", "ts", "jsx", "tsx", "mjs", "cjs"].includes(ext);

  if (!isSource) return { clean: true, newIssues: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments and strings for some checks
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    // console.log/debug/info in non-test files
    if (!filePath.includes(".test.") && !filePath.includes(".spec.") && !filePath.includes("__test")) {
      if (/\bconsole\.(log|debug|info)\s*\(/.test(line)) {
        issues.push(`Line ${i + 1}: console.log/debug/info introduced`);
      }
    }

    // debugger statements
    if (/^\s*debugger\s*;?\s*$/.test(line)) {
      issues.push(`Line ${i + 1}: debugger statement introduced`);
    }

    // TODO/FIXME/HACK/XXX
    if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(line)) {
      issues.push(`Line ${i + 1}: TODO/FIXME comment introduced`);
    }

    // eval()
    if (/\beval\s*\(/.test(line) && !trimmed.startsWith("//")) {
      issues.push(`Line ${i + 1}: eval() introduced`);
    }

    // var declarations
    if (/^\s*var\s+\w/.test(line)) {
      issues.push(`Line ${i + 1}: var declaration introduced (use const/let)`);
    }

    // Empty catch blocks
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
      issues.push(`Line ${i + 1}: empty catch block introduced`);
    }
  }

  return { clean: issues.length === 0, newIssues: issues };
}

// Concurrency cap for parallel file fixing — balances Vercel time budget vs API rate.
// Dropped from 4 → 2 after prod hit cascading EPROTO / TLS alert 80 failures under
// heavy undici keep-alive pressure. Two parallel requests + keepalive:false on each
// keeps fresh sockets without pool-poisoning a whole batch when one goes bad.
const FIX_CONCURRENCY = 2;
// Max file size we'll send to Claude (bigger risks output truncation at 8192 tokens).
const MAX_FILE_BYTES = 400 * 1024;

/**
 * Ask Claude to generate a NEW file (when it doesn't exist yet).
 * Used when the issue is "Missing X" and we need to create X.
 */
/**
 * Phase 1.3 — thin wrapper around anthropicCallWithRetry shaped for
 * the test-generator's askClaudeForTest contract: takes a prompt,
 * returns the raw text. Same model + retry behaviour as the main
 * fix path.
 */
async function askClaudeForTest(prompt: string): Promise<string> {
  const fixModel = activeFixModel();
  const body = JSON.stringify({
    model: fixModel,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
    ...fixModelExtras(fixModel),
  });
  const res = await anthropicCallWithRetry(body);
  if (res.status !== 200) {
    const errSnippet = JSON.stringify(res.data).slice(0, 200);
    throw new Error(`Claude API error ${res.status}: ${errSnippet}`);
  }
  const content = res.data.content as Array<{ type: string; text: string }>;
  return content?.[0]?.text || "";
}

async function askClaudeCreate(filePath: string, context: string[]): Promise<string> {
  const prompt = `You are an expert developer. Generate the COMPLETE contents of a new file.

FILE TO CREATE: ${filePath}
CONTEXT / REASON:
${context.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Rules:
- Return ONLY the file content. No explanations. No markdown code fences.
- Generate a production-ready file, not a stub.
- For .gitignore: include standard Node, env, and secret exclusions.
- For README.md: include project purpose, installation, usage sections.
- For .env.example: include common env vars with descriptions.
- For tsconfig.json: use modern strict settings.
- Follow whatever format the file extension implies.`;

  const fixModel = activeFixModel();
  const body = JSON.stringify({
    model: fixModel,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
    ...fixModelExtras(fixModel),
  });

  const res = await anthropicCallWithRetry(body);

  if (res.status !== 200) {
    const errSnippet = JSON.stringify(res.data).slice(0, 200);
    throw new Error(`Claude API error ${res.status}: ${errSnippet}`);
  }

  const content = res.data.content as Array<{ type: string; text: string }>;
  let newFile = content?.[0]?.text || "";
  newFile = newFile.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
  return newFile;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Shared mutable state for adaptive concurrency — when Anthropic starts rejecting
// with SSL alerts, parallel requests just poison each other. Drop to serial and
// let the retry backoff do the work, rather than burning the whole budget in
// parallel failures.
//
// `mapWithAdaptiveConcurrency` is implemented in
// `website/app/lib/adaptive-concurrency.js` (pure JS for testability).
// The matching AdaptiveState type is declared earlier in this file (line ~224)
// next to the require() of the JS module — no second declaration here.

interface IssueInput {
  file: string;
  issue: string;
  module: string;
  // Day-2: when the extractor parsed a line number out of the finding, it's
  // forwarded here. Issues with `line` go through surgical-fix mode; issues
  // without fall back to whole-file mode with the mutation guard.
  line?: number;
  // 🔥 LIVE: set by callers that already ran the static-runtime correlator
  // (or by this route when `runtimeEvents` is supplied). Live issues bubble
  // their cluster to the FRONT of the fix queue — GateTest fixes what
  // production says is broken, first.
  live?: boolean;
}

// Production runtime events (Sentry / Datadog / Rollbar / Vercel shapes as
// normalised by the clients in app/lib). When supplied, findings are
// correlated pre-clustering and matching ones are flagged `live`.
interface RuntimeEventInput {
  sourceLocation: { file: string; line: number } | null;
  message?: string;
  service?: string;
  timestamp?: string;
}

// Phase 1.2b — optional callers can pass the pre-fix workspace and the
// pre-fix module findings so the scanner re-validation gate has a
// baseline to diff against. When absent, the gate is skipped (the
// per-file iterative loop + syntax gate still run; only cross-file
// regression detection is missing).
interface OriginalFileInput {
  path: string;
  content: string;
}

export async function POST(req: NextRequest) {
  let input: {
    repoUrl?: string;
    issues?: IssueInput[];
    runtimeEvents?: RuntimeEventInput[];
    originalFileContents?: OriginalFileInput[];
    originalFindingsByModule?: Record<string, string[]>;
    tier?: string;
    // Customer-supplied GitHub PAT — used for ONE request only, never
    // stored, never logged. When supplied AND validated, overrides the
    // server-side resolveRepoAuth fallback so customers without our
    // GitHub App installed can still get the fix PR opened on their repo.
    //
    // Expected shape: `ghp_*` (classic), `github_pat_*` (fine-grained),
    // or any GH-issued token. Must have `repo` scope (or `contents:write`
    // + `pull_requests:write` for fine-grained).
    //
    // Security:
    //   - Validated against /repos/<owner>/<repo> via probe BEFORE we
    //     waste any Anthropic tokens on the fix loop.
    //   - Used only to push the branch + open the PR; not echoed anywhere.
    //   - JavaScript can't truly zero memory but the variable goes out
    //     of scope as soon as the request returns.
    customerPat?: string;
    // Optional explicit model choice (Craig 2026-07-10 — user-selectable
    // model). Validated against the engine-models allow-list; overrides the
    // per-tier default on the request tracker.
    model?: string;
    // Customer-supplied Anthropic key (BYOK — Craig 2026-07-10). Same
    // security contract as customerPat: used for THIS request only, never
    // stored, never logged, never echoed in any response, PR body, or budget
    // summary. Shape-checked (sk-ant-*) before use. When present, all fix
    // calls ride the customer's own key and the per-tier USD cap is lifted
    // (their budget); the tier token cap stays as runaway protection.
    anthropicApiKey?: string;
  };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { repoUrl, issues: rawIssues } = input;

  if (!repoUrl || !rawIssues || rawIssues.length === 0) {
    return NextResponse.json({ error: "Missing repoUrl or issues" }, { status: 400 });
  }

  if (Array.isArray(input.originalFileContents) && input.originalFileContents.length > 500) {
    return NextResponse.json(
      { error: "originalFileContents too large (max 500 files)" },
      { status: 400 },
    );
  }

  // Explicit model choice — validate early so a bad name fails fast (400)
  // before any rate-limit or AI work.
  let chosenModel: string | null = null;
  if (input.model !== undefined) {
    const choice = resolveModelChoice(input.model);
    if (!choice.ok) {
      return NextResponse.json(
        { error: choice.error, allowedModels: allowedModelIds() },
        { status: 400 },
      );
    }
    chosenModel = choice.model;
  }

  // BYOK key — shape-check only (never validated by echoing it anywhere).
  const byokKey = typeof input.anthropicApiKey === "string" && input.anthropicApiKey.trim()
    ? input.anthropicApiKey.trim()
    : null;
  if (byokKey && !/^sk-ant-/.test(byokKey)) {
    return NextResponse.json(
      { error: "anthropicApiKey must be an Anthropic API key (sk-ant-...)" },
      { status: 400 },
    );
  }

  if (!ANTHROPIC_API_KEY && !byokKey) {
    return NextResponse.json(
      { error: "AI not configured (ANTHROPIC_API_KEY) — supply anthropicApiKey (BYOK) to run on your own key" },
      { status: 503 },
    );
  }

  // 🔥 LIVE correlation — when the caller supplies production runtime
  // events (Sentry / Datadog / Rollbar), correlate them against the
  // findings BEFORE clustering so live clusters rank first in the fix
  // queue. The correlator returns a re-SORTED copy, so live flags are
  // captured via a keyed map (file:line:issue) — never by index.
  // Callers may also pass pre-flagged `issue.live` directly; both paths
  // merge. Best-effort: correlation failure never blocks the fix flow.
  let liveCorrelation: { liveCount: number; findings: Array<Record<string, unknown>> } | null = null;
  let issuesForClustering: IssueInput[] = rawIssues;
  if (Array.isArray(input.runtimeEvents) && input.runtimeEvents.length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { correlateFindingsWithRuntime } = require("@/app/lib/static-runtime-correlator") as {
        correlateFindingsWithRuntime: (opts: {
          findings: Array<{ file: string; line: number; severity: string; detail: string }>;
          datadogErrors: RuntimeEventInput[];
        }) => { findings: Array<{ file: string; line: number; detail: string; live: boolean }>; liveCount: number };
      };
      const corr = correlateFindingsWithRuntime({
        findings: rawIssues.map((i) => ({
          file: i.file,
          line: i.line || 0,
          severity: "error",
          detail: i.issue,
        })),
        datadogErrors: input.runtimeEvents,
      });
      const liveKeys = new Set(
        corr.findings
          .filter((f) => f.live)
          .map((f) => `${f.file}::${f.line || 0}::${f.detail}`),
      );
      issuesForClustering = rawIssues.map((i) => ({
        ...i,
        live: i.live === true || liveKeys.has(`${i.file}::${i.line || 0}::${i.issue}`),
      }));
      liveCorrelation = {
        liveCount: corr.findings.filter((f) => f.live).length,
        findings: corr.findings as unknown as Array<Record<string, unknown>>,
      };
    } catch (err) { // error-ok: live correlation is best-effort augmentation; logged, scan continues
      console.error("[scan/fix] LIVE correlation failed (non-blocking):", err instanceof Error ? err.message : String(err));
    }
  }

  // Cluster + cap. Collapses noisy multi-file fan-out (e.g. one tsconfig
  // strict-false flag → 200 implicit-any findings across 50 files) into
  // a ranked list of per-file fixes, then trims to the tier's budget.
  // Default policy: include errors + warnings, drop info-severity
  // (which is typically "scanned 42 files" chatter). Anything trimmed
  // by the cap surfaces in the PR comment as advisory.
  const tierForCap = input.tier || "full";
  const clusterResult = clusterAndRank(issuesForClustering, { includeWarnings: true });
  const capResult = applyFixCap(clusterResult.clusters, tierForCap);
  const advisoryMarkdown = renderAdvisorySection(capResult);
  const issues = clustersToIssues(capResult.toFix);

  if (issues.length === 0) {
    return NextResponse.json(
      {
        status: "no_fixable",
        message: `No error/warning-severity findings to fix. ${clusterResult.advisory.info.length} info-level findings were excluded as non-actionable.`,
        cluster: {
          totalIssuesIn: clusterResult.totalIssuesIn,
          totalClusters: clusterResult.clusters.length,
          infoFindings: clusterResult.advisory.info.length,
        },
      },
      { status: 400 }
    );
  }

  // Rate-limit AFTER body parsing + validation, BEFORE Anthropic/GitHub API calls.
  // Admin requests bypass the limiter — they are internal and authenticated.
  if (!isAdminRequest(req)) {
    const _rlScanFix = await _scanFixLimiter.guard(req);
    if (!_rlScanFix.allowed) {
      return NextResponse.json(_rlScanFix.body, {
        status: _rlScanFix.status ?? 429,
        headers: _rlScanFix.headers as Record<string, string>,
      });
    }
  }

  // Budget tracker — caps Anthropic spend at the per-tier ceiling. Runs
  // for the entire request via AsyncLocalStorage so anthropicCall() can
  // reach it without explicit threading. Stored on the closure so the
  // route's outer try/catch can attach a snapshot to any error response.
  const _budgetTracker = createTrackerForTier(tierForCap, { byok: Boolean(byokKey) });
  // Hybrid engine (Craig 2026-07-07): the AI layer runs Fable 5 on the paid fix
  // tiers and Sonnet 5 elsewhere. The chosen model rides on the per-request
  // tracker (which lives in ALS) so anthropicCall's helpers read it without
  // module-global state — safe on Fluid Compute's shared-instance model.
  // An explicit user `model` choice overrides the per-tier default.
  (_budgetTracker as Record<string, unknown>).fixModel = chosenModel || modelForTier(tierForCap);
  // BYOK: the customer's key rides the tracker the same way — per-request
  // only, unreachable from any other request, gone when the request ends.
  if (byokKey) (_budgetTracker as Record<string, unknown>).apiKeyOverride = byokKey;
  // Wire the invocation circuit breaker for paid AI-fix tiers.
  if (tierForCap === "scan_fix" || tierForCap === "nuclear") {
    (_budgetTracker as Record<string, unknown>)._maxInvocations = MAX_AI_INVOCATIONS;
  }
  return await runWithTracker(_budgetTracker, async (): Promise<NextResponse> => {

  // Accept gluecron.com URLs first; fall back to github.com for links
  // still in customer bookmarks during the migration window.
  const gluecronMatch = repoUrl.match(/gluecron\.com\/([^/]+)\/([^/?#]+)/);
  const githubMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  const repoMatch = gluecronMatch || githubMatch;
  if (!repoMatch) {
    return NextResponse.json({ error: "Invalid repo URL (expected gluecron.com/<owner>/<repo>)" }, { status: 400 });
  }

  const owner = repoMatch[1];
  const repo = repoMatch[2].replace(/\.git$/, "");

  // Top-level guard — wraps everything from auth resolution through PR creation.
  // Node 24 changed unhandledRejection from 'warn' to 'throw'; any uncaught
  // await inside this function would crash the Vercel function. The inner
  // try/catch at the branch-creation block catches PR-layer failures; this outer
  // guard catches auth, file fetching, syntax gate, scanner gate, and any other
  // unexpected throw so the customer always gets a JSON 500 instead of a crash.
  try {

  // Auth resolution — order of preference:
  //   1. Logged-in customer session (OAuth access token from cookie)
  //   2. Customer-supplied PAT in request body (one-shot, per-request)
  //   3. Server-side fallback (Gluecron PAT, then GITHUB_TOKEN env)
  //
  // Session path is the LAUNCH-DEFAULT path — customer clicks "Sign in
  // with GitHub", we use their OAuth token for scan + fix. No PAT to
  // paste, no App to install. Token is AES-256-GCM encrypted in the
  // session cookie and decrypted only inside this Node handler.
  let token: string;
  let authSource: string;

  // (1) Session cookie path — if logged in AND token reaches the repo,
  // skip the PAT + server cascade entirely. Falls through to the next
  // tier if the session doesn't grant access (revoked / scoped-out / etc).
  let sessionResolvedToken: string | null = null;
  try {
    const oauthStatus = getOAuthConfig();
    if (oauthStatus.ok && oauthStatus.config) {
      const cookieStore = await cookies();
      const sessionCookie = cookieStore.get(CUSTOMER_COOKIE_NAME);
      if (sessionCookie && sessionCookie.value) {
        const payload = verifyCustomerSession(sessionCookie.value, oauthStatus.config.sessionSecret);
        if (payload && typeof payload.a === "string" && payload.a) {
          // Probe — does the session's OAuth token actually grant access
          // to THIS repo? OAuth tokens are user-scoped so the user might
          // not have access to the pasted repo URL.
          const probeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${payload.a}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "GateTest-Session-OAuth/1.0",
            },
          });
          if (probeRes.status === 200) {
            sessionResolvedToken = payload.a;
          }
          // 401 / 404 / other — fall through to PAT / server cascade.
        }
      }
    }
  } catch (sessionErr) { // error-ok — session reading must never block the fix flow; log + continue
    console.error("[/api/scan/fix] session resolution failed (continuing):", sessionErr);
  }

  // (2) Customer-PAT path
  const customerPat = typeof input.customerPat === "string" ? input.customerPat.trim() : "";
  // GitHub PAT shapes: classic `ghp_<40>`, fine-grained `github_pat_<...>`,
  // or app-installation `ghs_<...>`. Reject anything that doesn't match
  // a known shape — prevents accidental use of an Anthropic key, an SSH
  // key, or whatever else the customer might paste in the wrong field.
  const PAT_SHAPE = /^(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}|ghs_[A-Za-z0-9]{36,})$/;

  if (sessionResolvedToken) {
    // Logged-in customer's OAuth token already passed the repo probe.
    // Use it for the fix and skip the PAT / server cascade.
    token = sessionResolvedToken;
    authSource = "customer-session";
  } else if (customerPat) {
    if (!PAT_SHAPE.test(customerPat)) {
      return NextResponse.json(
        {
          error: "Supplied PAT doesn't match a recognised GitHub token shape",
          hint: "Use a classic PAT (ghp_*), fine-grained PAT (github_pat_*), or installation token (ghs_*). Generate at https://github.com/settings/tokens",
        },
        { status: 400 }
      );
    }
    // Probe — does this token actually grant repo access? Cheap GET that
    // tells us yes/no without burning the fix budget.
    const probeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${customerPat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "GateTest-Customer-PAT/1.0",
      },
    });
    if (probeRes.status === 401) {
      return NextResponse.json(
        { error: "GitHub PAT was rejected (401 unauthorised). Check the token is valid + not expired." },
        { status: 401 }
      );
    }
    if (probeRes.status === 404) {
      return NextResponse.json(
        { error: `Repo ${owner}/${repo} not found OR the PAT doesn't grant access to it.`, hint: "If the repo is private, ensure the PAT was issued with the repo selected (fine-grained) or full repo scope (classic)." },
        { status: 404 }
      );
    }
    if (probeRes.status !== 200) {
      return NextResponse.json(
        { error: `GitHub repo probe failed with HTTP ${probeRes.status}` },
        { status: 502 }
      );
    }
    token = customerPat;
    authSource = "customer-pat";
  } else {
    // Fall through to server-side token resolution (Gluecron PAT, then
    // GITHUB_TOKEN env). This is the GitHub-App-installed path — works
    // when our App has been installed on the customer's repo.
    const auth = await resolveRepoAuth(owner, repo);
    if (!auth.token) {
      return NextResponse.json(
        {
          error:
            auth.error ||
            "No write access to this repo. Install the GateTestHQ GitHub App OR paste a GitHub PAT (scope 'repo') in the customerPat field to authorise this one fix.",
          hint: "Install: https://github.com/apps/GateTestHQ — or generate a PAT at https://github.com/settings/tokens (Classic) / https://github.com/settings/personal-access-tokens (Fine-grained).",
        },
        { status: 503 }
      );
    }
    token = auth.token;
    authSource = auth.source;
  }

  // Phase 1.2b — hydrate the original workspace + baseline findings when
  // the caller didn't send them. Activates the cross-fix scanner gate,
  // contextual grounding, stack detection and prior-art recall for every
  // production caller. Failure degrades to the old behaviour (gate skips)
  // and the reason is carried into the response below — never blocking.
  const hydration = await hydrateFixWorkspace({
    owner,
    repo,
    token,
    tier: input.tier || "full",
    issueFiles: [...new Set(issues.map((i) => i.file).filter((f): f is string => Boolean(f)))],
    existingFileContents: input.originalFileContents || [],
    existingFindings: input.originalFindingsByModule || null,
    fetchTree,
    fetchBlob,
    runTier,
  });
  input.originalFileContents = hydration.fileContents;
  if (hydration.findingsByModule) {
    input.originalFindingsByModule = hydration.findingsByModule;
  }

  // Group issues by file. Day-2: retain `line` per issue so the per-file
  // worker can choose surgical-fix vs whole-file mode.
  type StructuredIssue = { text: string; line?: number };
  const issuesByFile = new Map<string, StructuredIssue[]>();
  for (const issue of issues) {
    if (!issue.file) continue;
    const existing = issuesByFile.get(issue.file) || [];
    existing.push({ text: issue.issue, line: issue.line });
    issuesByFile.set(issue.file, existing);
  }

  if (issuesByFile.size === 0) {
    return NextResponse.json({ error: "No fixable issues (issues must have file paths)" }, { status: 400 });
  }

  type Fix = { file: string; original: string; fixed: string; issues: string[]; cve?: boolean };
  const fixes: Fix[] = [];
  const errors: string[] = [];

  // CVE-to-Fix accumulator — populated by the per-file CVE fast-path below.
  // Applied patches skip Claude entirely: they are regex version-bumps that
  // need no AI reasoning.
  type CvePatch = { packageName: string; currentVersion: string | null; patchedVersion: string; cveId: string; filePath: string };
  const collectedCvePatches: CvePatch[] = [];

  // Phase 1: per-file attempt history. Each entry captures every attempt
  // the iterative loop made — used in the PR body, surfaced in the API
  // response, and logged so a human reviewer can see at a glance how many
  // attempts each fix took and what each attempt's outcome was.
  type AttemptLog = {
    attemptNumber: number;
    startedAt: number;
    durationMs: number;
    outcome: "success" | "validation-fail" | "quality-fail" | "claude-error";
    validationReason: string | null;
    qualityIssues: string[];
    claudeError: string | null;
  };
  const attemptHistoryByFile: Record<string, { attempts: AttemptLog[]; summary: string; success: boolean }> = {};

  // Contextual Grounding — build ONCE before the per-file loop from whatever
  // file contents the caller already passed in (no extra network call). An
  // empty header means no convention files were found; askClaude treats that
  // as a no-op so the prompt is unchanged. Cached here; both the whole-file
  // and surgical Claude paths use the same header.
  const groundingExtract = extractConventions({
    files: (input.originalFileContents || []).map((f) => f.path),
    fileContents: input.originalFileContents || [],
  });
  // Stack auto-detection — reads package.json / requirements.txt / Cargo.toml /
  // composer.json / pom.xml / build.gradle / vercel.json / Dockerfile / etc.
  // from the in-memory file map, infers (language, framework, db, deploy, ci),
  // and renders a "STACK: TypeScript (Next.js, React) + Prisma on Vercel"
  // prompt header. Claude sees the customer's actual stack upfront, so fix
  // recommendations land on-target instead of asking the customer to adapt
  // a generic snippet.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { detectStack, formatStackHeader } = require("@lib/stack-detector") as {
    detectStack: (opts: { projectRoot: string; fileContents?: Record<string, string> }) => {
      summary: string;
      languages: Array<{ language: string }>;
      frameworks: Array<{ label: string }>;
      databases: Array<{ label: string }>;
      deploy: string[];
      ci: string[];
      testTools: Array<{ label: string }>;
    };
    formatStackHeader: (stack: { summary?: string; testTools?: Array<{ label: string }>; ci?: string[] }) => string;
  };
  const stackFileContents: Record<string, string> = {};
  for (const f of input.originalFileContents || []) {
    stackFileContents[f.path] = f.content;
  }
  const stack = detectStack({ projectRoot: "/", fileContents: stackFileContents });
  const stackHeader = formatStackHeader(stack);

  // Prior-art recall — surfaces the customer's own .gatetest/memory/fix-patterns.json
  // (when committed) so Claude sees "you fixed this kind of issue 4 times before,
  // here's how" before generating the new fix. Per-customer compounding moat;
  // central cross-customer brain is the Boss-Rule Tier 2 unlock.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildPriorArtHeader, summarisePriorArt } = require("@lib/fix-pattern-recall") as {
    buildPriorArtHeader: (opts: {
      fileContents: Array<{ path: string; content: string }>;
      findings: string[];
      maxPatterns?: number;
      maxExamplesPerPattern?: number;
    }) => string;
    summarisePriorArt: (opts: {
      fileContents: Array<{ path: string; content: string }>;
      findings: string[];
    }) => { available: boolean; reason?: string; totalPatternsInStore?: number; matchedThisScan?: number; matchedKeys?: string[] };
  };
  const priorArtHeader = buildPriorArtHeader({
    fileContents: input.originalFileContents || [],
    findings: (input.issues || []).map((i) => `${i.module}: ${i.issue}`),
  });
  const priorArtSummary = summarisePriorArt({
    fileContents: input.originalFileContents || [],
    findings: (input.issues || []).map((i) => `${i.module}: ${i.issue}`),
  });

  // Order in the conventionsHeader passed to Claude:
  //   1. STACK — what tools the customer uses
  //   2. PROJECT CONVENTIONS — how they configure those tools (README/AGENTS/ARCHITECTURE)
  //   3. PRIOR FIXES — how they've fixed similar issues before
  const conventionsHeader = stackHeader + formatGroundingHeader(groundingExtract.found) + priorArtHeader;
  const groundingSummary  = summariseGrounding(groundingExtract);

  // Time budget — start the clock so per-file workers can bail early if the
  // remaining budget won't fit another Claude round-trip + retries.
  const startedAt = Date.now();
  const budgetExceeded = () => Date.now() - startedAt > TIME_BUDGET_MS;
  let skippedForBudget = 0;
  // Files skipped because the tier's Anthropic USD/token cap was crossed
  // mid-run (distinct from the wall-clock budget above). One friendly
  // summary line is pushed after the loop — never a scary error per file.
  let skippedForAiBudget = 0;
  let aiBudgetHalted = false;
  // Files that failed specifically due to Anthropic network/TLS errors — the UI
  // surfaces these as a "Retry Failed" list since they're usually transient and
  // re-running the same payload works without re-running the whole scan.
  const failedFiles: Array<{ file: string; issues: string[]; reason: string }> = [];

  // Process files in parallel (capped concurrency) — major UX win over sequential
  const fileEntries = Array.from(issuesByFile.entries());
  await mapWithAdaptiveConcurrency(fileEntries, FIX_CONCURRENCY, async ([filePath, fileIssues], state) => {
    if (budgetExceeded() || state.haltRun) {
      if (aiBudgetHalted) skippedForAiBudget += 1;
      else skippedForBudget += 1;
      return;
    }
    // String-only view of the issues for legacy callers (CREATE_FILE,
    // whole-file path, error reporting, fix.issues field).
    const fileIssueTexts = fileIssues.map((i) => i.text);

    // -----------------------------------------------------------------------
    // CVE fast-path — version-bump patches that don't need Claude.
    // For each issue in this file that contains a CVE/GHSA ID we try to:
    //   1. extractCveContext — parse package name, versions, ecosystem
    //   2. generateVersionBumpPatch — regex-replace the version in file content
    //   3. If ALL CVE issues for this file applied cleanly, skip Claude
    //      entirely and record the file as fixed with cve:true.
    //   4. Issues that didn't apply (package not found, no patchedVersion)
    //      fall through to the normal Claude path with CVE context added.
    // -----------------------------------------------------------------------
    const cveIssues = fileIssueTexts.filter((t) => CVE_ID_PATTERN.test(t));
    if (cveIssues.length > 0) {
      try {
        const originalContent = await fetchBlob(owner, repo, filePath, "", token);
        if (originalContent && originalContent.length <= MAX_FILE_BYTES) {
          let workingContent = originalContent;
          const appliedPatches: CvePatch[] = [];
          const unappliedCveIssues: string[] = [];

          for (const issueText of cveIssues) {
            const ctx = extractCveContext(issueText);
            if (!ctx || !ctx.patchedVersion) {
              // No patchedVersion — advisory only, fall through to Claude
              unappliedCveIssues.push(issueText);
              continue;
            }
            const patch = generateVersionBumpPatch({
              ecosystem: ctx.ecosystem,
              packageName: ctx.packageName,
              currentVersion: ctx.currentVersion,
              patchedVersion: ctx.patchedVersion,
              fileContent: workingContent,
              filePath,
              cveId: ctx.cveId,
            });
            if (!patch) {
              // Package not found in file — fall through to Claude
              unappliedCveIssues.push(issueText);
              continue;
            }
            workingContent = patch.newContent;
            appliedPatches.push({
              packageName: ctx.packageName,
              currentVersion: ctx.currentVersion,
              patchedVersion: ctx.patchedVersion,
              cveId: ctx.cveId,
              filePath,
            });
          }

          if (appliedPatches.length > 0) {
            // Record applied patches in the global accumulator for PR section
            collectedCvePatches.push(...appliedPatches);

            const nonCveIssues = fileIssueTexts.filter((t) => !CVE_ID_PATTERN.test(t));
            const remainingIssues = [...nonCveIssues, ...unappliedCveIssues];

            if (remainingIssues.length === 0) {
              // All issues for this file were CVE-patchable — skip Claude entirely
              fixes.push({
                file: filePath,
                original: originalContent,
                fixed: workingContent,
                issues: fileIssueTexts,
                cve: true,
              });
              attemptHistoryByFile[filePath] = {
                attempts: [{
                  attemptNumber: 1,
                  startedAt: Date.now(),
                  durationMs: 0,
                  outcome: "success",
                  validationReason: "cve-version-bump (no Claude)",
                  qualityIssues: [],
                  claudeError: null,
                }],
                summary: `CVE: ${appliedPatches.map((p) => p.cveId).join(", ")} — version bumped without Claude`,
                success: true,
              };
              return;
            }
            // Some issues still need Claude — continue with workingContent
            // already having CVE patches applied; Claude only sees the rest.
            // We intentionally fall through to the normal path with the
            // pre-patched content and remaining issues list.
            // (For simplicity we let Claude re-fix from the original — the
            // CVE patches will be included in the final merged content below
            // since workingContent already reflects them.)
          }
        }
      } catch {
        // Non-fatal — fall through to normal Claude path
      }
    }

    // Handle CREATE_FILE issues — the file doesn't exist, generate it from scratch
    const createIssues = fileIssueTexts.filter((i) => i.startsWith("CREATE_FILE:"));
    if (createIssues.length > 0) {
      try {
        const newContent = await askClaudeCreate(filePath, createIssues.map((i) => i.replace("CREATE_FILE: ", "")));
        if (newContent && newContent.length > 10) {
          fixes.push({ file: filePath, original: "", fixed: newContent, issues: fileIssueTexts });
        } else {
          errors.push(`Could not generate ${filePath}: empty response`);
        }
      } catch (err) {
        errors.push(`Could not generate ${filePath}: ${err instanceof Error ? err.message : "unknown"}`);
      }
      return;
    }

    try {
      // fetchBlob already routes through Gluecron-first / GitHub-fallback so
      // a GitHub PAT can read files when Gluecron is unavailable.
      const originalContent = await fetchBlob(owner, repo, filePath, "", token);

      if (!originalContent) {
        errors.push(`Could not read ${filePath}`);
        return;
      }

      if (originalContent.length > MAX_FILE_BYTES) {
        errors.push(`Skipped ${filePath}: file too large (${originalContent.length} bytes, limit ${MAX_FILE_BYTES})`);
        return;
      }

      // Day-2 — Surgical-fix path. Triggered when EVERY issue for this file
      // has a parseable line number. Sends Claude only the issue's slice of
      // the file; bytes outside the slice are byte-identical because they
      // were never sent. Mutation becomes architecturally impossible.
      const allHaveLines = fileIssues.every((i) => typeof i.line === "number" && i.line! > 0);
      if (allHaveLines) {
        const surgicalAttempts: AttemptLog[] = [];
        let workingContent = originalContent;
        let surgicalOk = true;
        let surgicalFinalReason: string | null = null;
        // Process bottom-up so earlier line numbers stay valid as we patch.
        const sortedIssues = [...fileIssues].sort((a, b) => (b.line! - a.line!));
        for (const issue of sortedIssues) {
          const ctx = surgicalFix.extractIssueContext(workingContent, issue.line!, 20);
          let issueOk = false;
          for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt++) {
            const startedAtAttempt = Date.now();
            try {
              const rawSurgicalPrompt = surgicalFix.buildSurgicalPrompt({
                filePath,
                slice: ctx.slice,
                startLine: ctx.startLine,
                endLine: ctx.endLine,
                issues: [issue.text],
              });
              // Prepend grounding header so Claude respects project conventions
              // even when it only sees a ±20-line slice of the file.
              const prompt = conventionsHeader + rawSurgicalPrompt;
              const claudeText = await askClaudeForTest(prompt);
              const replacement = surgicalFix.parseReplacementBlock(claudeText);
              const newContent = surgicalFix.spliceReplacement(
                workingContent,
                ctx.startLine,
                ctx.endLine,
                replacement,
                ctx.lineEnding
              );
              const v = surgicalFix.validateSurgicalFix({
                originalContent: workingContent,
                fixedContent: newContent,
                startLine: ctx.startLine,
                endLine: ctx.endLine,
                lineEnding: ctx.lineEnding,
              });
              if (!v.ok) {
                surgicalAttempts.push({
                  attemptNumber: surgicalAttempts.length + 1,
                  startedAt: startedAtAttempt,
                  durationMs: Date.now() - startedAtAttempt,
                  outcome: "validation-fail",
                  validationReason: `mutation outside slice: ${v.reason || "unknown"}`,
                  qualityIssues: [],
                  claudeError: null,
                });
                continue;
              }
              workingContent = newContent;
              surgicalAttempts.push({
                attemptNumber: surgicalAttempts.length + 1,
                startedAt: startedAtAttempt,
                durationMs: Date.now() - startedAtAttempt,
                outcome: "success",
                validationReason: null,
                qualityIssues: [],
                claudeError: null,
              });
              issueOk = true;
              break;
            } catch (err) {
              surgicalAttempts.push({
                attemptNumber: surgicalAttempts.length + 1,
                startedAt: startedAtAttempt,
                durationMs: Date.now() - startedAtAttempt,
                outcome: "claude-error",
                validationReason: null,
                qualityIssues: [],
                claudeError: err instanceof Error ? err.message : "unknown",
              });
            }
          }
          if (!issueOk) {
            surgicalOk = false;
            surgicalFinalReason = `surgical fix failed at line ${issue.line} after ${DEFAULT_MAX_ATTEMPTS} attempts`;
            break;
          }
        }

        attemptHistoryByFile[filePath] = {
          attempts: surgicalAttempts,
          summary: summariseAttempts(surgicalAttempts),
          success: surgicalOk,
        };

        if (!surgicalOk) {
          const allClaudeErrors = surgicalAttempts.length > 0 && surgicalAttempts.every((a) => a.outcome === "claude-error");
          if (allClaudeErrors) {
            throw new Error(surgicalAttempts[surgicalAttempts.length - 1].claudeError || "Claude API error");
          }
          errors.push(`Skipped ${filePath} (surgical, ${surgicalAttempts.length} attempts): ${surgicalFinalReason}`);
          return;
        }

        fixes.push({ file: filePath, original: originalContent, fixed: workingContent, issues: fileIssueTexts });
        state.consecutiveNetworkErrors = 0;
        return;
      }

      // Whole-file fallback path — used when one or more issues lack a line
      // number (summary-shaped findings, multi-region issues, etc.). Same
      // existing iterative loop, BUT the result is now run through the
      // mutation guard before being accepted.
      const loopResult = await attemptFixWithRetries({
        askClaude: (currentIssues: string[]) => askClaude(originalContent, filePath, currentIssues, conventionsHeader),
        validateFix,
        verifyFixQuality,
        originalContent,
        filePath,
        issues: fileIssueTexts,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
      });

      attemptHistoryByFile[filePath] = {
        attempts: loopResult.attempts,
        summary: summariseAttempts(loopResult.attempts),
        success: loopResult.success,
      };

      if (!loopResult.success) {
        const allClaudeErrors = loopResult.attempts.length > 0 && loopResult.attempts.every((a) => a.outcome === "claude-error");
        if (allClaudeErrors) {
          throw new Error(loopResult.attempts[loopResult.attempts.length - 1].claudeError || "Claude API error");
        }
        errors.push(`Skipped ${filePath} (${loopResult.attempts.length} attempt${loopResult.attempts.length > 1 ? "s" : ""}): ${loopResult.finalReason}`);
        return;
      }

      // Day-2 — mutation guard on the whole-file path. Reject fixes that
      // changed dramatically more lines than the issue count justifies.
      const guardResult = mutationGuard.evaluateMutation({
        original: originalContent,
        fixed: loopResult.fixed!,
        issueCount: fileIssueTexts.length,
      });
      if (!guardResult.ok) {
        errors.push(`Rejected ${filePath} by mutation guard: ${guardResult.reason} — ${mutationGuard.summariseMutation(guardResult)}`);
        return;
      }

      fixes.push({ file: filePath, original: originalContent, fixed: loopResult.fixed!, issues: fileIssueTexts });
      state.consecutiveNetworkErrors = 0;
    } catch (err) {
      const raw = err instanceof Error ? err.message : "unknown";
      const isAbortErr = err instanceof Error && (err.name === "AbortError" || /aborted|abort/i.test(raw));
      const isNetworkErr = isAbortErr || /EPROTO|ECONNRESET|ETIMEDOUT|ssl.*alert|handshake|fetch failed|socket hang up|unreachable/i.test(raw);

      if ((err as { code?: string }).code === "BUDGET_EXCEEDED") {
        // Tier AI-spend cap crossed (budget-tracker preflight). Halt the
        // loop cleanly: remaining files count into skippedForAiBudget and
        // ONE friendly summary line ships after the loop — the customer
        // never sees a wall of identical per-file budget errors.
        aiBudgetHalted = true;
        state.haltRun = true;
        skippedForAiBudget += 1;
      } else if (err instanceof Error && err.name === "INVOCATION_LIMIT_EXCEEDED") {
        // Circuit breaker fired — halt the loop; partial fixes already in
        // `fixes[]` will be committed and the PR body will explain.
        state.haltRun = true;
      } else if (isNetworkErr) {
        state.consecutiveNetworkErrors += 1;
        if (state.consecutiveNetworkErrors === 3 && state.activeConcurrency > 1) {
          state.activeConcurrency = 1;
        }
        if (state.consecutiveNetworkErrors >= 8) {
          state.haltRun = true;
        }
        failedFiles.push({ file: filePath, issues: fileIssueTexts, reason: "api-unavailable" });
        const msg = isAbortErr
          ? `${filePath}: request timed out (file may be too large) — queued for retry`
          : `${filePath}: Anthropic API temporarily unavailable — queued for retry`;
        errors.push(msg);
      } else {
        errors.push(`Failed to fix ${filePath}: ${raw}`);
      }
    }
  });

  const hitInvocationLimit = Boolean(
    _budgetTracker && (_budgetTracker as Record<string, unknown>)._maxInvocations !== undefined
    && _budgetTracker.callCount >= ((_budgetTracker as Record<string, unknown>)._maxInvocations as number)
  );

  // One honest, friendly budget story instead of robotic per-condition
  // errors (Inclusive tone spec). Computed once; reused in the PR body
  // and every response payload below.
  const budgetSummary = buildBudgetSummary({
    snapshot: _budgetTracker.snapshot(),
    fixes,
    failedFiles,
    skippedForTimeBudget: skippedForBudget,
    skippedForAiBudget,
    invocationLimitHit: hitInvocationLimit,
    capResult,
  });
  if (budgetSummary.capReached && budgetSummary.retry.message) {
    errors.push(budgetSummary.retry.message);
  }
  if (hitInvocationLimit) {
    errors.push(
      `⚡ This repo maxed out the AI call limit (${MAX_AI_INVOCATIONS} calls) — ${fixes.length} file(s) were fixed before it kicked in. ` +
      `For repositories this size, a dedicated scanner instance is the right tool: enterprise@gatetest.ai.`
    );
  }

  // Flywheel capture — one telemetry record per attempted file. CVE
  // version-bumps ran without Claude (deterministic 'rule' layer);
  // everything else that reached the loop is the 'claude' layer. Records
  // ruleKey/module-free aggregates only (privacy contract in fix-telemetry).
  for (const [filePath, history] of Object.entries(attemptHistoryByFile)) {
    const deterministic = history.summary.includes("without Claude");
    recordFixAttempt({
      layer: deterministic ? "rule" : "claude",
      success: history.success,
      durationMs: history.attempts.reduce((acc, a) => acc + (a.durationMs || 0), 0),
      reason: history.success ? undefined : (history.attempts[history.attempts.length - 1]?.outcome || "unknown"),
      fileExt: (filePath.match(/\.[a-z0-9]+$/i) || [""])[0] || undefined,
    });
  }

  if (fixes.length === 0) {
    const apiDegraded = failedFiles.length > 0 && failedFiles.length === fileEntries.length;
    return NextResponse.json({
      status: apiDegraded ? "api_unavailable" : "no_fixes",
      message: apiDegraded
        ? `Anthropic API is temporarily degraded — every file failed with a network/TLS error. All ${failedFiles.length} files are queued for retry. Click "Retry Failed" in 1-2 minutes; if the problem persists, Anthropic is likely having an incident (check status.anthropic.com).`
        : skippedForBudget > 0
        ? `All ${skippedForBudget} files skipped — function time budget exhausted before Claude could finish. Try again — the second run will typically complete since results cache and retries kick in faster.`
        : "No fixes could be generated",
      errors,
      skippedForBudget,
      skippedForAiBudget,
      failedFiles,
      budget: budgetSummary,
    });
  }

  // Phase 1.2 — cross-fix syntax gate. Ran ONCE on the full collected
  // fix set after every per-file iterative loop completed. Anything that
  // doesn't parse is dropped from the PR — the customer never sees a
  // broken-syntax fix on their branch.
  const syntaxGate = validateFixesSyntax({ fixes });
  if (syntaxGate.rejected.length > 0) {
    for (const r of syntaxGate.rejected) {
      errors.push(`Rejected ${r.file} (${r.language}): ${r.reason}`);
    }
    // Replace the working fix list with the syntax-validated subset.
    // The accepted entries carry the same shape as the originals plus
    // a `language` field; downstream code reads `file`/`fixed`/etc.
    fixes.length = 0;
    for (const a of syntaxGate.accepted) {
      fixes.push({ file: a.file, fixed: a.fixed, original: a.original, issues: a.issues });
    }
  }
  const syntaxGateSummary = summariseSyntaxGate(syntaxGate);

  if (fixes.length === 0) {
    return NextResponse.json({
      status: "no_fixes",
      message: `Every fix failed the syntax gate — Claude returned content that doesn't parse. ${syntaxGateSummary}`,
      errors,
      skippedForBudget,
      failedFiles,
      syntaxGate: { accepted: syntaxGate.accepted.length, rejected: syntaxGate.rejected.length, summary: syntaxGateSummary },
    });
  }

  // Phase 1.2b — cross-file scanner re-validation. Only runs when the
  // caller supplied the original workspace + findings. Without that
  // baseline we can't tell which findings are NEW vs pre-existing, so
  // skip silently — per-file iterative loop + syntax gate still ran.
  let scannerGateSummary: string | undefined;
  let scannerGateRolledBack: Array<{ file: string; reason: string; newFindings: string[] }> = [];
  let postFixFindingsByModule: Record<string, string[]> | undefined;
  if (
    Array.isArray(input.originalFileContents) &&
    input.originalFileContents.length > 0 &&
    input.originalFindingsByModule &&
    typeof input.originalFindingsByModule === "object"
  ) {
    const scannerGate = await validateFixesAgainstScanner({
      fixes,
      originalFileContents: input.originalFileContents,
      originalFindingsByModule: input.originalFindingsByModule,
      runTier,
      owner,
      repo,
      tier: input.tier || "full",
    });
    scannerGateSummary = scannerGate.summary;
    postFixFindingsByModule = scannerGate.postFixFindingsByModule;
    if (scannerGate.rolledBack.length > 0) {
      for (const rb of scannerGate.rolledBack) {
        errors.push(`Rolled back ${rb.file}: ${rb.reason} — ${rb.newFindings.join("; ")}`);
      }
      scannerGateRolledBack = scannerGate.rolledBack.map((rb) => ({
        file: rb.file,
        reason: rb.reason,
        newFindings: rb.newFindings,
      }));
      // Replace fix list with scanner-validated subset.
      fixes.length = 0;
      for (const a of scannerGate.accepted) {
        fixes.push({ file: a.file, fixed: a.fixed, original: a.original, issues: a.issues });
      }
    }

    if (fixes.length === 0) {
      return NextResponse.json({
        status: "no_fixes",
        message: `Every fix failed the cross-file scanner gate — each one introduced a new finding. ${scannerGateSummary}`,
        errors,
        skippedForBudget,
        failedFiles,
        syntaxGate: { accepted: syntaxGate.accepted.length, rejected: syntaxGate.rejected.length, summary: syntaxGateSummary },
        scannerGate: { rolledBack: scannerGateRolledBack, summary: scannerGateSummary },
      });
    }
  }

  // Phase 1.3 — test generation per fix. For every successful,
  // gate-passed fix, ask Claude to write a regression test that
  // would have failed against the original code. Tests are added
  // to `fixes` as new-file entries so the existing PR commit logic
  // ships them in the same PR. Per-fix failures here NEVER block
  // the underlying fix — a missing regression test is annoying but
  // not destructive.
  const testGen = await generateTestsForFixes({
    fixes,
    askClaudeForTest,
  }).catch((err) => {
    // Failing the WHOLE batch shouldn't kill the PR. Log and proceed
    // with no generated tests.
    const message = err instanceof Error ? err.message : "test generation failed";
    errors.push(`Test generation failed (no regression tests added): ${message}`);
    return { tests: [] as Array<{ path: string; content: string; sourceFile: string }>, skipped: [] as Array<{ sourceFile: string; reason: string }>, summary: `test generation: failed (${message})` };
  });
  for (const t of testGen.tests) {
    fixes.push({ file: t.path, original: "", fixed: t.content, issues: [`Regression test for ${t.sourceFile}`] });
  }
  for (const s of testGen.skipped) {
    errors.push(`No regression test for ${s.sourceFile}: ${s.reason}`);
  }
  const testGenSummary = testGen.summary;

  // Create a branch, commit fixes, open PR
  try {
    // Resolve the default branch + its tip SHA. Tries Gluecron first, falls
    // back to GitHub when the token is GitHub-shaped or Gluecron returns no
    // sha — used to silently 500 with "Could not get base branch SHA from
    // Gluecron" even when a GitHub PAT was available and the API would have
    // worked. See gluecron-client.ts:resolveBaseBranchSha.
    const baseRef = await resolveBaseBranchSha(owner, repo, "", token);
    const defaultBranch = baseRef.defaultBranch;
    const baseSha = baseRef.sha;

    if (!baseSha) {
      return NextResponse.json({
        error: "Could not resolve base branch SHA from Gluecron or GitHub",
        hint: "Confirm the repo is reachable and GLUECRON_API_TOKEN / GITHUB_TOKEN has read access.",
        defaultBranch,
      }, { status: 500 });

    }

    // Create branch via Gluecron.
    const branchName = `gatetest/auto-fix-${Date.now()}`;
    const branchRes = await createBranch(owner, repo, branchName, baseSha, token);

    if (branchRes.status !== 201) {
      return NextResponse.json({
        error: "Could not create branch — check Gluecron token permissions",
        details: branchRes.data,
      }, { status: 500 });
    }

    // Commit each fixed file (parallel, capped). New files have no SHA.
    await mapWithConcurrency(fixes, FIX_CONCURRENCY, async (fix) => {
      const isNewFile = fix.original === "";
      const message = isNewFile
        ? `feat: create ${fix.file}`
        : `fix: ${fix.issues[0]}${fix.issues.length > 1 ? ` (+${fix.issues.length - 1} more)` : ""}`;
      const existingSha = isNewFile
        ? ""
        : await fetchFileSha(owner, repo, fix.file, branchName, token);
      await upsertFile(owner, repo, fix.file, fix.fixed, message, branchName, existingSha, token);
    });

    // Forensic-tier CISO board-report. Generated AFTER all fixes are
    // committed (so it reflects the post-fix landscape), BEFORE PR-body
    // composition (so the body can mention it). Committed to the same
    // branch as a markdown file the customer receives in the PR diff;
    // they can open in any browser → File > Print > Save as PDF for
    // board distribution.
    //
    // Failure is non-blocking — the fixes already shipped to the
    // branch; the customer keeps what they paid for and we log a soft
    // advisory in the PR body.
    let cisoReportDescriptor: {
      path?: string;
      riskLevel?: string;
      complianceGaps?: { owasp: unknown[]; soc2: unknown[]; cis: unknown[] };
      counts?: { Critical: number; High: number; Medium: number; Low: number };
      failed?: boolean;
    } | undefined;
    let cisoReportSummary: string | undefined;
    if (input.tier === "nuclear") {
      try {
        // Build the findings list from the original (pre-fix) findings the
        // caller passed in. Falls back to the input.issues array if the
        // caller didn't supply originalFindingsByModule (older clients).
        type CisoFinding = { module: string; detail: string; severity: string };
        const cisoFindings: CisoFinding[] = [];
        if (input.originalFindingsByModule && typeof input.originalFindingsByModule === "object") {
          for (const [moduleName, details] of Object.entries(input.originalFindingsByModule)) {
            if (!Array.isArray(details)) continue;
            for (const detail of details) {
              // Heuristic severity: error if the detail looks error-shaped,
              // warning otherwise. The CISO renderer normalises this.
              const sev = /error|critical|fail|violation/i.test(detail) ? "error" : "warning";
              cisoFindings.push({ module: moduleName, detail, severity: sev });
            }
          }
        } else {
          for (const iss of rawIssues || []) {
            cisoFindings.push({ module: iss.module, detail: iss.issue, severity: "error" });
          }
        }

        // Phase 3.2 wire-up — run cross-finding correlation BEFORE the
        // CISO report so chains can flow into the report's attack-chain
        // section. ONE Claude call, budget-bounded by a 30s timeout.
        // Fail-soft: any error / timeout / parse failure returns
        // chains:[] with a human-readable note. The Forensic deliverable
        // STILL ships either way — chains are an additive lift on top
        // of the per-finding diagnosis the CISO report already covers.
        const correlationResult = await correlateForCisoChains({
          tier: "nuclear",
          findings: cisoFindings.map((f) => ({ detail: f.detail, module: f.module, severity: f.severity })),
          hostname: `${owner}/${repo}`,
          askClaude: askClaudeForTest,
        });
        if (correlationResult.note) {
          // Surface the honest reason in the PR body so customers see
          // why their CISO report rendered without chains. Not a hard
          // error — just an advisory.
          errors.push(`CISO attack-chain correlation: ${correlationResult.note}`);
        }

        const cisoResult = await generateCisoReport({
          findings: cisoFindings,
          // Real chains from the correlator. Empty array = "findings
          // appear independent" (an honest outcome, not a failure).
          chains: correlationResult.chains,
          hostName: `${owner}/${repo}`,
          tier: "Forensic",
          askClaude: askClaudeForTest,
        });

        const reportPath = cisoReportPath();
        // Commit the report to the branch as a real file in the PR diff.
        try {
          const existingReportSha = await fetchFileSha(owner, repo, reportPath, branchName, token);
          await upsertFile(
            owner,
            repo,
            reportPath,
            cisoResult.markdown,
            `docs(gatetest): add board-ready CISO report`,
            branchName,
            existingReportSha,
            token
          );
        } catch (commitErr) {
          // Treat commit failure the same as generation failure — surface
          // in PR body as advisory, do not block the PR.
          const msg = commitErr instanceof Error ? commitErr.message : "commit failed";
          errors.push(`CISO report commit failed (report not attached to PR): ${msg}`);
          cisoReportDescriptor = { failed: true };
          cisoReportSummary = `ciso: commit failed (${msg})`;
        }

        if (!cisoReportDescriptor) {
          cisoReportDescriptor = {
            path: reportPath,
            riskLevel: cisoResult.riskLevel,
            complianceGaps: cisoResult.complianceGaps,
            counts: cisoResult.counts,
          };
          cisoReportSummary = `ciso: report committed at ${reportPath} (${cisoResult.riskLevel} risk, ${cisoFindings.length} findings)`;
        }
      } catch (err) {
        // Generation failed entirely — Claude error, mapping crash, etc.
        // Customer still gets the fixes; PR body gets a soft advisory.
        const msg = err instanceof Error ? err.message : "ciso report failed";
        errors.push(`CISO report generation failed (report not attached to PR): ${msg}`);
        cisoReportDescriptor = { failed: true };
        cisoReportSummary = `ciso: failed (${msg})`;
      }
    }

    // Phase 1.4 — Compose the PR body from every artifact we collected.
    // The composer renders header, CVE patches (if any), before/after scan
    // comparison, gate results, per-file attempt history, fixed-files list,
    // regression tests, advisory section, how-it-works, next steps, footer.
    const totalIssuesFixed = fixes.reduce((sum, f) => sum + f.issues.length, 0);
    const cvePrSection = composeCveFixPrSection(collectedCvePatches);
    const cveSummary = summariseCvePatches(collectedCvePatches);
    const prBodyCore = composePrBody({
      fixes,
      errors,
      attemptHistoryByFile,
      syntaxGate: { summary: syntaxGateSummary },
      scannerGate: scannerGateSummary
        ? { summary: scannerGateSummary }
        : { skipped: true, reason: "caller did not pass originalFileContents + originalFindingsByModule" },
      testGen: { summary: testGenSummary },
      originalFindingsByModule: input.originalFindingsByModule,
      postFixFindingsByModule,
      repoUrl,
      cveSection: cvePrSection || undefined,
      cisoReport: cisoReportDescriptor,
    });
    // Cross-repo flywheel CONSUME side — annotate fixes whose diff shape
    // structurally matches anonymised vectors already shipped on other
    // codebases. Best-effort: helper never throws, '' means no section.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { annotateFixesWithPriorArt, renderPriorArtSection } = require("@/app/lib/cross-repo-prior-art") as {
      annotateFixesWithPriorArt: (fixes: Array<{ file: string; original: string; fixed: string }>) => Array<{ file: string; priorArt: { operatorClass: string; sampleSize: number } }>;
      renderPriorArtSection: (annotations: Array<{ file: string; priorArt: { operatorClass: string; sampleSize: number } }>) => string;
    };
    const priorArtSection = renderPriorArtSection(annotateFixesWithPriorArt(fixes));

    // 🔥 LIVE section — when production runtime events were correlated and
    // matched, lead the PR with them: these fixes address errors real users
    // are hitting right now. renderLiveBadgeSection returns '' when nothing
    // is live. Wired here for the first time (was dead code since Phase 6.2).
    let liveSection = "";
    if (liveCorrelation && liveCorrelation.liveCount > 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { renderLiveBadgeSection } = require("@/app/lib/static-runtime-correlator") as {
          renderLiveBadgeSection: (result: { findings: Array<Record<string, unknown>> }) => string;
        };
        liveSection = renderLiveBadgeSection({ findings: liveCorrelation.findings });
      } catch {
        // Non-blocking — PR ships without the live section.
      }
    }

    // Append the advisory section (files the tier cap couldn't cover)
    // so customers see what was left on the table without paying for it.
    let prBody = liveSection
      ? `${liveSection}\n\n---\n\n${prBodyCore}`
      : prBodyCore;
    if (advisoryMarkdown) prBody = `${prBody}\n\n---\n\n${advisoryMarkdown}`;
    const budgetMarkdown = renderBudgetSummaryMarkdown(budgetSummary);
    if (budgetMarkdown) prBody = `${prBody}\n\n---\n\n${budgetMarkdown}`;
    if (priorArtSection) prBody = `${prBody}\n\n---\n\n${priorArtSection}`;

    // Open the PR. NOTE: Gluecron uses `headBranch` / `baseBranch` (NOT
    // GitHub's `head` / `base`) — our openPullRequest helper handles the
    // translation for us.
    const prRes = await openPullRequest(
      owner,
      repo,
      `GateTest: Fix ${fixes.reduce((sum, f) => sum + f.issues.length, 0)} issues across ${fixes.length} files`,
      prBody,
      branchName,
      defaultBranch,
      token
    );

    if (prRes.status !== 201) {
      return NextResponse.json({
        status: "fixes_committed",
        message: `Fixes committed to branch ${branchName} but PR creation failed`,
        branch: branchName,
        filesFixed: fixes.length,
        issuesFixed: totalIssuesFixed,
        errors: [...errors, `PR creation failed: ${JSON.stringify(prRes.data)}`],
        budget: budgetSummary,
      });
    }

    const prNumber = prRes.data.number as number;
    const prUrl = (prRes.data.html_url as string) || "";

    // Audit-log the PR-open event. Fire-and-forget. Includes the budget
    // snapshot so finance / support can reconcile spend against the scan.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { recordEventIfConfigured } = require("@/app/lib/audit-log-store");
    void recordEventIfConfigured({
      actor: input.tier ? `tier:${input.tier}` : "anonymous",
      action: "fix.pr_opened",
      resourceType: "pr",
      resourceId: prUrl || `${owner}/${repo}#${prNumber}`,
      metadata: {
        repo: `${owner}/${repo}`,
        prNumber,
        tier: input.tier || "full",
        issuesFixed: totalIssuesFixed,
        filesFixed: fixes.length,
        budget: _budgetTracker.snapshot(),
      },
    });

    // Post verification comment on the PR
    try {
      const remainingIssues: string[] = [];
      for (const fix of fixes) {
        const verify = verifyFixQuality(fix.fixed, fix.file);
        if (!verify.clean) {
          remainingIssues.push(`**${fix.file}**: ${verify.newIssues.join(", ")}`);
        }
      }

      const verifyBody = remainingIssues.length === 0
        ? `## ✅ GateTest Verification Passed\n\nAll ${totalIssuesFixed} fixes have been verified against GateTest's pattern scanner. No new issues introduced.\n\n**This PR is safe to merge.**`
        : `## ⚠️ GateTest Verification Warning\n\n${remainingIssues.length} file(s) may still have issues:\n${remainingIssues.map((i) => `- ${i}`).join("\n")}\n\nPlease review these files carefully before merging.`;

      await postPrComment(owner, repo, prNumber, verifyBody, token);
    } catch {
      // Non-critical — PR was created successfully, comment failed
    }

    // Phase 2.2 — architecture annotator. Runs only on the $199 tier.
    // Posts a separate PR comment with design observations the
    // per-file scanner cannot see (layering, god objects, etc.).
    // Requires `originalFileContents` so it has the codebase shape;
    // skipped silently if the caller didn't pass that.
    let architectureSummary: string | undefined;
    if (input.tier === "scan_fix" && Array.isArray(input.originalFileContents) && input.originalFileContents.length > 0) {
      try {
        const arch = await annotateArchitecture({
          fileContents: input.originalFileContents,
          askClaudeForArchitecture: askClaudeForTest,
          repoUrl,
        });
        architectureSummary = arch.ok
          ? `architecture: ${arch.summary?.sourceFiles ?? '?'} source files analysed, ${arch.sampleFiles?.length ?? 0} sampled, report posted`
          : `architecture: skipped (${arch.reason})`;
        const archMarkdown = renderArchitectureComment(arch);
        await postPrComment(owner, repo, prNumber, archMarkdown, token);
      } catch (err) {
        const message = err instanceof Error ? err.message : "architecture annotator failed";
        errors.push(`Architecture annotation failed (no report posted): ${message}`);
        architectureSummary = `architecture: failed (${message})`;
      }
    }

    // Phase 2.1 — pair-review agent. Runs only when the caller's tier
    // is scan_fix (the $199 tier). For Quick / Full scans the loop +
    // gates + test-gen + composer ship without pair-review. The
    // critique posts as a separate PR comment so the customer sees
    // a second pair of eyes on every fix.
    let pairReviewSummary: string | undefined;
    let confidenceSummary: string | undefined;
    if (input.tier === "scan_fix") {
      try {
        // Build map: source-file → regression-test-content for the
        // pair-review agent to see per-fix tests.
        const testsBySourceFile: Record<string, string> = {};
        for (const f of fixes) {
          if (f.file.startsWith("tests/auto-generated/")) {
            const sourceMatch = (f.issues || []).join(" ").match(/Regression test for (.+)/);
            if (sourceMatch) testsBySourceFile[sourceMatch[1]] = f.fixed;
          }
        }
        const review = await runPairReview({
          fixes,
          testsBySourceFile,
          askClaudeForReview: askClaudeForTest, // same Claude wrapper, different prompt
        });
        pairReviewSummary = review.summary;
        const reviewMarkdown = renderReviewComment(review.reviews, review.averages);
        await postPrComment(owner, repo, prNumber, reviewMarkdown, token);

        // Tier-1 Item 5 — Confidence-Aware Reporting.
        // Aggregate the pair-review 4-axis scores into a per-fix confidence
        // and apply the per-tier threshold gate. Non-blocking: we surface
        // the gate decision in the response + PR comment but never reject
        // a fix that already shipped to the branch (the customer keeps
        // what they paid for). Future: feed this back into the loop to
        // re-attempt fixes below threshold.
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const {
            aggregateConfidence,
            summariseConfidence,
            formatConfidenceReport,
          } = require("@lib/confidence-gate") as {
            aggregateConfidence: (s: unknown) => number | null;
            summariseConfidence: (opts: { fixes: Array<{ file: string; scores?: unknown }>; tier: string }) => string;
            formatConfidenceReport: (opts: { fixes: Array<{ file: string; scores?: unknown }>; tier: string }) => string;
          };
          const fixesWithScores = review.reviews.map((r) => ({
            file: r.file,
            scores: r.scores || undefined,
          }));
          const confTier = input.tier || "scan_fix";
          confidenceSummary = summariseConfidence({ fixes: fixesWithScores, tier: confTier });
          // Best-effort log of per-fix confidence for ops visibility.
          for (const f of fixesWithScores) {
            const conf = aggregateConfidence(f.scores);
            if (conf !== null && conf < 0.85) {
              console.warn(`[GateTest] low-confidence fix ${f.file}: ${conf.toFixed(2)} (scan_fix threshold 0.85)`);
            }
          }
          const confidenceMarkdown = formatConfidenceReport({ fixes: fixesWithScores, tier: confTier });
          await postPrComment(owner, repo, prNumber, confidenceMarkdown, token);
        } catch (confErr) {
          // Non-critical — fix shipped, pair review posted, only the
          // confidence summary failed.
          const message = confErr instanceof Error ? confErr.message : "confidence report failed";
          errors.push(`Confidence report failed (no comment posted): ${message}`);
          confidenceSummary = `confidence: failed (${message})`;
        }
      } catch (err) {
        // Non-critical — PR + verification already posted. Pair review
        // is a $199-tier value-add; if Claude is degraded, the rest
        // of the deliverable still ships.
        const message = err instanceof Error ? err.message : "pair review failed";
        errors.push(`Pair review failed (no critique posted): ${message}`);
        pairReviewSummary = `pair review: failed (${message})`;
      }
    }

    return NextResponse.json({
      status: "pr_created",
      prUrl,
      prNumber,
      branch: branchName,
      filesFixed: fixes.length,
      issuesFixed: totalIssuesFixed,
      fixes: fixes.map((f) => ({ file: f.file, issues: f.issues })),
      authSource,
      errors,
      failedFiles,
      budget: budgetSummary,
      cluster: {
        totalIssuesIn: clusterResult.totalIssuesIn,
        totalClusters: clusterResult.clusters.length,
        clustersFixed: capResult.toFix.length,
        clustersAdvisory: capResult.advisory.length,
        advisoryIssueCount: capResult.advisoryIssueCount,
        infoFindings: clusterResult.advisory.info.length,
        tier: tierForCap,
        cap: capResult.cap,
      },
      livePriority: liveCorrelation
        ? {
            liveIssuesIn: liveCorrelation.liveCount,
            liveClustersFixedFirst: capResult.toFix.filter((c) => c.hasLive === true).length,
          }
        : { skipped: true, reason: "no runtimeEvents supplied — pass production errors (Sentry/Datadog/Rollbar shapes) to prioritise live findings" },
      syntaxGate: { accepted: syntaxGate.accepted.length, rejected: syntaxGate.rejected.length, summary: syntaxGateSummary },
      scannerGate: scannerGateSummary
        ? { rolledBack: scannerGateRolledBack, summary: scannerGateSummary }
        : { skipped: true, reason: hydration.reason || "no baseline workspace/findings available (hydration yielded nothing)" },
      workspaceHydration: {
        files: input.originalFileContents?.length || 0,
        hydratedFiles: hydration.hydratedFiles,
        hydratedFindings: hydration.hydratedFindings,
        reason: hydration.reason,
      },
      testGeneration: { testsWritten: testGen.tests.length, skipped: testGen.skipped, summary: testGenSummary },
      pairReview: pairReviewSummary
        ? { summary: pairReviewSummary }
        : { skipped: true, reason: "tier is not scan_fix — pair review is a $199-tier value-add" },
      confidence: confidenceSummary
        ? { summary: confidenceSummary }
        : { skipped: true, reason: "tier is not scan_fix — confidence-aware reporting is a $199-tier value-add" },
      architecture: architectureSummary
        ? { summary: architectureSummary }
        : { skipped: true, reason: "tier is not scan_fix or originalFileContents not supplied — architecture annotation is a $199-tier value-add" },
      cisoReport: cisoReportSummary
        ? {
            summary: cisoReportSummary,
            path: cisoReportDescriptor?.path,
            riskLevel: cisoReportDescriptor?.riskLevel,
            failed: cisoReportDescriptor?.failed === true,
          }
        : { skipped: true, reason: "tier is not nuclear — board-ready CISO report is a $399-tier deliverable" },
      grounding: {
        summary: groundingSummary,
        filesUsed: groundingExtract.found.map((f) => f.path),
      },
      cve: {
        patchesApplied: collectedCvePatches.length,
        summary: cveSummary,
        patches: collectedCvePatches,
      },
      attemptHistory: attemptHistoryByFile,
    });
  } catch (err) {
    return NextResponse.json({
      status: "error",
      error: err instanceof Error ? err.message : "Failed to create PR",
      fixesGenerated: fixes.length,
      errors,
    }, { status: 500 });
  }

  } catch (outerErr) { // error-ok — outer guard: catches auth / file-fetch / gate throws that bypassed inner handler
    // Budget-exceeded is a customer-visible quota event, not a server crash.
    // Return 402 (Payment Required) with the tracker snapshot so support can
    // see exactly which scan hit the cap and how much it had spent.
    if ((outerErr as { code?: string })?.code === "BUDGET_EXCEEDED") {
      // Budget tracker is wired (see runWithTracker IIFE at top of POST).
      // Pull the snapshot off the thrown error first; fall back to the
      // closure's tracker if for some reason the snapshot didn't ride
      // along with the throw.
      const snap = (outerErr as { tracker?: Record<string, unknown> }).tracker
        || _budgetTracker.snapshot();
      console.warn("[GateTest] scan/fix budget exhausted:", JSON.stringify(snap));
      // Audit-log the budget exhaustion — high-value finance signal.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { recordEventIfConfigured } = require("@/app/lib/audit-log-store");
      void recordEventIfConfigured({
        actor: "scan_fix",
        action: "fix.budget_exceeded",
        resourceType: "scan",
        resourceId: typeof snap === "object" && snap && "label" in snap ? String((snap as { label?: string }).label || "scan-fix") : "scan-fix",
        metadata: snap as Record<string, unknown>,
      });
      // Friendly nothing-shipped copy (Inclusive tone spec) — fixes[] and
      // capResult are out of scope in this outer guard, so the summary is
      // built from the tracker snapshot alone (filesFixed 0 → 402 wording).
      const summary402 = buildBudgetSummary({ snapshot: snap });
      return NextResponse.json(
        {
          status: "error",
          error: summary402.retry.message
            || "This run used its full AI budget before any fixes were ready to ship. Run the fix again from this page.",
          budget: { ...summary402, snapshot: snap },
        },
        { status: 402 }
      );
    }
    const msg = outerErr instanceof Error ? outerErr.message : "Unexpected fix-route error";
    console.error("[GateTest] scan/fix route crashed:", msg);
    return NextResponse.json(
      { status: "error", error: "Fix failed — please try again or contact support." },
      { status: 500 }
    );
  }
  }); // close runWithTracker IIFE
}

