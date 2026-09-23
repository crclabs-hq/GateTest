'use strict';

/**
 * Issue #681 item 1 — `/api/web/scan` (JSON) and `/api/web/scan/stream`
 * (SSE) must build the SAME module config for a given URL, including the
 * shared live-page fetch (`config.livePage`, #643/#645). Before this fix
 * each route carried its own copy of the fetch + config-wiring code; a
 * live scan of tallrig.com on 2026-09-22 showed the non-streaming route
 * reporting 6 of 20 web-suite modules not-checked (webHeaders,
 * tlsSecurity, cookieSecurity, accessibility, seo, links) where the design
 * intent was only 2 (tlsSecurity needs a raw socket; links needs its own
 * crawl — see issue #681 item 4 for links' new crawl-backed live mode).
 *
 * Both routes now call `website/app/lib/live-scan-config.js` — one
 * definition, imported (Doctrine #4) — so they cannot silently diverge.
 * The route handlers themselves are Next.js server routes not practical to
 * execute directly in `node --test` (same rationale as
 * web-scan-not-checked-stream.test.js / web-scan-auth.test.js): this file
 * unit-tests the shared helper directly, then proves — by actually running
 * the real modules against a config built the ONE way both routes now
 * build it — that the resulting not-checked set for a fixture page is
 * exactly what the design intends, and identical regardless of which
 * route's shape (JSON vs SSE) the config came from.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { fetchLivePage, applyLiveScanConfig } = require('../website/app/lib/live-scan-config.js');
const { deriveModuleCoverage } = require('../website/app/lib/health-score.js');

const WebHeadersModule = require('../src/modules/web-headers');
const TlsSecurityModule = require('../src/modules/tls-security');
const CookieSecurityModule = require('../src/modules/cookie-security');
const AccessibilityModule = require('../src/modules/accessibility');
const SeoModule = require('../src/modules/seo');
const LinksModule = require('../src/modules/links');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function makeResult(moduleName) {
  return {
    module: moduleName,
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

describe('live-scan-config.js — fetchLivePage', () => {
  it('returns a livePage shape on a successful fetch', async () => {
    const fakeFetch = async () => ({
      url: 'https://example.com/',
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => '<html><head><title>x</title></head></html>',
    });
    const page = await fetchLivePage('https://example.com', { fetchImpl: fakeFetch });
    assert.equal(page.status, 200);
    assert.equal(page.url, 'https://example.com/');
    assert.match(page.html, /<title>x<\/title>/);
  });

  it('resolves to null (never throws) when the fetch fails', async () => {
    const fakeFetch = async () => { throw new Error('network down'); };
    const page = await fetchLivePage('https://example.com', { fetchImpl: fakeFetch });
    assert.equal(page, null);
  });
});

describe('live-scan-config.js — applyLiveScanConfig', () => {
  it('sets targetUrl/webUrl via cfg.set() and livePage as a direct property', () => {
    const calls = [];
    const gt = { config: { set: (k, v) => calls.push([k, v]) } };
    const livePage = { url: 'https://x.example.com', status: 200, headers: new Headers(), html: '' };
    applyLiveScanConfig(gt, { targetUrl: 'https://x.example.com', livePage });
    assert.deepEqual(calls, [['targetUrl', 'https://x.example.com'], ['webUrl', 'https://x.example.com']]);
    assert.equal(gt.config.livePage, livePage);
  });

  it('threads authed-crawl headers/cookie into modules.liveCrawler config', () => {
    const calls = [];
    const gt = { config: { set: (k, v) => calls.push([k, v]) } };
    applyLiveScanConfig(gt, {
      targetUrl: 'https://x.example.com',
      livePage: null,
      sanitizedAuth: { headers: { Authorization: 'Bearer t' }, cookie: 'session=1' },
    });
    assert.ok(calls.some(([k, v]) => k === 'modules.liveCrawler.headers' && v.Authorization === 'Bearer t'));
    assert.ok(calls.some(([k, v]) => k === 'modules.liveCrawler.cookie' && v === 'session=1'));
  });

  it('does nothing destructive when gt.config is absent', () => {
    assert.doesNotThrow(() => applyLiveScanConfig({}, { targetUrl: 'https://x.example.com', livePage: null }));
    assert.doesNotThrow(() => applyLiveScanConfig(null, { targetUrl: 'https://x.example.com', livePage: null }));
  });
});

describe('all four hosted scan routes call the one shared live-scan-config helper (Doctrine #4, issue #695)', () => {
  const ALL_SCAN_ROUTES = [
    'website/app/api/web/scan/route.ts',
    'website/app/api/web/scan/stream/route.ts',
    'website/app/api/wp/scan/route.ts',
    'website/app/api/wp/scan/stream/route.ts',
  ];

  for (const rel of ALL_SCAN_ROUTES) {
    it(`${rel} imports fetchLivePage + applyLiveScanConfig from the shared module`, () => {
      const src = read(rel);
      assert.match(src, /require\("@\/app\/lib\/live-scan-config"\)/);
      assert.match(src, /fetchLivePage\(targetUrl\)/);
      assert.match(src, /applyLiveScanConfig\(gt,\s*\{/);
    });

    it(`${rel} no longer carries its own inline page-fetch AbortController block`, () => {
      const src = read(rel);
      // The old duplicated fetch each route carried built its OWN
      // AbortController + 15s timer inline; that logic now lives ONLY in
      // live-scan-config.js. A route re-introducing it would be exactly
      // the drift this fix closes.
      assert.ok(!/const pageController = new AbortController\(\)/.test(src), 'route must not re-inline the live-page fetch');
    });
  }

  // Issue #695: before this fix, the two wp routes built their OWN
  // config-wiring by hand (setting targetUrl/wpUrl directly, no
  // fetchLivePage / config.livePage at all), so webHeaders / seo /
  // accessibility / cookieSecurity silently went not-checked on a wp scan
  // where the equivalent web scan of the same URL had them checked.
  for (const rel of ['website/app/api/wp/scan/route.ts', 'website/app/api/wp/scan/stream/route.ts']) {
    it(`${rel} no longer hand-builds config wiring instead of calling applyLiveScanConfig`, () => {
      const src = read(rel);
      assert.ok(
        !/Different config implementations expose data differently; try both\./.test(src),
        'route must not re-inline the old hand-rolled config-wiring branch — that is exactly the drift #695 closes'
      );
      // targetUrl must be set via applyLiveScanConfig, not a second
      // hand-rolled `.set("targetUrl", ...)` call outside it.
      const setTargetUrlCalls = (src.match(/\.set\("targetUrl"/g) || []).length;
      assert.equal(setTargetUrlCalls, 0, 'targetUrl must be set only inside applyLiveScanConfig, never re-inlined in the route');
    });
  }
});

// Shared by every describe block below — one fixture page, checked the
// same way regardless of which route (web/wp, JSON/stream) built the config.
const FIXTURE_LIVE_PAGE = {
  url: 'https://fixture.example.com/',
  status: 200,
  headers: new Headers({
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-abc123'",
  }),
  html: '<html><head><title>Fixture</title><meta name="description" content="A fixture page for tests"></head><body><h1>Fixture</h1></body></html>',
};

describe('web suite — a fixture page produces the SAME not-checked set no matter which route built the config (item 1)', () => {
  it('matches the design intent: only tlsSecurity and links (no crawler data) are not-checked', async () => {
    const gt = { config: {} };
    applyLiveScanConfig(gt, { targetUrl: 'https://fixture.example.com', livePage: FIXTURE_LIVE_PAGE });
    const config = { ...gt.config, getModuleConfig: () => ({}) };

    const MODULES = [
      ['webHeaders', WebHeadersModule],
      ['tlsSecurity', TlsSecurityModule],
      ['cookieSecurity', CookieSecurityModule],
      ['accessibility', AccessibilityModule],
      ['seo', SeoModule],
      ['links', LinksModule],
    ];
    const results = [];
    for (const [name, Mod] of MODULES) {
      const result = makeResult(name);
      await new Mod().run(result, config);
      results.push(result);
    }

    const coverage = deriveModuleCoverage(results);
    assert.deepEqual(coverage.notChecked.map((n) => n.module).sort(), ['links', 'tlsSecurity']);
  });

  it('two independently-built configs (simulating each route) agree byte-for-byte on livePage + targetUrl', () => {
    const gtA = { config: {} };
    const gtB = { config: {} };
    applyLiveScanConfig(gtA, { targetUrl: 'https://fixture.example.com', livePage: FIXTURE_LIVE_PAGE });
    applyLiveScanConfig(gtB, { targetUrl: 'https://fixture.example.com', livePage: FIXTURE_LIVE_PAGE });
    assert.equal(gtA.config.livePage, gtB.config.livePage);
    assert.equal(gtA.config.targetUrl, gtB.config.targetUrl);
    assert.equal(gtA.config.webUrl, gtB.config.webUrl);
  });
});

describe('the not-checked set is identical across all four routes for the same fixture page (issue #695 acceptance test)', () => {
  const MODULES = [
    ['webHeaders', WebHeadersModule],
    ['tlsSecurity', TlsSecurityModule],
    ['cookieSecurity', CookieSecurityModule],
    ['accessibility', AccessibilityModule],
    ['seo', SeoModule],
    ['links', LinksModule],
  ];

  async function notCheckedSetFor(gt) {
    const config = { ...gt.config, getModuleConfig: () => ({}) };
    const results = [];
    for (const [name, Mod] of MODULES) {
      const result = makeResult(name);
      await new Mod().run(result, config);
      results.push(result);
    }
    return deriveModuleCoverage(results).notChecked.map((n) => n.module).sort();
  }

  it('web-route-style config wiring (applyLiveScanConfig only) and wp-route-style wiring (applyLiveScanConfig + the wpUrl fallback) produce the SAME not-checked set', async () => {
    // Mirrors website/app/api/web/scan/route.ts's wiring exactly.
    const gtWeb = { config: {} };
    applyLiveScanConfig(gtWeb, { targetUrl: 'https://fixture.example.com', livePage: FIXTURE_LIVE_PAGE });

    // Mirrors website/app/api/wp/scan/route.ts's wiring exactly (#695: the
    // SAME applyLiveScanConfig call, plus the WP-only wpUrl fallback that
    // wp-*.js modules read as a second choice — see src/modules/wp-*.js).
    const gtWp = { config: { set: (k, v) => { gtWp.config[k] = v; } } };
    applyLiveScanConfig(gtWp, { targetUrl: 'https://fixture.example.com', livePage: FIXTURE_LIVE_PAGE });
    gtWp.config.set('wpUrl', 'https://fixture.example.com');

    const webNotChecked = await notCheckedSetFor(gtWeb);
    const wpNotChecked = await notCheckedSetFor(gtWp);

    assert.deepEqual(webNotChecked, ['links', 'tlsSecurity']);
    assert.deepEqual(wpNotChecked, webNotChecked, 'wp-route-style config wiring must produce the identical not-checked set as web-route-style wiring for the same fixture page');
  });

  it('the streaming variant of each suite (no sanitizedAuth argument) still agrees with its non-streaming sibling', async () => {
    // web/scan/stream/route.ts calls applyLiveScanConfig(gt, { targetUrl, livePage })
    // — no sanitizedAuth key at all, unlike the non-streaming route which
    // always passes it (even as undefined). Prove the omitted key changes
    // nothing about which modules get checked.
    const gtStream = { config: {} };
    applyLiveScanConfig(gtStream, { targetUrl: 'https://fixture.example.com', livePage: FIXTURE_LIVE_PAGE });
    const gtNonStream = { config: {} };
    applyLiveScanConfig(gtNonStream, { targetUrl: 'https://fixture.example.com', livePage: FIXTURE_LIVE_PAGE, sanitizedAuth: null });

    assert.deepEqual(await notCheckedSetFor(gtStream), await notCheckedSetFor(gtNonStream));
  });
});
