/**
 * Admin Compliance API — returns the compliance posture snapshot.
 *
 * GET /api/admin/compliance — admin-only (same auth pattern as /api/admin/stats).
 *
 * Returns the SOC2 / HIPAA controls inventory, audit log activity counters,
 * admin-auth lockout state, and a recent-window hash-chain integrity probe.
 * Always returns a snapshot — partial data on DB error.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminRoute } from "@/app/lib/admin-guard";
import { buildComplianceSnapshot } from "../../../lib/compliance-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const refused = requireAdminRoute(req);
  if (refused) return refused;

  const snapshot = await buildComplianceSnapshot();
  return NextResponse.json(snapshot);
}
