'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const LiveCrawlerModule = require('../src/modules/live-crawler');

// Regression: against a host whose pages take a few seconds each (or one
// that stalls outright), the crawl used to have only the module's overall
// wall-clock ceiling (120s) to work with — a handful of slow/stalled pages
// could burn the whole budget before the module ever reached
// generateFeedbackReport, so the run ended with ZERO pages recorded and a
// single opaque timeout line (see tests/live-crawler-concurrent-runs.test.js
// for that end-to-end shape). Each page now has its own bounded fetch budget
// (`pageTimeout`, default 15000ms, `--crawl-page-timeout`), so one stalled
// page is recorded as a timeout finding with its URL/elapsed time and the
// crawl keeps going — fast pages still get scanned and the module completes
// with a clearly labelled partial report.
describe('live-crawler — per-page timeout budget', () => {
  let server;
  let baseUrl;
  const openSockets = new Set();

  async function setup() {
    if (server) return;
    server = http.createServer((req, res) => {
      if (req.url === '/slow') {
        // Never responds — the connection is held open by the test fixture,
        // not destroyed until `after()`.
        return;
      }
      if (req.url === '/fast') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Fast</title></head><body>fast page, answers immediately, plenty of visible text here</body></html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><title>Home</title></head><body>home page with enough visible text to not look blank
        <a href="/fast">fast</a>
        <a href="/slow">slow</a>
      </body></html>`);
    });
    server.on('connection', (socket) => openSockets.add(socket));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;
  }

  after(() => {
    for (const socket of openSockets) socket.destroy();
    if (server) server.close();
  });

  it('CONTROL PAIR — /fast is scanned, /slow is a per-page timeout, run stays well under the module ceiling', async () => {
    await setup();
    const mod = new LiveCrawlerModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-pagetimeout-'));
    const config = {
      projectRoot,
      getModuleConfig: () => ({
        url: baseUrl,
        maxPages: 5,
        timeout: 5000,
        pageTimeout: 1200, // short relative to the module's 120s ceiling, but generous enough not to flake under CI load
        browser: false,
        checkExternal: false,
        checkSitemap: false,
        checkRobotsTxt: false,
        checkFavicon: false,
      }),
      get: () => undefined,
    };

    const startedAt = Date.now();
    await mod.run(result, config);
    const elapsedMs = Date.now() - startedAt;

    // The module's real wall-clock ceiling is 120000ms — this must finish
    // in a small fraction of that (one bounded 400ms timeout, not a hang).
    assert.ok(elapsedMs < 10000, `expected a bounded run, took ${elapsedMs}ms`);

    const scanned = checks.find((c) => c.name === 'crawl:pages-scanned');
    assert.ok(scanned, 'expected a pages-scanned check');
    assert.match(scanned.details.message, /2 page\(s\)/); // home + /fast

    const timeouts = checks.find((c) => c.name === 'crawl:page-timeouts');
    assert.ok(timeouts, 'expected a crawl:page-timeouts check');
    assert.strictEqual(timeouts.passed, false);
    assert.match(timeouts.details.message, /1 of 3/);
    assert.ok(
      timeouts.details.details.some((d) => d.url === `${baseUrl}slow`),
      `expected /slow in the timeout details: ${JSON.stringify(timeouts.details.details)}`,
    );

    const report = fs.readFileSync(path.join(projectRoot, '.gatetest/reports/crawl-feedback.md'), 'utf-8');
    assert.match(report, /Pages scanned: 2 \(1 of 3 timed out\)/);
    assert.match(report, /### Page Timeouts \(1 of 3 pages\)/);
    assert.ok(report.includes(`${baseUrl}slow`), 'report body should name the timed-out URL');
    assert.ok(!report.includes('## RESULT: ALL CLEAR'), 'a run with a page timeout must not claim ALL CLEAR');
    assert.match(report, /## RESULT: ISSUES FOUND/);
  });
});
