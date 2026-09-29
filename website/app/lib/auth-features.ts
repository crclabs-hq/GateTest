/**
 * Sign-in feature switches — ONE place that says which entry points the
 * /login page and the password routes expose.
 *
 * PASSWORD_AUTH_ENABLED: email + password sign-in alongside GitHub / Google
 * (owner directive 2026-09-29). When false the /login/password pages 404 and
 * the /api/auth/password/* routes answer 404 `unavailable`, so the build can
 * ship dark and be switched on in one line.
 */
export const PASSWORD_AUTH_ENABLED = true;
