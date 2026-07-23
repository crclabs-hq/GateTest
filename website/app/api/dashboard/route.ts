/**
 * Customer Dashboard API — fetch scan history for the signed-in customer.
 *
 * POST /api/dashboard
 *   Auth: gatetest_customer session cookie (OAuth sign-in). The lookup
 *   email comes from the VERIFIED session payload — never from the
 *   request body. A client-supplied email would let anyone enumerate any
 *   customer's scan history, repos, and total spend (fixed 2026-07-23;
 *   previously the body email was trusted with only IP rate limiting).
 *   Returns: { scans: [...], customer: {...} } · 401 when not signed in.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "../../lib/db";
import {
  getOAuthConfig,
  verifyCustomerSession,
  CUSTOMER_COOKIE_NAME,
} from "../../lib/customer-session";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};

const _dashboardLimiter = createLimiter(PRESETS.dashboard);

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const _rl = await _dashboardLimiter.guard(req);
  if (!_rl.allowed) {
    return NextResponse.json(_rl.body, {
      status: _rl.status ?? 429,
      headers: _rl.headers as Record<string, string>,
    });
  }
  // Identity comes from the verified session cookie, not the body.
  const oauth = getOAuthConfig();
  if (!oauth.ok || !oauth.config) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  const cookieStore = await cookies();
  const token = cookieStore.get(CUSTOMER_COOKIE_NAME)?.value;
  const session = verifyCustomerSession(token, oauth.config.sessionSecret);
  if (!session || typeof session.e !== "string" || !session.e.includes("@")) {
    return NextResponse.json(
      { error: "Sign in to view your scan history" },
      { status: 401 }
    );
  }

  const email = session.e.trim().toLowerCase();

  try {
    const sql = getDb();

    const scans = await sql`
      SELECT
        id, session_id, repo_url, tier, status, score,
        duration_ms, tier_price_usd, summary,
        created_at, completed_at
      FROM scans
      WHERE LOWER(customer_email) = ${email}
      ORDER BY created_at DESC
      LIMIT 50
    `;

    const customers = await sql`
      SELECT email, github_login, total_scans, total_spent_usd, created_at
      FROM customers
      WHERE LOWER(email) = ${email}
      LIMIT 1
    `;

    return NextResponse.json({
      scans,
      customer: customers[0] || null,
    });
  } catch (err) {
    // DB not available — return empty rather than crashing
    const message = err instanceof Error ? err.message : "Database unavailable";
    if (message.includes("DATABASE_URL")) {
      return NextResponse.json({
        scans: [],
        customer: null,
        note: "Database not configured yet.",
      });
    }
    return NextResponse.json({ error: "Failed to fetch scans" }, { status: 500 });
  }
}
