/**
 * POST /api/scan/preview
 *
 * Free, no-auth, deliberately limited preview scan. Runs the quick tier
 * (syntax / lint / secrets / codeQuality) against a public repo and returns
 * the top 5 findings. Designed to be invoked by Claude (or any MCP client) on
 * behalf of a user inside a chat — the result feeds the upgrade pitch:
 *
 *   "Found 47 errors. Here's a sample of 5. Want me to fix all 47?
 *    That's $199. Tap to confirm with Apple/Google Pay."
 *
 * RELIABILITY CONTRACT:
 *   - Hard 12s deadline (Vercel-safe even on cold start).
 *   - Per-IP rate limit (1 preview per 10 seconds, in-memory best-effort
 *     since serverless doesn't share state — cold starts effectively reset
 *     the counter; that's an acceptable abuse-vs-reliability trade).
 *   - Hosted infra-only: never executes code, never reads private repos
 *     (uses the same Gluecron-or-GitHub-token auth as /api/scan/run).
 *   - Always returns 200 with { ok, findings, total } on success OR
 *     { ok: false, error, hint } on any failure — never 500-with-stacktrace.
 *
 * NO PAYMENT. No login. Designed to make every Claude invocation cheap
 * enough to be a marketing channel.
 */

import { NextRequest, NextResponse } from "next/server";
import { type RepoFile } from "@/app/lib/scan-modules";
import { runEngineForTier, hostedModulesForTier } from "@/app/lib/scan-engine-dispatch";
import { loadRepoFiles, resolveRepoAuth } from "@/app/lib/gluecron-client";
import { parseDetail, fromRankedFinding, type PreviewFinding } from "@/app/lib/preview-finding";
import { SUPPORT_EMAIL } from "@/app/lib/site-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const HARD_DEADLINE_MS = 12_000;
const MAX_FILES_TO_READ = 60;
const TOP_FINDINGS = 5;

// Best-effort per-IP throttle. Map is reset on every cold start so this is
// not a hard limit — it's a "don't accidentally hammer Anthropic / Gluecron
// from one tab" guard. Real abuse protection comes from Vercel's edge layer.
const PREVIEW_RATE_LIMIT_MS = 10_000;
const recentPreviews = new Map<string, number>();

function tooSoon(ip: string): boolean {
  const now = Date.now();
  const last = recentPreviews.get(ip) || 0;
  if (now - last < PREVIEW_RATE_LIMIT_MS) return true;
  recentPreviews.set(ip, now);
  // Cap map size — drop the oldest entries periodically.
  if (recentPreviews.size > 5000) {
    const entries = [...recentPreviews.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of entries.slice(0, 1000)) recentPreviews.delete(k);
  }
  return false;
}


export async function POST(req: NextRequest) {
  // Per-IP throttle — best effort.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (tooSoon(ip)) {
    return NextResponse.json(
      {
        ok: false,
        error: "rate limit — wait 10 seconds between previews",
        hint: "Free preview is throttled to 1 request per 10s per IP. Upgrade to Quick ($29) to remove the limit.",
      },
      { status: 429 }
    );
  }

  let input: { repoUrl?: string };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body", hint: "POST { repoUrl: 'https://github.com/owner/repo' }" },
      { status: 400 }
    );
  }

  const repoUrl = (input?.repoUrl || "").trim();
  if (!repoUrl) {
    return NextResponse.json(
      { ok: false, error: "repoUrl is required", hint: "Provide a public GitHub or Gluecron repo URL" },
      { status: 400 }
    );
  }

  const gluecronMatch = repoUrl.match(/gluecron\.com\/([^/]+)\/([^/?#]+)/);
  const githubMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  const repoMatch = gluecronMatch || githubMatch;
  if (!repoMatch) {
    return NextResponse.json(
      { ok: false, error: "expected a github.com or gluecron.com URL", hint: "e.g. https://github.com/vercel/next.js" },
      { status: 400 }
    );
  }
  const owner = repoMatch[1];
  const repo = repoMatch[2].replace(/\.git$/, "");

  const startTime = Date.now();
  const deadline = startTime + HARD_DEADLINE_MS;

  let auth;
  try {
    auth = await resolveRepoAuth(owner, repo);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "could not authenticate repo access",
        hint: err instanceof Error ? err.message : "auth provider unreachable",
      },
      { status: 503 }
    );
  }
  // No git-host token is NOT a dead end for a public repo: fetchTree/fetchBlob
  // fall back to the anonymous public archive (repo-snapshot.js), so the free
  // funnel no longer depends on any credential being alive (KI #100/#101).
  const token = auth.token || "";

  // One archive read for tree + contents (credentialed → anonymous → per-blob
  // API), capped to the quick-tier sample. Replaces `git/trees` + 60 blob calls.
  const sourceExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".rb", ".md", ".json", ".yml", ".yaml"];
  // Dotfiles the engine judges BY CONTENT — a config-only `.npmrc` is clean,
  // one carrying `_authToken` is a leaked credential; `.gitignore` decides
  // whether an `.env` next to it is tracked. Without them in the workspace the
  // secrets module can only infer from the path, which is the false positive
  // this route shipped until 2026-09-13.
  const contentJudgedNames = [".npmrc", ".gitignore", ".nvmrc", ".env", ".env.example", ".env.sample"];
  const isPreviewSource = (f: string) =>
    (sourceExts.some((ext) => f.endsWith(ext)) || contentJudgedNames.includes(f.split("/").pop() || "")) &&
    !f.includes("node_modules") &&
    !f.includes(".next") &&
    !f.includes("dist/");
  let files: string[] = [];
  let fileContents: RepoFile[] = [];
  try {
    const loaded = await loadRepoFiles(owner, repo, "HEAD", token, {
      maxFiles: MAX_FILES_TO_READ,
      filter: isPreviewSource,
      deadlineMs: deadline,
    });
    files = loaded.paths;
    fileContents = loaded.fileContents;
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "could not read repo file tree",
        hint: err instanceof Error ? err.message : "tree fetch failed",
      },
      { status: 502 }
    );
  }
  if (files.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `${owner}/${repo} appears to be empty or unreachable`,
        hint: "Confirm the URL is correct and the repo is public.",
      },
      { status: 404 }
    );
  }

  if (Date.now() > deadline) {
    return NextResponse.json({
      ok: false,
      error: "preview timed out reading files",
      hint: "Try again with a smaller repo, or upgrade to Quick ($29) for the full scan.",
    });
  }

  // The SAME dispatcher every paid path uses: the real CLI engine on the
  // `quick` suite, falling back to the in-memory runTier only if the engine
  // cannot run. The response says which one ran (`engine`), because a pass
  // from the fallback must never wear the engine's verdict.
  let scanResult;
  try {
    scanResult = await runEngineForTier({
      tier: "quick",
      owner,
      repo,
      files,
      fileContents,
      token,
      deadlineMs: deadline,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "scan engine error",
        hint: err instanceof Error ? err.message : "unknown",
      },
      { status: 500 }
    );
  }

  const findings: PreviewFinding[] = [];
  if (scanResult.engineUsed === "cli" && Array.isArray(scanResult.findings)) {
    // Ranked + deduped by the engine, with severity and confidence intact.
    for (const f of scanResult.findings) {
      if (f.duplicateOf) continue;
      findings.push(fromRankedFinding(f));
    }
  } else {
    for (const m of scanResult.modules) {
      if (!m.details || m.details.length === 0) continue;
      for (const d of m.details) findings.push(parseDetail(d, m.name));
    }
  }
  const blocking = findings.filter((f) => f.severity === "error").length;

  // Sort: errors first, then warnings, then info; within each, file then line.
  // The secondary key is what makes the top-5 selection deterministic — module
  // completion order varies run to run, so without it the same repo can show a
  // different sample each time and look flaky to a customer evaluating us.
  const severityRank = { error: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => {
    const bySeverity = severityRank[a.severity] - severityRank[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byFile = (a.file || "").localeCompare(b.file || "");
    if (byFile !== 0) return byFile;
    return (a.line ?? 0) - (b.line ?? 0);
  });
  const top = findings.slice(0, TOP_FINDINGS);

  return NextResponse.json({
    ok: true,
    repo: `${owner}/${repo}`,
    durationMs: Date.now() - startTime,
    engine: scanResult.engineUsed,
    modulesRun: scanResult.modules.filter((m) => m.status !== "skipped").map((m) => m.name),
    moduleSummary: scanResult.modules.map((m) => ({
      module: m.name,
      status: m.status,
      issues: m.issues || 0,
    })),
    findings: top,
    total: findings.length,
    blocking,
    truncated: findings.length > TOP_FINDINGS,
    nextStep: {
      tier: "quick",
      price: "$29",
      message:
        findings.length > TOP_FINDINGS
          ? `Showing top ${TOP_FINDINGS} of ${findings.length}. Upgrade to Quick ($29) to see them all + tighter scan limits.`
          : "Upgrade to Full ($99) for the full suite + auto-fix.",
      checkoutHint: `POST /api/checkout { tier, repoUrl } to start checkout`,
    },
    // Launch feedback channel: the first strangers hit exactly this
    // endpoint. Wrong or missing finding → we want the report, not the churn.
    feedback: {
      email: SUPPORT_EMAIL,
      hint: "Wrong result, missing finding, or anything confusing — email us and include the repo URL.",
    },
  });
}

export async function GET() {
  // Generated over typed: the modules the hosted engine runs for the Quick
  // tier (checkout tier table ∩ engine suite − hosted-unsafe), so the page
  // and this description cannot drift from the run.
  const modulesRun = hostedModulesForTier("quick");
  return NextResponse.json({
    description: "Free preview scan endpoint. POST with { repoUrl } to use.",
    rateLimit: `1 per ${PREVIEW_RATE_LIMIT_MS / 1000}s per IP`,
    deadline: `${HARD_DEADLINE_MS / 1000}s hard timeout`,
    engine: "cli",
    suite: "quick",
    modulesRun: modulesRun || [],
    notRun: "lint (loads your ESLint config, which is code — runs in the CLI and the GitHub Action, not on our host)",
    tier: "free",
    upgradePath: ["quick ($29)", "full ($99)", "scan_fix ($199)", "forensic ($399)"],
  });
}
