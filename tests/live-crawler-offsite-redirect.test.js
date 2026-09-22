'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const LiveCrawlerModule = require('../src/modules/live-crawler');

// ============================================================================
// #634 — off-site links must be judged by their first hop only
// ============================================================================
// Reproduced on gluecron.com: GET https://gluecron.com/login/google answered
// 302 to accounts.google.com (a perfectly normal OAuth redirect — 2xx/3xx
// from the target's OWN origin is fine). The crawler kept following it
// through Google's own further redirects and landed on a 404 on
// accounts.google.com, then reported THAT status as a broken finding on
// gluecron.com — grading a page the crawl does not own. fetchPage()
// (live-crawler-http-helpers.js) now stops following a redirect the moment
// it leaves the origin the crawl started at, and the target's own first-hop
// status (the 3xx) is what gets recorded — never the off-site terminus.
describe('live-crawler — off-site redirect chain control pair (#634)', () => {
  let appServer, extServer, appUrl, extUrl;

  function startServer(handler) {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  async function setup() {
    if (appServer) return;
    // The "off-site" host — its own further redirect chain terminates in a
    // 404. The crawl must never even reach this far.
    extServer = await startServer((req, res) => {
      if (req.url === '/v3/signin/') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('not found');
        return;
      }
      res.writeHead(302, { Location: '/v3/signin/' });
      res.end();
    });
    extUrl = `http://127.0.0.1:${extServer.address().port}`;

    appServer = await startServer((req, res) => {
      if (req.url === '/login/x') {
        // The target's OWN first hop — a normal redirect, off-site.
        res.writeHead(302, { Location: `${extUrl}/o/auth` });
        res.end();
        return;
      }
      if (req.url === '/dead') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><title>Home</title></head><body>home page with enough visible text to not look blank at all
        <a href="/login/x">login with google</a>
        <a href="/dead">dead link</a>
      </body></html>`);
    });
    appUrl = `http://127.0.0.1:${appServer.address().port}/`;
  }

  after(() => {
    if (appServer) appServer.close();
    if (extServer) extServer.close();
  });

  async function crawl() {
    await setup();
    const mod = new LiveCrawlerModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-offsite-'));
    const config = {
      projectRoot,
      getModuleConfig: () => ({
        url: appUrl, maxPages: 10, timeout: 5000, browser: false,
        checkExternal: false, checkSitemap: false, checkRobotsTxt: false, checkFavicon: false,
      }),
      get: () => undefined,
    };
    await mod.run(result, config);
    return checks;
  }

  it('CONTROL — /login/x 302s off-site to a URL that 404s: no broken-link / http-error finding', async () => {
    const checks = await crawl();

    const httpError = checks.find((c) => c.name === 'crawl:error:http-error');
    if (httpError) {
      const urls = httpError.details.details.map((d) => d.url);
      assert.ok(!urls.some((u) => u.includes('login/x')), `/login/x must not be reported as an http-error: ${JSON.stringify(urls)}`);
    }
    const brokenLinks = checks.find((c) => c.name === 'crawl:broken-links');
    if (brokenLinks) {
      const links = brokenLinks.details.details.map((d) => d.link || d.page);
      assert.ok(!links.some((u) => (u || '').includes('login/x')), `/login/x must not appear in broken-links: ${JSON.stringify(links)}`);
    }

    const offSite = checks.find((c) => c.name === 'crawl:off-site-redirect');
    assert.ok(offSite, 'expected a crawl:off-site-redirect disclosure check');
    assert.strictEqual(offSite.passed, true, 'off-site redirect disclosure must be informational, never a failing finding');
    assert.strictEqual(offSite.details.severity, 'info');
    assert.ok(
      offSite.details.details.some((d) => d.page === `${appUrl}login/x`),
      `expected /login/x in the off-site-redirect details: ${JSON.stringify(offSite.details.details)}`,
    );
  });

  it('POSITIVE CONTROL — /dead 404s on-site: still reported as a real http-error', async () => {
    const checks = await crawl();
    const httpError = checks.find((c) => c.name === 'crawl:error:http-error');
    assert.ok(httpError, 'expected an http-error check for the on-site 404');
    const urls = httpError.details.details.map((d) => d.url);
    assert.ok(urls.includes(`${appUrl}dead`), `expected /dead in the http-error details: ${JSON.stringify(urls)}`);
  });
});
