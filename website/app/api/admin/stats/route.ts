/**
 * Admin Stats API — Returns scan and customer data from the database.
 *
 * GET /api/admin/stats
 *
 * Admin-only: requires valid admin session cookie.
 * Returns recent scans, customer list, and aggregate stats.
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const marketplacePurchaseStore = require("../../../lib/marketplace-purchase-store");

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

  // Auth: GitHub OAuth OR password cookie
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

  try {
    let sql: ReturnType<typeof getDb>;
    try {
      sql = getDb();
    } catch {
      // DATABASE_URL unset — same empty-state shape as "tables not
      // initialized yet" below, so the dashboard renders instead of 500ing
      // on a config gap that isn't actually a query failure.
      return NextResponse.json({
        scans: [],
        customers: [],
        stats: {
          total_scans: 0,
          completed_scans: 0,
          failed_scans: 0,
          total_revenue: 0,
          avg_score: 0,
          avg_duration_ms: 0,
          total_customers: 0,
          marketplace_active_installs: 0,
        },
        note: "DATABASE_URL not set.",
      });
    }

    // Recent scans (last 50)
    const recentScans = await sql`
      SELECT id, session_id, customer_email, repo_url, tier, status, score,
             duration_ms, tier_price_usd, created_at, completed_at
      FROM scans ORDER BY created_at DESC LIMIT 50`;

    // All customers
    const customers = await sql`
      SELECT id, email, github_login, stripe_customer_id, total_scans,
             total_spent_usd, created_at
      FROM customers ORDER BY created_at DESC LIMIT 100`;

    // Aggregate stats
    const statsResult = await sql`
      SELECT
        COUNT(*)::int AS total_scans,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_scans,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_scans,
        COALESCE(SUM(tier_price_usd), 0)::numeric AS total_revenue,
        COALESCE(AVG(score), 0)::int AS avg_score,
        COALESCE(AVG(duration_ms), 0)::int AS avg_duration_ms
      FROM scans`;

    const stats = statsResult[0] || {
      total_scans: 0,
      completed_scans: 0,
      failed_scans: 0,
      total_revenue: 0,
      avg_score: 0,
      avg_duration_ms: 0,
    };

    const customerCount = await sql`
      SELECT COUNT(*)::int AS total FROM customers`;

    // GitHub Marketplace active-install count (from marketplace_purchase
    // webhook deliveries) — best-effort, never fails the whole stats page.
    let marketplaceActiveInstalls = 0;
    try {
      marketplaceActiveInstalls = (await marketplacePurchaseStore.summarize(sql)).activeInstalls;
    } catch { // error-ok — an ops dashboard number is not a critical path
      marketplaceActiveInstalls = 0;
    }

    return NextResponse.json({
      scans: recentScans,
      customers,
      stats: {
        ...stats,
        total_customers: customerCount[0]?.total || 0,
        marketplace_active_installs: marketplaceActiveInstalls,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // If tables don't exist yet, return empty state rather than crashing
    if (message.includes("does not exist") || message.includes("relation")) {
      return NextResponse.json({
        scans: [],
        customers: [],
        stats: {
          total_scans: 0,
          completed_scans: 0,
          failed_scans: 0,
          total_revenue: 0,
          avg_score: 0,
          avg_duration_ms: 0,
          total_customers: 0,
          marketplace_active_installs: 0,
        },
        note: "Database tables not initialized. Run POST /api/db/init first.",
      });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
