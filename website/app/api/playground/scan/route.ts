/**
 * Playground Scan API — free, no-auth quick scan for the public playground.
 *
 * POST /api/playground/scan
 * Body: { repo_url: string }
 *
 * Runs the "quick" tier (syntax + lint + secrets + codeQuality) against any
 * public GitHub repo. No payment required. Results are ephemeral — nothing
 * is stored. Rate limiting is enforced at the CDN/edge layer.
 *
 * Deliberately restricted to quick tier so the playground is fast (<30s)
 * and the cost is bounded. The full module catalogue (see modules-data.ts
 * / totalModuleCount()) is a paid product.
 *
 * Superseded by /api/playground/scan/stream for the interactive
 * playground UI (real-time per-module events + a shadow-preview
 * "X/120 unlocked" progress bar) — this non-streaming route is kept for
 * external API consumers (see /docs/api) who want a single JSON response.
 */

import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { runScan } from "@/app/lib/scan-executor";
import { resolveBaseBranchSha, resolveRepoAuth } from "@/app/lib/gluecron-client";
import { totalModuleCount } from "@/app/components/howitworks/modules-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One definition of the grade, the severity split and the honesty labels —
// shared with /api/playground/scan/stream (tests/free-scan-grade.test.js).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const scanGrade = require("@/app/lib/scan-grade") as {
  severityForModule: (name: string) => "error" | "warning" | "info";
  computeScanGrade: (modules: Array<{ name?: string; status?: string; issues?: number }>) => {
    score: number | null;
    grade: string;
    gradeColor: string;
    blocking: number;
    warnings: number;
    info: number;
    notChecked: boolean;
    countLabel: string;
    summary: string;
  };
  describeScanScope: (scope: Record<string, unknown>) => string;
  formatResultHeader: (meta: Record<string, unknown>) => string;
};

function problem(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest) {
  let body: { repo_url?: string };
  try {
    body = await req.json();
  } catch {
    return problem(400, "Invalid JSON body");
  }

  const repoUrl = (body.repo_url || "").trim().replace(/\.git$/, "");

  if (!repoUrl) {
    return problem(400, "repo_url is required");
  }
  if (!/^https?:\/\/github\.com\/[^/]+\/[^/?#\s]+/.test(repoUrl)) {
    return problem(400, "repo_url must be a public github.com URL — e.g. https://github.com/owner/repo");
  }

  const scanId = `scn_${crypto.randomBytes(9).toString("hex")}`;
  const startedAt = Date.now();
  const result = await runScan(repoUrl, "quick");
  const verdict = scanGrade.computeScanGrade(result.modules);

  // Flatten top findings for the playground results panel. Severity comes
  // from the shared map — this route used to stamp every finding "error",
  // which is how a repo of lint warnings could read as release-blocking.
  const topFindings: Array<{ module: string; message: string; severity: string }> = [];
  for (const mod of result.modules) {
    if (mod.status === "failed" && mod.details) {
      for (const detail of mod.details.slice(0, 3)) {
        if (topFindings.length >= 8) break;
        topFindings.push({
          module: mod.name,
          message: detail,
          severity: scanGrade.severityForModule(mod.name),
        });
      }
    }
  }

  // The commit this scan read. Never guessed — a failure leaves it null and
  // the rendered header says the commit was not resolved, WHY (N1/F2:
  // resolveBaseBranchSha now always returns a `reason` alongside a null sha
  // — rate-limited, 404, no token, timeout — instead of a bare null nobody
  // could explain).
  const slugMatch = /github\.com\/([^/]+)\/([^/?#\s]+)/.exec(repoUrl);
  const owner = slugMatch?.[1] || "";
  const repoName = slugMatch?.[2] || "";
  const head = owner && repoName
    ? await resolveRepoAuth(owner, repoName)
        .then((auth) => resolveBaseBranchSha(owner, repoName, "", auth.token || ""))
        .catch((err) => ({
          sha: null as string | null,
          defaultBranch: "",
          source: "none" as const,
          reason: err instanceof Error ? `sha resolution crashed (${err.message})` : "sha resolution crashed",
        }))
    : { sha: null as string | null, defaultBranch: "", source: "none" as const, reason: "repo_url could not be parsed" };
  const scannedAt = new Date().toISOString();

  return NextResponse.json({
    status:          result.status,
    // scan-executor computes a precise reason on failure ("... not found (404)
    // — the repository is private, does not exist, or the ref is wrong") and
    // this route used to drop it, answering HTTP 200 / grade "F" / no
    // explanation. A typo'd repo was told it scored F rather than that it was
    // never found — a silent failure (Forbidden #16) and a false finding.
    // The streaming sibling route already forwards this; now both agree.
    ...(result.error ? { error: result.error } : {}),
    repo_url:        repoUrl,
    tier:            "quick",
    modules:         result.modules,
    totalModules:    result.totalModules,
    totalIssues:     result.totalIssues,
    duration:        result.duration,
    healthScore:     verdict.score,
    grade:           verdict.grade,
    gradeColor:      verdict.gradeColor,
    blockingCount:   verdict.blocking,
    warningCount:    verdict.warnings,
    infoCount:       verdict.info,
    countLabel:      verdict.countLabel,
    gradeSummary:    verdict.summary,
    scanId,
    scannedAt,
    commitSha:       head.sha,
    // N1/F2 — why the sha is null, never a bare null the reader has to guess at.
    commitShaReason: head.sha ? null : (head.reason || "sha not resolved for an unknown reason"),
    branch:          head.defaultBranch || null,
    resultHeader:    scanGrade.formatResultHeader({
      repoSlug: owner && repoName ? `${owner}/${repoName}` : repoUrl,
      commitSha: head.sha,
      shaReason: head.reason,
      branch: head.defaultBranch || null,
      scannedAt,
      scanId,
    }),
    coverage: {
      filesAnalysed: result.filesAnalysed ?? null,
      filesInRepo:   result.filesInRepo ?? null,
      truncated:     result.coverageTruncated ?? false,
      engineMs:      result.duration,
      wallMs:        Date.now() - startedAt,
    },
    scopeLabel:      scanGrade.describeScanScope({
      filesAnalysed: result.filesAnalysed,
      filesInRepo:   result.filesInRepo,
      truncated:     result.coverageTruncated,
      engineMs:      result.duration,
    }),
    topFindings,
    upgradeNote:     `This is 4 of ${totalModuleCount()} modules. A full scan would check ${totalModuleCount() - 4} more.`,
  });
}
