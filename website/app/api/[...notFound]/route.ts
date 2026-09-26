/**
 * API catch-all — matches any /api/* path that no other route handles.
 *
 * P2 (outside reviewer, 2026-09-26, unauthenticated crawl of gatetest.io):
 * `/api/<anything unknown>` — including `/api/version`, which never
 * existed — fell through to Next's default HTML 404 page (44 KB of markup).
 * A machine caller (a customer's CI pinging `/api/status` on a typo'd path,
 * a health-check script, our own smoke test) got HTML where it expected
 * JSON and had to sniff the body to learn "not found".
 *
 * This is the LAST route Next tries under /api/ — every real route is a
 * more specific literal segment and wins first (Next.js routes static
 * segments before a catch-all). Anything that reaches here really does not
 * exist. auth-public: the body names only the path the caller sent, nothing
 * about the server's configuration.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function notFound(req: NextRequest): NextResponse {
  const { pathname } = new URL(req.url);
  return NextResponse.json(
    { ok: false, error: "not_found", path: pathname },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
