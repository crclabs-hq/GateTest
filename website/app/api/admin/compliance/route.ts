/**
 * Admin Compliance API — returns the compliance posture snapshot.
 *
 * GET /api/admin/compliance — admin-only (same auth pattern as /api/admin/stats).
 *
 * Returns the SOC2 / HIPAA controls inventory, audit log activity counters,
 * admin-auth lockout state, and a recent-window hash-chain integrity probe.
 * Always returns a snapshot — partial data on DB error.
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
import { buildComplianceSnapshot } from "../../../lib/compliance-status";

export const runtime = "nodejs";
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

  const snapshot = await buildComplianceSnapshot();
  return NextResponse.json(snapshot);
}
