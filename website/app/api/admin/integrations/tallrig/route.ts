/**
 * GET /api/admin/integrations/tallrig
 *
 * Admin-only view of the last 50 Tallrig push events received at
 * POST /api/integrations/tallrig/events (issue #672) — deploy.started/
 * finished, job.failed, secret.rotated. Reads the same capped JSON-lines
 * ledger the receiver route writes to (tallrig-push-event-store.js);
 * nothing here re-verifies or re-derives anything, it's a plain read.
 *
 * Auth: requireAdminRoute (app/lib/admin-guard.ts) — the one admin gate
 * every /api/admin/* route uses. Signed-out users get 401, never the event
 * list.
 *
 *   200 { ok: true, events: [...], generatedAt }
 *   401 { error: "Unauthorized" }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminRoute } from "@/app/lib/admin-guard";

// CommonJS interop — helper is .js using require-style exports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tallrigPushEventStore = require("@/app/lib/tallrig-push-event-store");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECENT_EVENTS = 50;

export async function GET(req: NextRequest) {
  const refused = requireAdminRoute(req);
  if (refused) return refused;

  let events: unknown[] = [];
  try {
    events = tallrigPushEventStore.listRecent(RECENT_EVENTS);
  } catch (err) {
    console.warn(
      "[admin/integrations/tallrig] could not read event ledger:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return NextResponse.json({
    ok: true,
    events,
    generatedAt: new Date().toISOString(),
  });
}
