'use strict';
/**
 * What the /login page offers — ONE definition (Doctrine #4).
 *
 * Owner directive 2026-09-29: sign-in offers a Gluecron account, Google, and
 * username + password, and every provider the deployment can actually serve
 * is a button. The page decides server-side from the OAuth config getters in
 * customer-session.ts (no client fetch of /api/auth/providers), passes the
 * booleans here, and renders what comes back. A provider whose credentials
 * are unset is not rendered at all: the initiate route would answer a
 * "not available" page, and a sign-in button that cannot sign you in is the
 * defect /api/auth/providers was written to stop.
 *
 * Plain CJS, like session-gate.js, so `node --test` can require() it with no
 * build step and assert the iff-configured rule directly.
 */

/**
 * Sign-in routes that take `?next=` (a same-origin path, validated by
 * safeNext() on the way in and again in the callback).
 */
const OAUTH_PROVIDERS = [
  { id: 'github', label: 'Sign in with GitHub', initiate: '/api/auth/github' },
  { id: 'google', label: 'Continue with Google', initiate: '/api/auth/google' },
  { id: 'gitlab', label: 'Sign in with GitLab', initiate: '/api/auth/gitlab' },
];

/**
 * Entries that are not built yet. Rendered as muted text with no href, so the
 * page is honest about what exists. Gluecron OAuth waits on Gluecron's
 * answer; it is never gated on an env var, because an env var cannot make an
 * unbuilt flow work.
 */
const COMING_SOON = [
  { id: 'gluecron', label: 'Sign in with Gluecron', note: 'coming soon' },
];

function withNext(initiate, next) {
  return next ? `${initiate}?next=${encodeURIComponent(next)}` : initiate;
}

/**
 * The list the page renders, in order. `available` holds the `.ok` of each
 * OAuth config getter; `next` is the already-validated landing path or null;
 * `passwordAuth` is PASSWORD_AUTH_ENABLED from auth-features.ts.
 *
 * Each entry: `{ id, label, href }` for a link, `{ id, label, note }` with no
 * href for a coming-soon line.
 *
 * @param {{ available?: Record<string, boolean>, next?: string | null, passwordAuth?: boolean }} [opts]
 * @returns {Array<{ id: string, label: string, href?: string, note?: string }>}
 */
function signInProviders({ available = {}, next = null, passwordAuth = false } = {}) {
  /** @type {Array<{ id: string, label: string, href?: string, note?: string }>} */
  const out = [];
  for (const p of OAUTH_PROVIDERS) {
    if (available[p.id] === true) out.push({ id: p.id, label: p.label, href: withNext(p.initiate, next) });
  }
  for (const c of COMING_SOON) out.push({ id: c.id, label: c.label, note: c.note });
  if (passwordAuth) {
    out.push({ id: 'password', label: 'Email and password', href: withNext('/login/password', next) });
  } else {
    out.push({ id: 'password', label: 'Email and password', note: 'coming soon' });
  }
  return out;
}

/**
 * Codes the OAuth callbacks redirect to /login?error=<code> with, and the
 * sentence the page shows for each. GitHub's are the original four (#819);
 * Google and GitLab carry a prefix so the copy can name the provider that
 * failed. Anything else falls back to a generic line.
 */
const ERROR_COPY = {
  invalid_state: 'The sign-in request expired or did not match this browser. Start again.',
  token_failed: 'GitHub did not return an access token. Start again.',
  user_failed: 'GitHub did not return your profile. Start again.',
  not_configured: 'GitHub sign-in is not configured on this deployment.',
  google_invalid_state: 'The Google sign-in request expired or did not match this browser. Start again.',
  google_token_failed: 'Google did not return an access token. Start again.',
  google_user_failed: 'Google did not return your profile. Start again.',
  google_not_configured: 'Google sign-in is not configured on this deployment.',
  gitlab_invalid_state: 'The GitLab sign-in request expired or did not match this browser. Start again.',
  gitlab_token_failed: 'GitLab did not return an access token. Start again.',
  gitlab_user_failed: 'GitLab did not return your profile. Start again.',
  gitlab_not_configured: 'GitLab sign-in is not configured on this deployment.',
};

const GENERIC_ERROR = 'Sign-in did not complete. Start again.';

function errorMessage(code) {
  if (!code) return null;
  return ERROR_COPY[code] || GENERIC_ERROR;
}

module.exports = { OAUTH_PROVIDERS, COMING_SOON, signInProviders, ERROR_COPY, GENERIC_ERROR, errorMessage };
