'use strict';

/**
 * Issue #768 item 3 — a hosted scan of a JSON API host (api.alecrae.com) ran
 * SEO/H1/meta/accessibility checks and the broken-link crawl, and graded the
 * host F largely on findings that make no sense off a JSON body (no <h1>,
 * no <title>, no <a href>). Header/TLS/cookie/CORS checks are content-type
 * agnostic and DO apply.
 *
 * Control pair: an HTML fixture still runs H1/meta (seo/accessibility fire
 * real findings); a JSON fixture does not (both report `notChecked` with
 * the reason "JSON API host — HTML checks do not apply"), and the health
 * score is computed only from the checks that actually ran.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const SeoModule = require('../src/modules/seo');
const AccessibilityModule = require('../src/modules/accessibility');
const LinksModule = require('../src/modules/links');
const LiveCrawlerModule = require('../src/modules/live-crawler');
const InteractiveElementsModule = require('../src/modules/interactive-elements');
const WebHeadersModule = require('../src/modules/web-headers');
const CookieSecurityModule = require('../src/modules/cookie-security');
const { isJsonApiResponse, fetchLivePage } = require('../website/app/lib/live-scan-config');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

const JSON_REASON = 'JSON API host — HTML checks do not apply';

describe('isJsonApiResponse — one definition of "is this a JSON API host"', () => {
  it('true on an application/json content-type, regardless of body', () => {
    assert.equal(isJsonApiResponse(new Headers({ 'content-type': 'application/json; charset=utf-8' }), '{}'), true);
  });

  it('true on a JSON-ish +json content-type (e.g. application/vnd.api+json)', () => {
    assert.equal(isJsonApiResponse(new Headers({ 'content-type': 'application/vnd.api+json' }), '{"data":[]}'), true);
  });

  it('false on text/html content-type even if the body happens to start with a brace', () => {
    assert.equal(isJsonApiResponse(new Headers({ 'content-type': 'text/html' }), '{ not really json'), false);
  });

  it('fallback: no usable content-type, body has no <html> and parses as JSON -> true', () => {
    assert.equal(isJsonApiResponse(new Headers(), '{"ok":true}'), true);
    assert.equal(isJsonApiResponse(new Headers(), '[1,2,3]'), true);
  });

  it('fallback: no content-type, body is HTML -> false', () => {
    assert.equal(isJsonApiResponse(new Headers(), '<html><body>hi</body></html>'), false);
  });

  it('fallback: body looks brace-shaped but is not valid JSON -> false (treated as unknown/HTML)', () => {
    assert.equal(isJsonApiResponse(new Headers(), '{not valid json'), false);
  });

  it('empty body -> false', () => {
    assert.equal(isJsonApiResponse(new Headers(), ''), false);
  });
});

describe('fetchLivePage — fixture server control pair (Content-Type drives isJson)', () => {
  it('an HTML fixture host -> isJson false', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Hi</title></head><body><h1>Hi</h1></body></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const page = await fetchLivePage(`http://127.0.0.1:${port}/`);
      assert.ok(page);
      assert.equal(page.isJson, false);
    } finally {
      server.close();
    }
  });

  it('a JSON API fixture host -> isJson true', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', items: [] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const page = await fetchLivePage(`http://127.0.0.1:${port}/`);
      assert.ok(page);
      assert.equal(page.isJson, true);
    } finally {
      server.close();
    }
  });
});

describe('web suite — HTML-only modules report notChecked on a JSON API host, never a fabricated grade', () => {
  const jsonLivePage = { url: 'https://api.example.com/', status: 200, headers: new Headers({ 'content-type': 'application/json' }), html: '{"ok":true}', isJson: true };

  it('seo: JSON host -> not-checked with the JSON reason, no SEO/H1/meta findings', async () => {
    const mod = new SeoModule();
    const r = makeResult();
    await mod.run(r, { livePage: jsonLivePage });
    const nc = r.checks.find((c) => c.name === 'seo:not-checked');
    assert.ok(nc && nc.passed === false && nc.notChecked === true);
    assert.equal(nc.message, JSON_REASON);
    assert.equal(r.checks.length, 1, `seo must report ONLY the not-checked check, got: ${JSON.stringify(r.checks)}`);
  });

  it('accessibility: JSON host -> not-checked with the JSON reason, no a11y findings', async () => {
    const mod = new AccessibilityModule();
    const r = makeResult();
    await mod.run(r, { livePage: jsonLivePage });
    const nc = r.checks.find((c) => c.name === 'accessibility:not-checked');
    assert.ok(nc && nc.passed === false && nc.notChecked === true);
    assert.equal(nc.message, JSON_REASON);
  });

  it('links: JSON host -> not-checked with the JSON reason (no broken-link crawl over JSON)', async () => {
    const mod = new LinksModule();
    const r = makeResult();
    await mod.run(r, { livePage: jsonLivePage });
    const nc = r.checks.find((c) => c.name === 'links:not-checked');
    assert.ok(nc && nc.passed === false && nc.notChecked === true);
    assert.equal(nc.message, JSON_REASON);
  });

  it('liveCrawler: JSON host -> not-checked with the JSON reason, never crawled', async () => {
    const mod = new LiveCrawlerModule();
    const r = makeResult();
    const config = { livePage: jsonLivePage, getModuleConfig: () => ({}), get: () => undefined };
    await mod.run(r, config);
    const nc = r.checks.find((c) => c.name === 'liveCrawler:not-checked');
    assert.ok(nc && nc.passed === false && nc.notChecked === true);
    assert.equal(nc.message, JSON_REASON);
  });

  it('interactiveElements: JSON host -> not-checked with the JSON reason, never launches a browser', async () => {
    const mod = new InteractiveElementsModule();
    const r = makeResult();
    const config = { livePage: jsonLivePage, getModuleConfig: () => ({}), get: () => undefined };
    await mod.run(r, config);
    const nc = r.checks.find((c) => c.name === 'interactiveElements:not-checked');
    assert.ok(nc && nc.passed === false && nc.notChecked === true);
    assert.equal(nc.message, JSON_REASON);
    assert.equal(r.checks.length, 1, 'must return before touching Playwright at all');
  });
});

describe('web suite — header/TLS/cookie/CORS checks still run on a JSON API host (content-type agnostic)', () => {
  it('webHeaders: still fires real findings against a JSON host missing security headers', async () => {
    const mod = new WebHeadersModule();
    const r = makeResult();
    await mod.run(r, {
      livePage: { url: 'https://api.example.com/', status: 200, headers: new Headers({ 'content-type': 'application/json' }), html: '{}', isJson: true },
    });
    assert.ok(r.checks.find((c) => c.name === 'web-headers:live-missing-csp' && c.passed === false));
    assert.ok(!r.checks.find((c) => c.notChecked === true), 'webHeaders must not be gated by the JSON check');
  });

  it('cookieSecurity: still fires real findings against a JSON host with an insecure cookie', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'session=abc123; Path=/');
    const mod = new CookieSecurityModule();
    const r = makeResult();
    await mod.run(r, { livePage: { url: 'https://api.example.com/', headers, html: '{}', isJson: true } });
    assert.ok(r.checks.find((c) => c.name === 'cookie-sec:live-httponly-missing:session' && c.passed === false));
    assert.ok(!r.checks.find((c) => c.notChecked === true), 'cookieSecurity must not be gated by the JSON check');
  });
});

describe('web suite — an HTML host is unaffected by the JSON gate (control)', () => {
  it('seo: an HTML fixture with a missing title still fires the real finding', async () => {
    const mod = new SeoModule();
    const r = makeResult();
    await mod.run(r, { livePage: { url: 'https://good.example.com/', headers: new Headers({ 'content-type': 'text/html' }), html: '<html><head></head><body></body></html>', isJson: false } });
    assert.ok(r.checks.find((c) => c.name === 'seo:title:https://good.example.com/' && c.passed === false));
    assert.ok(!r.checks.find((c) => c.notChecked === true));
  });
});
