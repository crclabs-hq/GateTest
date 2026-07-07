/**
 * Public config-readiness probe — GET /api/status
 *
 * The "why isn't the site going?" endpoint. Unlike /api/admin/health (which
 * needs an admin session + makes real network calls, so it's useless when auth
 * itself is misconfigured), this endpoint:
 *   - needs NO auth, NO database, NO session, NO network — it can't hang and
 *     works even when everything else is broken;
 *   - returns ONLY booleans and variable NAMES — never a secret value, never a
 *     key, never a connection string.
 *
 * It answers one question: is the deployed environment configured well enough
 * for the core user flows (scan, auth, payment) to work? If `ready` is false,
 * `missing` lists exactly which required vars to set in the Vercel dashboard.
 *
 * Info exposure is limited to "is variable X currently set" — non-sensitive and
 * transient. If you want it locked down later, set GATETEST_STATUS_TOKEN and
 * pass ?token=... (enforced below only when that var is set).
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Vars whose absence BREAKS a core user flow (scan / auth / payment).
const REQUIRED: Array<{ name: string; why: string }> = [
  { name: "ANTHROPIC_API_KEY", why: "AI review, auto-fix, and the watch cron all throw without it" },
  { name: "DATABASE_URL", why: "no scan results, sessions, customers, or API keys persist" },
  { name: "SESSION_SECRET", why: "customer + admin login (OAuth) fails to encrypt sessions" },
  { name: "STRIPE_SECRET_KEY", why: "checkout / payment cannot be created" },
  { name: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", why: "Stripe.js won't load on the checkout page" },
  { name: "NEXT_PUBLIC_BASE_URL", why: "redirect + callback URLs resolve wrong" },
];

// Vars whose absence DEGRADES a feature but doesn't break the core flow.
const IMPORTANT: Array<{ name: string; why: string }> = [
  { name: "STRIPE_WEBHOOK_SECRET", why: "Stripe webhooks can't be verified (subscription lifecycle)" },
  { name: "GITHUB_CLIENT_ID", why: "customer 'Sign in with GitHub' disabled" },
  { name: "GITHUB_CLIENT_SECRET", why: "pairs with GITHUB_CLIENT_ID" },
  { name: "GATETEST_ADMIN_PASSWORD", why: "admin console password login disabled" },
  { name: "CRON_SECRET", why: "background cron jobs (watch tick, scan worker) exit early in prod" },
];

// Purely optional integrations.
const OPTIONAL = [
  "GLUECRON_BASE_URL", "GLUECRON_API_TOKEN",
  "SLACK_WEBHOOK_URL", "RESEND_API_KEY",
  "SENTRY_AUTH_TOKEN", "DATADOG_API_KEY", "ROLLBAR_READ_TOKEN",
  "GATETEST_FIX_MODEL", "CONTINUOUS_AI_BUDGET_USD",
];

function isSet(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

export async function GET(req: NextRequest) {
  // Optional lock: only enforced if the operator sets GATETEST_STATUS_TOKEN.
  const gate = process.env.GATETEST_STATUS_TOKEN;
  if (gate) {
    const token = new URL(req.url).searchParams.get("token") || "";
    if (token !== gate) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const missing = REQUIRED.filter((v) => !isSet(v.name));
  const importantMissing = IMPORTANT.filter((v) => !isSet(v.name));
  const optionalMissing = OPTIONAL.filter((n) => !isSet(n));

  // Stripe mode — a live site running test keys means payments silently fail on
  // real cards (ROADMAP #3). This is a common "not going" cause.
  const stripeKey = process.env.STRIPE_SECRET_KEY || "";
  const stripeMode = stripeKey.startsWith("sk_live_")
    ? "live"
    : stripeKey.startsWith("sk_test_")
      ? "test"
      : stripeKey
        ? "unknown"
        : "unset";
  const inProduction =
    process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
  const stripeWarning =
    inProduction && stripeMode === "test"
      ? "Stripe is in TEST mode in production — real customer cards will fail. Swap to sk_live_ keys."
      : null;

  const ready = missing.length === 0;

  return NextResponse.json(
    {
      ready,
      // The headline: what to fix, by name, no values.
      missing_required: missing.map((v) => ({ name: v.name, why: v.why })),
      missing_important: importantMissing.map((v) => ({ name: v.name, why: v.why })),
      missing_optional: optionalMissing,
      stripe: { mode: stripeMode, warning: stripeWarning },
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
      // Present-count so a healthy deploy reads cleanly.
      summary: {
        required_set: REQUIRED.length - missing.length,
        required_total: REQUIRED.length,
        important_set: IMPORTANT.length - importantMissing.length,
        important_total: IMPORTANT.length,
      },
      note: "Booleans + variable names only — no secret values are ever returned.",
      generated_at: new Date().toISOString(),
    },
    { status: ready ? 200 : 503 },
  );
}
