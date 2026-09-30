/**
 * GET /api/auth/me — return current customer session info.
 * Returns { login, email, admin } if authenticated, 401 if not. `admin` is
 * true when this same request would be let into /admin
 * (getAdminLoginFromCookies — e.g. a provider-verified email on the admin
 * allowlist), so the dashboard can link there; it grants nothing itself.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  getOAuthConfig,
  verifyCustomerSession,
  CUSTOMER_COOKIE_NAME,
} from "../../../lib/customer-session";
import { getAdminLoginFromCookies } from "../../../lib/admin-session";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = getOAuthConfig();
  if (!status.ok || !status.config) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(CUSTOMER_COOKIE_NAME)?.value;
  const session = verifyCustomerSession(token, status.config.sessionSecret);

  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = Boolean(getAdminLoginFromCookies(cookieStore));
  return NextResponse.json({ login: session.u, email: session.e, admin });
}
