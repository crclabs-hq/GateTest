/**
 * Admin shell layout (issue #691) — wraps every /admin/* route.
 *
 * Renders the shell (sidebar naming every section, sign-out, top bar with
 * build/theme controls) only for a signed-in operator. Signed out, children
 * render bare: `/admin` itself owns the login screen (AdminLogin), and every
 * other /admin/* page already degrades to its own "not authenticated" message
 * when its API calls 401 (see e.g. admin/compliance/page.tsx) — the shell
 * would otherwise leak the full section list to a signed-out visitor for no
 * benefit, and would sit awkwardly around a full-bleed login screen.
 *
 * Auth check is the SAME shared helper the root /admin page and every
 * /api/admin/* route use (`getAdminLoginFromCookies`, Doctrine #4) — so the
 * shell's decision to render chrome can never disagree with whether the
 * page underneath is actually signed in.
 */

import { cookies, headers } from "next/headers";
import { getAdminLoginFromCookies } from "@/app/lib/admin-session";
import { AdminShell } from "./AdminShell";
import { getAdminThemeScript } from "./theme-script";
import "./admin.css";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const adminLogin = getAdminLoginFromCookies(cookieStore);
  // GT-10 (outside reviewer, 2026-09-26): script-src no longer carries
  // 'unsafe-inline' (website/proxy.ts + app/lib/csp.js) — the inline theme
  // script below needs the per-request nonce.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  // Inline, blocking, and tiny — reads the stored theme choice and stamps
  // `data-theme` on <html> BEFORE first paint, so there is no flash of the
  // wrong theme (#690 contract item 4). Runs even when signed out so the
  // login screen itself respects the stored choice.
  const themeScript = <script nonce={nonce} dangerouslySetInnerHTML={{ __html: getAdminThemeScript() }} />;

  if (!adminLogin) {
    return (
      <>
        {themeScript}
        {children}
      </>
    );
  }

  return (
    <>
      {themeScript}
      <AdminShell adminLogin={adminLogin}>{children}</AdminShell>
    </>
  );
}
