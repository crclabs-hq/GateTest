/**
 * Embeddable Quality Badge — GET /badge/:owner/:repo[.svg]
 *
 * ![GateTest](https://gatetest.ai/badge/facebook/react)
 *
 * Shows the repo's most recent completed scan as one glance:
 *   [GateTest] [B] [4 issues · 3d ago]
 *
 * Distinct from the pre-existing api/badge/route.ts (generic status/
 * modules badges, no per-repo lookup) and api/badge/[repo]/route.ts
 * (reads `repo` from a QUERY PARAM despite its [repo] folder name — the
 * dynamic segment was never actually wired to params, so
 * /api/badge/anything?repo=... worked but /api/badge/owner/repo alone did
 * not). This route is the real, correctly-wired path-based version: owner
 * and repo both come from the URL path, matching the shields.io/GitHub
 * Actions badge convention every other badge on the internet already
 * follows.
 *
 * No scan on record → a neutral grey "not scanned" badge, never an error
 * (a broken badge image in someone's README is worse than an honest
 * "not scanned" — same "false positive is worse than a missed issue"
 * spirit as the rest of this session's false-positive-elimination work).
 *
 * Cached 5 minutes (CDN + browser) — badges render on every README page
 * view; no need to hit the DB more than that.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";
import { scoreToGrade, renderBadge, relativeTimeShort } from "@/app/lib/badge-svg";

export const dynamic = "force-dynamic";

function notScannedBadge(owner: string, repo: string): string {
  return renderBadge(
    [
      { text: "GateTest", bg: "#555" },
      { text: "not scanned", bg: "#9ca3af" },
    ],
    `GateTest: ${owner}/${repo} has not been scanned yet — https://gatetest.ai/playground`
  );
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ owner: string; repo: string }> }
) {
  const { owner: rawOwner, repo: rawRepo } = await context.params;
  const owner = decodeURIComponent(rawOwner || "");
  const repo = decodeURIComponent((rawRepo || "").replace(/\.svg$/i, ""));

  const headers = {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "public, max-age=300, s-maxage=300",
  };

  if (!owner || !repo) {
    return new NextResponse(notScannedBadge(owner || "?", repo || "?"), { headers });
  }

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT score, results, completed_at
      FROM scans
      WHERE repo_url ILIKE ${"%" + owner + "/" + repo}
        AND status = 'completed'
        AND score IS NOT NULL
      ORDER BY completed_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `;

    if (rows.length === 0) {
      return new NextResponse(notScannedBadge(owner, repo), { headers });
    }

    const scan = rows[0] as { score: number; results: Array<{ issues?: number }> | null; completed_at: string | null };
    const grade = scoreToGrade(scan.score);
    const modules = Array.isArray(scan.results) ? scan.results : [];
    const issueCount = modules.reduce((sum, m) => sum + (m.issues || 0), 0);
    const scannedText = scan.completed_at ? relativeTimeShort(scan.completed_at) : "recently";
    const issuesText = `${issueCount} issue${issueCount !== 1 ? "s" : ""} · ${scannedText}`;

    const svg = renderBadge(
      [
        { text: "GateTest", bg: "#555" },
        { text: grade.letter, bg: grade.bgColor, fg: grade.color },
        { text: issuesText, bg: "#374151" },
      ],
      `GateTest: ${owner}/${repo} scored ${grade.letter} (${scan.score}/100), ${issuesText} — https://gatetest.ai`
    );

    return new NextResponse(svg, { headers });
  } catch {
    // DB unavailable (DATABASE_URL unset, connection error, etc.) — same
    // honest fallback as "no scan on record", never a broken image.
    return new NextResponse(notScannedBadge(owner, repo), { headers });
  }
}
