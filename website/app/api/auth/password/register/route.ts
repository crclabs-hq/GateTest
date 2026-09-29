/**
 * POST /api/auth/password/register — start an email + password account.
 *
 * Body (JSON or form): { email, password, password_confirm?, next? }
 *
 *   200 { ok: true,  code: "verify_sent" }     — always, known address or not
 *   400 { ok: false, code: email_invalid | password_short | password_long | password_common | password_mismatch }
 *   403 { ok: false, code: "csrf" }             — not a same-origin request
 *   404 { ok: false, code: "unavailable" }      — PASSWORD_AUTH_ENABLED is off
 *   503 { ok: false, code: "mail_unavailable" | "db_unavailable" }
 *
 * A form post answers 303 to /login/password/register?notice=|error= instead.
 * The password is not active until the emailed link is clicked
 * (password-auth-core.js register / verify). Rules live in the core; this
 * file parses and answers.
 */

import { NextRequest } from "next/server";
import { register } from "@/app/lib/password-auth-core";
import { safeNext } from "@/app/lib/session-gate";
import {
  answer, csrfOk, mailer, origin, passwordAuthEnabled, readFields, store,
  CSRF_FAIL, UNAVAILABLE,
} from "@/app/lib/password-auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE = "/login/password/register";

// auth-public — creating an account is, by definition, done without one. The
// address is only ever confirmed by a link sent to it; the answer is the same
// whether or not the address is already known (no enumeration).
export async function POST(req: NextRequest) {
  const { fields, form } = await readFields(req);
  const next = safeNext(fields.next ?? null);
  const pages = { ok: PAGE, error: PAGE, next };
  if (!passwordAuthEnabled()) return answer(form, UNAVAILABLE, pages);
  if (!csrfOk(req)) return answer(form, CSRF_FAIL, pages);
  if (typeof fields.password_confirm === "string" && fields.password_confirm !== fields.password) {
    return answer(form, { ok: false, status: 400, code: "password_mismatch" }, pages);
  }
  const mail = mailer();
  if (!mail.configured) return answer(form, { ok: false, status: 503, code: "mail_unavailable" }, pages);
  try {
    const result = await register({
      store: store(), mail: mail.send, origin: origin(),
      email: fields.email, password: fields.password,
    });
    return answer(form, result, pages);
  } catch (err) {
    console.error("[password-auth] register failed:", err instanceof Error ? err.message : "error");
    return answer(form, { ok: false, status: 503, code: "db_unavailable" }, pages);
  }
}
