/**
 * Server-side auth gate for /admin/learning — mirrors app/admin/page.tsx.
 *
 * LearningDashboard (page.tsx) is a client component that fires three
 * admin-only fetches on mount with no session check, so an unauthenticated
 * visit hit 401s immediately on page load. Gating here means the client
 * component never mounts without a valid admin cookie.
 */

import { cookies } from "next/headers";
import { createHmac } from "crypto";
import {
  getAdminConfig,
  getAdminUser,
  SESSION_COOKIE_NAME,
} from "../../lib/admin-session";
import { ADMIN_COOKIE_NAME } from "../../lib/admin-auth";
import AdminLogin from "../AdminLogin";

const HMAC_PAYLOAD = "gatetest-admin-v1";

export default async function AdminLearningLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();

  // --- Auth check 1: GitHub OAuth session ---
  const adminConfig = getAdminConfig();
  if (adminConfig.ok && adminConfig.config) {
    const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    const adminUser = getAdminUser(sessionCookie, adminConfig.config);
    if (adminUser) {
      return <>{children}</>;
    }
  }

  // --- Auth check 2: Password-based cookie ---
  const adminPassword = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (adminPassword) {
    const passwordCookie = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
    if (passwordCookie) {
      const expectedToken = createHmac("sha256", adminPassword)
        .update(HMAC_PAYLOAD)
        .digest("hex");
      if (passwordCookie === expectedToken) {
        return <>{children}</>;
      }
    }
  }

  // --- Not authenticated — show login UI instead of mounting the dashboard ---
  return (
    <AdminLogin
      hasGitHubOAuth={adminConfig.ok}
      hasPasswordAuth={!!adminPassword}
    />
  );
}
