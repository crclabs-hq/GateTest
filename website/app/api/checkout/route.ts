/**
 * Stripe Checkout API — Creates a per-scan payment session (charge upfront).
 *
 * Flow:
 * 1. Customer selects a scan tier and provides repo URL
 * 2. This route creates a Stripe Checkout Session — charge captures at checkout
 * 3. Customer completes payment → Stripe charges the card immediately
 * 4. GateTest runs the scan (and AI fix on Scan + Fix and Forensic tiers)
 * 5. If a scan fails to start or crashes mid-way, support handles the
 *    exception (re-run or credit at our discretion) — NOT an automatic refund.
 *
 * Per Craig's call (2026-05-18): the previous hold-then-capture model
 * invited "didn't deliver" chargeback abuse. Standard SaaS (Vercel,
 * GitHub, Linear, Stripe itself) charges upfront and treats refunds
 * as discretionary exceptions, not entitlements.
 *
 * Environment variables:
 *   STRIPE_SECRET_KEY — Stripe secret key (sk_live_... or sk_test_...)
 *   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY — For client-side (pk_live_... or pk_test_...)
 */

import { NextRequest, NextResponse } from "next/server";
import https from "https";
// Next.js App Router route files only allow a restricted export set (GET,
// POST, dynamic, runtime, etc.) — TIERS/ScanTier live in a standalone
// zero-dependency module instead of being re-exported from here, both so
// this file stays a valid route AND so plain CJS consumers (see
// stripe-checkout.js) can require() the tier data without pulling in
// next/server (which isn't resolvable outside the Next.js build).
import { TIERS } from "@/app/lib/checkout-tiers";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};

const _checkoutLimiter = createLimiter(PRESETS.checkout);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://gatetest.ai";

function stripeRequest(
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
        const raw = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Stripe API error: ${raw}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Stripe request timed out"));
    });
    if (body) req.write(body);
    req.end();
  });
}

export async function POST(req: NextRequest) {
  if (!STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { error: "Payments not configured yet" },
      { status: 503 }
    );
  }

  let input: { tier?: string; repoUrl?: string };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Rate-limit AFTER body parsing, BEFORE any Stripe API call.
  const _rlCheckout = await _checkoutLimiter.guard(req);
  if (!_rlCheckout.allowed) {
    return NextResponse.json(_rlCheckout.body, {
      status: _rlCheckout.status ?? 429,
      headers: _rlCheckout.headers as Record<string, string>,
    });
  }

  const tier = TIERS[input.tier || ""];
  if (!tier) {
    return NextResponse.json(
      { error: `Invalid tier. Options: ${Object.keys(TIERS).join(", ")}` },
      { status: 400 }
    );
  }

  // MCP tier is key-based — no repo URL required. All other tiers need one.
  if (input.tier !== "mcp") {
    if (
      !input.repoUrl ||
      !(input.repoUrl.includes("github.com") || input.repoUrl.includes("gluecron.com"))
    ) {
      return NextResponse.json(
        { error: "A valid GitHub or Gluecron repository URL is required" },
        { status: 400 }
      );
    }
  }

  try {
    // Create Stripe Checkout Session — charge captures at checkout (no
    // manual capture / hold-then-charge). Refunds are discretionary, not
    // an automatic-on-failure mechanism.
    //
    // Two commercial shapes share this endpoint:
    //   one-time  (mode=payment)      — per-scan tiers, metadata on the PI
    //   recurring (mode=subscription) — Continuous $49/mo; subscription mode
    //     forbids payment_intent_data, so metadata rides on the session and
    //     on subscription_data (→ lands on the Subscription object, which
    //     the stripe-webhook lifecycle handlers read).
    const params = tier.recurring
      ? new URLSearchParams({
          "payment_method_types[0]": "card",
          mode: "subscription",
          "metadata[tier]": input.tier || "",
          "metadata[repo_url]": input.repoUrl || "",
          "metadata[modules]": tier.modules,
          "subscription_data[metadata][tier]": input.tier || "",
          "subscription_data[metadata][repo_url]": input.repoUrl || "",
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][unit_amount]": String(tier.priceInCents),
          "line_items[0][price_data][recurring][interval]": "month",
          "line_items[0][price_data][product_data][name]": `GateTest ${tier.name}`,
          "line_items[0][price_data][product_data][description]": tier.description,
          "line_items[0][quantity]": "1",
          success_url: `${BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${BASE_URL}/checkout/cancel`,
        })
      : new URLSearchParams({
          "payment_method_types[0]": "card",
          mode: "payment",
          "payment_intent_data[metadata][tier]": input.tier || "",
          "payment_intent_data[metadata][repo_url]": input.repoUrl || "",
          "payment_intent_data[metadata][modules]": tier.modules,
          "metadata[tier]": input.tier || "",
          "metadata[repo_url]": input.repoUrl || "",
          "metadata[modules]": tier.modules,
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][unit_amount]": String(tier.priceInCents),
          "line_items[0][price_data][product_data][name]": `GateTest ${tier.name}`,
          "line_items[0][price_data][product_data][description]": tier.description,
          "line_items[0][quantity]": "1",
          success_url: `${BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${BASE_URL}/checkout/cancel`,
        });

    const session = await stripeRequest(
      "POST",
      "/v1/checkout/sessions",
      params.toString()
    );

    if (session.error) {
      return NextResponse.json(
        { error: (session.error as Record<string, string>).message },
        { status: 400 }
      );
    }

    return NextResponse.json({
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    // Never leak Stripe API internals / stack traces to the browser.
    // Log server-side with full context; return a generic user-facing message.
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[GateTest] Checkout failed:", message);
    return NextResponse.json(
      { error: "Checkout failed. Please try again or contact support." },
      { status: 500 }
    );
  }
}

// GET — return available tiers
export async function GET() {
  return NextResponse.json({
    tiers: Object.entries(TIERS).map(([key, tier]) => ({
      id: key,
      name: tier.name,
      price: `$${(tier.priceInCents / 100).toFixed(0)}`,
      priceInCents: tier.priceInCents,
      modules: tier.modules,
      description: tier.description,
    })),
    paymentModel: "per-scan-upfront",
    note: "Scan tiers are one-time payments charged at checkout — no auto-renew. The Continuous tier is a $49/month subscription (cancel anytime). Refunds discretionary — contact support if a scan fails to start or crashes mid-way.",
  });
}
