/**
 * Runtime-status poll endpoint.
 *
 * The customer's /scan/status (or /web result page) polls this every
 * few seconds while the platform (Tallrig) worker is running their URL through a
 * real Chromium. When the runtime-callback lands, this returns the
 * finished payload.
 *
 * Public + unauthenticated by scan id — the scan id is a randomly
 * generated 18-hex-char token, hard to guess. Same threat-model as
 * Stripe checkout session ids.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const scanId = req.nextUrl.searchParams.get("scanId");
  if (!scanId || !/^scn_[0-9a-f]{18}$/.test(scanId)) {
    return NextResponse.json({ error: "Invalid or missing scanId" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/app/lib/db") as { getDb: () => (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };

  let sql;
  try {
    sql = getDb();
  } catch {
    return NextResponse.json(
      { scanId, runtime: { status: "unavailable", reason: "not-configured", checked: false } },
      { status: 200 }
    );
  }

  try {
    const rows = (await sql`
      SELECT runtime_status, runtime_payload, runtime_completed_at
      FROM scan_queue
      WHERE event_id = ${scanId}
      LIMIT 1
    `) as Array<{ runtime_status: string | null; runtime_payload: unknown; runtime_completed_at: string | null }>;

    if (rows.length === 0) {
      return NextResponse.json(
        { scanId, runtime: { status: "queued", reason: null, checked: false } },
        { status: 200 }
      );
    }

    const row = rows[0];
    if (!row.runtime_status) {
      return NextResponse.json(
        { scanId, runtime: { status: "queued", reason: null, checked: false } },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        scanId,
        runtime: {
          status: row.runtime_status,
          // A signed callback landed — the runtime pass really ran (completed or failed).
          checked: true,
          completedAt: row.runtime_completed_at,
          payload: row.runtime_payload,
        },
      },
      { status: 200 }
    );
  } catch {
    // error-ok — the DB error is the operator's problem; the customer only needs the third state.
    return NextResponse.json(
      {
        scanId,
        runtime: {
          status: "unavailable",
          // The job's state could not be read — reason code only, the DB error
          // text stays server-side. Pollers keep waiting and report callback-timeout.
          reason: "status-unavailable",
          checked: false,
        },
      },
      { status: 200 }
    );
  }
}
