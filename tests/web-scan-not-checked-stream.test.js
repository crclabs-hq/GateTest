'use strict';

/**
 * Issue #648 items 1-2 — the hosted /web SSE stream must tick a not-checked
 * module as not-checked (never a clean pass), and the reason it prints must
 * come from the module's OWN `_notChecked()` message, never from
 * web-runtime-gate.js's unrelated runtime-dispatch reason vocabulary.
 *
 * Issue #658 item 1 extends this: that live reason was reaching the SSE
 * ticker (`module:end`) fine, but was dropped by the time the scan finished
 * — the `complete` event, the non-streaming route's JSON, and (since the
 * share-link is that same JSON re-encoded client-side in UrlScanFlow.tsx)
 * the restored share-link all carried only bare module NAMES
 * (`notCheckedModules: string[]`), never the reason. Fixed by carrying a
 * `notCheckedReasons: Array<{module, reason}>` field alongside it end to
 * end: `deriveModuleCoverage()` (already had the reason) → `computeHealthScore()`'s
 * `coverage.notChecked` → both routes' response JSON → `ScanResult` type →
 * `HealthScoreCard`.
 *
 * The route is a Next.js server route (ReadableStream + require() of the
 * bundled engine entry) that isn't practical to execute directly in a plain
 * `node --test` file — the existing web-scan-auth.test.js /
 * web-runtime-gate.test.js tests for these routes are source-text contracts
 * for the same reason. This file follows that pattern, plus a direct unit
 * test of the pure `deriveFreeCheckNames` logic in health-score.js that the
 * route's `moduleChecks` field is built from.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { deriveFreeCheckNames, LIVE_URL_MODULES, computeHealthScore, deriveModuleCoverage } = require('../website/app/lib/health-score.js');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('web-scan/stream route — module:end says not-checked, not clean (item 1)', () => {
  const src = read('website/app/api/web/scan/stream/route.ts');

  it('reads the real TestResult#toJSON() shape instead of undefined properties off the live instance', () => {
    assert.match(src, /raw\.toJSON\s*\(\s*\)/);
    assert.match(src, /typeof raw\.toJSON === "function"/);
  });

  it('a module whose checks carry notChecked emits status "not-checked", never "checked"', () => {
    assert.match(src, /notCheckedCheck\.message \|\| "not checked"/);
    assert.match(src, /status: "not-checked"/);
    assert.match(src, /status: "checked"/);
  });

  it('the not-checked branch returns before the clean-tick branch runs', () => {
    const idx = src.indexOf('if (event === "module:end")');
    assert.ok(idx > -1, 'module:end handler not found');
    const body = src.slice(idx, idx + 2500);
    const notCheckedIdx = body.indexOf('status: "not-checked"');
    const checkedIdx = body.indexOf('status: "checked"');
    assert.ok(notCheckedIdx > -1 && checkedIdx > -1 && notCheckedIdx < checkedIdx);
    // A `return;` must separate them so a not-checked module never also
    // sends the checked-branch event.
    assert.match(body.slice(notCheckedIdx, checkedIdx), /return;/);
  });
});

describe('web-scan/stream route — not-checked reason is module-scoped, not runtime-scoped (item 2)', () => {
  const src = read('website/app/api/web/scan/stream/route.ts');

  it('the module:end not-checked reason reads the check message, never the runtime gate', () => {
    const idx = src.indexOf('if (event === "module:end")');
    const notCheckedIdx = src.indexOf('status: "not-checked"', idx);
    const block = src.slice(Math.max(0, notCheckedIdx - 400), notCheckedIdx + 900);
    assert.match(block, /notCheckedCheck\.message/);
    assert.ok(!/runtimeGate|gateRuntimeScan/.test(block), 'module-level reason must not reference the runtime dispatch gate');
  });

  it('web-runtime-gate.js reason codes and a module\'s own not-checked message are different vocabularies', () => {
    const gate = require('../website/app/lib/web-runtime-gate.js');
    const moduleReason = 'this module reads source files, not a live URL';
    assert.notEqual(moduleReason, gate.RUNTIME_REASONS.NOT_CONFIGURED);
    assert.ok(!moduleReason.includes('live-browser worker'));
  });
});

describe('deriveFreeCheckNames — free-safe check-name breakdown (item 4 groundwork, item 1 JSON-route parity)', () => {
  it('a not-checked live module reports status not-checked with its own reason, no check names', () => {
    const results = [
      { module: 'webHeaders', duration: 3, checks: [{ name: 'web-headers:not-checked', passed: false, severity: 'info', notChecked: true, message: 'no live page was fetched for this scan' }] },
    ];
    const out = deriveFreeCheckNames(results, ['webHeaders']);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'not-checked');
    assert.equal(out[0].reason, 'no live page was fetched for this scan');
    assert.deepEqual(out[0].checks, []);
  });

  it('a checked live module reports check names + pass/fail, never the message (fix guidance)', () => {
    const results = [
      {
        module: 'webHeaders', duration: 2, checks: [
          { name: 'web-headers:live-missing-csp', passed: false, severity: 'warning', message: 'Add a Content-Security-Policy header — full fix guidance here' },
          { name: 'web-headers:live-hsts-present', passed: true, severity: 'info' },
        ],
      },
    ];
    const out = deriveFreeCheckNames(results, ['webHeaders']);
    assert.equal(out[0].status, 'checked');
    assert.deepEqual(out[0].checks.map((c) => c.name).sort(), ['web-headers:live-hsts-present', 'web-headers:live-missing-csp']);
    for (const c of out[0].checks) assert.equal('message' in c, false, 'fix guidance must never appear in the free check-name view');
    const failed = out[0].checks.find((c) => c.name === 'web-headers:live-missing-csp');
    assert.equal(failed.passed, false);
    assert.equal(failed.severity, 'warning');
  });

  it('a non-live module (e.g. liveCrawler) is excluded from the free view entirely', () => {
    const results = [{ module: 'liveCrawler', checks: [{ name: 'crawl:broken-links', passed: false, severity: 'error' }] }];
    assert.deepEqual(deriveFreeCheckNames(results, LIVE_URL_MODULES), []);
  });

  it('LIVE_URL_MODULES is the four #645 modules plus links (#681 item 4)', () => {
    assert.deepEqual([...LIVE_URL_MODULES].sort(), ['accessibility', 'cookieSecurity', 'links', 'seo', 'webHeaders']);
  });

  it('non-array / missing results are safe (no throw, empty output)', () => {
    assert.deepEqual(deriveFreeCheckNames(null, LIVE_URL_MODULES), []);
    assert.deepEqual(deriveFreeCheckNames([undefined, null, {}], LIVE_URL_MODULES), []);
  });
});

describe('issue #658 item 1 — not-checked reason survives past the live stream into the completed report', () => {
  it('computeHealthScore carries the per-module reason in coverage.notChecked, not just names', () => {
    const coverage = deriveModuleCoverage([
      { module: 'seo', checks: [{ name: 'seo:summary', passed: true }] },
      { module: 'links', checks: [{ name: 'links:not-checked', passed: false, severity: 'info', notChecked: true, message: 'no live page was fetched for this scan' }] },
    ]);
    const r = computeHealthScore([], coverage);
    assert.deepEqual(r.coverage.notCheckedModules, ['links']); // back-compat: unchanged shape
    assert.equal(r.coverage.notChecked.length, 1);
    assert.equal(r.coverage.notChecked[0].module, 'links');
    assert.equal(r.coverage.notChecked[0].reason, 'no live page was fetched for this scan');
  });

  for (const rel of ['website/app/api/web/scan/route.ts', 'website/app/api/web/scan/stream/route.ts']) {
    it(`${rel} returns notCheckedReasons (module + reason) alongside notCheckedModules`, () => {
      const src = read(rel);
      assert.match(src, /notCheckedReasons:\s*moduleCoverage\.notChecked/);
      // Must appear after moduleCoverage is computed, not a re-derivation —
      // one definition (Doctrine #4): the SAME array `deriveModuleCoverage`
      // returned, not a second pass over `summary.results`.
      const coverageIdx = src.indexOf('const moduleCoverage = deriveModuleCoverage(');
      const reasonsIdx = src.indexOf('notCheckedReasons:');
      assert.ok(coverageIdx > -1 && reasonsIdx > coverageIdx);
    });
  }

  it('ScanResult carries notCheckedReasons so the share-link (a re-encode of this same object) restores it too', () => {
    const src = read('website/app/components/url-scan-flow-types.ts');
    assert.match(src, /notCheckedReasons\?:\s*Array<\{\s*module:\s*string;\s*reason:\s*string\s*\}>/);
  });

  it('HealthScoreCard renders the reason per module when notCheckedReasons is present', () => {
    const src = read('website/app/components/url-scan-flow-cards.tsx');
    assert.match(src, /notCheckedReasons/);
    assert.match(src, /n\.reason/);
  });

  it('UrlScanFlow passes notCheckedReasons from the result into HealthScoreCard', () => {
    const src = read('website/app/components/UrlScanFlow.tsx');
    assert.match(src, /notCheckedReasons=\{result\.notCheckedReasons\}/);
  });
});

describe('issue #658 item 2 — "why the score changed" note and hosted-vs-CLI methodology disclosure', () => {
  it('UrlScanFlow computes explainScoreChange against the last scan of the SAME url, persisted client-side', () => {
    const src = read('website/app/components/UrlScanFlow.tsx');
    assert.match(src, /explainScoreChange/);
    assert.match(src, /loadPreviousCoverage\(targetUrl\)/);
    assert.match(src, /saveCoverage\(targetUrl, data\)/);
    // Must be wrapped the same try/catch-per-viewer-convenience way as the
    // existing ScanFeedback.tsx localStorage usage — never throw into the
    // scan result over a blocked/unavailable store.
    assert.match(src, /catch\s*{\s*\n\s*return null;.*storage/s);
  });

  it('HealthScoreCard renders the scoreChangeNote and a permanent hosted-vs-CLI methodology line', () => {
    const src = read('website/app/components/url-scan-flow-cards.tsx');
    assert.match(src, /scoreChangeNote/);
    assert.match(src, /not directly comparable/);
  });
});

describe('web-scan routes — moduleChecks field ships free regardless of preview tier (item 4)', () => {
  for (const rel of ['website/app/api/web/scan/route.ts', 'website/app/api/web/scan/stream/route.ts']) {
    it(`${rel} computes moduleChecks via the one shared definition and returns it unconditionally`, () => {
      const src = read(rel);
      assert.match(src, /deriveFreeCheckNames/);
      assert.match(src, /LIVE_URL_MODULES/);
      assert.match(src, /moduleChecks/);
      // The field must not be inside an `isPreview ? … : null`-style gate —
      // simplest proof available from source text: it's assigned once,
      // outside the `paywall:` block that IS conditioned on isPreview.
      const paywallIdx = src.indexOf('paywall:');
      const moduleChecksIdx = src.indexOf('moduleChecks,');
      assert.ok(moduleChecksIdx > -1 && moduleChecksIdx < paywallIdx, 'moduleChecks must be assigned outside/before the paywall-gated block');
    });
  }
});
