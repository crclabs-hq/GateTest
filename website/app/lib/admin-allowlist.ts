/**
 * The one definition of WHO the admin is (Doctrine #4).
 *
 * Two kinds of entry, read from two variables:
 *
 *   GATETEST_ADMIN_USERNAMES  comma list. An entry WITHOUT "@" is a GitHub
 *                             login — the separate admin GitHub OAuth
 *                             (/api/github/admin-login) admits it, exactly
 *                             as before. An entry WITH "@" is an email
 *                             address (the owner put his address here
 *                             expecting it to work, 30 Sep 2026 — so it does).
 *   GATETEST_ADMIN_EMAILS     comma list of email addresses. The documented
 *                             home for addresses; entries without "@" are
 *                             ignored rather than read as logins.
 *
 * Every entry is trimmed and lower-cased. An email entry admits a CUSTOMER
 * sign-in (Google, GitHub, Gluecron, email + password) only when the provider
 * verified that address — see isAdminEmail() and the `ev` flag in
 * customer-session.ts. An unverified address never grants admin.
 */

export interface AdminAllowlist {
  /** GitHub logins (admin GitHub OAuth). */
  logins: string[];
  /** Email addresses (customer sign-in with a provider-verified email). */
  emails: string[];
}

type Env = Record<string, string | undefined>;

function entries(raw: string | undefined): string[] {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** A plausible single address: one "@", something on both sides, no spaces. */
function looksLikeEmail(s: string): boolean {
  const at = s.indexOf("@");
  return at > 0 && at === s.lastIndexOf("@") && at < s.length - 1 && !/\s/.test(s);
}

export function getAdminAllowlist(env: Env = process.env): AdminAllowlist {
  const logins: string[] = [];
  const emails: string[] = [];
  for (const entry of entries(env.GATETEST_ADMIN_USERNAMES)) {
    if (entry.includes("@")) {
      if (looksLikeEmail(entry)) emails.push(entry);
    } else {
      logins.push(entry);
    }
  }
  for (const entry of entries(env.GATETEST_ADMIN_EMAILS)) {
    if (looksLikeEmail(entry)) emails.push(entry);
  }
  return { logins: [...new Set(logins)], emails: [...new Set(emails)] };
}

/**
 * True when `email` is on the allowlist AND the sign-in provider verified it.
 * `verified` must be exactly `true` — a missing flag (a session signed before
 * the flag existed, a GitLab session, a v1 cookie) is "not verified".
 */
export function isAdminEmail(
  email: unknown,
  verified: unknown,
  allowlist: AdminAllowlist = getAdminAllowlist()
): boolean {
  if (verified !== true) return false;
  if (typeof email !== "string") return false;
  const e = email.trim().toLowerCase();
  if (!looksLikeEmail(e)) return false;
  return allowlist.emails.includes(e);
}
