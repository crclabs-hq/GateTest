/**
 * Live self-scan status endpoint.
 *
 * POST — accept the latest self-scan result from CI (HMAC-signed).
 * GET  — return the latest result for the badge component / public.
 *
 * The CI self-scan job in `.github/workflows/ci.yml` POSTs here after
 * running `node bin/gatetest.js --suite quick --json`. The badge
 * component at `website/app/components/SelfScanBadge.tsx` GETs.
 *
 * See `website/app/lib/self-scan-status.js` for the wire contract,
 * payload validation, and the in-memory storage strategy note.
 */

import { NextRequest, NextResponse } from "next/server";

// CommonJS interop — helper is .js with require-style exports so it
// stays unit-testable via node:test from /tests.
const selfScanStatus = require("@/app/lib/self-scan-status");

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json(
      { error: "malformed: cannot read body" },
      { status: 400 },
    );
  }

  const signatureHeader = req.headers.get("x-internal-signature");

  const result = selfScanStatus.processPublishStatus({
    rawBody,
    signatureHeader,
    env: process.env,
  });

  return NextResponse.json(result.body, { status: result.status });
}

export async function GET(): Promise<NextResponse> {
  let payload = selfScanStatus.getLatestStatus();

  // No live CI publish yet (fresh deploy / cold store) → serve the last
  // MEASURED result committed at build time instead of a dead "no-data".
  // `source: "fallback"` + a real ageMinutes keep it honest: consumers
  // render "GREEN · N days ago", never a fake "live" claim.
  if (payload && payload.status === "no-data") {
    try {
      const fb = require("@/app/data/self-scan-fallback.json");
      payload = {
        gateStatus: fb.gateStatus,
        errorCount: fb.errorCount,
        warningCount: fb.warningCount,
        modulesPassedCount: fb.modulesPassedCount,
        modulesTotalCount: fb.modulesTotalCount,
        scannedAt: fb.scannedAt,
        commitSha: fb.commitSha,
        ageMinutes: Math.max(
          0,
          Math.floor((Date.now() - Date.parse(fb.scannedAt)) / 60000),
        ),
        source: "fallback",
      };
    } catch {
      // error-ok: fallback file absent in some build shapes — the honest
      // no-data payload is still a valid response.
    }
  }

  return NextResponse.json(payload, {
    status: 200,
    // The badge polls every 60s; CDN caching would lie about freshness.
    headers: { "Cache-Control": "no-store, must-revalidate" },
  });
}
