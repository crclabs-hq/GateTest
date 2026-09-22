/**
 * Embeddable Quality Badge — GET /badge/:owner/:repo[.svg]
 *
 * ![GateTest](https://gatetest.io/badge/facebook/react)
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
 * No scan on record → a neutral grey badge, never an error (a broken badge
 * image in someone's README is worse than an honest gap — same "false
 * positive is worse than a missed issue" spirit as the rest of this
 * session's false-positive-elimination work).
 *
 * issue #651 (N2 partial, Tallrig re-walk 2 on #647): this used to claim
 * the repo had never been scanned, even for one the free scan at
 * /playground had just graded a minute earlier. That reads as the badge
 * (and by extension GateTest) being broken. The honest fix is NOT reading
 * the free scan's grade — playground scans have nowhere server-side to
 * read it from: the share/permalink `?s=` mechanism in playground/page.tsx
 * encodes the whole result into the URL client-side (base64 JSON, see
 * encodeShareData there), and neither playground/scan/route.ts nor its
 * /stream sibling writes a row to `scans` or anywhere else — there is no
 * free-scan store this route could read even if it wanted to. So the badge
 * copy says what is actually true: a free scan doesn't produce a badge,
 * and getting one needs an account scan.
 *
 * Cached 5 minutes (CDN + browser) — badges render on every README page
 * view; no need to hit the DB more than that.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";
import { scoreToGrade, renderBadge, relativeTimeShort } from "@/app/lib/badge-svg";
import { siteUrl } from "@/app/lib/site-url";

export const dynamic = "force-dynamic";

function needsAccountScanBadge(owner: string, repo: string): string {
  return renderBadge(
    [
      { text: "GateTest", bg: "#555" },
      { text: "needs account scan", bg: "#9ca3af" },
    ],
    `GateTest: ${owner}/${repo} has no account scan on record — a free scan at ` +
      `${siteUrl('/playground')} does not appear on a badge; run an account scan for one`
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
    return new NextResponse(needsAccountScanBadge(owner || "?", repo || "?"), { headers });
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
      return new NextResponse(needsAccountScanBadge(owner, repo), { headers });
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
      `GateTest: ${owner}/${repo} scored ${grade.letter} (${scan.score}/100), ${issuesText} — ${siteUrl()}`
    );

    return new NextResponse(svg, { headers });
  } catch {
    // DB unavailable (DATABASE_URL unset, connection error, etc.) — same
    // honest fallback as "no scan on record", never a broken image.
    return new NextResponse(needsAccountScanBadge(owner, repo), { headers });
  }
}
