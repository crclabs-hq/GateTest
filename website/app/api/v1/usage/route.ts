/**
 * Public API — GET /api/v1/usage
 *
 * The customer's usage meter: what they ran, where, what it found, and what
 * the AI layer cost — across every surface (web, hosted fix, push scans,
 * REST API, MCP, CLI, editor), whoever paid for the key (GateTest or BYOK).
 *
 * Auth: identical to POST /api/v1/scans — `Authorization: Bearer gt_live_…`
 * or `X-API-Key`. The response covers ONLY the accounts this key owns
 * (usage-ledger.js accountKeysForApiKey): the key's customer e-mail identity
 * and the key's own id. Another customer's rows are unreachable by design.
 *
 * Query:
 *   from  ISO-8601 date/time — default: 30 days ago (UTC day start)
 *   to    ISO-8601 date/time — default: now; a bare date means that whole day
 *
 * Response 200:
 *   {
 *     summary:   { window, events, scans, fixes, modulesRun, findingsTotal,
 *                  findingsBlocking, aiCalls, tokensIn, tokensOut, tokensTotal,
 *                  usdEstimated, usdGatetestPaid, usdByok, byokEvents },
 *     series:    [{ day, events, aiCalls, tokensIn, tokensOut, usdEstimated, findingsTotal }, …]  // gap-filled per UTC day
 *     bySurface: { web: {…}, "hosted-fix": {…}, … },
 *     recent:    [{ id, occurredAt, surface, repo, suite, tier, … keyOwner, modelTier }, …],
 *     nextCursor: number|null
 *   }
 *
 * Errors: 401 missing/invalid key · 403 revoked key · 400 bad window · 503 no DB
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey, recordApiCall } from "@/app/lib/api-key";
import { getDb } from "@/app/lib/db";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handleUsageRequest } = require("@/app/lib/usage-ledger") as {
  handleUsageRequest: (args: {
    auth: Awaited<ReturnType<typeof authenticateApiKey>>;
    searchParams: URLSearchParams;
    getSql: () => ReturnType<typeof getDb>;
  }) => Promise<{ status: number; body: Record<string, unknown> }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  // 1. Authenticate — same helper, same failure shape as /api/v1/scans.
  const auth = await authenticateApiKey(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error, code: "AUTH_FAILED" },
      { status: auth.status }
    );
  }

  // 2. Build the report. The helper scopes every query to this key's own
  //    account keys — there is no parameter that names another account.
  const out = await handleUsageRequest({
    auth,
    searchParams: req.nextUrl.searchParams,
    getSql: () => getDb(),
  });

  // 3. Record the API call (rate-limit accounting + audit trail).
  try {
    await recordApiCall({ apiKeyId: auth.key.id, statusCode: out.status });
  } catch (err) { // error-ok: the customer's response must not depend on our accounting, but a lost rate-limit row is logged, not erased
    console.error(`[api/v1/usage] recordApiCall failed for key ${auth.key.id}:`, err instanceof Error ? err.message : String(err));
  }

  return NextResponse.json(out.body, {
    status: out.status,
    headers: {
      "X-GateTest-API-Version": "v1",
      "Cache-Control": "private, no-store",
    },
  });
}
