/**
 * GateTest Score API
 *
 * GET /api/score?owner=acme&repo=payments-api
 * Returns the public GateTest score for a repo based on scan history.
 *
 * Score: 0-100 derived from the latest row in `scan_history`:
 *   - Issues found by the scan (−5 each, up to −50)
 *   - Share of modules that passed, over that run's real module count (+0-10)
 *   - Fix delivery (scan_fix / nuclear tier) → +5 bonus
 *   - Recent scan (within 7 days) → no penalty; older → −5/week
 *
 * The bonus was documented as +10 and has always been +5 in the code; the
 * deductions were documented as two terms and are now one, because the source
 * table records a single issue count. Both corrected here rather than left to
 * describe a version that never ran.
 *
 * Badge SVG also available: /api/score?owner=X&repo=Y&format=badge
 */

import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { badgeUrl } from "@/app/lib/site-url";
import { hashRepoUrl } from "@/app/lib/scan-history-store";

function computeScore(scan: {
  issues: number;
  modulesPassed: number;
  totalModules: number;
  tier: string;
  scannedAt: string;
}): number {
  let score = 100;

  // Deduct for issues found by the scan. `scan_history` records a single
  // `total_issues` count and does not split errors from warnings, so this is
  // one deduction rather than two — the previous split was reading
  // errors_FIXED and warnings_FIXED, which penalised customers for having
  // their problems fixed. One honest term beats two inverted ones.
  score -= Math.min(50, scan.issues * 5);

  // Bonus for modules that actually passed, over the real denominator for
  // that run. Never a hardcoded module count.
  if (scan.totalModules > 0) {
    const passRate = scan.modulesPassed / scan.totalModules;
    score += Math.round(passRate * 10);
  }

  // Fix tier bonus
  if (scan.tier === 'scan_fix' || scan.tier === 'nuclear') {
    score += 5;
  }

  // Staleness penalty
  const daysSince = (Date.now() - new Date(scan.scannedAt).getTime()) / 86400000;
  if (daysSince > 7) score -= Math.floor((daysSince - 7) / 7) * 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreGrade(score: number): { grade: string; label: string; color: string } {
  if (score >= 90) return { grade: 'A', label: 'Excellent', color: '#10b981' };
  if (score >= 75) return { grade: 'B', label: 'Good', color: '#3b82f6' };
  if (score >= 60) return { grade: 'C', label: 'Fair', color: '#f59e0b' };
  if (score >= 40) return { grade: 'D', label: 'Poor', color: '#f97316' };
  return { grade: 'F', label: 'Critical', color: '#ef4444' };
}

function buildBadgeSvg(owner: string, repo: string, score: number, grade: string, color: string): string {
  const label = `${owner}/${repo}`;
  const value = `GateTest ${grade} (${score}/100)`;
  const labelW = label.length * 6 + 10;
  const valueW = value.length * 6.5 + 10;
  const totalW = labelW + valueW;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelW / 2}" y="14">${label}</text>
    <text x="${labelW + valueW / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelW + valueW / 2}" y="14">${value}</text>
  </g>
</svg>`;
}

/**
 * Latest SCAN for a repo, read from `scan_history`.
 *
 * This used to read `fixes_log`, which is a log of auto-fix PRs, not scans.
 * Every input it took was inverted against the name it was given:
 *
 *   errors_fixed        AS errors          -> score -= errors * 5
 *       so the more errors we FIXED for a customer, the WORSE their public
 *       grade became.
 *   array_length(modules_fired,1) AS modules_passed -> score += passRate * 10
 *       `modules_fired` is the modules that found something (and is capped at
 *       20 on write), presented as modules that PASSED — so the more of our
 *       modules reported problems, the HIGHER the grade.
 *   totalModules: 90    hardcoded
 *       a hand-typed denominator driving a customer-facing letter grade, in
 *       a repo whose Bible rule is "never hand-write a module count, import
 *       it". It escaped tests/module-count-sync.test.js only because that
 *       test matches three-digit claims and 90 has two.
 *
 * `scan_history` is the table that actually records scans: real issue counts,
 * the real `total_modules` for that run, and a per-module summary carrying
 * each module's status. No denominator is invented here.
 *
 * When there is no scan row we return null and the caller answers "No scans
 * found for this repo". That is the correct answer for a repo we have not
 * scanned — better than deriving a grade from a fix log that cannot express
 * pass or fail.
 */
async function getLatestScan(owner: string, repo: string) {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;

  try {
    const sql = neon(dbUrl);
    // Scans are stored under a hash of the repo URL, never the cleartext URL.
    const repoHash = hashRepoUrl(`https://github.com/${owner}/${repo}`);

    const rows = await sql`
      SELECT tier, total_issues, total_modules, module_summary,
             scanned_at AS "scannedAt"
      FROM scan_history
      WHERE repo_hash = ${repoHash}
      ORDER BY scanned_at DESC
      LIMIT 1
    `;

    if (rows.length === 0) return null;
    const r = rows[0] as {
      tier: string;
      total_issues: number;
      total_modules: number;
      module_summary: Array<{ name: string; status: string; issues: number }> | null;
      scannedAt: string;
    };

    const summary = Array.isArray(r.module_summary) ? r.module_summary : [];
    // A module counts as passed only if it says so. An unrecognised status is
    // NOT counted as a pass — inventing passes is how the previous version
    // flattered every grade.
    const modulesPassed = summary.filter((m) => m && m.status === 'pass').length;

    return {
      issues: Number(r.total_issues) || 0,
      modulesPassed,
      totalModules: Number(r.total_modules) || 0,
      tier: r.tier,
      scannedAt: r.scannedAt,
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const owner = (searchParams.get("owner") || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  const repo = (searchParams.get("repo") || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  const format = searchParams.get("format") || "json";

  if (!owner || !repo) {
    return NextResponse.json({ error: "owner and repo are required" }, { status: 400 });
  }

  const scan = await getLatestScan(owner, repo);

  if (!scan) {
    if (format === "badge") {
      const svg = buildBadgeSvg(owner, repo, 0, "?", "#6b7280");
      return new NextResponse(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" } });
    }
    return NextResponse.json({ owner, repo, score: null, grade: null, message: "No scans found for this repo" });
  }

  const score = computeScore(scan);
  const { grade, label, color } = scoreGrade(score);
  const ageDays = Math.round((Date.now() - new Date(scan.scannedAt).getTime()) / 86400000);

  if (format === "badge") {
    const svg = buildBadgeSvg(owner, repo, score, grade, color);
    return new NextResponse(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  return NextResponse.json({
    owner,
    repo,
    score,
    grade,
    label,
    color,
    lastScan: {
      tier: scan.tier,
      scannedAt: scan.scannedAt,
      ageDays,
      issues: scan.issues,
    },
    badge: badgeUrl(`/api/score?owner=${owner}&repo=${repo}&format=badge`),
    readme: `[![GateTest Score](${badgeUrl(`/api/score?owner=${owner}&repo=${repo}&format=badge`)})](${badgeUrl(`/score/${owner}/${repo}`)})`,
  });
}
