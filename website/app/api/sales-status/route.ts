/**
 * GET /api/sales-status — whether paid plans can be bought right now.
 *
 * Public and read-only: the pricing cards, /checkout, the scan page's upgrade
 * button and the MCP button read it to show "not on sale yet" instead of a
 * buy button. The decision itself is enforced in POST /api/checkout; this
 * route only reports it. See website/app/lib/sales-pause.js.
 */

import { NextResponse } from "next/server";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { salesPaused, SALES_PAUSED_MESSAGE } = require("@/app/lib/sales-pause") as {
  salesPaused: (env?: Record<string, string | undefined>) => boolean;
  SALES_PAUSED_MESSAGE: string;
};

export const dynamic = "force-dynamic";

export async function GET() {
  const paused = salesPaused();
  return NextResponse.json(
    paused ? { paused: true, message: SALES_PAUSED_MESSAGE } : { paused: false },
    { headers: { "Cache-Control": "no-store" } },
  );
}
