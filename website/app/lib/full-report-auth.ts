/**
 * Server-side authority for whether a scan request may receive the full
 * (unpaywalled) report on the free web/wp scan endpoints.
 *
 * NEVER trust a client-supplied `fullReport: true` — the four routes that
 * consume this (web/scan, wp/scan, and their SSE `/stream` twins) used to
 * do exactly that: `fullReport = Boolean(body.fullReport)`, no server-side
 * check at all. Any anonymous caller could send `{fullReport: true}` and
 * get the paid tier for free. Found during a 2026-07-01 review (see
 * gatetest-questions.txt session 38 log) — the streaming variants also
 * didn't even call `isAdminRequest`, so the admin bypass silently didn't
 * work there either.
 *
 * This is the ONLY function allowed to decide fullReport=true. It checks,
 * in order:
 *   (a) admin request — via the existing httpOnly-cookie / X-Admin-Token
 *       mechanism in admin-auth.ts (which itself gates on
 *       GATETEST_ADMIN_PASSWORD; fails closed if that env var is unset).
 *   (b) a real paid Stripe Checkout Session — the client passes the
 *       `sessionId` it got back from Stripe Checkout, we look it up
 *       server-side and only trust `payment_status === "paid"` from
 *       Stripe's own response, never anything the client asserts.
 * Anything else — no sessionId, an unpaid/expired session, a Stripe API
 * error, STRIPE_SECRET_KEY unset — resolves to `false`. Fail closed, not
 * open, same posture as admin-auth.ts.
 *
 * The actual yes/no decision lives in full-report-auth-core.js (plain JS,
 * unit-tested via tests/full-report-auth.test.js) — this file is just the
 * Next.js-specific wiring (reading the request, the real Stripe fetch).
 */

import type { NextRequest } from "next/server";
import { isAdminRequest } from "@/app/lib/admin-auth";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveFullReportAccess: resolveCore, defaultFetchStripeSession } = require("@/app/lib/full-report-auth-core.js");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";

export interface FullReportRequestBody {
  fullReport?: boolean;
  /** Stripe Checkout Session ID returned to the client after a successful checkout. */
  sessionId?: string;
}

/**
 * Resolve whether THIS request is allowed to receive the full report.
 * Never derives `true` from anything the client asserts about itself.
 */
export async function resolveFullReportAccess(
  req: NextRequest,
  body: FullReportRequestBody
): Promise<boolean> {
  return resolveCore({
    isAdmin: isAdminRequest(req),
    sessionId: body.sessionId,
    stripeSecretKey: STRIPE_SECRET_KEY,
    fetchStripeSession: defaultFetchStripeSession,
  });
}
