/**
 * Auto-Fix Agent — Claude reads scan issues, generates fixes, creates a PR.
 *
 * POST /api/scan/fix
 * Body: { repoUrl, issues: [{ file, issue, module }], tier? }
 *
 * Two response modes — chosen by the caller:
 *   1. Single JSON   — default. Same shape this endpoint has always returned.
 *      Used by admin-panel, MCP, anything that does a plain fetch().
 *   2. SSE stream    — opt-in via `?stream=1` OR `Accept: text/event-stream`.
 *      Emits per-file checkpoint events so the customer-facing scan page
 *      can render a live "auth.ts ✓ syntax ✓ scanner ✓" progress list
 *      instead of staring at a 4-minute spinner. The final `done` event
 *      carries the same JSON shape the JSON path returns, so the page-side
 *      handler can branch on it identically.
 *
 * The work body lives in app/lib/fix-core.js with all I/O dependencies
 * injected, so the route file is small and the pipeline is unit-testable.
 *
 * Requires: ANTHROPIC_API_KEY, Gluecron PAT (or GitHub PAT fallback).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  createBranch,
  fetchBlob,
  fetchFileSha,
  openPullRequest,
  postPrComment,
  resolveBaseBranchSha,
  resolveRepoAuth,
  upsertFile,
} from "../../../lib/gluecron-client";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeFixCore } = require("@/app/lib/fix-core") as {
  executeFixCore: (args: {
    input: { repoUrl?: string; issues?: IssueInput[]; tier?: string };
    deps: FixCoreDeps;
    emitter?: ProgressEmitter | null;
  }) => Promise<{ payload: Record<string, unknown>; status: number }>;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createEmitter } = require("@/app/lib/progress-emitter") as {
  createEmitter: (opts: { enabled: boolean }) => ProgressEmitter;
};

interface ProgressEmitter {
  enabled: boolean;
  emit: (eventName: string, data: object) => void;
  end: (finalData?: object) => Promise<void>;
  response: Response | null;
}

interface FixCoreDeps {
  hasAnthropicKey: boolean;
  resolveRepoAuth: typeof resolveRepoAuth;
  fetchBlob: typeof fetchBlob;
  resolveBaseBranchSha: typeof resolveBaseBranchSha;
  createBranch: typeof createBranch;
  fetchFileSha: typeof fetchFileSha;
  upsertFile: typeof upsertFile;
  openPullRequest: typeof openPullRequest;
  postPrComment: typeof postPrComment;
  askClaude: (fileContent: string, filePath: string, issues: string[]) => Promise<string>;
  askClaudeCreate: (filePath: string, context: string[]) => Promise<string>;
  validateFix: (original: string, fixed: string) => { ok: boolean; reason?: string };
  verifyFixQuality: (fixed: string, filePath: string) => { clean: boolean; newIssues: string[] };
  composePrBody: (args: { fixes: FixForBody[]; errors: string[]; totalIssuesFixed: number; totalChecks: number }) => string;
}

interface FixForBody {
  file: string;
  issues: string[];
}

interface IssueInput {
  file: string;
  issue: string;
  module: string;
}

// Vercel Pro allows up to 300s. Fix runs 44 issues across ~10 files, each file
// needs a Claude call + GitHub read + commit. 300s gives headroom for retries
// without pushing browser into connection-reset territory.
export const maxDuration = 300;
export const runtime = "nodejs";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

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
  if (name === "AbortError" || /aborted|abort/i.test(msg)) return true;
  const retryableCodes = [
    "EPROTO", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT",
    "EAI_AGAIN", "ENOTFOUND", "EPIPE", "EHOSTUNREACH",
    "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT", "UND_ERR_RESPONSE_STATUS_CODE",
  ];
  if (retryableCodes.includes(code)) return true;
  if (/EPROTO|ECONNRESET|ETIMEDOUT|ssl.*alert|handshake|fetch failed|socket hang up|TLS/i.test(msg)) {
    return true;
  }
  return false;
}

async function anthropicCall(body: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  // 45s is a safe per-request ceiling that leaves room for retries inside the
  // 300s function budget and won't let a single stuck request monopolise.
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": ANTHROPIC_API_KEY,
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
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// Retry wrapper — handles both HTTP-status retries (429/5xx) and raw network
// errors (EPROTO, ECONNRESET, TLS handshake). Jittered exponential backoff so
// parallel retries don't synchronise and re-overwhelm the remote.
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
      if (res.status === 200) return res;
      if (res.status !== 429 && res.status < 500) {
        return res;
      }
      lastResponse = res;
    } catch (err) {
      if (!isRetryableNetworkError(err)) {
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

async function askClaude(fileContent: string, filePath: string, issues: string[]): Promise<string> {
  // Enrich broken-link issues with context about what actually exists
  const enrichedIssues = await Promise.all(issues.map(async (issue) => {
    const brokenMatch = issue.match(/BROKEN LINK \(404\):\s*(https:\/\/github\.com\/([^/]+)\/([^/]+)\/([^\s]+))/i);
    if (brokenMatch) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [, _fullUrl, owner, repo, _path] = brokenMatch;
      try {
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

  const prompt = `You are an expert code fixer for GateTest, an AI-powered QA platform with 90 scanning modules.

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

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
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

    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    if (!filePath.includes(".test.") && !filePath.includes(".spec.") && !filePath.includes("__test")) {
      if (/\bconsole\.(log|debug|info)\s*\(/.test(line)) {
        issues.push(`Line ${i + 1}: console.log/debug/info introduced`);
      }
    }
    if (/^\s*debugger\s*;?\s*$/.test(line)) {
      issues.push(`Line ${i + 1}: debugger statement introduced`);
    }
    if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(line)) {
      issues.push(`Line ${i + 1}: TODO/FIXME comment introduced`);
    }
    if (/\beval\s*\(/.test(line) && !trimmed.startsWith("//")) {
      issues.push(`Line ${i + 1}: eval() introduced`);
    }
    if (/^\s*var\s+\w/.test(line)) {
      issues.push(`Line ${i + 1}: var declaration introduced (use const/let)`);
    }
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
      issues.push(`Line ${i + 1}: empty catch block introduced`);
    }
  }

  return { clean: issues.length === 0, newIssues: issues };
}

/**
 * Ask Claude to generate a NEW file (when it doesn't exist yet).
 * Used when the issue is "Missing X" and we need to create X.
 */
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

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
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

function composePrBody({
  fixes,
  errors,
  totalIssuesFixed,
  totalChecks,
}: {
  fixes: FixForBody[];
  errors: string[];
  totalIssuesFixed: number;
  totalChecks: number;
}): string {
  return `## GateTest Auto-Fix Report

> **${totalIssuesFixed} issues fixed** across **${fixes.length} files** — verified before commit.

Every fix in this PR was generated by Claude AI and verified against GateTest's 90-module scanner before being committed. Fixes that introduced new issues were automatically rejected and retried.

### Fixed Files

${fixes.map((f) => {
  const issueList = f.issues.map((i) => `  - ✅ ${i}`).join("\n");
  return `<details>\n<summary><strong>${f.file}</strong> — ${f.issues.length} fix${f.issues.length > 1 ? "es" : ""}</summary>\n\n${issueList}\n</details>`;
}).join("\n\n")}

${errors.length > 0 ? `\n### ⚠️ Could Not Fix\n${errors.map((e) => `- ${e}`).join("\n")}` : ""}

### How This Works

1. **Scan** — GateTest scanned the repo with ${totalChecks} checks
2. **AI Fix** — Claude AI generated fixes for each issue
3. **Verify** — Each fix was re-scanned before commit to prevent regressions
4. **PR** — Clean fixes committed to this branch

### Next Steps

- Review the changes in the **Files Changed** tab
- Merge when satisfied — GateTest never auto-merges
- Re-scan after merge to confirm: \`gatetest --suite full\`

---

<sub>Scanned and fixed by <a href="https://gatetest.ai">GateTest</a> — 90 modules, AI-powered, verify-before-commit</sub>`;
}

function buildDeps(): FixCoreDeps {
  return {
    hasAnthropicKey: Boolean(ANTHROPIC_API_KEY),
    resolveRepoAuth,
    fetchBlob,
    resolveBaseBranchSha,
    createBranch,
    fetchFileSha,
    upsertFile,
    openPullRequest,
    postPrComment,
    askClaude,
    askClaudeCreate,
    validateFix,
    verifyFixQuality,
    composePrBody,
  };
}

function wantsStream(req: NextRequest): boolean {
  if (req.nextUrl.searchParams.get("stream") === "1") return true;
  const accept = req.headers.get("accept") || "";
  return accept.includes("text/event-stream");
}

export async function POST(req: NextRequest): Promise<Response> {
  let input: { repoUrl?: string; issues?: IssueInput[]; tier?: string };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const deps = buildDeps();

  if (!wantsStream(req)) {
    const result = await executeFixCore({ input, deps, emitter: null });
    return NextResponse.json(result.payload, { status: result.status });
  }

  // Streaming path — open the SSE response immediately, run work in the
  // background, and end the stream when work resolves.
  const emitter = createEmitter({ enabled: true });
  // Best-effort scheduling; never await (we'd block the Response).
  void executeFixCore({ input, deps, emitter })
    .then((result) => emitter.end({ ...result.payload, __innerStatus: result.status }))
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : "fix-core failed";
      try {
        emitter.emit("error", { message });
      } catch { /* swallow — emitter may already be closed */ }
      await emitter.end({ error: message, __innerStatus: 500 });
    });

  return emitter.response as Response;
}
