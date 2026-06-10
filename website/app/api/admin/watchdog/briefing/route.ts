/**
 * Watchdog Briefing API — the operator's morning read.
 *
 * GET /api/admin/watchdog/briefing
 *
 * Admin-only. Composes a deterministic (zero-Claude-cost) briefing from
 * the watches table and the last 24h of heal_history: fleet status,
 * anomalies, auto-fix PR outcomes, and any stored AI diagnoses written
 * by the tick's intelligence layer. Returns markdown + machine stats.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  getAdminConfig,
  getAdminUser,
  SESSION_COOKIE_NAME,
} from "../../../../lib/admin-session";
import { ADMIN_COOKIE_NAME } from "../../../../lib/admin-auth";
import { createHmac, timingSafeEqual } from "crypto";
import { getDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";

const { composeBriefing } = require("@/app/lib/watchdog-intelligence") as {
  composeBriefing: (opts: {
    watches: unknown[];
    events: unknown[];
    diagnoses: unknown[];
  }) => { markdown: string; stats: Record<string, number> };
};

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

  // Auth: GitHub OAuth OR password cookie — same gate as /api/admin/stats.
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
    const watches = (await sql`
      SELECT id, target, target_type, enabled, last_status, last_issue_count, last_checked_at
      FROM watches
      ORDER BY last_status DESC NULLS LAST, target ASC
    `) as unknown as Array<{ id: number }>;

    const eventsRaw = (await sql`
      SELECT h.watch_id, h.action, h.status, h.pr_url, h.details, h.completed_at,
             w.target
      FROM heal_history h
      LEFT JOIN watches w ON w.id = h.watch_id
      WHERE h.completed_at > NOW() - INTERVAL '24 hours'
      ORDER BY h.completed_at DESC
      LIMIT 500
    `) as unknown as Array<{ action: string; status: string; details: Record<string, unknown> | string | null; target: string | null }>;

    const events = eventsRaw.map((e) => ({
      ...e,
      details: typeof e.details === "string" ? JSON.parse(e.details || "{}") : (e.details || {}),
    }));

    const diagnoses = events
      .filter((e) => e.action === "diagnosis" && e.status === "success")
      .map((e) => ({
        target: e.target || (e.details as { target?: string }).target || "(unknown)",
        diagnosis: (e.details as { diagnosis?: Record<string, string> }).diagnosis || {},
      }));

    const { markdown, stats } = composeBriefing({ watches, events, diagnoses });

    return NextResponse.json({ markdown, stats, generatedAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[watchdog/briefing] failed:", message.slice(0, 200));
    return NextResponse.json({ error: "Briefing unavailable" }, { status: 500 });
  }
}
