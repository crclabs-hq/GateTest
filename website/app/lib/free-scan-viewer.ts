/**
 * Who is looking at a free scan result, and may they act on it.
 *
 * The free repo scan runs against ANY public repository — the visitor almost
 * never owns the one they pasted. Until 2026-09-22 the result offered
 * "Fix This PR →" on every finding regardless, to signed-out visitors, for
 * repositories they have no write access to. The link went to checkout, so a
 * stranger could pay for a fix branch that could never be pushed.
 *
 * This resolves the only two facts the result view needs:
 *   signedIn  — a valid customer session cookie is present
 *   canFix    — that session can push to this repository
 *
 * `canFix` is answered by GitHub, not by us: the customer's own OAuth token is
 * asked for the repository and the answer is `permissions.push`. A login that
 * merely matches the owner slug is not enough (organisations, forks, renamed
 * accounts). When the probe cannot run or does not answer, `canFix` is false
 * and `reason` says which — never an optimistic true.
 */

import {
  getOAuthConfig,
  verifyCustomerSession,
  CUSTOMER_COOKIE_NAME,
} from "./customer-session";

export interface FreeScanViewer {
  signedIn: boolean;
  /** false when sign-in is not configured in this environment — the result
   *  view then offers nothing rather than a link that answers 503. */
  canSignIn: boolean;
  login: string | null;
  canFix: boolean;
  /** Why canFix is false — shown nowhere, logged nowhere sensitive, carried for honesty. */
  reason: string;
}

const SIGNED_OUT: FreeScanViewer = Object.freeze({
  signedIn: false,
  canSignIn: true,
  login: null,
  canFix: false,
  reason: "not signed in",
});

const PROBE_TIMEOUT_MS = 5000;

async function probePushAccess(
  owner: string,
  repo: string,
  accessToken: string
): Promise<{ canFix: boolean; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "GateTest",
        Accept: "application/vnd.github.v3+json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { canFix: false, reason: `repository access check returned ${res.status}` };
    }
    const data = (await res.json()) as { permissions?: { push?: boolean; admin?: boolean } };
    const push = data.permissions?.push === true || data.permissions?.admin === true;
    return {
      canFix: push,
      reason: push ? "signed in with push access" : "signed in without push access to this repository",
    };
  } catch (err) {
    return {
      canFix: false,
      reason: `repository access not checked (${err instanceof Error ? err.message : "probe failed"})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param cookieValue the raw `gatetest_customer` cookie, if the request carried one
 */
export async function resolveFreeScanViewer(
  cookieValue: string | undefined | null,
  owner: string,
  repo: string
): Promise<FreeScanViewer> {
  const status = getOAuthConfig();
  if (!status.ok || !status.config) return { ...SIGNED_OUT, canSignIn: false, reason: "sign-in not configured" };

  const session = verifyCustomerSession(cookieValue, status.config.sessionSecret);
  if (!session) return { ...SIGNED_OUT };

  const login = typeof session.u === "string" ? session.u : null;
  if (!session.a) {
    return { signedIn: true, canSignIn: true, login, canFix: false, reason: "session has no repository token — sign in again to fix" };
  }
  const probe = await probePushAccess(owner, repo, session.a);
  return { signedIn: true, canSignIn: true, login, canFix: probe.canFix, reason: probe.reason };
}
