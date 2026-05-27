/**
 * GET /api/admin/audit-log
 *
 * Admin-only export of the admin-auth audit table. Lets the operator
 * pull recent auth events for compliance review or incident response
 * without needing to open the Postgres console.
 *
 *   GET /api/admin/audit-log?limit=100&format=json
 *     200 application/json:
 *       { count, entries: [ { ts, ip, result, userAgent } ] }
 *
 *   GET /api/admin/audit-log?format=csv
 *     200 text/csv (RFC 4180):
 *       ts,ip,result,userAgent
 *       2026-05-20T...,203.0.113.5,success,Mozilla/...
 *
 * AUTH:
 *   Requires the admin cookie set by POST /api/admin/auth. Unauthed
 *   requests return 401.
 *
 * DEGRADATION:
 *   If DATABASE_URL is unset, returns 503. The audit table is the
 *   product — we can't export an empty document and call it good.
 *
 * Cap: `limit` defaults to 100, max 1000. Beyond that the operator
 * should pull from Postgres directly (or we'd need a streaming
 * endpoint, which is out of scope for the MVP).
 */

import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/app/lib/admin-auth";
import { recentAudit } from "@/app/lib/admin-lockout";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

function toCsv(entries: Array<{ ts: Date; ip: string | null; result: string; userAgent: string | null }>): string {
  const escape = (v: string | null) => {
    if (v == null) return "";
    if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  };
  const lines = ["ts,ip,result,userAgent"];
  for (const e of entries) {
    lines.push([
      escape(e.ts.toISOString()),
      escape(e.ip),
      escape(e.result),
      escape(e.userAgent),
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "admin auth required" }, { status: 401 });
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "DATABASE_URL not set — audit log is unavailable" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const format = (url.searchParams.get("format") || "json").toLowerCase();

  let limit = DEFAULT_LIMIT;
  if (limitRaw) {
    const parsed = parseInt(limitRaw, 10);
    if (Number.isFinite(parsed)) {
      limit = Math.max(1, Math.min(MAX_LIMIT, parsed));
    }
  }

  const entries = await recentAudit(limit);

  if (format === "csv") {
    return new NextResponse(toCsv(entries), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="gatetest-audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store, max-age=0",
      },
    });
  }

  return NextResponse.json({
    count: entries.length,
    limit,
    entries: entries.map((e) => ({
      ts: e.ts.toISOString(),
      ip: e.ip,
      result: e.result,
      userAgent: e.userAgent,
    })),
  }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
