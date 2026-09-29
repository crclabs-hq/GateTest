/**
 * GET /api/admin/overview
 *
 * Admin-only. Backs the Overview dashboard (issue #691, item 2) — same
 * admin-cookie auth pattern as every other /api/admin/* route. The facts
 * themselves live in app/lib/admin-overview.ts (one definition, so a future
 * consumer — a CLI, a digest email — reads the same computation).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminRoute } from "@/app/lib/admin-guard";
import { getOverviewFacts } from "@/app/lib/admin-overview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const refused = requireAdminRoute(req);
  if (refused) return refused;

  const facts = await getOverviewFacts();
  return NextResponse.json(facts);
}
