'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const LiveCrawlerModule = require('../src/modules/live-crawler');
const { GateTestRunner } = require('../src/core/runner');
const { GateTestConfig } = require('../src/core/config');

// ============================================================================
// #640 — a slow host under a tight wall-clock budget must yield a PARTIAL
// report, never "no data was collected for this run".
// ============================================================================
// Before this fix, liveCrawler got the generic 120s module ceiling (or
// whatever explicit override was configured) with no idea what that number
// even was — it just kept fetching until the runner's outer race killed the
// whole run() call, abandoning every page already fetched. Now the module
// reads back its own assigned budget (config._moduleTimeoutMs, injected by
// GateTestRunner._runModule) and paces its own crawl loop against it, so a
// tight budget produces a labelled partial report instead of losing
// everything.
describe('live-crawler — wall-clock budget control pair (#640)', () => {
  let server;
  let baseUrl;
  const PAGE_DELAY_MS = 400;

  async function setup() {
    if (server) return;
    server = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><title>${req.url}</title></head><body>page ${req.url}, plenty of visible text here to avoid the blank-page check
          <a href="/a">a</a>
          <a href="/b">b</a>
          <a href="/c">c</a>
        </body></html>`);
      }, PAGE_DELAY_MS);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;
  }

  after(() => { if (server) server.close(); });

  async function crawlDirect(assignedTimeoutMs) {
    await setup();
    const mod = new LiveCrawlerModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-budget-'));
    const config = {
      projectRoot,
      _moduleTimeoutMs: assignedTimeoutMs,
      getModuleConfig: () => ({
        url: baseUrl, maxPages: 10, timeout: 2000, pageTimeout: 600, browser: false,
        checkExternal: false, checkSitemap: false, checkRobotsTxt: false, checkFavicon: false,
      }),
      get: () => undefined,
    };
    const startedAt = Date.now();
    await mod.run(result, config);
    return { checks, elapsedMs: Date.now() - startedAt, projectRoot };
  }

  it('CONTROL — a tight budget (1000ms, 400ms/page, 10-page limit) yields a partial report + the not-checked line', async () => {
    const { checks, elapsedMs, projectRoot } = await crawlDirect(1000);

    // Must finish comfortably inside the assigned budget itself — this IS
    // the outer race timeout in the real runner, so overrunning it defeats
    // the whole point.
    assert.ok(elapsedMs < 1000, `expected the module to self-pace under its own 1000ms budget, took ${elapsedMs}ms`);

    const scanned = checks.find((c) => c.name === 'crawl:pages-scanned');
    assert.ok(scanned, 'expected a pages-scanned check');
    assert.ok(!/10 page/.test(scanned.details.message), `expected fewer than all 10 pages, got: ${scanned.details.message}`);

    const notChecked = checks.find((c) => c.name === 'crawl:not-checked:budget');
    assert.ok(notChecked, 'expected a crawl:not-checked:budget disclosure');
    assert.strictEqual(notChecked.passed, true);
    assert.strictEqual(notChecked.details.severity, 'info');
    assert.match(notChecked.details.message, /of 10 pages fetched in [\d.]+s/);

    assert.strictEqual(checks.find((c) => c.name === 'crawl:clean'), undefined,
      'an incomplete crawl must never claim clean');

    const report = fs.readFileSync(path.join(projectRoot, '.gatetest/reports/crawl-feedback.md'), 'utf-8');
    assert.ok(!report.includes('No crawl report'), 'a report WAS produced — this must not read as "no data"');
    assert.ok(!report.includes('## RESULT: ALL CLEAR'), 'an incomplete crawl must not print ALL CLEAR');
    assert.match(report, /crawl budget exhausted/);
  });

  it('POSITIVE CONTROL — an adequate budget completes the full crawl, no not-checked line', async () => {
    // 4 pages (home + a + b + c) at ~400ms sequential ≈ 1600ms, comfortably
    // inside a 10s budget.
    const { checks, projectRoot } = await crawlDirect(10000);

    const scanned = checks.find((c) => c.name === 'crawl:pages-scanned');
    assert.ok(scanned, 'expected a pages-scanned check');
    assert.match(scanned.details.message, /4 page\(s\)/);

    assert.strictEqual(checks.find((c) => c.name === 'crawl:not-checked:budget'), undefined,
      'a crawl that finished within budget must not carry a not-checked:budget line');

    const clean = checks.find((c) => c.name === 'crawl:clean');
    assert.ok(clean, 'expected a clean crawl with no errors');

    const report = fs.readFileSync(path.join(projectRoot, '.gatetest/reports/crawl-feedback.md'), 'utf-8');
    assert.match(report, /## RESULT: ALL CLEAR/);
    assert.ok(!report.includes('crawl budget exhausted'));
  });

  it('estimateTimeoutMs() sizes the module\'s own budget from crawlMax × pageTimeout + margin', () => {
    const mod = new LiveCrawlerModule();
    const config = {
      getModuleConfig: () => ({ url: 'https://example.com', maxPages: 40, pageTimeout: 20000 }),
      get: () => undefined,
    };
    const estimated = mod.estimateTimeoutMs(config);
    assert.strictEqual(estimated, 40 * 20000 + 30000);
  });

  it('estimateTimeoutMs() defers to the generic default when nothing is configured to crawl', () => {
    const mod = new LiveCrawlerModule();
    const config = { getModuleConfig: () => ({}), get: () => undefined };
    assert.strictEqual(mod.estimateTimeoutMs(config), null);
  });
});

// ============================================================================
// Runner-level integration: the module-declared timeout hook actually wires
// through GateTestRunner, and a tight EXPLICIT override (highest precedence)
// still races the module — proving the module completes gracefully within
// it rather than being killed with a "timed out" module failure (#640).
// ============================================================================
describe('live-crawler — runner integration (#640)', () => {
  let server;
  let baseUrl;

  async function setup() {
    if (server) return;
    server = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Home</title></head><body>home page with plenty of visible text to avoid the blank-page check</body></html>');
      }, 300);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;
  }

  after(() => { if (server) server.close(); });

  it('a tight explicit moduleTimeouts override does not fail the module — it completes with a partial/clean result', async () => {
    await setup();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-runner-budget-'));
    const config = new GateTestConfig(projectRoot);
    config.config.modules.liveCrawler = {
      url: baseUrl, maxPages: 5, timeout: 2000, pageTimeout: 500,
      browser: false, checkExternal: false, checkSitemap: false, checkRobotsTxt: false, checkFavicon: false,
    };
    // Explicit override — the top precedence tier, still above the module's
    // own self-sized estimate.
    const runner = new GateTestRunner(config, { moduleTimeouts: { liveCrawler: 1500 } });
    runner.register('liveCrawler', new LiveCrawlerModule());

    const summary = await runner.run(['liveCrawler']);
    assert.strictEqual(summary.modules.failed, 0, 'the module must not be marked failed by the runner\'s race');
    assert.strictEqual((summary.failedModules || []).length, 0);
  });
});
