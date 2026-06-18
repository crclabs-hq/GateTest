/**
 * GET /api/stats/public
 *
 * Returns live aggregate stats for the social proof layer on the homepage.
 * Queries the Neon scans table. Result is cached at the edge for 1 hour so
 * the homepage doesn't hammer the DB on every render.
 *
 * Falls back gracefully when DATABASE_URL is not set (e.g. preview deploys).
 */

import { NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 3600; // 1-hour ISR cache

export async function GET() {
  try {
    const sql = getDb();

    const [countRow, reposRow, scoreRow] = await Promise.all([
      sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'completed')::int AS completed FROM scans`,
      sql`SELECT COUNT(DISTINCT repo_url)::int AS repos FROM scans WHERE status = 'completed'`,
      sql`SELECT AVG(score)::numeric(5,1) AS avg_score FROM scans WHERE status = 'completed' AND score IS NOT NULL`,
    ]) as unknown as [
      Array<{ total: number; completed: number }>,
      Array<{ repos: number }>,
      Array<{ avg_score: string | null }>,
    ];

    const total = countRow[0]?.total ?? 0;
    const completed = countRow[0]?.completed ?? 0;
    const repos = reposRow[0]?.repos ?? 0;
    const avgScore = scoreRow[0]?.avg_score ? Number(scoreRow[0].avg_score) : null;

    return NextResponse.json(
      {
        scans_completed: completed,
        scans_total: total,
        repos_scanned: repos,
        avg_score: avgScore,
        generated_at: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200",
        },
      }
    );
  } catch {
    // DB unavailable — return zeros so the UI degrades gracefully
    return NextResponse.json(
      {
        scans_completed: 0,
        scans_total: 0,
        repos_scanned: 0,
        avg_score: null,
        generated_at: new Date().toISOString(),
        note: "stats unavailable",
      },
      {
        headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" },
      }
    );
  }
}
