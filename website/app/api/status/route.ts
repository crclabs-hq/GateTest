/**
 * Public config-readiness probe — GET /api/status
 *
 * The "why isn't the site going?" endpoint. Unlike /api/admin/health (which
 * needs an admin session + makes real network calls, so it's useless when auth
 * itself is misconfigured), this endpoint:
 *   - needs NO auth, NO session, NO network — it can't hang and works even
 *     when everything else is broken. The one exception is the queue-depth
 *     block (2026-08-18 audit advancement #11), which races the database
 *     against a 2s timeout and degrades to an error string — never a hang,
 *     never a 500;
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { findPlaceholders, inspectEnvValue } = require("@/app/lib/env-placeholder");
// Which brand the platform variables are pointed at (Vapron → Tallrig rename,
// Craig 2026-09-14): names only, so the readiness card shows a flipped
// box as flipped. Requested by the platform side.
const { platformPointing } = require("@/app/lib/platform-config");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Vars whose absence BREAKS a core user flow (scan / auth / payment).
const REQUIRED: Array<{ name: string; why: string }> = [
  { name: "ANTHROPIC_API_KEY", why: "AI review, auto-fix, and the watch cron all throw without it" },
  { name: "DATABASE_URL", why: "no scan results, sessions, customers, or API keys persist" },
  { name: "SESSION_SECRET", why: "customer + admin login (OAuth) fails to encrypt sessions" },
  { name: "STRIPE_SECRET_KEY", why: "checkout / payment cannot be created" },
  // No NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: checkout is Stripe-hosted (a
  // server-created session + redirect); nothing loads Stripe.js, so nothing
  // reads the publishable key (envVars, 2026-09-13).
  { name: "NEXT_PUBLIC_BASE_URL", why: "redirect + callback URLs resolve wrong" },
];

// Vars whose absence DEGRADES a feature but doesn't break the core flow.
const IMPORTANT: Array<{ name: string; why: string }> = [
  { name: "STRIPE_WEBHOOK_SECRET", why: "Stripe webhooks can't be verified (subscription lifecycle)" },
  { name: "GITHUB_CLIENT_ID", why: "customer 'Sign in with GitHub' disabled" },
  { name: "GITHUB_CLIENT_SECRET", why: "pairs with GITHUB_CLIENT_ID" },
  { name: "GOOGLE_CLIENT_ID", why: "customer 'Continue with Google' returns 503 (login modal button dead)" },
  { name: "GOOGLE_CLIENT_SECRET", why: "pairs with GOOGLE_CLIENT_ID — needed for the Google token exchange" },
  { name: "GATETEST_ADMIN_PASSWORD", why: "admin console password login disabled ('Admin access is not configured')" },
  { name: "CRON_SECRET", why: "background cron jobs (watch tick, scan worker) exit early in prod" },
  { name: "RESEND_API_KEY", why: "MCP $29/mo API-key emails can't send — subscriber pays, key never arrives (webhook 500s until set)" },
  { name: "TALLRIG_BASE_URL", why: "runtime-scan dispatch to the Tallrig worker tier disabled — /web and /wp scans ship static probes only (VAPRON_BASE_URL is the pre-rename alias)" },
  { name: "TALLRIG_API_TOKEN", why: "pairs with TALLRIG_BASE_URL — Tallrig rejects unauthenticated dispatch (VAPRON_API_TOKEN is the pre-rename alias)" },
  { name: "TALLRIG_DISPATCH_SECRET", why: "pairs with TALLRIG_BASE_URL — signs outbound jobs and verifies Tallrig's result callbacks (VAPRON_DISPATCH_SECRET is the pre-rename alias, CRONTECH_DISPATCH_SECRET the legacy one)" },
  { name: "GATETEST_RECIPE_STORE_TOKEN", why: "fix-recipe WRITES (PUT /api/recipes) are refused with 503 until set — the flywheel cannot learn from CLI fixes; must equal the token CLI users set as GATETEST_RECIPE_STORE_TOKEN" },
  // ── Gluecron: the PREFERRED git host (Craig 2026-08-29 — customers may use
  // GitHub, but we steer them to Gluecron). These were classified "purely
  // optional" while GitHub was the only door, which is no longer true: this
  // is now the host we actively want customers on, so its ingress going dark
  // has to be visible here. Confirmed dead in production on 2026-08-29 —
  // POST /api/events/push returned 503 and nothing in this probe said so.
  { name: "GLUECRON_EMITTER_SECRET", why: "the Gluecron push ingress (POST /api/events/push) fails closed with 503 — every push from our PREFERRED git host is rejected, so no scan is ever queued for a Gluecron customer" },
  { name: "GLUECRON_BASE_URL", why: "Gluecron API base URL (defaults to https://gluecron.com) — set it explicitly when pointing at a non-default deployment" },
  { name: "GLUECRON_API_TOKEN", why: "no Gluecron PAT means repo reads fall back to a GitHub token, and private Gluecron repos cannot be scanned at all" },
  // ── The GitHub App credentials. Previously listed ONLY in the extras array
  // handed to findPlaceholders, so they could be reported as fake while no
  // classified list contained them — nothing could act on the finding.
  // IMPORTANT, not REQUIRED, and deliberately so: a Gluecron-only deployment
  // legitimately has no GitHub App, and flipping `ready` false there would be
  // the same over-correction this file just fixed in the other direction.
  { name: "GATETEST_APP_ID", why: "GitHub App JWT cannot be minted — commit statuses, PR comments, and the App-installed fix path all fail" },
  { name: "GATETEST_PRIVATE_KEY", why: "pairs with GATETEST_APP_ID. Confirmed dead in production 2026-08-31: the pasted documentation example was still in place, GitHub returned 401 Bad credentials, and EVERY private-repo scan 502'd on both hosts" },
];

// Purely optional integrations.
const OPTIONAL = [
  "SLACK_WEBHOOK_URL",
  "GITLAB_CLIENT_ID", "GITLAB_CLIENT_SECRET",
  "SENTRY_AUTH_TOKEN", "DATADOG_API_KEY", "ROLLBAR_READ_TOKEN",
  "GATETEST_FIX_MODEL", "CONTINUOUS_AI_BUDGET_USD",
];

// Older env names still honored by the code that reads the canonical var
// (vapron-dispatch.js reads TALLRIG_* → VAPRON_* → CRONTECH_* through
// platform-config). A var counts as set when either the canonical name or
// any alias is set — otherwise this probe would report "missing" for a
// deployment that actually works. TALLRIG_* is canonical since the rename
// (Craig 2026-09-14); VAPRON_* is the pre-rename name a not-yet-flipped box
// still carries, CRONTECH_* the one before that.
const ALIASES: Record<string, string[]> = {
  TALLRIG_BASE_URL: ["VAPRON_BASE_URL", "CRONTECH_BASE_URL"],
  TALLRIG_API_TOKEN: ["VAPRON_API_TOKEN", "CRONTECH_API_TOKEN"],
  TALLRIG_DISPATCH_SECRET: ["VAPRON_DISPATCH_SECRET", "CRONTECH_DISPATCH_SECRET"],
};

// A variable holding documentation filler is NOT set. It is worse than unset:
// unset fails loudly at the first call, filler sails past every presence check
// and fails at the credential exchange, where nothing is watching.
//
// This probe already DETECTED the fake GATETEST_PRIVATE_KEY and listed it under
// invalid_placeholders — and then computed `ready` from presence alone, so it
// answered `ready: true` / HTTP 200 for weeks while GitHub App auth returned
// 401 and every private-repo scan 502'd. The detection was never wired to the
// verdict. Fixing the verdict, not adding another field nobody reads.
function isSet(name: string): boolean {
  const candidates = [name, ...(ALIASES[name] ?? [])];
  return candidates.some((n) => {
    const v = process.env[n];
    if (typeof v !== "string" || v.trim().length === 0) return false;
    return inspectEnvValue(n, v).ok;
  });
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

  // PRESENT-BUT-FAKE. `isSet` only asks "length > 0", which is how
  // GATETEST_PRIVATE_KEY sat in production holding the literal documentation
  // example ("-----BEGIN RSA PRIVATE KEY-----\n...(all the base64 lines)...")
  // while every dashboard reported green and GitHub App auth was dead.
  // A variable that is set to filler is worse than one that is unset, because
  // every other guard here is looking for absence.
  const placeholders = findPlaceholders(
    [
      ...REQUIRED.map((v) => v.name),
      ...IMPORTANT.map((v) => v.name),
      ...OPTIONAL,
      // Not in the lists above, but the credential whose fake value caused the
      // incident — the App auth path fails silently without it.
      "GATETEST_PRIVATE_KEY",
      "GATETEST_APP_ID",
      "GITHUB_TOKEN",
      "GITHUB_WEBHOOK_SECRET",
    ],
    process.env as Record<string, string | undefined>,
  );

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

  // Queue posture (advancement #11: "queue depth on /api/status") — the
  // number that says whether pushes are actually being scanned. Bounded:
  // the DB read races a 2s timeout so this probe keeps its can't-hang
  // promise; any failure degrades to an error string.
  let queue: Record<string, unknown>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/app/lib/db") as { getDb: () => unknown };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const queueStore = require("@/app/lib/scan-queue-store") as {
      getQueueStats: (sql: unknown) => Promise<Record<string, unknown>>;
    };
    queue = (await Promise.race([
      queueStore.getQueueStats(getDb()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("queue stats timed out (2s)")), 2000)),
    ])) as Record<string, unknown>;
  } catch (err) {
    queue = { error: err instanceof Error ? err.message : "queue stats unavailable" };
  }

  return NextResponse.json(
    {
      ready,
      queue,
      // The headline: what to fix, by name, no values.
      missing_required: missing.map((v) => ({ name: v.name, why: v.why })),
      missing_important: importantMissing.map((v) => ({ name: v.name, why: v.why })),
      // Set, but not real. Never echoes the value — only the name and why it
      // cannot be genuine.
      invalid_placeholders: placeholders,
      missing_optional: optionalMissing,
      stripe: { mode: stripeMode, warning: stripeWarning },
      // Brand each platform variable resolves from (tallrig / vapron /
      // crontech), independent of one another — no values.
      platform: platformPointing(process.env),
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
