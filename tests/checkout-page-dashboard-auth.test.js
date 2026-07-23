/**
 * Regression tests for two 2026-07-23 production-readiness fixes:
 *
 * 1. /checkout page EXISTS. Every upsell surface (playground findings,
 *    scan results) links to `/checkout?tier=...&repo=...`; before this fix
 *    there was no page at that route — only /checkout/success and
 *    /checkout/cancel — so every paid CTA outside the homepage 404'd at
 *    the exact moment of purchase intent.
 *
 * 2. /api/dashboard derives identity from the VERIFIED session cookie,
 *    never from the request body. The previous shape accepted any email
 *    in the POST body (rate-limited only), letting anyone enumerate any
 *    customer's scan history, repos scanned, and total spend.
 *
 * Source-text tests, same convention as tests/payment-gate-scan-routes.test.js —
 * Next.js route handlers can't be require()'d outside the Next build.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CHECKOUT_PAGE = path.resolve(__dirname, '..', 'website', 'app', 'checkout', 'page.tsx');
const DASHBOARD_ROUTE = path.resolve(__dirname, '..', 'website', 'app', 'api', 'dashboard', 'route.ts');
const PLAYGROUND_PAGE = path.resolve(__dirname, '..', 'website', 'app', 'playground', 'page.tsx');

test('/checkout page exists (playground + scan upsell CTAs link to it)', () => {
  assert.ok(fs.existsSync(CHECKOUT_PAGE), 'website/app/checkout/page.tsx must exist — upsell surfaces link to /checkout?tier=...');
});

test('/checkout page POSTs /api/checkout and forwards to Stripe', () => {
  const src = fs.readFileSync(CHECKOUT_PAGE, 'utf8');
  assert.match(src, /fetch\("\/api\/checkout"/, 'must POST /api/checkout');
  assert.match(src, /checkoutUrl/, 'must follow the returned Stripe checkoutUrl');
  assert.match(src, /searchParams|URLSearchParams/, 'must read tier/repo from the query string');
});

test('playground upsell links still point at /checkout (the route the page now serves)', () => {
  const src = fs.readFileSync(PLAYGROUND_PAGE, 'utf8');
  assert.match(src, /\/checkout\?tier=/, 'playground must link to /checkout?tier=...');
});

test('scan/run maps the scan_fix tier to the full engine suite (no silent standard fallback)', () => {
  // "scan_fix" is a pricing tier, not an engine suite — getSuite() falls back
  // to the 45-module standard suite for unknown names, which quietly gave
  // $199 Scan+Fix customers a SHALLOWER scan than $99 Full customers.
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'website', 'app', 'api', 'scan', 'run', 'route.ts'),
    'utf8'
  );
  assert.match(
    src,
    /shadowTier\s*===\s*"scan_fix"\s*\?\s*"full"\s*:\s*shadowTier/,
    'scan/run must map the scan_fix tier to the "full" suite before calling runFullEngine'
  );
  assert.match(src, /suite:\s*engineSuite/, 'runFullEngine must receive the mapped suite, not the raw tier');
});

test('/api/dashboard requires a verified customer session (no body-email lookup)', () => {
  const src = fs.readFileSync(DASHBOARD_ROUTE, 'utf8');
  assert.match(src, /verifyCustomerSession/, 'must verify the session cookie');
  assert.match(src, /CUSTOMER_COOKIE_NAME/, 'must read the customer session cookie');
  assert.match(src, /status:\s*401/, 'must 401 when not signed in');
  assert.doesNotMatch(src, /body\.email/, 'must NOT read the lookup email from the request body — that allowed cross-customer scan-history enumeration');
  // The email used in the SQL lookup must come from the session payload.
  assert.match(src, /session\.e/, 'lookup email must come from the verified session payload');
});
