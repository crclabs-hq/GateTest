/**
 * Sign-in feature flags — ONE place the /login page reads to decide which
 * entries are links and which are honest "coming soon" lines.
 *
 * PASSWORD_AUTH_ENABLED: the username + password sign-in (owner directive
 * 2026-09-29). Stays `false` until `app/login/password/page.tsx` and its
 * backend exist (branch feat/password-auth); that builder flips it in the same
 * PR. tests/signin-gate.test.js fails if it is `true` while the page is
 * missing, so the flag can never link to a 404.
 */
export const PASSWORD_AUTH_ENABLED = false;
