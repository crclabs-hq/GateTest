'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const LiveCrawlerModule = require('../src/modules/live-crawler');
const { fetchPage } = require('../src/modules/live-crawler-http-helpers');

// ============================================================================
// #812 - a redirect must not carry an error page
// ============================================================================
// https://gatetest.io/docs answered 307 -> /developers with a 16,518-byte body
// whose root was `<html id="__next_error__">`. Browsers follow the Location and
// never see it; crawlers and monitors read an error page. The crawler read no
// body on a 3xx hop at all, so the defect was invisible to the tool that
// should catch it on customers' sites. fetchPage() now reads each same-origin
// hop's body (capped) and flags `id="__next_error__"`; the live crawler raises
// `crawl:error:redirect-error-page`.
describe('live-crawler - redirect that carries an error page (#812)', () => {
  const ERROR_SHELL = '<!DOCTYPE html><html id="__next_error__"><head><title>x</title></head><body>' + 'x'.repeat(2000) + '</body></html>';
  let server, baseUrl;

  async function setup() {
    if (server) return;
    server = http.createServer((req, res) => {
      if (req.url === '/bad-redirect') {
        res.writeHead(307, { Location: '/target', 'Content-Type': 'text/html' });
        res.end(ERROR_SHELL);
        return;
      }
      if (req.url === '/clean-redirect') {
        res.writeHead(307, { Location: '/target' });
        res.end();
        return;
      }
      if (req.url === '/bad-then-clean') {
        res.writeHead(307, { Location: '/clean-redirect', 'Content-Type': 'text/html' });
        res.end(ERROR_SHELL);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (req.url === '/target') {
        res.end('<html><head><title>Target</title><meta name="description" content="d"></head><body>the real page with enough visible text to not look blank at all</body></html>');
        return;
      }
      res.end(`<html><head><title>Home</title><meta name="description" content="d"></head><body>home page with enough visible text to not look blank at all
        <a href="/bad-redirect">bad</a> <a href="/clean-redirect">clean</a>
      </body></html>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }

  after(() => { if (server) server.close(); });

  async function crawl() {
    await setup();
    const mod = new LiveCrawlerModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const config = {
      projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-rep-')),
      getModuleConfig: () => ({
        url: `${baseUrl}/`, maxPages: 10, timeout: 5000, browser: false,
        checkExternal: false, checkSitemap: false, checkRobotsTxt: false, checkFavicon: false,
      }),
      get: () => undefined,
    };
    await mod.run(result, config);
    return checks;
  }

  it('POSITIVE - a 307 whose body is a __next_error__ shell is flagged on that URL', async () => {
    await setup();
    const page = await fetchPage(`${baseUrl}/bad-redirect`, 5000);
    assert.strictEqual(page.redirected, true);
    assert.strictEqual(page.redirectStatus, 307);
    assert.strictEqual(page.status, 200, 'the followed page is still graded on its own');
    assert.strictEqual(page.redirectCarriesErrorPage, true);

    const checks = await crawl();
    const flagged = checks.find((c) => c.name === 'crawl:error:redirect-error-page');
    assert.ok(flagged, `expected crawl:error:redirect-error-page in ${checks.map((c) => c.name).join(', ')}`);
    const urls = flagged.details.details.map((d) => d.url);
    assert.deepStrictEqual(urls, [`${baseUrl}/bad-redirect`]);
    assert.match(flagged.details.details[0].message, /redirect carries an error page/);
  });

  it('CONTROL - a clean 307 with an empty body is not flagged (and /clean-redirect is not in the finding)', async () => {
    await setup();
    const page = await fetchPage(`${baseUrl}/clean-redirect`, 5000);
    assert.strictEqual(page.redirected, true);
    assert.notStrictEqual(page.redirectCarriesErrorPage, true);

    const checks = await crawl();
    const flagged = checks.find((c) => c.name === 'crawl:error:redirect-error-page');
    assert.ok(flagged);
    assert.ok(!flagged.details.details.some((d) => d.url.includes('clean-redirect')));
  });

  it('a bad hop earlier in a chain is still flagged after a clean hop follows it', async () => {
    await setup();
    const page = await fetchPage(`${baseUrl}/bad-then-clean`, 5000);
    assert.strictEqual(page.redirectCarriesErrorPage, true);
  });
});
