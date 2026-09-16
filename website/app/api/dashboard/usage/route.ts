/**
 * GET /api/dashboard/usage[?from=&to=] — the signed-in customer's usage meter.
 *
 * The dashboard twin of GET /api/v1/usage. Same report, same ledger, same
 * route logic (usage-ledger.js handleUsageRequest — one definition of the
 * window parsing, the account scoping and the 400/403/503 shapes); only the
 * door differs: /api/v1/usage takes a gt_live_ REST key, this route takes the
 * `gatetest_customer` OAuth session cookie the dashboard already relies on.
 *
 * Identity comes from the VERIFIED session payload (`session.e`) — never
 * from the query string or a body — and the ledger is queried under exactly
 * one key: accountKeyForEmail(session.e). That is the key every surface
 * writes under when it knows the customer's e-mail, so the web page and the
 * CLI show the same numbers for the same customer.
 *
 * Failure is loud, not zero: no session → 401, no database → 503 with
 * code DB_UNAVAILABLE. The page renders those as "not checked"; it never
 * shows $0.00 for a ledger it could not read (Doctrine #1).
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/app/lib/db";
import {
  getOAuthConfig,
  verifyCustomerSession,
  CUSTOMER_COOKIE_NAME,
} from "@/app/lib/customer-session";

const{ createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{
      allowed: boolean;
      status?: number;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};

const{ handleUsageRequest } = require("@/app/lib/usage-ledger") as {
  handleUsageRequest: (args: {
    auth: { ok: true; key: { id: string; customer_email: string | null } };
    searchParams: URLSearchParams;
    getSql: () => ReturnType<typeof getDb>;
  }) => Promise<{ status: number; body: Record<string, unknown> }>;
};

const limiter = createLimiter(PRESETS.dashboard);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: NextRequest) {
  const rl = await limiter.guard(req);
  if (!rl.allowed) {
    return NextResponse.json(rl.body, {
      status: rl.status ?? 429,
      headers: { ...(rl.headers as Record<string, string>), ...NO_STORE },
    });
  }

  // 1. Identity — the verified session cookie, nothing else.
  const oauth = getOAuthConfig();
  if (!oauth.ok || !oauth.config) {
    return NextResponse.json(
      { error: "Sign-in is not configured", code: "AUTH_UNAVAILABLE" },
      { status: 503, headers: NO_STORE }
    );
  }
  const cookieStore = await cookies();
  const token = cookieStore.get(CUSTOMER_COOKIE_NAME)?.value;
  const session = verifyCustomerSession(token, oauth.config.sessionSecret);
  if (!session || typeof session.e !== "string" || !session.e.includes("@")) {
    return NextResponse.json(
      { error: "Sign in to view your usage", code: "AUTH_REQUIRED" },
      { status: 401, headers: NO_STORE }
    );
  }

  // 2. The report — the same helper /api/v1/usage runs, handed the session
  //    identity as a key with no id: accountKeysForApiKey then resolves to
  //    exactly [accountKeyForEmail(e)], the customer's cross-surface key.
  const out = await handleUsageRequest({
    auth: { ok: true, key: { id: "", customer_email: session.e } },
    searchParams: req.nextUrl.searchParams,
    getSql: () => getDb(),
  });

  return NextResponse.json(
    out.status === 200 ? { ...out.body, account: { login: session.u, email: session.e } } : out.body,
    { status: out.status, headers: NO_STORE }
  );
}
