'use strict';
/**
 * The server-side sign-in gate — ONE definition (Doctrine #4).
 *
 * Before this file, /dashboard answered 200 with a 48 KB shell to an anonymous
 * client and decided sign-in in the browser (GET /api/auth/me after the server
 * had already rendered), so a crawler, a monitor or a prospect with JS off saw
 * a page that looked like it was there (#810). Now `website/proxy.ts` calls
 * `requireSession()` for every request before a protected page renders, and an
 * anonymous request gets a 307 to `/login?next=<path>` with no body.
 *
 * Plain CJS, like csp.js and site-url.js, so `node --test` can require() it
 * with no build step. The cookie check itself is injected (`verify`), because
 * `verifyCustomerSession` lives in customer-session.ts; the proxy passes the
 * real one and the tests pass the real one too.
 */

// Path prefixes only a signed-in customer may open. Admin has its own
// password gate (admin-auth.ts) and is not listed here.
const PROTECTED_PREFIXES = ['/dashboard', '/account/notifications', '/account/password'];

function underPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

/**
 * Is this a page that needs a signed-in customer?
 * /account/notifications?token=… is the emailed unsubscribe link: the token
 * proves which address to update, so that flow stays open without sign-in
 * (see app/account/notifications/page.tsx).
 */
function isProtectedPath(pathname, search) {
  if (typeof pathname !== 'string') return false;
  if (!PROTECTED_PREFIXES.some((p) => underPrefix(pathname, p))) return false;
  if (underPrefix(pathname, '/account/notifications')) {
    const token = new URLSearchParams(search || '').get('token');
    if (token) return false;
  }
  return true;
}

/**
 * A `next` value is only ever a same-origin path. Anything else (absolute
 * URL, protocol-relative `//host`, backslash tricks, control characters, the
 * login page itself, the API) is dropped and the caller falls back to
 * /dashboard — an open redirect on the sign-in path is a phishing primitive.
 */
function safeNext(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > 512) return null;
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return null;
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  if (underPrefix(raw.split(/[?#]/)[0], '/login')) return null;
  if (underPrefix(raw.split(/[?#]/)[0], '/api')) return null;
  return raw;
}

function loginLocation(pathname, search) {
  const next = safeNext(`${pathname}${search || ''}`);
  return next ? `/login?next=${encodeURIComponent(next)}` : '/login';
}

/**
 * The gate. `{ ok: true }` lets the request through; `{ ok: false,
 * location }` is where to 307 an anonymous request. Fails closed: no
 * SESSION_SECRET, no cookie, a bad or expired cookie are all "anonymous".
 */
function requireSession({ pathname, search, cookie, secret, verify }) {
  if (!isProtectedPath(pathname, search)) return { ok: true };
  if (secret && cookie && typeof verify === 'function') {
    let session = null;
    try { session = verify(cookie, secret); } catch { session = null; }
    if (session) return { ok: true, session };
  }
  return { ok: false, location: loginLocation(pathname, search) };
}

module.exports = { PROTECTED_PREFIXES, isProtectedPath, safeNext, loginLocation, requireSession };
