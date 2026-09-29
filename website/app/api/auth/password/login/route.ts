/**
 * POST /api/auth/password/login — sign in with email + password.
 *
 * Body (JSON or form): { email, password, next? }
 *
 *   200 { ok: true,  code: "signed_in", next? }  + the customer session cookie
 *   401 { ok: false, code: "bad_credentials" }   — unknown email, no password, wrong password: one answer
 *   403 { ok: false, code: "unverified" }        — right password, address not yet confirmed (link re-sent)
 *   403 { ok: false, code: "csrf" }
 *   404 { ok: false, code: "unavailable" }
 *   429 { ok: false, code: "throttled" }         — 10 failures per email + IP per 15 min (database counter)
 *   503 { ok: false, code: "db_unavailable" }
 *
 * A form post answers 303: to `next` (or /dashboard) with the cookie on
 * success, back to /login/password?error= otherwise. The cookie is signed by
 * the same signCustomerSession the OAuth callbacks use, with the same flags.
 */

import { NextRequest } from "next/server";
import { login } from "@/app/lib/password-auth-core";
import { safeNext } from "@/app/lib/session-gate";
import {
  answer, clientIp, csrfOk, mailer, origin, passwordAuthEnabled, readFields, redirectTo,
  sessionSecret, signInCookie, store, CSRF_FAIL, UNAVAILABLE,
} from "@/app/lib/password-auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE = "/login/password";

// auth-public — this IS the sign-in: the credentials in the body are the
// authentication, and the session cookie is its result.
export async function POST(req: NextRequest) {
  const { fields, form } = await readFields(req);
  const next = safeNext(fields.next ?? null);
  const pages = { ok: PAGE, error: PAGE, next };
  if (!passwordAuthEnabled()) return answer(form, UNAVAILABLE, pages);
  if (!csrfOk(req)) return answer(form, CSRF_FAIL, pages);
  if (!sessionSecret()) return answer(form, { ok: false, status: 503, code: "unavailable" }, pages);
  const mail = mailer();
  try {
    const result = await login({
      store: store(), mail: mail.configured ? mail.send : undefined, origin: origin(),
      email: fields.email, password: fields.password, ip: clientIp(req),
    });
    if (!result.ok || !result.customer) return answer(form, result, pages);
    const cookie = signInCookie(result.customer);
    if (form) {
      const res = redirectTo(next ?? "/dashboard");
      res.headers.set("Set-Cookie", cookie);
      return res;
    }
    return answer(false, result, { ok: PAGE, error: PAGE, next: next ?? "/dashboard" }, cookie);
  } catch (err) {
    console.error("[password-auth] login failed:", err instanceof Error ? err.message : "error");
    return answer(form, { ok: false, status: 503, code: "db_unavailable" }, pages);
  }
}
