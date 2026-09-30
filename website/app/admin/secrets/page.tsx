/**
 * /admin/secrets — infra-secrets panel (owner directive 2026-09-30).
 *
 * Server-rendered gate: the SAME shared helper the root /admin page, the
 * admin layout and every /api/admin/* route use (`getAdminLoginFromCookies`).
 * Signed out, this page renders a sign-in pointer and never mounts the
 * panel, so not even the list request is made. Signed in, it mounts the
 * client panel, whose API calls are admin-gated again server-side.
 */

import { cookies } from "next/headers";
import Link from "next/link";
import { getAdminLoginFromCookies } from "../../lib/admin-session";
import SecretsPanel from "./SecretsPanel";
import "./secrets.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Secrets · Admin",
  robots: { index: false, follow: false },
};

export default async function AdminSecretsPage() {
  const adminLogin = getAdminLoginFromCookies(await cookies());
  if (!adminLogin) {
    return (
      <div className="gs-wrap">
        <h1 className="gs-title">Secrets</h1>
        <p className="gs-sub">
          Not signed in as admin.{" "}
          <Link href="/admin" className="gs-link">
            Sign in at /admin
          </Link>{" "}
          first.
        </p>
      </div>
    );
  }
  return <SecretsPanel />;
}
