/**
 * /api/account/notifications — the customer's "Email me release notes"
 * preference (`customers.release_emails_opt_in`, default FALSE — opt-IN).
 *
 * GET   — current state for the signed-in customer (session cookie).
 * POST  — one of two shapes:
 *   { optIn: boolean }  — signed-in customer toggling their own preference.
 *   { token: string }   — the signed one-click unsubscribe link from a
 *                          release e-mail; no session required. This is the
 *                          "signed token route in the same style" the
 *                          release-notifier lib builds (there was no
 *                          existing digest-unsubscribe mechanism to reuse —
 *                          the weekly digest's own unsubscribeUrl has always
 *                          pointed at this not-yet-built page).
 *
 * Identity for the session path comes from the VERIFIED session cookie,
 * never the request body — same rule as /api/dashboard.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import { getDb } from "@/app/lib/db";
import {
  getOAuthConfig,
  verifyCustomerSession,
  CUSTOMER_COOKIE_NAME,
} from "@/app/lib/customer-session";

const { ensureSchema, verifyUnsubscribeToken } = require("@/app/lib/release-notifier");

export const dynamic = "force-dynamic";

async function sessionEmail(): Promise<string | null> {
  const oauth = getOAuthConfig();
  if (!oauth.ok || !oauth.config) return null;
  const cookieStore = await cookies();
  const token = cookieStore.get(CUSTOMER_COOKIE_NAME)?.value;
  const session = verifyCustomerSession(token, oauth.config.sessionSecret);
  if (!session || typeof session.e !== "string" || !session.e.includes("@")) return null;
  return session.e.trim().toLowerCase();
}

export async function GET() {
  const email = await sessionEmail();
  if (!email) {
    return NextResponse.json({ error: "Sign in to manage notification settings" }, { status: 401 });
  }
  try {
    const sql = getDb();
    await ensureSchema(sql);
    const rows = await sql`SELECT release_emails_opt_in FROM customers WHERE LOWER(email) = ${email} LIMIT 1`;
    const optIn = Boolean(rows && rows[0] && rows[0].release_emails_opt_in);
    return NextResponse.json({ email, releaseEmailsOptIn: optIn });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "database not configured" },
      { status: 503 }
    );
  }
}

export async function POST(req: NextRequest) {
  let body: { optIn?: boolean; token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // One-click unsubscribe link — no login required, identity comes from the
  // signed token (mirrors the release-notifier lib's own verify function).
  if (typeof body.token === "string" && body.token) {
    const email = verifyUnsubscribeToken(body.token);
    if (!email) {
      return NextResponse.json({ error: "Invalid or expired unsubscribe link" }, { status: 400 });
    }
    try {
      const sql = getDb();
      await ensureSchema(sql);
      const id = crypto.randomUUID();
      await sql`INSERT INTO customers (id, email, release_emails_opt_in)
        VALUES (${id}, ${email}, FALSE)
        ON CONFLICT (email) DO UPDATE SET release_emails_opt_in = FALSE`;
      return NextResponse.json({ ok: true, email, releaseEmailsOptIn: false });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "database not configured" },
        { status: 503 }
      );
    }
  }

  // Signed-in customer toggling their own preference.
  const email = await sessionEmail();
  if (!email) {
    return NextResponse.json({ error: "Sign in to manage notification settings" }, { status: 401 });
  }
  if (typeof body.optIn !== "boolean") {
    return NextResponse.json({ error: "optIn (boolean) is required" }, { status: 400 });
  }
  try {
    const sql = getDb();
    await ensureSchema(sql);
    const id = crypto.randomUUID();
    await sql`INSERT INTO customers (id, email, release_emails_opt_in)
      VALUES (${id}, ${email}, ${body.optIn})
      ON CONFLICT (email) DO UPDATE SET release_emails_opt_in = ${body.optIn}`;
    return NextResponse.json({ ok: true, email, releaseEmailsOptIn: body.optIn });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "database not configured" },
      { status: 503 }
    );
  }
}
