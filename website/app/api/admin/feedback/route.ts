/**
 * GET /api/admin/feedback
 *
 * The triage view behind the two customer feedback loops: the last 200
 * feedback_events rows plus up / down counts per surface over the last 7
 * and 30 days. Rendered by /admin/feedback and linked from every issue the
 * escalation opens.
 *
 * Auth: requireAdminRoute (app/lib/admin-guard.ts) — the one admin gate
 * every /api/admin/* route uses. Returns 401 if not authenticated.
 *
 *   200 { ok: true, rows: [...], counts: { d7: [...], d30: [...] }, generatedAt }
 *   401 { error: "Unauthorized" }
 *   503 { ok: false, error }  — DATABASE_URL unset
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminRoute } from "@/app/lib/admin-guard";
import { getDb } from "@/app/lib/db";

type Sql = ReturnType<typeof getDb>;

const { listRecentFeedback, countsBySurface } = require("@/app/lib/feedback-store") as {
  listRecentFeedback: (sql: Sql, limit: number) => Promise<unknown[]>;
  countsBySurface: (sql: Sql, days: number) => Promise<Array<{ surface: string; up: number; down: number }>>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECENT_ROWS = 200;

export async function GET(req: NextRequest) {
  const refused = requireAdminRoute(req);
  if (refused) return refused;
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
