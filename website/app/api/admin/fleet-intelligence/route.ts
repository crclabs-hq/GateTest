/**
 * Fleet Intelligence API — top vulnerability signatures across customer scans.
 *
 * GET /api/admin/fleet-intelligence
 *
 * Admin-only. Queries the scans table for the most frequently failing modules
 * across all completed scans in the last 30 days. Pure DB aggregation —
 * zero Claude cost. Falls back gracefully when the table is empty or the
 * DB is unconfigured.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  getAdminConfig,
  getAdminUser,
  SESSION_COOKIE_NAME,
} from "../../../lib/admin-session";
import { ADMIN_COOKIE_NAME } from "../../../lib/admin-auth";
import { createHmac, timingSafeEqual } from "crypto";
import { getDb } from "../../../lib/db";

export const dynamic = "force-dynamic";

function checkPwCookie(v: string | undefined): boolean {
  const pw = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (!pw || !v) return false;
  const exp = createHmac("sha256", pw).update("gatetest-admin-v1").digest("hex");
  const a = Buffer.from(v), b = Buffer.from(exp);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

export async function GET() {
  const cookieStore = await cookies();

  const oauthStatus = getAdminConfig();
  let adminLogin: string | null = null;
  if (oauthStatus.ok && oauthStatus.config) {
    adminLogin = getAdminUser(cookieStore.get(SESSION_COOKIE_NAME)?.value, oauthStatus.config);
  }
  if (!adminLogin && checkPwCookie(cookieStore.get(ADMIN_COOKIE_NAME)?.value)) {
    adminLogin = "admin";
  }
  if (!adminLogin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let sql;
  try { sql = getDb(); } catch {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  try {
    const countRows = await sql`
      SELECT COUNT(*)::int AS total
      FROM scans
      WHERE status = 'completed'
        AND results IS NOT NULL
        AND jsonb_typeof(results) = 'array'
        AND created_at > NOW() - INTERVAL '30 days'
    ` as Array<{ total: number }>;

    const scansAnalyzed = countRows[0]?.total ?? 0;

    if (scansAnalyzed === 0) {
      return NextResponse.json({
        signatures: [],
        scansAnalyzed: 0,
        generatedAt: new Date().toISOString(),
      });
    }

    const rows = await sql`
      WITH module_failures AS (
        SELECT
          result->>'name' AS module_name,
          s.repo_url,
          COALESCE((result->>'issues')::int, 0) AS issue_count,
          s.created_at
        FROM scans s,
          jsonb_array_elements(s.results) AS result
        WHERE s.status = 'completed'
          AND s.results IS NOT NULL
          AND jsonb_typeof(s.results) = 'array'
          AND s.created_at > NOW() - INTERVAL '30 days'
          AND result->>'status' = 'failed'
          AND result->>'name' IS NOT NULL
      )
      SELECT
        module_name,
        COUNT(*)::int AS occurrences,
        COUNT(DISTINCT repo_url)::int AS affected_repos,
        SUM(issue_count)::int AS total_issues,
        MAX(created_at)::text AS last_seen
      FROM module_failures
      GROUP BY module_name
      ORDER BY occurrences DESC, total_issues DESC
      LIMIT 5
    ` as Array<{ module_name: string; occurrences: number; affected_repos: number; total_issues: number; last_seen: string }>;

    return NextResponse.json({
      signatures: rows,
      scansAnalyzed,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("does not exist") || message.includes("relation")) {
      return NextResponse.json({
        signatures: [],
        scansAnalyzed: 0,
        generatedAt: new Date().toISOString(),
        note: "Scan history table not initialized yet.",
      });
    }
    console.error("[fleet-intelligence] failed:", message.slice(0, 200));
    return NextResponse.json({ error: "Fleet intelligence unavailable" }, { status: 500 });
  }
}
