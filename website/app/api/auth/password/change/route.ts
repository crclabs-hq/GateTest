/**
 * POST /api/auth/password/change — a signed-in customer changes their password.
 *
 * Body (JSON or form): { current_password, new_password, new_password_confirm? }
 *
 *   200 { ok: true,  code: "changed" }
 *   400 { ok: false, code: current_wrong | no_password | password_short | password_long | password_common | password_mismatch }
 *   401 { ok: false, code: "not_signed_in" }
 *   403 { ok: false, code: "csrf" }
 *   404 { ok: false, code: "unavailable" }
 *   503 { ok: false, code: "db_unavailable" }
 *
 * Identity comes from the VERIFIED session cookie, never the body (same rule
 * as /api/account/notifications). Outstanding reset links are invalidated.
 */

import { NextRequest } from "next/server";
import { change } from "@/app/lib/password-auth-core";
import {
  answer, csrfOk, currentSessionEmail, passwordAuthEnabled, readFields, store, CSRF_FAIL, UNAVAILABLE,
} from "@/app/lib/password-auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE = "/account/password";

export async function POST(req: NextRequest) {
  const { fields, form } = await readFields(req);
  const pages = { ok: PAGE, error: PAGE };
  if (!passwordAuthEnabled()) return answer(form, UNAVAILABLE, pages);
  if (!csrfOk(req)) return answer(form, CSRF_FAIL, pages);
  const email = await currentSessionEmail();
  if (!email) return answer(form, { ok: false, status: 401, code: "not_signed_in" }, { ok: "/login", error: "/login", next: PAGE });
  if (typeof fields.new_password_confirm === "string" && fields.new_password_confirm !== fields.new_password) {
    return answer(form, { ok: false, status: 400, code: "password_mismatch" }, pages);
  }
  try {
    const result = await change({
      store: store(), email, currentPassword: fields.current_password, newPassword: fields.new_password,
    });
    return answer(form, result, pages);
  } catch (err) {
    console.error("[password-auth] change failed:", err instanceof Error ? err.message : "error");
    return answer(form, { ok: false, status: 503, code: "db_unavailable" }, pages);
  }
}
