/**
 * GitHub Marketplace webhook — the listing's own webhook, NOT the GitHub
 * App's push/PR webhook (that one is /api/webhook — see
 * website/app/lib/github-events.js). Configured on the Marketplace listing's
 * Webhook page: payload URL `https://gatetest.io/api/marketplace/webhook`,
 * content type `application/json`, secret `GITHUB_MARKETPLACE_WEBHOOK_SECRET`.
 *
 * GitHub POSTs `marketplace_purchase` (actions: purchased, cancelled,
 * changed, pending_change, pending_change_cancelled) plus `ping` on setup.
 * Signed the same way as the App webhook — X-Hub-Signature-256, HMAC-SHA256
 * of the raw body — but with its own secret, because it is a listing-level
 * subscription GitHub configures separately from the App's own webhook
 * events (src/core/github-app-permissions.js's WEBHOOK_EVENTS is ground-
 * truthed against website/app/lib/github-events.js's eventType branches,
 * which marketplace_purchase deliberately is not one of).
 *
 * Wire contract + all logic lives in website/app/lib/marketplace-webhook.js
 * so it is unit-testable without a TS loader (tests/marketplace-webhook.test.js).
 * This file stays thin, same pattern as /api/webhook/route.ts.
 *
 * Fails closed (Forbidden #15): no configured secret → 503; bad/missing
 * signature → 401.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";

// CommonJS interop — helpers are .js using require-style exports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const marketplaceWebhook = require("@/app/lib/marketplace-webhook");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const purchaseStore = require("@/app/lib/marketplace-purchase-store");

export async function POST(req: NextRequest) {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: "malformed: cannot read body" }, { status: 400 });
  }

  const eventType = req.headers.get("x-github-event");
  const delivery = req.headers.get("x-github-delivery");
  const signatureHeader = req.headers.get("x-hub-signature-256");

  let result: { status: number; body: unknown };
  try {
    result = await marketplaceWebhook.processMarketplaceWebhookEvent({
      rawBody,
      eventType,
      delivery,
      signatureHeader,
      env: process.env,
      // Lazy: only called once the request is a verified marketplace_purchase,
      // so a database outage never turns a ping or an ignored event into a 503.
      getSql: () => getDb(),
      purchaseStore,
    });
  } catch (err) { // error-ok — webhook handler must never crash the Vercel function
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[GateTest] Marketplace webhook processing error:", msg);
    return NextResponse.json({ error: "Internal webhook error" }, { status: 500 });
  }

  return NextResponse.json(result.body, { status: result.status });
}
