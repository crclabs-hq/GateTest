// The live crawler treats HTTP 429 as the site's answer to OUR request rate,
// not as a broken page (gluecron.com 2026-10-03: ~35 pages reported as 429
// failures by the crawl's own burst; 120 parallel browser requests drew
// none). Run against a real local server: a transient 429 is retried after
// Retry-After and recovers; a persistent 429 comes back marked rateLimited
// (reported "not checked"); a real 404 is still a failure.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const helpers = require('../src/modules/live-crawler-http-helpers');

let server;
let base;
const hits = new Map();

before(async () => {
  server = http.createServer((req, res) => {
    const n = (hits.get(req.url) || 0) + 1;
    hits.set(req.url, n);
    if (req.url === '/flaky' && n <= 2) { res.writeHead(429, { 'Retry-After': '0' }); return res.end('slow down'); }
    if (req.url === '/always') { res.writeHead(429, { 'Retry-After': '0' }); return res.end('slow down'); }
    if (req.url === '/busy') { res.writeHead(503, { 'Retry-After': '0' }); return res.end('busy'); }
    if (req.url === '/gone') { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>ok</title></head><body>ok</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); helpers._hostDelayMs.clear(); });

describe('live crawler — rate limiting is not breakage', () => {
  it('a transient 429 is retried after Retry-After and recovers', async () => {
    const r = await helpers.fetchPage(`${base}/flaky`, 5000);
    assert.strictEqual(r.status, 200);
    assert.ok(!r.rateLimited);
    assert.strictEqual(hits.get('/flaky'), 3);
  });

  it('a persistent 429 comes back marked rateLimited after two retries', async () => {
    const r = await helpers.fetchPage(`${base}/always`, 5000);
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.rateLimited, true);
    assert.strictEqual(hits.get('/always'), 3);
  });

  it('HEAD checks (assets, links) follow the same rule, including 503 + Retry-After', async () => {
    const r = await helpers.checkUrl(`${base}/busy`, 5000);
    assert.strictEqual(r.rateLimited, true);
  });

  it('control: a real 404 is not rate limiting', async () => {
    const r = await helpers.checkUrl(`${base}/gone`, 5000);
    assert.strictEqual(r.status, 404);
    assert.ok(!r.rateLimited);
  });

  it('Retry-After is honoured and capped', () => {
    assert.strictEqual(helpers.retryAfterMs({ headers: { 'retry-after': '3' } }, 0), 3000);
    assert.strictEqual(helpers.retryAfterMs({ headers: { 'retry-after': '3600' } }, 0), 10000);
    assert.strictEqual(helpers.retryAfterMs({ headers: {} }, 1), 2000);
  });
});

describe('live crawler report — a rate-limited page is "not checked", never broken', () => {
  const report = require('../src/modules/live-crawler-report');
  const data = {
    baseUrl: 'https://example.test/', pagesScanned: 9, maxPages: 50,
    errors: [], brokenLinks: [], brokenImages: [], brokenScripts: [], brokenStylesheets: [],
    timedOutPages: [], budgetExhausted: false,
    rateLimited: [{ url: 'https://example.test/limited', status: 429, kind: 'page' }],
  };
  it('appears in the JSON findings as rate-limited, not as an error', () => {
    const f = report.buildCrawlFindings(data);
    assert.ok(f.some((x) => x.type === 'rate-limited' && x.url === 'https://example.test/limited'));
    assert.ok(!f.some((x) => x.severity === 'error'));
  });

  it('is never ALL CLEAR, and blocks only past the not-checked share, like a timeout', () => {
    assert.notStrictEqual(report.crawlResultLabel(data), 'ALL CLEAR');
    assert.strictEqual(report.crawlExitCode(data), 0); // 1 of 10 pages not checked < 20%
    const mostlyLimited = { ...data, pagesScanned: 2, rateLimited: Array.from({ length: 8 }, (_, i) => ({ url: `https://example.test/${i}`, status: 429, kind: 'page' })) };
    assert.strictEqual(report.crawlExitCode(mostlyLimited), 1);
  });

  it('a rate-limited asset is info, and does not count as a page not checked', () => {
    const assetOnly = { ...data, rateLimited: [{ url: 'https://example.test/app.js', status: 429, kind: 'script' }] };
    assert.strictEqual(report.crawlResultLabel(assetOnly), 'ALL CLEAR');
    assert.ok(report.buildCrawlFindings(assetOnly).some((x) => x.type === 'rate-limited' && x.severity === 'info'));
  });
});
