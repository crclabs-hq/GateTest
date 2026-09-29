/**
 * The HTTP glue shared by the /api/auth/password/* routes: body parsing for
 * both plain HTML forms and JSON, the same-origin (CSRF) check, the session
 * cookie with EXACTLY the flags the OAuth callbacks set, and the two answer
 * shapes — a 303 back to the page (form post, works with JavaScript off) or
 * a JSON body (fetch). The rules themselves live in password-auth-core.js.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  CUSTOMER_COOKIE_NAME,
  CUSTOMER_MAX_AGE_SECONDS,
  signCustomerSession,
  verifyCustomerSession,
} from "./customer-session";
import { PASSWORD_AUTH_ENABLED } from "./auth-features";
import { checkSameOrigin, sessionLogin } from "./password-auth-core";
import { createStore } from "./password-auth-store";
import { getDb } from "./db";
// CJS modules shared with the CLI / tests, imported the way app/login/page.tsx
// imports session-gate.js (allowJs; Next handles the interop).
import { siteUrl } from "./site-url.js";
import { deliver, mailConfigured } from "./mail-transport.js";
import { extractClientIp } from "@lib/rate-limit";

export type Fields = Record<string, string>;

export interface FlowResult {
  ok: boolean;
  status: number;
  code: string;
  customer?: { id: string; email: string; github_login: string | null };
  email?: string;
  delivered?: boolean | null;
}

export function passwordAuthEnabled(): boolean {
  return PASSWORD_AUTH_ENABLED === true;
}

export function sessionSecret(): string {
  return process.env.SESSION_SECRET || "";
}

/** The signed-in customer's email from the session cookie, or null. */
export async function currentSessionEmail(): Promise<string | null> {
  const secret = sessionSecret();
  if (!secret) return null;
  const cookieStore = await cookies();
  const session = verifyCustomerSession(cookieStore.get(CUSTOMER_COOKIE_NAME)?.value, secret);
  if (!session || typeof session.e !== "string" || !session.e.includes("@")) return null;
  return session.e.trim().toLowerCase();
}

/**
 * Read the fields of a JSON or form-encoded POST. `form` says which, so the
 * answer can be a redirect (form) or JSON (fetch). Values are strings;
 * anything else is dropped. The password is read and passed on, never
 * copied anywhere else.
 */
export async function readFields(req: NextRequest): Promise<{ fields: Fields; form: boolean }> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  const fields: Fields = {};
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    try {
      const fd = await req.formData();
      for (const [k, v] of fd.entries()) if (typeof v === "string") fields[k] = v;
    } catch {
      // error-ok — an unreadable form is an empty form; the flow answers bad_request
    }
    return { fields, form: true };
  }
  try {
    const body = (await req.json()) as unknown;
    if (body && typeof body === "object") {
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) if (typeof v === "string") fields[k] = v;
    }
  } catch {
    // error-ok — a bad JSON body is an empty body
  }
  return { fields, form: false };
}

/** Same-origin check on every POST. Fails closed when no browser header is present. */
export function csrfOk(req: NextRequest): boolean {
  const h = req.headers;
  return checkSameOrigin(
    {
      origin: h.get("origin"),
      secFetchSite: h.get("sec-fetch-site"),
      host: h.get("host"),
      forwardedHost: h.get("x-forwarded-host"),
      forwardedProto: h.get("x-forwarded-proto"),
    },
    siteUrl()
  ).ok;
}

export function clientIp(req: NextRequest): string {
  return extractClientIp(req);
}

/** The exact Set-Cookie the GitHub / Google callbacks issue. */
export function sessionCookieHeader(token: string): string {
  const isProduction = process.env.NODE_ENV === "production";
  return [
    `${CUSTOMER_COOKIE_NAME}=${token}`,
    `Max-Age=${CUSTOMER_MAX_AGE_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(isProduction ? ["Secure"] : []),
  ].join("; ");
}

export function signInCookie(customer: { email: string; github_login: string | null }): string {
  return sessionCookieHeader(signCustomerSession(sessionLogin(customer), customer.email, sessionSecret()));
}

export function store() {
  return createStore(getDb());
}

/** The one mail transport; a not-configured provider is reported, never thrown. */
export function mailer() {
  return {
    configured: mailConfigured(),
    send: (msg: { to: string; subject: string; text?: string; html?: string }) => deliver(msg),
  };
}

export function origin(): string {
  return siteUrl();
}

function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(path, siteUrl());
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

/** A 303 to a page on the canonical origin, with the code in the query. */
export function redirectTo(path: string, params: Record<string, string | null | undefined> = {}): NextResponse {
  const res = NextResponse.redirect(withQuery(path, params), 303);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * Answer a flow result. Form posts go back to a page with `?error=` or
 * `?notice=` (plus `next` when there is one); fetch callers get JSON.
 */
export function answer(
  form: boolean,
  result: FlowResult,
  pages: { ok: string; error: string; next?: string | null; extra?: Record<string, string> },
  cookie?: string
): NextResponse {
  if (form) {
    const res = result.ok
      ? redirectTo(pages.ok, { notice: result.code, next: pages.next, ...(pages.extra || {}) })
      : redirectTo(pages.error, { error: result.code, next: pages.next, ...(pages.extra || {}) });
    if (cookie) res.headers.set("Set-Cookie", cookie);
    return res;
  }
  const body: Record<string, unknown> = { ok: result.ok, code: result.code };
  if (result.ok && pages.next) body.next = pages.next;
  const res = NextResponse.json(body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  if (cookie) res.headers.set("Set-Cookie", cookie);
  return res;
}

export function fail(form: boolean, status: number, code: string, errorPage: string, next?: string | null): NextResponse {
  return answer(form, { ok: false, status, code }, { ok: errorPage, error: errorPage, next });
}

export const CSRF_FAIL: FlowResult = { ok: false, status: 403, code: "csrf" };
export const UNAVAILABLE: FlowResult = { ok: false, status: 404, code: "unavailable" };
