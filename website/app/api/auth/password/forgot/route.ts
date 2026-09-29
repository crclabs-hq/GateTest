/**
 * POST /api/auth/password/forgot — ask for a password reset link.
 *
 * Body (JSON or form): { email, next? }
 *
 *   200 { ok: true,  code: "reset_sent" }   — always for a well-formed address
 *   400 { ok: false, code: "email_invalid" }
 *   403 { ok: false, code: "csrf" }
 *   404 { ok: false, code: "unavailable" }
 *   503 { ok: false, code: "mail_unavailable" | "db_unavailable" }
 *
 * The mail is sent only when the address belongs to a customer (with or
 * without a password — a reset link is how an OAuth-only account gets one).
 * A delivery failure for a known address is logged, never answered: a 503
 * only for known addresses would say which addresses are known.
 */

import { NextRequest } from "next/server";
import { forgot } from "@/app/lib/password-auth-core";
import { safeNext } from "@/app/lib/session-gate";
import {
  answer, csrfOk, mailer, origin, passwordAuthEnabled, readFields, store, CSRF_FAIL, UNAVAILABLE,
} from "@/app/lib/password-auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE = "/login/password/forgot";

// auth-public — a customer who has lost their password cannot sign in to ask
// for it back. The link goes only to the address on file.
export async function POST(req: NextRequest) {
  const { fields, form } = await readFields(req);
  const next = safeNext(fields.next ?? null);
  const pages = { ok: PAGE, error: PAGE, next };
  if (!passwordAuthEnabled()) return answer(form, UNAVAILABLE, pages);
  if (!csrfOk(req)) return answer(form, CSRF_FAIL, pages);
  const mail = mailer();
  if (!mail.configured) return answer(form, { ok: false, status: 503, code: "mail_unavailable" }, pages);
  try {
    const result = await forgot({ store: store(), mail: mail.send, origin: origin(), email: fields.email });
    if (result.delivered === false) console.error("[password-auth] reset mail was not delivered");
    return answer(form, result, pages);
  } catch (err) {
    console.error("[password-auth] forgot failed:", err instanceof Error ? err.message : "error");
    return answer(form, { ok: false, status: 503, code: "db_unavailable" }, pages);
  }
}
