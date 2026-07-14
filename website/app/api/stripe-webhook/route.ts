/**
 * Stripe Webhook Handler — Acknowledges Stripe in <5s, runs scan async.
 *
 * PAYMENT MODEL (Craig 2026-05-18 — per-scan upfront):
 * - Customer pays at checkout. Charge captures immediately.
 * - This webhook fires on checkout.session.completed and kicks off the scan.
 * - Scan result is stamped on the payment intent metadata for support /
 *   chargeback-defence purposes. NO capture or cancel call — the money
 *   already moved at checkout.
 * - If a scan crashes, support handles the customer manually (re-run or
 *   credit at discretion). The previous auto-cancel-on-failure path
 *   created a chargeback-abuse vector.
 *
 * ARCHITECTURE (decoupled — historical 60s-timeout fix):
 * - Webhook receives checkout.session.completed
 * - Verifies signature (fail-closed per Bible Forbidden #15)
 * - Stamps the payment intent with a scan_job_id (Stripe metadata acts as
 *   the idempotency lock so retries don't double-run the scan)
 * - Schedules the scan via `after()` so the response returns immediately
 * - Returns 200 to Stripe within milliseconds
 */

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import crypto from "crypto";
import https from "https";
import { runScanJob } from "../../lib/scan-executor";
import { getDb } from "../../lib/db";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

function verifyStripeSignature(payload: string, sigHeader: string): boolean {
  // FAIL CLOSED — if the webhook secret is missing from env, refuse the
  // event. Accepting unverified Stripe events = attacker can forge payment
  // captures. Bible Forbidden #15 + security-audit 2026-04-18.
  if (!STRIPE_WEBHOOK_SECRET) return false;
  if (!sigHeader) return false;

  const parts = sigHeader.split(",").reduce(
    (acc, part) => {
      const [key, val] = part.split("=");
      if (key === "t") acc.timestamp = val;
      if (key === "v1") acc.signatures.push(val);
      return acc;
    },
    { timestamp: "", signatures: [] as string[] }
  );

  if (parts.signatures.length === 0) return false;

  const signedPayload = `${parts.timestamp}.${payload}`;
  const expected = crypto
    .createHmac("sha256", STRIPE_WEBHOOK_SECRET)
    .update(signedPayload)
    .digest("hex");

  return parts.signatures.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
    } catch {
      return false;
    }
  });
}

function stripeApi(
  method: string,
  path: string,
  body?: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: "api.stripe.com",
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };
    if (body) {
      options.headers = {
        ...options.headers,
        "Content-Length": String(Buffer.byteLength(body)),
      };
    }
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        } catch {
          resolve({});
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Stripe request timed out"));
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Derive a stable idempotency key from the checkout session id. Same session
 * id → same job id, regardless of how many times Stripe retries the webhook.
 */
function deriveJobId(sessionId: string): string {
  return crypto
    .createHash("sha256")
    .update(`gatetest-scan:${sessionId}`)
    .digest("hex")
    .slice(0, 32);
}

export async function POST(req: NextRequest) {
  try {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature") || "";

  if (!verifyStripeSignature(body, sig)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Subscription lifecycle — keep local records in sync for both the
  // Continuous ($49/mo, repo-based) and MCP ($29/mo, key-based) tiers.
  // We try both stores; whichever has the matching sub ID updates its row.
  if (
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const sub = (event.data?.object || {}) as Record<string, unknown>;
    const subId = typeof sub.id === "string" ? sub.id : "";
    const stripeStatus = typeof sub.status === "string" ? sub.status : "";
    // Map Stripe's status vocabulary onto ours.
    const status =
      event.type === "customer.subscription.deleted"
        ? "canceled"
        : stripeStatus === "active" || stripeStatus === "trialing"
        ? "active"
        : stripeStatus === "past_due"
        ? "past_due"
        : "canceled";
    if (subId) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getDb } = require("@/app/lib/db");
      // Continuous store
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { setSubscriptionStatus } = require("@/app/lib/continuous-subscription-store");
        await setSubscriptionStatus(getDb(), subId, status);
      } catch (err) {
        console.error("[GateTest] continuous subscription status sync failed", {
          subPrefix: subId.slice(0, 12) + "...",
          status,
          error: err instanceof Error ? err.message : "unknown",
        });
      }
      // MCP store — silently no-ops if this sub is a Continuous sub (no row)
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { setMcpSubscriptionStatus } = require("@/app/lib/mcp-subscription-store");
        await setMcpSubscriptionStatus(getDb(), subId, status);
      } catch {
        // No matching MCP row is expected and fine — not an error
      }
    }
    return NextResponse.json({ received: true });
  }

  if (event.type !== "checkout.session.completed") {
    return NextResponse.json({ received: true });
  }

  const session = (event.data?.object || {}) as Record<string, unknown>;
  const sessionId = typeof session.id === "string" ? session.id : "";
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : "";
  const sessionMetadata =
    (session.metadata as Record<string, string> | undefined) || {};

  // Subscription session — two shapes:
  //   tier=mcp        → MCP ($29/mo, key-based, no repo URL)
  //   tier=continuous → Continuous ($49/mo, repo-based push gating)
  if (session.mode === "subscription") {
    const subscriptionId =
      typeof session.subscription === "string" ? session.subscription : "";
    const customerId =
      typeof session.customer === "string" ? session.customer : "";
    const subCustomerEmail: string | null =
      typeof session.customer_email === "string" && session.customer_email
        ? session.customer_email
        : typeof (session.customer_details as Record<string, unknown> | null)?.email === "string"
        ? (session.customer_details as Record<string, unknown>).email as string
        : null;
    const subTier = sessionMetadata.tier || "";

    // ── MCP tier ────────────────────────────────────────────────────────────
    if (subTier === "mcp") {
      if (!subscriptionId) {
        console.error("[GateTest] MCP subscription session missing subscription ID", {
          sessionPrefix: sessionId ? sessionId.slice(0, 12) + "..." : null,
        });
        return NextResponse.json({ received: true, note: "missing_subscription_id" });
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { generateApiKey, upsertMcpSubscription } = require("@/app/lib/mcp-subscription-store");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getDb: getMcpDb } = require("@/app/lib/db");
      const apiKey = generateApiKey();
      try {
        await upsertMcpSubscription(getMcpDb(), {
          stripeSubscriptionId: subscriptionId,
          stripeCustomerId: customerId,
          apiKey,
          status: "active",
          customerEmail: subCustomerEmail,
        });
      } catch (err) {
        console.error("[GateTest] MCP subscription record write failed", {
          subPrefix: subscriptionId.slice(0, 12) + "...",
          error: err instanceof Error ? err.message : "unknown",
        });
        // Do NOT ack — Stripe must retry so the customer gets their entitlement.
        return NextResponse.json({ error: "persist_failed" }, { status: 500 });
      }
      // The key exists only in our DB and this email — delivery IS the
      // entitlement. If the email can't be sent (RESEND_API_KEY missing,
      // Resend down), do NOT ack: Stripe retries, the upsert above preserves
      // the same key on conflict, and the retry re-sends it. Silent failure
      // here means a customer paying $29/mo for nothing (Bible Forbidden #16).
      if (subCustomerEmail) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sendApiKeyEmail } = require("@/app/lib/digest-mailer");
        const emailResult: { ok: boolean; error?: string } = await sendApiKeyEmail({
          to: subCustomerEmail,
          apiKey,
        });
        if (!emailResult.ok) {
          console.error("[mcp-key-email] delivery failed — not acking so Stripe retries:", {
            subPrefix: subscriptionId.slice(0, 12) + "...",
            error: emailResult.error,
          });
          return NextResponse.json({ error: "key_email_failed" }, { status: 500 });
        }
      } else {
        // No email on the session — nothing to retry into existence. Ack, but
        // loudly: support must deliver this key by hand (hello@gatetest.ai).
        console.error("[mcp-key-email] session has no customer email — key needs manual delivery", {
          subPrefix: subscriptionId.slice(0, 12) + "...",
        });
      }
      return NextResponse.json({ received: true, subscription: true, tier: "mcp" });
    }

    // ── Continuous tier ─────────────────────────────────────────────────────
    const subRepoUrl = sessionMetadata.repo_url || "";
    if (!subscriptionId || !subRepoUrl) {
      console.error("[GateTest] subscription session missing data", {
        sessionPrefix: sessionId ? sessionId.slice(0, 12) + "..." : null,
        subscriptionPresent: Boolean(subscriptionId),
        repoUrlPresent: Boolean(subRepoUrl),
      });
      return NextResponse.json({ received: true, note: "missing_subscription_metadata" });
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { upsertSubscription } = require("@/app/lib/continuous-subscription-store");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getDb } = require("@/app/lib/db");
      await upsertSubscription(getDb(), {
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: customerId,
        repoUrl: subRepoUrl,
        status: "active",
        customerEmail: subCustomerEmail,
      });
    } catch (err) {
      console.error("[GateTest] subscription record write failed", {
        subPrefix: subscriptionId.slice(0, 12) + "...",
        error: err instanceof Error ? err.message : "unknown",
      });
      return NextResponse.json({ error: "persist_failed" }, { status: 500 });
    }
    return NextResponse.json({ received: true, subscription: true });
  }

  let tier = sessionMetadata.tier || "";
  let repoUrl = sessionMetadata.repo_url || "";

  // Fallback to payment intent metadata if the checkout session didn't have it.
  if ((!tier || !repoUrl) && paymentIntentId && STRIPE_SECRET_KEY) {
    try {
      const pi = await stripeApi(
        "GET",
        `/v1/payment_intents/${paymentIntentId}`
      );
      const piMeta = (pi.metadata || {}) as Record<string, string>;
      tier = tier || piMeta.tier || "";
      repoUrl = repoUrl || piMeta.repo_url || "";
    } catch (err) { // error-ok — PI lookup is best-effort; proceed with session metadata
      console.error("[GateTest] PI metadata lookup failed:", err);
    }
  }

  if (!tier || !repoUrl || !paymentIntentId || !sessionId) {
    // Ack anyway so Stripe doesn't retry — missing metadata is not a
    // transient failure we can recover from. Log only a prefix of the
    // session/PI IDs (PII-safe — enough to correlate, not enough to
    // reconstruct a full Stripe reference).
    console.error("[GateTest] Missing scan metadata on webhook", {
      sessionPrefix: sessionId ? sessionId.slice(0, 12) + "..." : null,
      piPrefix: paymentIntentId ? paymentIntentId.slice(0, 12) + "..." : null,
      tierPresent: Boolean(tier),
      repoUrlPresent: Boolean(repoUrl),
    });
    return NextResponse.json({ received: true, note: "missing_metadata" });
  }

  const jobId = deriveJobId(sessionId);
  const scanId = crypto.randomUUID();

  // Extract customer email from the checkout session
  const customerEmail =
    typeof session.customer_email === "string"
      ? session.customer_email
      : (typeof session.customer_details === "object" &&
          session.customer_details !== null &&
          typeof (session.customer_details as Record<string, unknown>).email === "string"
            ? (session.customer_details as Record<string, unknown>).email as string
            : "");

  // Tier price mapping (cents to USD)
  const tierPrices: Record<string, number> = {
    quick: 29, full: 99, scan_fix: 199, nuclear: 399,
  };
  const tierPriceUsd = tierPrices[tier] || 0;

  // Write scan + customer records to the database
  try {
    const sql = getDb();
    const stripeCustomerId = typeof session.customer === "string" ? session.customer : null;

    // Upsert customer if we have an email
    if (customerEmail) {
      const customerId = crypto.randomUUID();
      await sql`INSERT INTO customers (id, email, stripe_customer_id)
        VALUES (${customerId}, ${customerEmail}, ${stripeCustomerId})
        ON CONFLICT (email) DO UPDATE SET
          stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, customers.stripe_customer_id)`;
    }

    // Create scan record
    const emailOrNull = customerEmail || null;
    await sql`INSERT INTO scans (id, session_id, payment_intent_id, customer_email, repo_url, tier, status, tier_price_usd)
      VALUES (${scanId}, ${sessionId}, ${paymentIntentId}, ${emailOrNull}, ${repoUrl}, ${tier}, 'pending', ${tierPriceUsd})
      ON CONFLICT (id) DO NOTHING`;
  } catch (dbErr) { // error-ok — DB write is best-effort; scan proceeds via Stripe metadata fallback
    // DB write is best-effort — scan still proceeds via Stripe metadata fallback
    console.error("[GateTest] DB write failed (webhook):", dbErr);
  }

  // Schedule the scan to run AFTER the response is sent. Vercel keeps the
  // invocation alive via waitUntil for up to the function's maxDuration, but
  // Stripe already has its 200 response so it won't retry.
  after(async () => {
    try {
      const outcome = await runScanJob({
        jobId,
        paymentIntentId,
        repoUrl,
        tier,
        scanId,
        customerEmail: customerEmail || undefined,
        tierPriceUsd,
      });
      if (outcome.skipped) {
        // code-quality-ok — operational status log inside webhook after() handler
        console.log(`[GateTest] Scan job ${jobId} skipped: ${outcome.reason}`);
      } else {
        // code-quality-ok — operational status log inside webhook after() handler
        console.log(`[GateTest] Scan job ${jobId} finished: ${outcome.result?.status}`);
      }
    } catch (err) {
      // Per-scan upfront model (Craig 2026-05-18): the payment already
      // captured at checkout. If a scan job crashes mid-way, we mark it
      // failed in DB so support can re-run or credit the customer at
      // discretion. No automatic refund / cancel — that's the loophole
      // the old hold-then-charge model created.
      console.error("[GateTest] Scan job crashed:", err);
      try {
        const sql = getDb();
        await sql`UPDATE scans SET status = 'failed', completed_at = NOW()
          WHERE id = ${scanId}`;
      } catch {
        // best-effort
      }
    }
  });

  return NextResponse.json({ received: true, jobId, scanId });
  } catch (err) {
    console.error("[GateTest] Stripe webhook handler crashed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
