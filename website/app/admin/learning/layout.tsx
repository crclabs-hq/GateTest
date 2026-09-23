/**
 * Server-side auth gate for /admin/learning — mirrors app/admin/page.tsx.
 *
 * LearningDashboard (page.tsx) is a client component that fires three
 * admin-only fetches on mount with no session check, so an unauthenticated
 * visit hit 401s immediately on page load. Gating here means the client
 * component never mounts without a valid admin cookie.
 */

import { cookies } from "next/headers";
import { getAdminConfig, getAdminLoginFromCookies } from "../../lib/admin-session";
import AdminLogin from "../AdminLogin";

export default async function AdminLearningLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();

  if (getAdminLoginFromCookies(cookieStore)) {
    return <>{children}</>;
  }

  // --- Not authenticated — show login UI instead of mounting the dashboard ---
  const adminConfig = getAdminConfig();
  return (
    <AdminLogin
      hasGitHubOAuth={adminConfig.ok}
      hasPasswordAuth={!!process.env.GATETEST_ADMIN_PASSWORD}
    />
  );
}
