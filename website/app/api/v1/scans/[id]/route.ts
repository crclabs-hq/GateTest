/**
 * Public API — GET /api/v1/scans/:id
 *
 * Returns the current status + (when complete) findings of a scan.
 *
 * Auth: Bearer API key.
 * Tier check: the key must own the scan (api_key_id stored on enqueue).
 *
 * Response shapes by status:
 *
 *   queued / running:
 *     {
 *       id, status: "queued"|"running", url, suite, createdAt,
 *       progress?: { modulesCompleted, modulesTotal }
 *     }
 *
 *   completed:
 *     {
 *       id, status: "completed", url, suite, createdAt, completedAt,
 *       healthScore?: 73,             // (Phase 2 — not wired yet)
 *       summary: { errors, warnings, info, modulesRun, durationMs },
 *       findings: [
 *         { module, severity, title, body, file?, line? },
 *         ...
 *       ]
 *     }
 *
 *   not_checked (KI #113 Phase 2 — an `api`-host row the worker could not
 *   execute honestly, e.g. a bare website URL needing an unconfigured
 *   browser runtime; Doctrine #1's third state, never folded into
 *   "completed" with zero findings):
 *     { id, status: "not_checked", url, suite, createdAt, completedAt,
 *       reason: "web-runtime:not-configured", findings: [] }
 *
 *   failed:
 *     { id, status: "failed", url, suite, createdAt, error: "..." }
 *
 * 404 if the scan ID doesn't exist or belongs to a different API key.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey, recordApiCall } from "@/app/lib/api-key";
import { getDb } from "@/app/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await authenticateApiKey(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error, code: "AUTH_FAILED" },
      { status: auth.status }
    );
  }

  const { id } = await ctx.params;
  if (!id || !id.startsWith("scn_")) {
    return NextResponse.json(
      { error: "Invalid scan ID format", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // Look up the row in scan_queue. `triggered_by` carries "api_key:<id>"
  // (written by POST /api/v1/scans via enqueueScan) so ownership is checked
  // on the stored record, not on anything the caller sends. Until KI #113
  // this imported a `getScanByEventId` the store did not export and called
  // it without `sql`, so every lookup threw and every scan was a 404.
  let row: Record<string, unknown> | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getScanByEventId } = require("@/app/lib/scan-queue-store") as {
      getScanByEventId: (eventId: string, sql: unknown) => Promise<Record<string, unknown> | null>;
    };
    row = await getScanByEventId(id, getDb());
  } catch (err) {
    console.error(
      `[api/v1/scans/:id] lookup failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return NextResponse.json(
      { error: "Scan lookup unavailable — try again shortly", code: "LOOKUP_UNAVAILABLE" },
      { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } }
    );
  }

  if (!row) {
    return NextResponse.json(
      { error: "Scan not found", code: "NOT_FOUND" },
      { status: 404 }
    );
  }

  const triggeredBy = String(row.triggered_by || row.triggeredBy || "");
  if (!triggeredBy.endsWith(`:${auth.key.id}`)) {
    // The scan exists but wasn't created by this API key. We hide existence
    // (return 404 not 403) to avoid leaking scan IDs across customers.
    return NextResponse.json(
      { error: "Scan not found", code: "NOT_FOUND" },
      { status: 404 }
    );
  }

  // Map the queue's status lifecycle (queued → running → done | not_checked
  // | failed → dead; see scan-queue-store.js) to the public API's states.
  // `failed` in the queue means "will retry", so it is still "running" to
  // the caller; `dead` is the terminal failure. ONE definition — imported,
  // not re-typed here (Doctrine #4; this table used to be hand-written in
  // this route and had no 'not_checked' entry at all).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { publicStatusFor } = require("@/app/lib/scan-queue-store") as {
    publicStatusFor: (internalStatus: string) => string;
  };
  const internalStatus = String(row.status || "queued").toLowerCase();
  const publicStatus = publicStatusFor(internalStatus);

  const metadata = (row.metadata || {}) as Record<string, unknown>;
  const result = (row.result_json || row.result || {}) as Record<string, unknown>;

  const response: Record<string, unknown> = {
    id,
    status: publicStatus,
    url: metadata.url,
    suite: metadata.suite || "web",
    callbackUrl: metadata.callbackUrl || null,
    createdAt: row.created_at,
    // Attribution as stored (KI #113) — the caller can see which producer
    // and which key the record belongs to.
    host: row.host || null,
    triggeredBy,
  };

  if (publicStatus === "completed") {
    response.completedAt = row.completed_at || row.updated_at;
    response.summary = result.summary || null;
    response.findings = Array.isArray(result.findings) ? result.findings : [];
    if (typeof result.healthScore === "number") {
      response.healthScore = result.healthScore;
    }
  } else if (publicStatus === "not_checked") {
    // KI #113 Phase 2 / Doctrine #1 third state — the worker recorded WHY it
    // could not execute this row (markNotChecked) rather than marking it
    // done with zero findings. Never present findings/summary here as if a
    // scan had actually run.
    response.completedAt = row.completed_at || row.updated_at;
    response.reason = result.reason || null;
    response.findings = [];
    response.summary = null;
  } else if (publicStatus === "failed") {
    response.error = result.error || row.last_error || row.error_message || "Scan failed";
  }

  // Record the API call for rate-limit accounting
  try {
    await recordApiCall({
      apiKeyId: auth.key.id,
      repoUrl: metadata.url as string | undefined,
      tier: metadata.suite as string | undefined,
      statusCode: 200,
    });
  } catch (err) { // error-ok: the customer's response must not depend on our accounting, but a lost rate-limit row is logged, not erased
    console.error(`[api/v1/scans/:id] recordApiCall failed for key ${auth.key.id}:`, err instanceof Error ? err.message : String(err));
  }

  return NextResponse.json(response, {
    status: 200,
    headers: {
      "X-GateTest-API-Version": "v1",
      "Cache-Control": publicStatus === "completed" ? "private, max-age=60" : "no-store",
    },
  });
}
