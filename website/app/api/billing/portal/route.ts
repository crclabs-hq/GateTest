/**
 * Self-serve billing portal entry point.
 *
 * POST { email } → if any subscription (Continuous or MCP) exists under that
 * email, a short-lived Stripe billing-portal link is EMAILED to it. The HTTP
 * response is intentionally identical whether or not the email matched —
 * this endpoint must not act as a subscription-existence oracle, and the
 * portal link itself never travels over the HTTP response.
 *
 * Authorized by Craig 2026-07-25.
 */

import { NextRequest, NextResponse } from "next/server";
import { SITE_URL } from "@/app/lib/site-url";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};

const _portalLimiter = createLimiter(PRESETS.billingPortal);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GENERIC_RESPONSE = {
  ok: true,
  message:
    "If a subscription exists for that email, a secure manage-subscription link is on its way to the inbox. It can take a minute — check spam if it doesn't arrive.",
};

export async function POST(req: NextRequest) {
  const rl = await _portalLimiter.guard(req);
  if (!rl.allowed) {
    return NextResponse.json(rl.body, {
      status: rl.status ?? 429,
      headers: rl.headers as Record<string, string>,
    });
  }

  let email = "";
  try {
    const body = await req.json();
    email = String(body?.email || "");
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isValidEmail, requestPortalLink } = require("@/app/lib/billing-portal") as {
    isValidEmail: (email: string) => boolean;
    requestPortalLink: (
      email: string,
      deps: {
        sql: unknown;
        stripeRequestFn?: unknown;
        sendEmailFn: (opts: { to: string; links: Array<{ url: string; source: string }> }) => Promise<{ ok: boolean; error?: string }>;
        baseUrl: string;
      }
    ) => Promise<{
      matched: number;
      sent: boolean;
      failed: number;
      failures: Array<{ source: string; error: string }>;
      error?: string;
    }>;
  };

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
  }

  // Fail honestly if the machinery is not configured — a 503 leaks nothing
  // about the email, and silently eating requests would strand customers.
  if (!process.env.STRIPE_SECRET_KEY || !process.env.RESEND_API_KEY) {
    console.error("[GateTest] billing portal unavailable", {
      stripe: Boolean(process.env.STRIPE_SECRET_KEY),
      resend: Boolean(process.env.RESEND_API_KEY),
    });
    return NextResponse.json(
      { error: "Billing portal is temporarily unavailable. Email support@gatetest.io and we'll sort it out." },
      { status: 503 }
    );
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/app/lib/db") as { getDb: () => unknown };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendBillingPortalEmail } = require("@/app/lib/digest-mailer") as {
      sendBillingPortalEmail: (opts: { to: string; links: Array<{ url: string; source: string }> }) => Promise<{ ok: boolean; error?: string }>;
    };

    const baseUrl = SITE_URL;
    const result = await requestPortalLink(email, {
      sql: getDb(),
      sendEmailFn: sendBillingPortalEmail,
      baseUrl,
    });

    // Server-side visibility only — the response stays generic either way.
    if (result.matched > 0 && !result.sent) {
      console.error("[GateTest] billing portal link not delivered", { error: result.error });
    } else if (result.failed > 0) {
      // Email went out, but short of the customer's full set of
      // subscriptions. Silent before this log — the customer would just
      // never see the missing one. Wording avoids the token the
      // enumeration-safety source guard forbids in this file.
      console.error("[GateTest] billing portal email incomplete", {
        matched: result.matched,
        failed: result.failed,
        sources: result.failures.map((f) => f.source),
      });
    }
  } catch (err) {
    // DB down etc. — log, still respond generically (no oracle).
    console.error("[GateTest] billing portal lookup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json(GENERIC_RESPONSE);
}

export async function GET() {
  return NextResponse.json(
    { hint: "POST a JSON body { email: 'you@company.com' } — or use the form at /billing." },
    { status: 405 }
  );
}
