/**
 * GET /api/scan/history?repo=<url>&limit=<n>
 *
 * Returns scan history for a given repo URL, newest first.
 * Used by the dashboard history section so customers can see improvement
 * over time ("last week: 54 errors, today: 12 errors").
 *
 * Auth: admin cookie (same pattern as all /api/admin/* routes).
 * Graceful: returns { history: [] } when DB is not configured.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminRoute } from "@/app/lib/admin-guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const refused = requireAdminRoute(req);
  if (refused) return refused;

  const { searchParams } = new URL(req.url);
  const repoUrl = searchParams.get("repo") || "";
  const limitRaw = parseInt(searchParams.get("limit") || "20", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 20;

  if (!repoUrl) {
    return NextResponse.json({ error: "repo parameter is required" }, { status: 400 });
  }

  try {
    const { getDb } = await import("@/app/lib/db");
    const scanHistoryStore = require("@/app/lib/scan-history-store.js") as {
      getRepoHistory: (sql: unknown, repoUrl: string, limit: number) => Promise<Array<Record<string, unknown>>>;
    };
    const sql = getDb();
    const history = await scanHistoryStore.getRepoHistory(sql, repoUrl, limit);
    return NextResponse.json({ history });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    // DATABASE_URL not set or table doesn't exist yet — return empty gracefully
    if (
      msg.includes("DATABASE_URL") ||
      msg.includes("does not exist") ||
      msg.includes("relation")
    ) {
      return NextResponse.json({ history: [] });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
