'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const LiveCrawlerModule = require('../src/modules/live-crawler');
const { extractTitle, extractDeclaredIconHref } = require('../src/modules/live-crawler-http-helpers');

// ============================================================================
// #641 defect 1 — <title data-sm="..."> counted as missing-title
// ============================================================================
// live-crawler-http-engine.js used a bare `/<title>([^<]*)<\/title>/i`, which
// requires an attribute-free tag. Framework-rendered pages commonly emit
// `<title data-sm="...">Home</title>` (reproduced on tallrig.com, 18/18
// false positives in one crawl) — the page plainly has a title, the regex
// just couldn't see it. extractTitle() (live-crawler-http-helpers.js) is now
// the one definition, and accepts attributes.
describe('extractTitle — one definition, attributes accepted (#641)', () => {
  it('CONTROL — a title with attributes is read correctly', () => {
    assert.strictEqual(extractTitle('<html><head><title data-sm="00000001">Home — Tallrig</title></head></html>'), 'Home — Tallrig');
    assert.strictEqual(extractTitle('<title class="x" id="y">Deploy — Tallrig</title>'), 'Deploy — Tallrig');
  });

  it('POSITIVE CONTROL — an empty title still counts as missing', () => {
    assert.strictEqual(extractTitle('<title></title>'), null);
    assert.strictEqual(extractTitle('<title data-sm="1">   </title>'), null);
  });

  it('POSITIVE CONTROL — no title tag at all still counts as missing', () => {
    assert.strictEqual(extractTitle('<html><head></head><body>hi</body></html>'), null);
  });
});

describe('live-crawler HTTP engine — missing-title control pair end-to-end (#641)', () => {
  let server;
  let baseUrl;

  async function setup() {
    if (server) return;
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (req.url === '/attrs') {
        res.end('<html><head><title data-sm="00000001000009000000030">Attrs Page</title></head><body>page with a title tag carrying attributes, plenty of visible text here to avoid the blank-page check</body></html>');
        return;
      }
      if (req.url === '/empty') {
        res.end('<html><head><title></title></head><body>page with an empty title tag, plenty of visible text here to avoid the blank-page check</body></html>');
        return;
      }
      if (req.url === '/none') {
        res.end('<html><head></head><body>page with no title tag at all, plenty of visible text here to avoid the blank-page check</body></html>');
        return;
      }
      res.end(`<html><head><title>Home</title></head><body>home page with enough visible text to not look blank
        <a href="/attrs">attrs</a>
        <a href="/empty">empty</a>
        <a href="/none">none</a>
      </body></html>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;
  }

  after(() => { if (server) server.close(); });

  it('a page with an attributed <title> is NOT reported missing; empty/absent titles still are', async () => {
    await setup();
    const mod = new LiveCrawlerModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-title-'));
    const config = {
      projectRoot,
      getModuleConfig: () => ({
        url: baseUrl, maxPages: 10, timeout: 5000, browser: false,
        checkExternal: false, checkSitemap: false, checkRobotsTxt: false, checkFavicon: false,
      }),
      get: () => undefined,
    };
    await mod.run(result, config);

    const missingTitle = checks.find((c) => c.name === 'crawl:error:missing-title');
    assert.ok(missingTitle, 'expected a missing-title check for /empty and /none');
    const urls = missingTitle.details.details.map((d) => d.url);
    assert.ok(!urls.includes(`${baseUrl}attrs`), '<title data-sm="..."> must NOT be flagged missing');
    assert.ok(urls.includes(`${baseUrl}empty`), 'an empty <title></title> must still be flagged');
    assert.ok(urls.includes(`${baseUrl}none`), 'a page with no <title> at all must still be flagged');
    assert.strictEqual(urls.length, 2, `expected exactly 2 missing-title findings, got ${JSON.stringify(urls)}`);
  });
});

// ============================================================================
// #641 defect 2 — favicon-missing ignores a declared <link rel="icon">
// ============================================================================
describe('extractDeclaredIconHref — one definition of "what icon does this page declare" (#641)', () => {
  it('CONTROL — rel="icon" is found', () => {
    assert.strictEqual(
      extractDeclaredIconHref('<head><link rel="icon" href="/favicon.svg" type="image/svg+xml"></head>'),
      '/favicon.svg',
    );
  });
  it('CONTROL — legacy rel="shortcut icon" is found', () => {
    assert.strictEqual(
      extractDeclaredIconHref('<link rel="shortcut icon" href="/icon.png">'),
      '/icon.png',
    );
  });
  it('CONTROL — rel="apple-touch-icon" is found', () => {
    assert.strictEqual(
      extractDeclaredIconHref('<link rel="apple-touch-icon" href="/apple.png">'),
      '/apple.png',
    );
  });
  it('POSITIVE CONTROL — no icon link at all returns null', () => {
    assert.strictEqual(extractDeclaredIconHref('<link rel="stylesheet" href="/app.css">'), null);
  });
  it('does not match an icon link sitting inside a comment', () => {
    assert.strictEqual(extractDeclaredIconHref('<!-- <link rel="icon" href="/dead.svg"> -->'), null);
  });
});

describe('live-crawler — favicon control pair end-to-end (#641)', () => {
  let server;
  let baseUrl;
  let homeHtml;

  async function setup() {
    if (server) return;
    server = http.createServer((req, res) => {
      if (req.url === '/favicon.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end('<svg></svg>');
        return;
      }
      if (req.url === '/' || req.url === '') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(homeHtml);
        return;
      }
      // Everything else — including /favicon.ico — 404s, deliberately.
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;
  }

  after(() => { if (server) server.close(); });

  async function crawl() {
    const mod = new LiveCrawlerModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-favicon-'));
    const config = {
      projectRoot,
      getModuleConfig: () => ({
        url: baseUrl, maxPages: 5, timeout: 5000, browser: false,
        checkExternal: false, checkSitemap: false, checkRobotsTxt: false, checkFavicon: true,
      }),
      get: () => undefined,
    };
    await mod.run(result, config);
    return checks;
  }

  it('CONTROL — a page declaring a resolving /favicon.svg is NOT flagged, even though /favicon.ico 404s', async () => {
    homeHtml = '<html><head><title>Home</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"></head><body>home page with plenty of visible text to avoid the blank-page check</body></html>';
    await setup();
    const checks = await crawl();
    assert.strictEqual(checks.find((c) => c.name === 'crawl:favicon-missing'), undefined,
      'a declared icon that resolves must suppress the finding even though /favicon.ico itself 404s');
  });

  it('POSITIVE CONTROL — a page declaring neither an icon link nor a working /favicon.ico IS flagged, severity info', async () => {
    homeHtml = '<html><head><title>Home</title></head><body>home page with plenty of visible text to avoid the blank-page check</body></html>';
    await setup();
    const checks = await crawl();
    const finding = checks.find((c) => c.name === 'crawl:favicon-missing');
    assert.ok(finding, 'expected a favicon-missing finding when neither resolves');
    assert.strictEqual(finding.passed, false);
    assert.strictEqual(finding.details.severity, 'info');
  });
});
