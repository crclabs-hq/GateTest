/**
 * Tallrig signed push events — POST /api/integrations/tallrig/events
 * (issue #672). Target URL registered on the Tallrig tenant via the
 * `pushEvents.register` tRPC call: https://gatetest.io/api/integrations/tallrig/events.
 *
 * Tallrig fires `deploy.started`, `deploy.finished` (sha or null plus
 * shaSource), `job.failed`, and `secret.rotated` (name only) at this
 * endpoint, signed the same way as the App/Marketplace webhooks in spirit
 * (raw-body HMAC) but with its own scheme and its own secret — see
 * website/app/lib/tallrig-push-signature.js for the wire contract
 * (X-Tallrig-Key-Id / -Timestamp / -Signature, 300s replay window).
 *
 * Wire contract + all logic lives in website/app/lib/tallrig-push-events.js
 * so it is unit-testable without a TS loader (tests/tallrig-push-route.test.js).
 * This file stays thin, same pattern as /api/marketplace/webhook/route.ts.
 *
 * Fails closed (Bible Forbidden #15): no configured secret -> 503;
 * missing header -> 400; bad/missing signature -> 401; timestamp outside
 * the replay window -> 409.
 */

import { NextRequest, NextResponse } from "next/server";

// CommonJS interop — helpers are .js using require-style exports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tallrigPushEvents = require("@/app/lib/tallrig-push-events");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tallrigPushEventStore = require("@/app/lib/tallrig-push-event-store");

export async function POST(req: NextRequest) {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: "malformed: cannot read body" }, { status: 400 });
  }

  const keyIdHeader = req.headers.get("x-tallrig-key-id");
  const timestampHeader = req.headers.get("x-tallrig-timestamp");
  const signatureHeader = req.headers.get("x-tallrig-signature");

  let result: { status: number; body: unknown };
  try {
    result = await tallrigPushEvents.processTallrigPushEvent({
      rawBody,
      keyIdHeader,
      timestampHeader,
      signatureHeader,
      env: process.env,
      store: tallrigPushEventStore,
    });
  } catch (err) { // error-ok — webhook handler must never crash the Vercel function
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[GateTest] Tallrig push-event processing error:", msg);
    return NextResponse.json({ error: "Internal push-event error" }, { status: 500 });
  }

  return NextResponse.json(result.body, { status: result.status });
}
