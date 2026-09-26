'use strict';

/**
 * The website's own Content-Security-Policy — ONE definition (Doctrine #4),
 * imported by `website/proxy.ts` (sets the live per-request header + nonce)
 * and by `tests/website-csp-nonce.test.js` (proves script-src never
 * regresses to `unsafe-eval` / `unsafe-inline` in production). Plain CJS,
 * like `website/app/lib/site-url.js`, so both a `.ts` proxy file and a
 * plain `node --test` file can `require()` it without a build step.
 *
 * GT-10 (outside reviewer, 2026-09-26): every gatetest.io response carried
 * `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com` —
 * the exact CSP weakness `src/modules/web-headers.js` and
 * `src/scanners/server-scanner.js` flag on customers' sites. Fix:
 *   - `'unsafe-eval'` is dropped outright in production. Next.js only needs
 *     it in development, for React Refresh's eval-based stack rewriting
 *     (website/node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md
 *     — "unsafe-eval is not required for production").
 *   - `'unsafe-inline'` on script-src is replaced by a per-request nonce +
 *     `'strict-dynamic'`, the pattern that doc names for `proxy.ts`
 *     (Next 16 renamed `middleware.ts` to `proxy.ts` — see
 *     website/node_modules/next/AGENTS.md and
 *     .../file-conventions/middleware.md — the deprecated file convention).
 *     `https://js.stripe.com` stays in the allow-list as a fallback for
 *     browsers that don't yet support `strict-dynamic` (which, once present,
 *     makes browsers that DO support it ignore host-source allow-lists and
 *     trust only the nonce and anything a nonce'd script injects — exactly
 *     how `@stripe/stripe-js`'s `loadStripe()` injects the real Stripe.js
 *     tag at runtime).
 *   - `style-src` keeps `'unsafe-inline'` untouched — GT-10 and this fix are
 *     about `script-src` only (Tailwind/Next inline styles are out of scope).
 */

/**
 * @param {{ nonce: string, isDev: boolean }} opts
 * @returns {string} the full `Content-Security-Policy` header value
 */
function buildCsp({ nonce, isDev }) {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    'https://js.stripe.com',
    ...(isDev ? ["'unsafe-eval'"] : []),
  ].join(' ');

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "connect-src 'self' https://api.stripe.com https://api.anthropic.com https://api.github.com https://github.com",
    'frame-src https://js.stripe.com https://hooks.stripe.com',
    "frame-ancestors 'self'",
    "form-action 'self' https://checkout.stripe.com",
    "base-uri 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

module.exports = { buildCsp };
