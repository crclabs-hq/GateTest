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

import { NextRequest, NextResponse } from "next/server";
import { requireAdminRoute } from "@/app/lib/admin-guard";
import { getDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";

const { composeBriefing } = require("@/app/lib/watchdog-intelligence") as {
  composeBriefing: (opts: {
    watches: unknown[];
    events: unknown[];
    diagnoses: unknown[];
  }) => { markdown: string; stats: Record<string, number> };
};

export async function GET(req: NextRequest) {
  const refused = requireAdminRoute(req);
  if (refused) return refused;

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
