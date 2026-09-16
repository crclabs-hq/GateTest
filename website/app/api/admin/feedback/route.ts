/**
 * GET /api/admin/feedback
 *
 * The triage view behind the two customer feedback loops: the last 200
 * feedback_events rows plus up / down counts per surface over the last 7
 * and 30 days. Rendered by /admin/feedback and linked from every issue the
 * escalation opens.
 *
 * Auth: gatetest_admin cookie — same two-method check as every other
 * /api/admin/* route. Returns 401 if not authenticated.
 *
 *   200 { ok: true, rows: [...], counts: { d7: [...], d30: [...] }, generatedAt }
 *   401 { error: "Unauthorized" }
 *   503 { ok: false, error }  — DATABASE_URL unset
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import {
  getAdminConfig,
  getAdminUser,
  SESSION_COOKIE_NAME,
} from "@/app/lib/admin-session";
import { ADMIN_COOKIE_NAME } from "@/app/lib/admin-auth";
import { getDb } from "@/app/lib/db";

type Sql = ReturnType<typeof getDb>;

const { listRecentFeedback, countsBySurface } = require("@/app/lib/feedback-store") as {
  listRecentFeedback: (sql: Sql, limit: number) => Promise<unknown[]>;
  countsBySurface: (sql: Sql, days: number) => Promise<Array<{ surface: string; up: number; down: number }>>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECENT_ROWS = 200;

// ----------------------------------------------------------------------------
// Auth — copied verbatim from /api/admin/repos/route.ts so every admin
// surface uses the same canonical check.
// ----------------------------------------------------------------------------

async function isAuthenticatedAdmin(): Promise<boolean> {
  const store = await cookies();
  const adminStatus = getAdminConfig();
  if (adminStatus.ok && adminStatus.config) {
    const sessionCookie = store.get(SESSION_COOKIE_NAME)?.value;
    if (getAdminUser(sessionCookie, adminStatus.config)) return true;
  }
  const adminPassword = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (adminPassword) {
    const passwordCookie = store.get(ADMIN_COOKIE_NAME)?.value || "";
    const expected = crypto
      .createHmac("sha256", adminPassword)
      .update("gatetest-admin-v1")
      .digest("hex");
    if (
      passwordCookie &&
      passwordCookie.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(passwordCookie), Buffer.from(expected))
    )
      return true;
  }
  return false;
}

export async function GET() {
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { ok: false, error: "persistence unavailable (DATABASE_URL unset)" },
      { status: 503 },
    );
  }
  try {
    const sql = getDb();
    const [rows, d7, d30] = await Promise.all([
      listRecentFeedback(sql, RECENT_ROWS),
      countsBySurface(sql, 7),
      countsBySurface(sql, 30),
    ]);
    return NextResponse.json({
      ok: true,
      rows,
      counts: { d7, d30 },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("[admin/feedback] query failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, error: "could not load feedback" }, { status: 500 });
  }
}
