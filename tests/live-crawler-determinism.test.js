'use strict';

/**
 * Issue #658 item 2 — grade drift on an UNCHANGED production URL (66 → 40
 * → 32 in one day; the like-for-like hosted pair is 40 → 32, scn_be644792
 * → scn_227b2132, per Tallrig's comment on the issue). No server-side scan
 * history exists to diff those two scanIds directly from a worktree with
 * no production DB access, so this proves the thing in our own code that
 * COULD legitimately vary between two runs of an unchanged site: the
 * crawl-wide wall-clock budget added by #640 (live-crawler.js /
 * live-crawler-http-engine.js / live-crawler-browser-engine.js).
 *
 * Findings from that code archaeology (bca11ec2 #645 → 7c8a659c #652, the
 * two builds Tallrig's scanIds ran on):
 *
 *   - Page-visit order is ALREADY deterministic: both engines use a plain
 *     sequential `while` loop over a FIFO queue (`queue.shift()`), never
 *     `Promise.all`/concurrent fetches, and links are pushed onto the
 *     queue in the order `extractLinks()` finds them in the HTML — so
 *     repeated crawls of byte-identical page content visit pages in the
 *     identical order. No bug found here; this file's "stable order"
 *     assertion pins that down as a regression guard.
 *   - The ONE real source of run-to-run variance is `crawlDeadlineTs`
 *     (#640): `Date.now() + pageTimeout > crawlDeadlineTs` is a genuine
 *     wall-clock race — on a real host, two scans a day apart can
 *     legitimately fetch a different NUMBER of pages if network timing
 *     differed, which changes every count-based finding (broken links,
 *     missing meta description, duplicate titles, ...) and therefore the
 *     score. That is real network nondeterminism, not fixable in our code
 *     (we don't control tallrig.com's response latency), so this test
 *     proves the converse instead: against a FAST, LOCAL fixture (comfortably
 *     inside the budget, so the wall-clock race never fires), our own code
 *     introduces NO additional nondeterminism — two consecutive crawls
 *     produce byte-identical checks, clusters, and Health Score.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const LiveCrawlerModule = require('../src/modules/live-crawler.js');
const { computeHealthScore, deriveModuleCoverage } = require('../website/app/lib/health-score.js');
const { clusterAndRankUrlFindings } = require('../website/app/lib/url-finding-clusterer.js');

describe('live-crawler + health-score — determinism against a fixture site (#658 item 2)', () => {
  let server;
  let baseUrl;

  // Home links to /b, /a, /c in THAT literal order (not alphabetical) —
  // proves visit order follows link-discovery order, not any incidental
  // sort. /a and /b share a duplicate <title>, which lets us read the
  // exact visit order back off `crawl:duplicate-titles`' `urls` array
  // (Map insertion order == page-visit order). /c has a broken image and
  // no meta description (same as every other page here) to produce a
  // handful of real findings to score.
  function pageBody(url) {
    if (url === '/') {
      return `<html><head><title>Home</title></head><body>Home page, plenty of visible text so the blank-page check stays quiet.
        <a href="/b">b</a><a href="/a">a</a><a href="/c">c</a>
      </body></html>`;
    }
    if (url === '/a' || url === '/b') {
      return `<html><head><title>Duplicate</title></head><body>Page ${url}, plenty of visible text so the blank-page check stays quiet.</body></html>`;
    }
    if (url === '/c') {
      return `<html><head><title>Page C</title></head><body>Page C, plenty of visible text so the blank-page check stays quiet.
        <img src="/missing.png">
      </body></html>`;
    }
    return null;
  }

  async function setup() {
    if (server) return;
    server = http.createServer((req, res) => {
      const url = (req.url || '/').split('?')[0];
      if (url === '/missing.png') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const body = pageBody(url);
      // Fixed, fast response — no jitter to accidentally trip the
      // crawl-wide wall-clock budget and turn this into a flaky test.
      if (body) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(body);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Not Found</title></head><body>not found, plenty of text here too</body></html>');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;
  }

  after(() => { if (server) server.close(); });

  async function runOnce() {
    await setup();
    const mod = new LiveCrawlerModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-determinism-'));
    const config = {
      projectRoot,
      // Comfortably inside budget for 4 fast local pages — the #640
      // wall-clock race must never fire in this test.
      _moduleTimeoutMs: 30000,
      getModuleConfig: () => ({
        url: baseUrl, maxPages: 10, timeout: 3000, pageTimeout: 3000, browser: false,
        checkExternal: false, checkSitemap: false, checkRobotsTxt: false, checkFavicon: false,
      }),
      get: () => undefined,
    };
    await mod.run(result, config);
    return checks;
  }

  // Minimal, deliberately non-production-faithful translation — this test
  // is not proving the translator is correct (that's covered elsewhere),
  // only that IDENTICAL checks produce an IDENTICAL score. Mirrors the
  // shape both /api/web/scan routes build: module + severity + ruleKey,
  // skipping `passed`/info checks exactly as they do.
  function toFindings(checks) {
    const out = [];
    for (const c of checks) {
      if (c.passed === true) continue;
      const sev = (c.details && c.details.severity) || 'error';
      if (sev !== 'error' && sev !== 'warning') continue;
      out.push({ severity: sev, title: c.name, body: (c.details && c.details.message) || '', module: 'liveCrawler', ruleKey: c.name });
    }
    return out;
  }

  function scoreFor(checks) {
    const coverage = deriveModuleCoverage([{ module: 'liveCrawler', checks: [] }]); // no not-checked modules in play here
    const { clusters } = clusterAndRankUrlFindings(toFindings(checks));
    return computeHealthScore(clusters, coverage);
  }

  it('CONTROL — two consecutive crawls of an unchanged fixture produce byte-identical checks', async () => {
    const run1 = await runOnce();
    const run2 = await runOnce();

    // Budget must never have fired — this proves the comparison below is
    // measuring OUR determinism, not re-deriving the (expected, honest)
    // wall-clock variance #640 accepts on a real, slower host.
    assert.equal(run1.find((c) => c.name === 'crawl:not-checked:budget'), undefined);
    assert.equal(run2.find((c) => c.name === 'crawl:not-checked:budget'), undefined);

    assert.deepEqual(run1, run2, 'two crawls of an unchanged fixture must produce identical checks');
  });

  it('page-visit order follows link-discovery order, not any incidental sort (regression guard)', async () => {
    const checks = await runOnce();
    const dup = checks.find((c) => c.name === 'crawl:duplicate-titles');
    assert.ok(dup, 'expected a duplicate-titles finding for /a and /b sharing a title');
    const urls = dup.details.details[0].urls.map((u) => new URL(u).pathname);
    // Home's HTML links to /b before /a — the queue is FIFO, so /b must be
    // visited (and therefore recorded) before /a, never alphabetical.
    assert.deepEqual(urls, ['/b', '/a']);
  });

  it('two consecutive crawls of an unchanged fixture produce the identical Health Score', async () => {
    const score1 = scoreFor(await runOnce());
    const score2 = scoreFor(await runOnce());

    assert.equal(score1.score, score2.score);
    assert.equal(score1.grade, score2.grade);
    assert.deepEqual(
      score1.deductions.map((d) => ({ ruleKey: d.ruleKey, severity: d.severity, deduction: d.deduction, instances: d.instances })),
      score2.deductions.map((d) => ({ ruleKey: d.ruleKey, severity: d.severity, deduction: d.deduction, instances: d.instances }))
    );
  });
});
