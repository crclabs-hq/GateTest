/**
 * /api/releases/notify — internal trigger for the release-notes e-mail.
 *
 * POST /api/releases/notify   body: { version: string }
 *   Auth: Bearer GATETEST_INTERNAL_TOKEN (same check as /api/fixes — this is
 *   an internal-only route, never called from the browser).
 *
 * Called by .github/workflows/publish.yml after a successful npm publish,
 * ONLY when the repo variable GATETEST_RELEASE_NOTIFY_ENABLED == '1'
 * (Bible Boss Rule: sending mail to customers is user communication and
 * ships OFF by default). When the flag is off this route itself also
 * refuses — belt and braces, since the flag is read from the server's own
 * env, not trusted from the caller.
 *
 * Returns the three-state result from notifyRelease() unchanged; the flag
 * being off is surfaced as HTTP 503 with reason: "disabled" so the caller
 * (and anyone curling it by hand) can tell "off on purpose" from "broken".
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getDb } from "@/app/lib/db";

const {
  releaseNotifyEnabled,
  notifyRelease,
} = require("@/app/lib/release-notifier");

// Same pattern as every other secret check in this codebase (admin-auth.ts,
// github-events.js, stripe-webhook/route.ts, events-push.js,
// self-scan-status.js, api/fixes/route.ts).
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Same fallback as /api/fixes — falls back to GATETEST_ADMIN_PASSWORD so
// existing infra doesn't need a new secret.
const INTERNAL_TOKEN = process.env.GATETEST_INTERNAL_TOKEN || process.env.GATETEST_ADMIN_PASSWORD || "";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!INTERNAL_TOKEN || !safeEqual(token, INTERNAL_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!releaseNotifyEnabled()) {
    return NextResponse.json(
      { status: "disabled", sent: 0, skipped: 0, reason: "GATETEST_RELEASE_NOTIFY_ENABLED is not \"1\"" },
      { status: 503 }
    );
  }

  let body: { version?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const version = typeof body.version === "string" ? body.version.trim() : "";
  if (!version) {
    return NextResponse.json({ error: "version is required" }, { status: 400 });
  }

  try {
    const sql = getDb();
    const result = await notifyRelease({ sql, version });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "database not configured" },
      { status: 503 }
    );
  }
}
