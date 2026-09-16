/**
 * Public status summary — GET /api/status/public
 *
 * The machine-readable twin of /status: per component, one of
 * operational | degraded | down | unknown with a customer-safe sentence, plus
 * the build stamp. Derived from the probes that already exist
 * (app/lib/public-status-collect.ts); nothing here is typed by hand.
 *
 * Contrast with the neighbours:
 *   - /api/status         — operator readiness: variable NAMES, queue counts
 *   - /api/platform-status — build stamp + sibling map
 *   - /api/health         — bare liveness
 * This route says nothing an operator would need and nothing a stranger
 * should not see: no env var names, no hostnames, no error text.
 *
 * Never 500s: the collector guards every reading and the mapper never
 * throws; a failure at this level still answers with an all-unknown body.
 * Cached 30s (the collector's TTL) and marked cacheable for the same window.
 */

import { NextResponse } from "next/server";
import { getPublicStatus, PUBLIC_STATUS_TTL_SECONDS } from "@/app/lib/public-status-collect";

const { summarisePublicStatus } = require("@/app/lib/public-status") as {
  summarisePublicStatus: (readings: Record<string, unknown>) => unknown;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "cache-control": `public, max-age=${PUBLIC_STATUS_TTL_SECONDS}, s-maxage=${PUBLIC_STATUS_TTL_SECONDS}, stale-while-revalidate=${PUBLIC_STATUS_TTL_SECONDS}`,
  "access-control-allow-origin": "*",
};

// auth-public — a customer-facing summary with no operator detail in it.
export async function GET(): Promise<NextResponse> {
  try {
    const summary = await getPublicStatus();
    return NextResponse.json(summary, { status: 200, headers: HEADERS });
  } catch {
    return NextResponse.json(summarisePublicStatus({}), { status: 200, headers: HEADERS });
  }
}
