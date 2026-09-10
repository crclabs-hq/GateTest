/**
 * GitHub App Installation Callback
 *
 * After a user installs the GateTest GitHub App, GitHub redirects here with
 * installation_id and setup_action parameters. We persist the installation_id
 * against the currently-signed-in customer (if any), then redirect to the
 * success page.
 *
 * URL: https://gatetest.io/api/github/callback?installation_id=123&setup_action=install
 *
 * Persistence: Neon Postgres `installations` table via
 * `website/app/lib/installation-store.js`. Per the Bible, installation_id is
 * a long-lived mapping (not per-scan state), so the database is the correct
 * layer — Stripe metadata is reserved for scan state.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "../../../lib/db";
// Redirects MUST be built on the public origin, never on `req.url`. Behind
// the box's reverse proxy `req.url` is the INTERNAL origin, and the live
// endpoint answered every install with a 307 to a private 10.x address —
// a dead page for the one customer who just clicked Install.
import { siteUrl } from "../../../lib/site-url";
import {
  getOAuthConfig,
  verifyCustomerSession,
  CUSTOMER_COOKIE_NAME,
} from "../../../lib/customer-session";
// CommonJS helper — imported the same way as gluecron-callback.js
import {
  ensureInstallationsTable,
  persistInstallation,
} from "../../../lib/installation-store";

async function getActiveCustomer(): Promise<{ email: string | null; login: string | null }> {
  const status = getOAuthConfig();
  if (!status.ok || !status.config) return { email: null, login: null };

  const cookieStore = await cookies();
  const token = cookieStore.get(CUSTOMER_COOKIE_NAME)?.value;
  const session = verifyCustomerSession(token, status.config.sessionSecret);
  if (!session) return { email: null, login: null };

  return { email: session.e || null, login: session.u || null };
}

async function storeInstallation(
  installationId: string,
  setupAction: string
): Promise<void> {
  // Silently skip if DATABASE_URL is not configured — persistence is
  // best-effort at callback time; the user must still land on the success
  // page even if the DB is unreachable.
  if (!process.env.DATABASE_URL) return;

  try {
    const sql = getDb();
    await ensureInstallationsTable(sql);
    const { email, login } = await getActiveCustomer();
    await persistInstallation({
      installationId,
      customerEmail: email,
      customerLogin: login,
      setupAction,
      sql,
    });
  } catch (err) {
    // Never block the redirect on persistence failure. Log for visibility.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[github-callback] installation persistence failed:", msg);
  }
}

/**
 * Queue a first scan for a fresh installation. NEVER throws and never
 * blocks the redirect — a slow GitHub or a down queue must not turn a
 * successful install into an error page. Failures are logged; the customer
 * still lands on the confirmation page, and their next push scans as usual.
 */
async function startFirstScans(installationId: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { enqueueFirstScans } = require("../../../lib/onboarding") as {
      enqueueFirstScans: (o: unknown) => Promise<{ ok: boolean; queued: unknown[]; skipped: unknown[]; reason?: string }>;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { enqueueScan, ensureScanQueueTable } = require("../../../lib/scan-queue-store");
    const { getInstallationToken, githubApi } = await import("../../../lib/github-app");

    const sql = getDb();
    await ensureScanQueueTable(sql);

    const result = await enqueueFirstScans({
      installationId,
      deps: {
        getInstallationToken: (id: string) => getInstallationToken(Number(id)),
        listRepos: async (token: string) => {
          const body = await githubApi("GET", "/installation/repositories?per_page=100", token);
          return (body && (body as { repositories?: unknown[] }).repositories) || [];
        },
        getDefaultBranchSha: async (token: string, fullName: string) => {
          const repo = await githubApi("GET", `/repos/${fullName}`, token) as { default_branch?: string };
          const branch = repo?.default_branch;
          if (!branch) return null;
          const ref = await githubApi("GET", `/repos/${fullName}/commits/${branch}`, token) as { sha?: string };
          return ref?.sha ? { sha: ref.sha, ref: `refs/heads/${branch}` } : null;
        },
        enqueueScan,
        sql,
      },
    });

    if (!result.ok) {
      console.warn("[onboarding] first scan not queued:", result.reason);
    } else {
      console.log(
        `[onboarding] installation ${installationId}: queued ${result.queued.length}, skipped ${result.skipped.length}`,
      );
    }
    // Deliberate swallow, and the one place in this file it is correct: the
    // customer is mid-redirect on a SUCCESSFUL install. Their App is
    // installed and their next push will scan — turning that into an error
    // page because GitHub was slow would be strictly worse. Logged, never
    // rethrown; the caller has no action to take, so the log IS the surface.
  } catch (err) { // error-ok
    console.warn("[onboarding] first scan failed:", err instanceof Error ? err.message : String(err));
  }
}

export async function GET(req: NextRequest) {
  const installationId = req.nextUrl.searchParams.get("installation_id");
  const setupAction = req.nextUrl.searchParams.get("setup_action");

  if (setupAction === "install" && installationId) {
    await storeInstallation(installationId, setupAction);
    // Onboarding: queue a scan of their most active repos NOW, so results
    // are waiting when they land. Before this, installing produced nothing
    // until the customer went away, wrote code and pushed it — the one
    // moment they were paying attention delivered no evidence the product
    // works. Best-effort by design; see startFirstScans().
    await startFirstScans(installationId);
    return NextResponse.redirect(siteUrl("/github/installed"));
  }

  // Handle uninstall or other actions
  if (setupAction === "update" && installationId) {
    await storeInstallation(installationId, setupAction);
    return NextResponse.redirect(siteUrl("/github/installed"));
  }

  // Default: redirect to setup page
  return NextResponse.redirect(siteUrl("/github/setup"));
}
