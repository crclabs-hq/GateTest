/**
 * GET /api — the API root: where the docs are and that the API is a path on
 * this origin, not a separate host (#810). Body: app/lib/api-root.js.
 */

import { NextResponse } from "next/server";
import { siteUrl } from "@/app/lib/site-url";
import { apiRootBody } from "@/app/lib/api-root";

export function GET() {
  return NextResponse.json(apiRootBody(siteUrl()));
}
