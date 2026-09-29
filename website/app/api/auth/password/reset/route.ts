/**
 * POST /api/auth/password/reset — choose a new password with a reset link.
 *
 * Body (JSON or form): { token, password, password_confirm? }
 *
 *   200 { ok: true,  code: "reset_ok" }
 *   400 { ok: false, code: token_invalid | password_short | password_long | password_common | password_mismatch }
 *   403 { ok: false, code: "csrf" }
 *   404 { ok: false, code: "unavailable" }
 *   503 { ok: false, code: "db_unavailable" }
 *
 * The token is consumed and every other outstanding reset token for the
 * customer is invalidated. The address counts as verified afterwards. A form
 * post answers 303 to /login/password?notice=reset_ok, or back to
 * /login/password/reset?token=…&error=.
 */

import { NextRequest } from "next/server";
import { reset } from "@/app/lib/password-auth-core";
import {
  answer, csrfOk, passwordAuthEnabled, readFields, store, CSRF_FAIL, UNAVAILABLE,
} from "@/app/lib/password-auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// auth-public — the single-use reset token in the body is the credential; it
// reached the caller only through the mailbox on file.
export async function POST(req: NextRequest) {
  const { fields, form } = await readFields(req);
  const token = typeof fields.token === "string" ? fields.token : "";
  const pages = { ok: "/login/password", error: "/login/password/reset", extra: { token } };
  if (!passwordAuthEnabled()) return answer(form, UNAVAILABLE, pages);
  if (!csrfOk(req)) return answer(form, CSRF_FAIL, pages);
  if (typeof fields.password_confirm === "string" && fields.password_confirm !== fields.password) {
    return answer(form, { ok: false, status: 400, code: "password_mismatch" }, pages);
  }
  try {
    const result = await reset({ store: store(), token, password: fields.password });
    return answer(form, result, result.ok ? { ok: "/login/password", error: "/login/password" } : pages);
  } catch (err) {
    console.error("[password-auth] reset failed:", err instanceof Error ? err.message : "error");
    return answer(form, { ok: false, status: 503, code: "db_unavailable" }, pages);
  }
}
