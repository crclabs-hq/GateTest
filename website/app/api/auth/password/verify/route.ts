/**
 * GET /api/auth/password/verify?token=… — the link in the confirmation e-mail.
 *
 * A valid, unused, unexpired verify token activates the password it carries,
 * marks the address verified, signs the customer in (same cookie as OAuth)
 * and answers 303 to /dashboard. Anything else answers 303 to
 * /login/password?error=token_invalid — one message for unknown, used and
 * expired alike.
 */

import { NextRequest } from "next/server";
import { verify } from "@/app/lib/password-auth-core";
import {
  passwordAuthEnabled, redirectTo, sessionSecret, signInCookie, store,
} from "@/app/lib/password-auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// auth-public — the 32-byte single-use token in the query IS the credential;
// it was delivered only to the mailbox being confirmed.
export async function GET(req: NextRequest) {
  if (!passwordAuthEnabled()) return redirectTo("/login", { error: "unavailable" });
  if (!sessionSecret()) return redirectTo("/login/password", { error: "unavailable" });
  const token = req.nextUrl.searchParams.get("token");
  try {
    const result = await verify({ store: store(), token });
    if (!result.ok || !result.customer) return redirectTo("/login/password", { error: result.code });
    const res = redirectTo("/dashboard");
    res.headers.set("Set-Cookie", signInCookie(result.customer));
    return res;
  } catch (err) {
    console.error("[password-auth] verify failed:", err instanceof Error ? err.message : "error");
    return redirectTo("/login/password", { error: "db_unavailable" });
  }
}
