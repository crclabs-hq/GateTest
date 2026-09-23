/**
 * GET /api/admin/overview
 *
 * Admin-only. Backs the Overview dashboard (issue #691, item 2) — same
 * admin-cookie auth pattern as every other /api/admin/* route. The facts
 * themselves live in app/lib/admin-overview.ts (one definition, so a future
 * consumer — a CLI, a digest email — reads the same computation).
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdminLoginFromCookies } from "@/app/lib/admin-session";
import { getOverviewFacts } from "@/app/lib/admin-overview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const cookieStore = await cookies();
  if (!getAdminLoginFromCookies(cookieStore)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const facts = await getOverviewFacts();
  return NextResponse.json(facts);
}
