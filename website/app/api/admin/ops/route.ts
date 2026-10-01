/**
 * GET /api/admin/ops
 *
 * Admin-only live-operations snapshot: queue, push-to-result latency, dead
 * letters, box pull-deploy and server-key AI spend vs the daily ceiling —
 * each section with its own state ("ok" | "warn" | "fail" | "not_checked")
 * and a reason. The computation lives in app/lib/admin-ops.js (sources
 * injected, unit-tested); this file only wires the real database.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminRoute } from "@/app/lib/admin-guard";
import { getDb } from "@/app/lib/db";

const { buildOpsSnapshot, defaultDeps } = require("@/app/lib/admin-ops") as {
  buildOpsSnapshot: (deps: Record<string, unknown>) => Promise<Record<string, unknown>>;
  defaultDeps: () => Record<string, unknown>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const refused = requireAdminRoute(req);
  if (refused) return refused;

  const snapshot = await buildOpsSnapshot({ ...defaultDeps(), getSql: getDb });
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
