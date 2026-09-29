/**
 * Config-readiness probe — GET /api/status
 *
 * The "why isn't the site going?" endpoint, for operators. Unlike
 * /api/admin/health (which needs an admin session + makes real network
 * calls, so it's useless when auth itself is misconfigured), this endpoint
 * for an AUTHENTICATED caller:
 *   - needs NO session cookie, NO network beyond the queue-depth block
 *     (2026-08-18 audit advancement #11, which races the database against a
 *     2s timeout and degrades to an error string — never a hang, never a 500);
 *   - returns booleans and variable NAMES — never a secret value, never a
 *     key, never a connection string.
 *
 * It answers one question: is the deployed environment configured well enough
 * for the core user flows (scan, auth, payment) to work? If `ready` is false,
 * `missing_required` lists exactly which required vars to set.
 *
 * GT-02 (outside reviewer, 2026-09-26): this used to be the answer for EVERY
 * caller, unauthenticated — a reconnaissance map of exactly which secrets a
 * live deployment is missing, by name, with the hint of what depends on each
 * one. Operator detail (variable names, Stripe mode, queue depth, platform
 * pointing) now requires an admin session OR `Authorization: Bearer
 * $CRON_SECRET` (see isAuthorisedTick, shared with scan/worker/tick). Every
 * other caller gets `{ ok, healthy, version, commit, checked_at }` — enough
 * to know the deploy is up and which commit is live, nothing an attacker can
 * act on. GATETEST_STATUS_TOKEN (below) still exists as a total lock in
 * front of BOTH bodies, for an operator who wants /api/status dark entirely.
 */

import { NextRequest, NextResponse } from "next/server";
import buildInfo from "@/app/data/build-info.json";
import { isAdminRequest } from "@/app/lib/admin-auth";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { findPlaceholders } = require("@/app/lib/env-placeholder");
// Which brand the platform variables are pointed at (Vapron → Tallrig rename,
// Craig 2026-09-14): names only, so the readiness card shows a flipped
// box as flipped. Requested by the platform side.
const { platformPointing } = require("@/app/lib/platform-config");
// Same authorisation the worker tick route uses (scan/worker/tick/route.ts)
// — imported, not re-implemented, so "who may see operator detail" has one
// definition (Doctrine #4).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isAuthorisedTick } = require("@/app/lib/scan-worker");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The catalogue — REQUIRED / IMPORTANT / OPTIONAL / ALIASES and isSet() —
// lives in app/lib/env-catalogue.js since 2026-09-30, so plain CommonJS (the
// admin secrets panel, the test suite, the catalogue drift test) can read the
// same definition this route answers from (Doctrine #4). REQUIRED and
// IMPORTANT stay exported here because the admin Overview dashboard's
// secrets checklist (#691) imports them from this module.
const catalogue = require("@/app/lib/env-catalogue") as {
  REQUIRED: Array<{ name: string; why: string }>;
  IMPORTANT: Array<{ name: string; why: string }>;
  OPTIONAL: string[];
  isSet: (name: string, env: Record<string, string | undefined>) => boolean;
};

// Vars whose absence BREAKS a core user flow (scan / auth / payment).
export const REQUIRED: Array<{ name: string; why: string }> = catalogue.REQUIRED;
// Vars whose absence DEGRADES a feature but doesn't break the core flow.
export const IMPORTANT: Array<{ name: string; why: string }> = catalogue.IMPORTANT;
// Purely optional integrations.
const OPTIONAL: string[] = catalogue.OPTIONAL;

// A variable holding documentation filler is NOT set — catalogue.isSet()
// counts a value only when inspectEnvValue() says it is real, so `ready` is
// never a presence check again (the 2026-08-31 GATETEST_PRIVATE_KEY incident;
// see app/lib/env-catalogue.js).
function isSet(name: string): boolean {
  return catalogue.isSet(name, process.env as Record<string, string | undefined>);
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

  // GT-02 (outside reviewer, 2026-09-26, unauthenticated crawl of gatetest.io):
  // this route used to hand ANY caller the names of missing secrets, the
  // "why" hints, Stripe mode, queue depth and platform.pointed_at — a
  // reconnaissance map. Operator detail below is now gated the same way the
  // worker tick accepts a trusted caller (scan/worker/tick/route.ts): an
  // admin session, or `Authorization: Bearer $CRON_SECRET` (the same secret
  // the tick routes already require). Anyone else gets a minimal, honest
  // body — no env var name, no provider, no queue count, no platform
  // pointing ever appears in it.
  const authHeader = req.headers.get("authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const cronHeader = req.headers.get("x-vercel-cron-secret") || bearer || null;
  const authed = isAuthorisedTick({ cronHeader, isAdmin: isAdminRequest(req), env: process.env });

  if (!authed) {
    // Same REQUIRED list, same isSet() validity check as the full body below
    // — only the verdict is exposed, never which variable or why.
    const healthy = REQUIRED.every((v) => isSet(v.name));
    return NextResponse.json(
      {
        ok: true,
        healthy,
        version: process.env.APP_VERSION ?? buildInfo.version ?? "dev",
        commit: process.env.GIT_COMMIT ?? buildInfo.commit ?? "unknown",
        checked_at: new Date().toISOString(),
      },
      { status: healthy ? 200 : 503 },
    );
  }

  // Everything below is the authenticated, full operator body. Vendor-named variables are reported under a neutral
  // label so the response never says which AI provider the engine uses; the
  // entry (and its `why`) stays so the readiness probe still fails on it.
  const publicName = (name: string) => (/ANTHROPIC|OPENAI|CLAUDE/i.test(name) ? "AI_PROVIDER_API_KEY" : name);
  const missing = REQUIRED.filter((v) => !isSet(v.name)).map((v) => ({ name: publicName(v.name), why: v.why }));
  const importantMissing = IMPORTANT.filter((v) => !isSet(v.name)).map((v) => ({ name: publicName(v.name), why: v.why }));
  const optionalMissing = OPTIONAL.filter((n) => !isSet(n)).map(publicName);

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
      // Brand each platform variable resolves from (tallrig / legacy),
      // independent of one another — no values, no pre-rename names.
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
