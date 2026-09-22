/**
 * GET /api/admin/integrations/tallrig
 *
 * Admin-only view of the last 50 Tallrig push events received at
 * POST /api/integrations/tallrig/events (issue #672) — deploy.started/
 * finished, job.failed, secret.rotated. Reads the same capped JSON-lines
 * ledger the receiver route writes to (tallrig-push-event-store.js);
 * nothing here re-verifies or re-derives anything, it's a plain read.
 *
 * Auth: gatetest_admin cookie — same two-method check as every other
 * /api/admin/* route (copied verbatim from /api/admin/repos/route.ts, same
 * as /api/admin/feedback/route.ts and /api/admin/platform-siblings/route.ts).
 * Signed-out users get 401, never the event list.
 *
 *   200 { ok: true, events: [...], generatedAt }
 *   401 { error: "Unauthorized" }
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

// CommonJS interop — helper is .js using require-style exports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tallrigPushEventStore = require("@/app/lib/tallrig-push-event-store");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECENT_EVENTS = 50;

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

  let events: unknown[] = [];
  try {
    events = tallrigPushEventStore.listRecent(RECENT_EVENTS);
  } catch (err) {
    console.warn(
      "[admin/integrations/tallrig] could not read event ledger:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return NextResponse.json({
    ok: true,
    events,
    generatedAt: new Date().toISOString(),
  });
}
