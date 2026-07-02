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

import { NextRequest, NextResponse } from "next/server";
import { runScan } from "@/app/lib/scan-executor";
import { totalModuleCount } from "@/app/components/howitworks/modules-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function problem(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

function computeHealthScore(modules: Array<{ status: string; issues?: number }>): {
  score: number;
  grade: string;
  gradeColor: string;
} {
  if (!modules.length) return { score: 0, grade: "F", gradeColor: "#ef4444" };

  const passed    = modules.filter((m) => m.status === "passed").length;
  const total     = modules.length;
  const errors    = modules.reduce((s, m) => s + (m.issues || 0), 0);
  const base      = Math.round((passed / total) * 100);
  const penalty   = Math.min(50, errors * 3);
  const score     = Math.max(0, base - penalty);

  let grade: string;
  let gradeColor: string;
  if (score >= 90) { grade = "A"; gradeColor = "#22c55e"; }
  else if (score >= 75) { grade = "B"; gradeColor = "#0d9488"; }
  else if (score >= 60) { grade = "C"; gradeColor = "#eab308"; }
  else if (score >= 40) { grade = "D"; gradeColor = "#f97316"; }
  else { grade = "F"; gradeColor = "#ef4444"; }

  return { score, grade, gradeColor };
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

  const result = await runScan(repoUrl, "quick");
  const { score, grade, gradeColor } = computeHealthScore(result.modules);

  // Flatten top findings for the playground results panel
  const topFindings: Array<{ module: string; message: string; severity: string }> = [];
  for (const mod of result.modules) {
    if (mod.status === "failed" && mod.details) {
      for (const detail of mod.details.slice(0, 3)) {
        if (topFindings.length >= 8) break;
        topFindings.push({
          module: mod.name,
          message: detail,
          severity: "error",
        });
      }
    }
  }

  return NextResponse.json({
    status:          result.status,
    repo_url:        repoUrl,
    tier:            "quick",
    modules:         result.modules,
    totalModules:    result.totalModules,
    totalIssues:     result.totalIssues,
    duration:        result.duration,
    healthScore:     score,
    grade,
    gradeColor,
    topFindings,
    upgradeNote:     `This is 4 of ${totalModuleCount()} modules. A full scan would check ${totalModuleCount() - 4} more.`,
  });
}
