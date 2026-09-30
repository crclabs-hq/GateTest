/**
 * GET /api/admin/build-status
 *
 * Admin-only. Backs the shell top bar (live commit vs origin/main + deploy
 * freshness) and the Overview dashboard's build card — same admin-cookie
 * auth pattern as every other /api/admin/* route.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminRoute } from "@/app/lib/admin-guard";
import { getBuildStatus } from "@/app/lib/admin-build-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const refused = requireAdminRoute(req);
  if (refused) return refused;

  const status = await getBuildStatus();
  return NextResponse.json(status);
}
