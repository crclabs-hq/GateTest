'use strict';

/**
 * Issue #681 item 2 / #695 — a cross-browser failure claim reached a
 * customer report under module `general` instead of `crossBrowser`:
 *
 *   "https://tallrig.com fails to load in firefox but loads fine in
 *   chromium"
 *
 * `src/modules/cross-browser.js` already follows the #659 evidence rule
 * (engine version + runtime error text in the finding's own `message`, or
 * `_notChecked` with a reason when no engine could run — see
 * tests/cross-browser.test.js). The actual producer of the customer-facing
 * `WebFinding` shape is `translateFinding()`.
 *
 * #687 gave the two WEB routes (`/api/web/scan`, `/api/web/scan/stream`) a
 * `cross-browser:` branch but left each of the four hosted scan routes
 * carrying its OWN copy of `translateFinding()` — so the two WP routes
 * (`/api/wp/scan`, `/api/wp/scan/stream`) never got the fix: a
 * cross-browser finding on a WordPress scan still fell into the generic
 * "general" bucket and had its evidence-rich message mangled by a naive
 * `message.split(":")` (the message's own `https://` colon gets treated as
 * a field separator).
 *
 * #695 collapses all four copies into ONE shared, plain-.js module —
 * `website/app/lib/scan-finding-translate.js` — imported by all four
 * routes. Unlike the routes themselves (Next.js server routes not
 * practical to execute directly in `node --test`), this module is a
 * genuine standalone function, so this file tests it directly rather than
 * via source-text pattern matching, then proves by source-text contract
 * that every route actually imports it instead of re-inlining its own
 * copy.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { translateFinding } = require('../website/app/lib/scan-finding-translate.js');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const ROUTES = [
  'website/app/api/web/scan/route.ts',
  'website/app/api/web/scan/stream/route.ts',
  'website/app/api/wp/scan/route.ts',
  'website/app/api/wp/scan/stream/route.ts',
];

// Reproduces the exact shape cross-browser.js emits (see
// tests/cross-browser.test.js for the full module-level proof).
const FIXTURE_MESSAGE =
  'https://tallrig.com fails to load in firefox but loads fine in chromium (v141.0.7390.37). ' +
  'Evidence: firefox v141.0.5790.13: net::ERR_CONNECTION_REFUSED at https://tallrig.com/';

describe('scan-finding-translate.js — translateFinding routes cross-browser findings correctly (item 2)', () => {
  it('maps a cross-browser: check to module "crossBrowser", never "general"', () => {
    const finding = translateFinding({
      name: 'cross-browser:navigation-broken',
      severity: 'error',
      message: FIXTURE_MESSAGE,
    });
    assert.ok(finding, 'error-severity cross-browser check must produce a finding');
    assert.equal(finding.module, 'crossBrowser');
  });

  it('preserves the full evidence-rich message as body, never truncating it via the generic colon-split fallback', () => {
    const finding = translateFinding({
      name: 'cross-browser:navigation-broken',
      severity: 'error',
      message: FIXTURE_MESSAGE,
    });
    assert.equal(finding.body, FIXTURE_MESSAGE);
    assert.match(finding.body, /firefox v141\.0\.5790\.13/);
    assert.match(finding.body, /ERR_CONNECTION_REFUSED/);
    // The OLD generic-fallback title logic is what used to eat this —
    // prove it really would have (the regression this fix guards against).
    const oldFallbackTitle = FIXTURE_MESSAGE.split(':').slice(0, 2).join(':');
    assert.notEqual(oldFallbackTitle, FIXTURE_MESSAGE, 'sanity: the old fallback really did mangle this message');
  });

  it('a warning-severity cross-browser finding is preserved the same way', () => {
    const finding = translateFinding({
      name: 'cross-browser:rendering-diff',
      severity: 'warning',
      message: 'Rendering diff evidence text',
    });
    assert.ok(finding);
    assert.equal(finding.module, 'crossBrowser');
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.body, 'Rendering diff evidence text');
  });

  it('an info-severity cross-browser check is dropped (not customer-facing), same as every other module', () => {
    const finding = translateFinding({
      name: 'cross-browser:probed',
      severity: 'info',
      message: 'probed 3 engines',
    });
    assert.equal(finding, null);
  });
});

describe('all four hosted scan routes import translateFinding from the ONE shared module (Doctrine #4, issue #695)', () => {
  for (const rel of ROUTES) {
    it(`${rel} imports translateFinding from @/app/lib/scan-finding-translate`, () => {
      const src = read(rel);
      assert.match(src, /require\("@\/app\/lib\/scan-finding-translate"\)/);
    });

    it(`${rel} no longer carries its own inline translateFinding definition or cross-browser: branch`, () => {
      const src = read(rel);
      assert.ok(
        !/function translateFinding\(/.test(src),
        'route must not carry its own translateFinding definition — that is exactly the drift #695 closes'
      );
      assert.ok(
        !/name\.startsWith\("cross-browser:"\)/.test(src),
        'route must not re-inline the cross-browser: branch — it lives only in scan-finding-translate.js'
      );
    });
  }
});

describe('cross-browser finding maps through the wp routes exactly as through the web routes (issue #695 acceptance test)', () => {
  it('the fixture cross-browser finding maps to module crossBrowser with its evidence, identically for every route', () => {
    const check = { name: 'cross-browser:navigation-broken', severity: 'error', message: FIXTURE_MESSAGE };
    // All four routes (proven above, by source-text contract, to import
    // the SAME function) now produce this exact result — there is
    // structurally only one behavior possible, and this is it.
    const finding = translateFinding(check);
    assert.ok(finding);
    assert.equal(finding.module, 'crossBrowser');
    assert.equal(finding.body, FIXTURE_MESSAGE);
    assert.equal(finding.title, 'Cross-browser rendering difference');
  });
});
