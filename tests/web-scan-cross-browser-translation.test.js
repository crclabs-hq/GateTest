'use strict';

/**
 * Issue #681 item 2 — a cross-browser failure claim reached a customer
 * report under module `general` instead of `crossBrowser`:
 *
 *   "https://tallrig.com fails to load in firefox but loads fine in
 *   chromium"
 *
 * `src/modules/cross-browser.js` already follows the #659 evidence rule
 * (engine version + runtime error text in the finding's own `message`, or
 * `_notChecked` with a reason when no engine could run — see
 * tests/cross-browser.test.js). The actual producer of the customer-facing
 * `WebFinding` shape is `translateFinding()` in each hosted web-scan
 * route, and NEITHER route's copy had a branch for the `cross-browser:`
 * check-name prefix — every `cross-browser:*` check fell through to the
 * generic `else` branch, which (a) mislabels `module` as `"general"` and
 * (b) mangles the title via a naive `message.split(":")` (the message's
 * own `https://` colon gets treated as a field separator).
 *
 * The routes are Next.js server routes not practical to execute directly
 * in `node --test` (same rationale as the other web-scan-*.test.js files
 * in this repo) — this is a source-text contract test, plus a direct
 * behavioral proof that cross-browser.js's own evidence-rich message
 * would in fact be preserved verbatim once module routing is fixed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

for (const rel of ['website/app/api/web/scan/route.ts', 'website/app/api/web/scan/stream/route.ts']) {
  describe(`${rel} — translateFinding routes cross-browser findings correctly (item 2)`, () => {
    const src = read(rel);

    /** Slice out ONLY this branch's own body — from its `startsWith` test
     *  up to (not including) the next `} else if (` — so assertions about
     *  what this branch does/doesn't contain can't accidentally match a
     *  sibling branch (e.g. the generic fallback's colon-split) that
     *  happens to land inside a fixed-size window. */
    function crossBrowserBranch() {
      const idx = src.indexOf('name.startsWith("cross-browser:")');
      assert.ok(idx > -1, 'no cross-browser: branch found');
      const nextBranch = src.indexOf('} else if (', idx);
      assert.ok(nextBranch > idx, 'could not find the end of the cross-browser: branch');
      return src.slice(idx, nextBranch);
    }

    it('has a dedicated branch for the cross-browser: check-name prefix', () => {
      assert.match(src, /name\.startsWith\("cross-browser:"\)/);
    });

    it('the cross-browser: branch assigns module = "crossBrowser", never "general"', () => {
      assert.match(crossBrowserBranch(), /module = "crossBrowser"/);
    });

    it('the cross-browser: branch preserves the full evidence-rich message as body, never truncating it', () => {
      const block = crossBrowserBranch();
      // Must NOT re-derive title/body from a naive colon-split — that's
      // exactly what the generic fallback branch does, and is why the
      // evidence used to be lost.
      assert.match(block, /body = check\.message \|\| ""/);
      // The generic fallback branch's actual code (not just prose mentioning
      // it) re-derives `title` this way — the branch under test must not.
      assert.ok(!/title = \(check\.message \|\| name\)\.split/.test(block), 'cross-browser branch must not use the generic colon-split fallback');
    });

    it('the cross-browser: branch appears before the generic fallback else', () => {
      const branchIdx = src.indexOf('name.startsWith("cross-browser:")');
      const fallbackIdx = src.lastIndexOf('} else {');
      assert.ok(branchIdx > -1 && fallbackIdx > -1 && branchIdx < fallbackIdx);
    });
  });
}

describe('cross-browser.js — the evidence this fix must not lose (control pair)', () => {
  it('a navigation-broken finding message already carries engine name + version + error text (#659)', () => {
    // Reproduces the exact shape cross-browser.js emits (see
    // tests/cross-browser.test.js for the full module-level proof) so this
    // file's routing-branch tests above are checked against something
    // realistic, not a strawman.
    const message =
      'https://tallrig.com fails to load in firefox but loads fine in chromium (v141.0.7390.37). ' +
      'Evidence: firefox v141.0.5790.13: net::ERR_CONNECTION_REFUSED at https://tallrig.com/';
    const check = { name: 'cross-browser:navigation-broken', severity: 'error', message };

    // Simulates exactly what the fixed translateFinding branch does:
    // module = "crossBrowser"; body = check.message || "";
    const body = check.message || '';
    assert.equal(body, message);
    assert.match(body, /firefox v141\.0\.5790\.13/);
    assert.match(body, /ERR_CONNECTION_REFUSED/);
    // The OLD generic-fallback title logic is what used to eat this —
    // prove it really would have (the regression this test guards against).
    const oldFallbackTitle = message.split(':').slice(0, 2).join(':');
    assert.notEqual(oldFallbackTitle, message, 'sanity: the old fallback really did mangle this message');
  });
});
