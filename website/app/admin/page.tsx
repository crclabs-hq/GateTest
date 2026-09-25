/**
 * Admin Page — server-rendered entry point.
 *
 * Supports two auth methods (checked in order):
 *   1. GitHub OAuth session — HMAC-signed cookie, allowlisted by username
 *   2. Password-based cookie — HMAC-derived from GATETEST_ADMIN_PASSWORD
 *
 * If neither cookie is valid, renders the login UI.
 */

import { cookies } from "next/headers";
import { getAdminConfig, getAdminLoginFromCookies } from "../lib/admin-session";
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

  return (
    <AdminLogin
      hasGitHubOAuth={hasGitHubOAuth}
      hasPasswordAuth={hasPasswordAuth}
      error={params.error}
    />
  );
}
