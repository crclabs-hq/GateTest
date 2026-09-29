/**
 * GET /api/auth/password/verify?token=…&next=… — the link in the confirmation e-mail.
 *
 * A valid, unused, unexpired verify token activates the password it carries
 * and marks the address verified, then answers 303 to
 * /login/password?notice=verified (with `next` carried through) so the
 * customer signs in with the password. It deliberately does NOT sign anyone
 * in: a click proves the mailbox, not the person, and a link someone else
 * requested must never hand out a session. Anything else answers 303 to
 * /login/password?error=token_invalid — one message for unknown, used and
 * expired alike.
 */

import { NextRequest } from "next/server";
import { verify } from "@/app/lib/password-auth-core";
import { safeNext } from "@/app/lib/session-gate";
import { passwordAuthEnabled, redirectTo, store } from "@/app/lib/password-auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE = "/login/password";

// auth-public — the 32-byte single-use token in the query IS the credential;
// it was delivered only to the mailbox being confirmed, and it grants no
// session — only the right to sign in with the password it activates.
export async function GET(req: NextRequest) {
  if (!passwordAuthEnabled()) return redirectTo("/login", { error: "unavailable" });
  const token = req.nextUrl.searchParams.get("token");
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  try {
    const result = await verify({ store: store(), token });
    if (!result.ok) return redirectTo(PAGE, { error: result.code, next });
    return redirectTo(PAGE, { notice: result.code, next });
  } catch (err) {
    console.error("[password-auth] verify failed:", err instanceof Error ? err.message : "error");
    return redirectTo(PAGE, { error: "db_unavailable", next });
  }
}
