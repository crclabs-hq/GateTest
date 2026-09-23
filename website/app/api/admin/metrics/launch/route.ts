/**
 * GET /api/admin/metrics/launch — the launch dashboard's data, admin-only.
 *
 * The four questions the first weeks of real usage must answer, from data
 * the pipeline already writes (no new collection):
 *   - is the loop moving? (scan_queue counts, day by day)
 *   - how fast is push → result? (queue wait + total latency, avg/p95)
 *   - who saw nothing? (last dead letters, terminal vs exhausted)
 *   - what do reviewers dismiss? (rule_suppressions — the negative-feedback
 *     channel that feeds the precision flywheel)
 *
 * `?days=N` widens the window (1–90, default 14).
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";
import { isAdminRequest } from "@/app/lib/admin-auth";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getLaunchMetrics } = require("@/app/lib/launch-metrics") as {
  getLaunchMetrics: (sql: unknown, opts?: { days?: number }) => Promise<Record<string, unknown>>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const days = Number(req.nextUrl.searchParams.get("days") || "") || 14;
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return NextResponse.json({ ok: false, error: "database not configured" }, { status: 503 });
  }
  try {
    const metrics = await getLaunchMetrics(sql, { days });
    return NextResponse.json({ ok: true, generated_at: new Date().toISOString(), ...metrics });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "metrics unavailable" },
      { status: 500 },
    );
  }
}
