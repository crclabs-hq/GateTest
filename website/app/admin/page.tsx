/**
 * Admin Page — server-rendered entry point.
 *
 * Signed in as the admin (getAdminLoginFromCookies, lib/admin-session.ts)
 * when ANY of:
 *   1. GitHub OAuth admin session — HMAC-signed cookie, allowlisted by login
 *   2. Customer sign-in (Google, GitHub, Gluecron, email + password) whose
 *      provider-verified email is on the allowlist (lib/admin-allowlist.ts)
 *   3. Password-based cookie — HMAC-derived from GATETEST_ADMIN_PASSWORD
 *
 * Otherwise renders the login UI. "Sign in with Google" there starts the
 * customer Google flow with next=/admin, so the callback lands back here;
 * a signed-in account that is not an admin sees "This account is not an
 * admin." and is never let in.
 */

import { cookies } from "next/headers";
import { getAdminConfig, getAdminLoginFromCookies, getCustomerAdminStatus } from "../lib/admin-session";
import { getGoogleOAuthConfig } from "../lib/customer-session";
import AdminPanel from "./AdminPanel";
import AdminLogin from "./AdminLogin";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const cookieStore = await cookies();
  const params = await searchParams;

  const adminLogin = getAdminLoginFromCookies(cookieStore);
  if (adminLogin) {
    return <AdminPanel adminLogin={adminLogin} />;
  }

  // --- Not authenticated — show login UI ---
  const adminConfig = getAdminConfig();
  const hasGitHubOAuth = adminConfig.ok;
  const hasPasswordAuth = !!process.env.GATETEST_ADMIN_PASSWORD;
  const hasGoogleOAuth = getGoogleOAuthConfig().ok;
  // Signed in to the site, but not as the admin (not allowlisted, or the
  // provider did not verify the address) — say so instead of a bare form.
  const signedInNotAdmin = getCustomerAdminStatus(cookieStore).signedIn;

  return (
    <AdminLogin
      hasGitHubOAuth={hasGitHubOAuth}
      hasPasswordAuth={hasPasswordAuth}
      hasGoogleOAuth={hasGoogleOAuth}
      signedInNotAdmin={signedInNotAdmin}
      error={params.error}
    />
  );
}
