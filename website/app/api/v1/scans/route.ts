/**
 * Public API — POST /api/v1/scans
 *
 * Authenticated. Starts a URL or repo scan on behalf of the caller.
 *
 * Request:
 *   Authorization: Bearer gt_live_<key>
 *   Content-Type:  application/json
 *
 *   Body:
 *     {
 *       "url": "https://customer-site.example",      // required for URL scans
 *       "suite": "web"|"wp"|"quick"|"full"|"nuclear", // default: "web"
 *       "callbackUrl": "https://partner.example/hook" // optional; we POST
 *                                                     // the scan result here
 *                                                     // when complete
 *     }
 *
 * Response:
 *   201 Created
 *   {
 *     "id": "scn_xxxxxxxx",
 *     "status": "queued",
 *     "url": "...",
 *     "suite": "web",
 *     "createdAt": "2026-05-15T..."
 *   }
 *
 * Error responses:
 *   401 — missing / invalid API key
 *   403 — key revoked OR tier doesn't include this suite
 *   429 — rate limit exceeded
 *   400 — invalid request body
 *   503 — the scan record could not be written (nothing was queued; retry)
 *
 * Sandbox keys (prefix `gt_test_`) return canned results without spending
 * Anthropic credit. Use them for integration development.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey, checkRateLimit, recordApiCall } from "@/app/lib/api-key";
import { getDb } from "@/app/lib/db";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // Quick handoff; the actual scan runs in the worker.

const VALID_SUITES = new Set(["web", "wp", "quick", "full", "nuclear", "standard"]);

interface PostScanBody {
  url?: string;
  suite?: string;
  callbackUrl?: string;
  idempotencyKey?: string;
}

function isPublicUrl(u: string): { ok: boolean; reason?: string } {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, reason: "URL must use http:// or https://" };
    }
    const host = parsed.hostname.toLowerCase();
    // Reject loopback and private ranges — protects against using us as an
    // internal-network port scanner.
    if (
      host === "localhost" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("169.254.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
    ) {
      return { ok: false, reason: "URL points at a private / loopback address" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "URL is malformed" };
  }
}

function shortId(prefix: string): string {
  const buf = crypto.randomBytes(9);
  return `${prefix}_${buf.toString("hex")}`;
}

export async function POST(req: NextRequest) {
  // 1. Authenticate
  const auth = await authenticateApiKey(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error, code: "AUTH_FAILED" },
      { status: auth.status }
    );
  }

  // 2. Rate limit
  const rl = await checkRateLimit(auth.key);
  if (rl) {
    return NextResponse.json(
      { error: rl.error, code: "RATE_LIMITED" },
      { status: rl.status, headers: { "Retry-After": "300" } }
    );
  }

  // 3. Parse body
  let body: PostScanBody;
  try {
    body = (await req.json()) as PostScanBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // 4. Validate fields
  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json(
      { error: "url is required", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }
  const urlCheck = isPublicUrl(body.url);
  if (!urlCheck.ok) {
    return NextResponse.json(
      { error: urlCheck.reason, code: "BAD_REQUEST" },
      { status: 400 }
    );
  }
  const suite = body.suite || "web";
  if (!VALID_SUITES.has(suite)) {
    return NextResponse.json(
      {
        error: `Invalid suite. Valid values: ${[...VALID_SUITES].join(", ")}`,
        code: "BAD_REQUEST",
      },
      { status: 400 }
    );
  }

  // 5. Tier enforcement — does the key allow this suite?
  // tier_allowed values: 'quick' (free), 'full' (paid), 'all' (enterprise),
  // 'admin' (first-party / sibling-product integration; bypasses payment +
  // rate limits via the SAME code path as everyone else). Map suites to
  // the minimum tier required.
  const suiteToTier: Record<string, string> = {
    web: "quick",
    quick: "quick",
    standard: "quick",
    wp: "quick",
    full: "full",
    nuclear: "all",
  };
  const requiredTier = suiteToTier[suite];
  const keyTier = auth.key.tier_allowed || "quick";
  const tierOrder = { quick: 0, full: 1, all: 2, admin: 3 };
  const keyLevel = tierOrder[keyTier as keyof typeof tierOrder] ?? 0;
  const requiredLevel = tierOrder[requiredTier as keyof typeof tierOrder] ?? 0;
  if (keyLevel < requiredLevel) {
    return NextResponse.json(
      {
        error: `This API key's tier (${keyTier}) does not include the "${suite}" suite. Upgrade required.`,
        code: "TIER_INSUFFICIENT",
      },
      { status: 403 }
    );
  }

  // 6. Create the scan record
  const scanId = shortId("scn");
  const createdAt = new Date().toISOString();

  // The record lives in the shared scan_queue table, host='api', attributed
  // to the caller's key via triggered_by — that is what GET /api/v1/scans/:id
  // matches ownership on. Until KI #113 (2026-09-16) this call did not match
  // the store's contract at all (no `sql`, `owner`/`repo` instead of
  // `repository`, no `sha`): enqueueScan threw on every request, the catch
  // below logged it and the route still answered 201 "queued" for a scan
  // that had never been recorded — so every later GET was a 404.
  //
  // The queue worker does not execute host='api' rows (it has no repository
  // to fetch); it marks them terminal and the GET reports that honestly.
  // Running URL scans from the queue is Phase 2 work — the record and its
  // attribution are what ship here.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { enqueueScan, ensureScanQueueTable } = require("@/app/lib/scan-queue-store") as {
      ensureScanQueueTable: (sql: unknown) => Promise<void>;
      enqueueScan: (opts: {
        eventId: string;
        repository: string;
        sha: string;
        host: "api" | "github" | "gluecron";
        triggeredBy: string;
        metadata?: Record<string, unknown>;
        sql: unknown;
      }) => Promise<{ duplicate: boolean; id: number | null }>;
    };
    const sql = getDb();
    await ensureScanQueueTable(sql);
    // The schema is repository-shaped; a URL scan has no owner/repo or
    // commit. Store the hostname/path as the pseudo-repository and a stable
    // digest of the URL where the commit sha goes, so the row is well-formed
    // and two scans of the same URL are recognisably the same target. The
    // real target lives in metadata.url.
    const parsedUrl = new URL(body.url);
    await enqueueScan({
      eventId: scanId,
      repository: `${parsedUrl.hostname}/${parsedUrl.pathname.slice(1) || "_root_"}`,
      sha: crypto.createHash("sha1").update(body.url).digest("hex"),
      host: "api",
      triggeredBy: `api_key:${auth.key.id}`,
      metadata: {
        url: body.url,
        suite,
        callbackUrl: body.callbackUrl || null,
        apiKeyName: auth.key.name,
        scanId,
      },
      sql,
    });
  } catch (err) {
    // A scan that was not recorded is not "queued" — say so instead of
    // returning a 201 the caller can never poll (Doctrine #1).
    console.error(
      `[api/v1/scans] enqueue failed for key ${auth.key.id}: ${err instanceof Error ? err.message : String(err)}`
    );
    return NextResponse.json(
      { error: "Scan could not be queued — try again shortly", code: "QUEUE_UNAVAILABLE" },
      { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } }
    );
  }

  // 7. Record the API call (rate-limit accounting + audit trail)
  try {
    await recordApiCall({
      apiKeyId: auth.key.id,
      repoUrl: body.url,
      tier: suite,
      statusCode: 201,
      idempotencyKey: body.idempotencyKey,
    });
  } catch (err) { // error-ok: the customer's 201 must not depend on our accounting, but a lost rate-limit row is logged, not erased
    console.error(`[api/v1/scans] recordApiCall failed for key ${auth.key.id}:`, err instanceof Error ? err.message : String(err));
  }

  return NextResponse.json(
    {
      id: scanId,
      status: "queued",
      url: body.url,
      suite,
      callbackUrl: body.callbackUrl || null,
      createdAt,
    },
    {
      status: 201,
      headers: {
        Location: `/api/v1/scans/${scanId}`,
        "X-GateTest-API-Version": "v1",
        "Cache-Control": "no-store",
      },
    }
  );
}
