/**
 * GET /api/admin/build-status
 *
 * Admin-only. Backs the shell top bar (live commit vs origin/main + deploy
 * freshness) and the Overview dashboard's build card — same admin-cookie
 * auth pattern as every other /api/admin/* route.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdminLoginFromCookies } from "@/app/lib/admin-session";
import { getBuildStatus } from "@/app/lib/admin-build-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const cookieStore = await cookies();
  if (!getAdminLoginFromCookies(cookieStore)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = await getBuildStatus();
  return NextResponse.json(status);
}
