// =============================================================================
// WEBSITE CSP NONCE — GT-10 (outside reviewer, 2026-09-26).
// =============================================================================
// Every gatetest.io response carried `script-src 'self' 'unsafe-inline'
// 'unsafe-eval' https://js.stripe.com` — the exact CSP weakness our own
// `src/modules/web-headers.js` and `src/scanners/server-scanner.js` flag on
// customers' sites. Fix:
//   - `'unsafe-eval'` is dropped outright in production (Next.js only needs
//     it in development, for React Refresh's eval-based stack rewriting).
//   - `'unsafe-inline'` on script-src is replaced by a per-request nonce +
//     `'strict-dynamic'` (`website/proxy.ts`, the Next 16 file convention
//     that replaced `middleware.ts`), applied to the app's inline scripts
//     (theme bootstrap, JSON-LD) via `website/app/lib/seo/NonceScript.tsx`
//     and `app/layout.tsx` / `app/admin/layout.tsx` directly.
//   - `style-src` is untouched — GT-10 and this fix are about script-src.
//
// The CSP header value is built by ONE function (Doctrine #4),
// `website/app/lib/csp.js`, imported here directly (it is plain CJS, like
// `website/app/lib/site-url.js`, specifically so a plain `node --test` file
// can require() it with no build step) and by `website/proxy.ts` (which
// generates the real per-request nonce and sets the live header). Testing
// the shared builder directly is the same control-pair shape as
// `tests/csp-unsafe-inline-directive-aware.test.js` uses for the scanner
// side: the real "line" that must be clean (production) and the "idiom
// beside it" that is allowed to differ (development).
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildCsp } = require('../website/app/lib/csp.js');

function scriptSrcOf(csp) {
  const match = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
  assert.ok(match, `expected a script-src directive in: ${csp}`);
  return match;
}

describe('website CSP (app/lib/csp.js) — production', () => {
  const csp = buildCsp({ nonce: 'TESTNONCE', isDev: false });
  const scriptSrc = scriptSrcOf(csp);

  it('never contains unsafe-eval in script-src', () => {
    assert.ok(!scriptSrc.includes('unsafe-eval'), `production script-src must not contain unsafe-eval: ${scriptSrc}`);
  });

  it('never contains unsafe-inline in script-src', () => {
    assert.ok(!scriptSrc.includes('unsafe-inline'), `production script-src must not contain unsafe-inline: ${scriptSrc}`);
  });

  it('carries the nonce placeholder', () => {
    assert.match(scriptSrc, /'nonce-TESTNONCE'/);
  });

  it('carries strict-dynamic', () => {
    assert.match(scriptSrc, /'strict-dynamic'/);
  });

  it('keeps unsafe-eval nowhere else in the policy either', () => {
    assert.ok(!csp.includes('unsafe-eval'), `production CSP must not contain unsafe-eval anywhere: ${csp}`);
  });

  it('leaves style-src untouched (still self + unsafe-inline — GT-10 is script-src only)', () => {
    const styleSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('style-src'));
    assert.ok(styleSrc, `expected a style-src directive in: ${csp}`);
    assert.match(styleSrc, /'unsafe-inline'/);
  });

  it('keeps every other directive from the pre-fix policy (frame-ancestors, HSTS-adjacent CSP directives, Stripe, etc.)', () => {
    for (const expected of [
      "default-src 'self'",
      'https://api.stripe.com',
      'https://api.anthropic.com',
      'https://api.github.com',
      'https://github.com',
      'frame-src https://js.stripe.com https://hooks.stripe.com',
      "frame-ancestors 'self'",
      "form-action 'self' https://checkout.stripe.com",
      "base-uri 'self'",
      "object-src 'none'",
      'upgrade-insecure-requests',
    ]) {
      assert.ok(csp.includes(expected), `expected "${expected}" to survive in: ${csp}`);
    }
  });
});

describe('website CSP (app/lib/csp.js) — development (control pair)', () => {
  const csp = buildCsp({ nonce: 'TESTNONCE', isDev: true });
  const scriptSrc = scriptSrcOf(csp);

  it('MAY contain unsafe-eval (React Refresh needs it in dev)', () => {
    assert.match(scriptSrc, /'unsafe-eval'/);
  });

  it('still carries the nonce and strict-dynamic even in dev', () => {
    assert.match(scriptSrc, /'nonce-TESTNONCE'/);
    assert.match(scriptSrc, /'strict-dynamic'/);
  });
});

describe('website proxy.ts wires the shared CSP builder into the live header', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const proxySource = fs.readFileSync(path.join(__dirname, '..', 'website', 'proxy.ts'), 'utf8');

  it('imports buildCsp from the one shared definition instead of re-declaring the policy', () => {
    assert.match(proxySource, /require\(["']\.\/app\/lib\/csp\.js["']\)/);
  });

  it('sets the Content-Security-Policy response header', () => {
    assert.match(proxySource, /Content-Security-Policy/);
  });

  it('sets the x-nonce request header so Server Components can read it back', () => {
    assert.match(proxySource, /x-nonce/);
  });

  it('gates isDev on NODE_ENV !== "production"', () => {
    assert.match(proxySource, /NODE_ENV\s*!==\s*["']production["']/);
  });
});

describe('next.config.ts no longer hardcodes a static Content-Security-Policy header', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const configSource = fs.readFileSync(path.join(__dirname, '..', 'website', 'next.config.ts'), 'utf8');

  it('does not declare a Content-Security-Policy header key (that would race the per-request nonce one from proxy.ts)', () => {
    assert.ok(!configSource.includes('key: "Content-Security-Policy"'));
  });

  it('still declares the other production security headers untouched', () => {
    for (const key of [
      'Strict-Transport-Security',
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'X-DNS-Prefetch-Control',
    ]) {
      assert.ok(configSource.includes(key), `expected ${key} to still be set in next.config.ts`);
    }
  });
});
