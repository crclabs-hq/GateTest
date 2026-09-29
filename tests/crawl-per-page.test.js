'use strict';

/**
 * Issue #815 — `--crawl <url> --module seo` used to audit the ENTRY page
 * only: the crawler fetched every page but handed none of them to the
 * page-level modules, so a missing meta description on /pricing was
 * invisible while / was clean, and the customer read "crawl and test every
 * page" off a one-page audit.
 *
 * Contract, each half proved against a real fixture site through the real
 * CLI, plus the two helpers it stands on:
 *   - the crawler keeps every HTML page it fetched (headers + body, bounded)
 *     and hands the first --crawl-check-pages of them to webHeaders,
 *     cookieSecurity, accessibility and seo (`retainPagesForChecks`)
 *   - each page is audited by the SAME checks the hosted single-page scan
 *     runs; a finding cites the page it was found on (`url`), and the same
 *     finding on N pages is ONE finding listing N `pages` (`_foldLivePages`)
 *   - a clean page is not cited; the total equals the sum of the folded groups
 *   - pages past the cap are named on the "N pages not checked" line and in
 *     `pageChecks`, never silently skipped
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { retainPagesForChecks, CRAWLED_PAGE_BODY_CAP } = require('../src/core/live-scan-config');
const BaseModule = require('../src/modules/base-module');
const { TestResult } = require('../src/core/runner');

const GATETEST_BIN = path.join(__dirname, '..', 'bin', 'gatetest.js');

const FILLER = '<p>Plenty of visible text on this page so the crawler never calls it blank or nearly empty at all.</p>';
const page = ({ title, description, body }) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title}</title>${description ? `\n<meta name="description" content="${description}">` : ''}
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><main><h1>${title}</h1>${body || ''}${FILLER}</main></body></html>`;

// Three pages: / and /login are clean; ONLY /pricing lacks a meta description.
const SITE = {
  '/': page({
    title: 'Fixture home page for the per-page crawl test',
    description: 'A tiny fixture home page with a title, a description and one heading, linking to two more pages.',
    body: '<nav><a href="/pricing">Pricing</a> <a href="/login">Sign in</a></nav>',
  }),
  '/pricing': page({ title: 'Fixture pricing page that is missing its meta description' }),
  '/login': page({
    title: 'Fixture sign-in page for the per-page crawl test',
    description: 'A tiny fixture sign-in page with a title, a description and one heading and nothing else to flag.',
  }),
};

function serve(site) {
  const server = http.createServer((req, res) => {
    const html = site[req.url];
    if (!html) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
  }));
}

function runCli(args, { timeoutMs = 40000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATETEST_BIN, ...args], {
      env: { ...process.env, GATETEST_NO_TELEMETRY: '1', CI: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
  });
}

describe('retainPagesForChecks: which crawled pages the page-level modules get (#815)', () => {
  const html = (url, extra = {}) => ({ url, status: 200, contentType: 'text/html; charset=utf-8', headers: { 'x-a': '1' }, body: '<html><title>t</title></html>', ...extra });

  it('keeps HTML pages in crawl order in livePage shape, up to the cap, and counts the rest', () => {
    const kept = retainPagesForChecks([html('http://h/'), html('http://h/a'), html('http://h/b')], 2);
    assert.deepEqual(kept.pages.map((p) => p.url), ['http://h/', 'http://h/a']);
    assert.deepEqual(kept.pages[0], { url: 'http://h/', status: 200, headers: { 'x-a': '1' }, html: '<html><title>t</title></html>', isJson: false });
    assert.deepEqual({ crawled: kept.crawled, checked: kept.checked, capped: kept.capped, oversize: kept.oversize }, { crawled: 3, checked: 2, capped: 1, oversize: 0 });
  });

  it('CONTROL: a 404, a non-HTML response, an off-site redirect and an empty body are not pages to audit', () => {
    const kept = retainPagesForChecks([
      html('http://h/'),
      html('http://h/missing', { status: 404 }),
      html('http://h/api', { contentType: 'application/json', body: '{"a":1}' }),
      html('http://h/out', { offSiteRedirect: true }),
      html('http://h/empty', { body: '' }),
    ], 25);
    assert.deepEqual(kept.pages.map((p) => p.url), ['http://h/']);
    assert.equal(kept.crawled, 1);
  });

  it('an oversize body is left out and counted, never truncated into a false "missing title"', () => {
    const kept = retainPagesForChecks([html('http://h/'), html('http://h/big', { body: 'x'.repeat(CRAWLED_PAGE_BODY_CAP + 1) })], 25);
    assert.deepEqual(kept.pages.map((p) => p.url), ['http://h/']);
    assert.deepEqual({ crawled: kept.crawled, checked: kept.checked, oversize: kept.oversize }, { crawled: 2, checked: 1, oversize: 1 });
  });

  it('a page the engine kept no headers for carries headers: null (header modules skip it)', () => {
    const kept = retainPagesForChecks([{ url: 'http://h/', status: 200, body: '<html></html>' }], 1);
    assert.equal(kept.pages[0].headers, null);
  });
});

describe('BaseModule#_foldLivePages: one finding per distinct issue, every page listed (#815)', () => {
  const mod = new BaseModule('x', 'fold test');
  const pages = [{ url: 'http://h/', bad: false }, { url: 'http://h/pricing', bad: true }, { url: 'http://h/login', bad: false }];
  const audit = (p, sink) => {
    sink.addCheck(`x:og:${p.url}`, false, { severity: 'warning', message: 'No og:title', suggestion: 'add it' });
    sink.addCheck(`x:title:${p.url}`, true);
    if (p.bad) sink.addCheck(`x:description:${p.url}`, false, { severity: 'error', message: 'No meta description' });
  };

  it('a finding on one page keeps that page as its URL; the same finding on every page is one check listing them all', () => {
    const result = new TestResult('x');
    const distinct = mod._foldLivePages(pages, result, audit);
    assert.equal(distinct, 2);
    assert.equal(result.checks.length, 2, 'passing checks are one page\'s pass, not the site\'s');
    const site = result.checks.find((c) => c.name === 'x:og');
    assert.ok(site, JSON.stringify(result.checks));
    assert.deepEqual(site.pages, ['http://h/', 'http://h/pricing', 'http://h/login']);
    assert.equal(site.file, 'http://h/');
    assert.equal(site.message, 'No og:title — on 3 of 3 crawled pages');
    assert.equal(site.suggestion, 'add it');
    const one = result.checks.find((c) => c.name === 'x:description:http://h/pricing');
    assert.ok(one, JSON.stringify(result.checks));
    assert.deepEqual(one.pages, ['http://h/pricing']);
    assert.equal(one.file, 'http://h/pricing');
    assert.equal(one.message, 'No meta description');
  });

  it('CONTROL: with no page carrying the issue, it is not recorded at all', () => {
    const result = new TestResult('x');
    mod._foldLivePages(pages.map((p) => ({ ...p, bad: false })), result, audit);
    assert.ok(!result.checks.some((c) => /description/.test(c.name)));
  });

  it('_crawledPages reads the crawl result the runner handed over and nothing else', () => {
    const crawl = new TestResult('liveCrawler');
    crawl.crawledPages = [{ url: 'http://h/' }];
    assert.deepEqual(mod._crawledPages({ _allResults: [crawl] }), [{ url: 'http://h/' }]);
    assert.equal(mod._crawledPages({ _allResults: [new TestResult('liveCrawler')] }), null, 'a crawl that kept no pages');
    assert.equal(mod._crawledPages({ _allResults: [] }), null);
    assert.equal(mod._crawledPages({}), null);
  });
});

describe('gatetest --crawl --module <page-level>: every crawled page is audited and cited (#815, CLI level)', () => {
  let site;
  let projectRoot;
  before(async () => {
    site = await serve(SITE);
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-per-page-'));
  });
  after(() => {
    site.server.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const base = () => ['--crawl', site.url, '--project', projectRoot, '--crawl-max', '5', '--crawl-page-timeout', '3000', '--no-artifacts', '--format', 'json'];
  const isDescription = (f) => /^seo:seo:description/.test(f.type);

  it('the missing description is attributed to /pricing; / and /login are not cited; the count equals the sum', async () => {
    const r = await runCli([...base(), '--module', 'seo']);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.pageChecks, { crawled: 3, checked: 3, notChecked: 0, cap: 25 }, JSON.stringify(doc));
    const description = doc.findings.filter(isDescription);
    assert.equal(description.length, 1, JSON.stringify(doc.findings));
    assert.equal(description[0].url, `${site.url}pricing`);
    assert.deepEqual(description[0].pages, [`${site.url}pricing`]);
    // CONTROL: the clean pages are listed nowhere for that finding.
    for (const f of doc.findings) {
      if (!isDescription(f)) continue;
      assert.ok(!(f.pages || []).some((u) => u === site.url || u.endsWith('/login')), JSON.stringify(f));
    }
    // A site-wide miss (no Open Graph tags anywhere) is ONE finding listing all three pages.
    const siteWide = doc.findings.find((f) => /^seo:/.test(f.type) && Array.isArray(f.pages) && f.pages.length === 3);
    assert.ok(siteWide, JSON.stringify(doc.findings));
    assert.equal(siteWide.url, site.url);
    assert.match(siteWide.message, / — on 3 of 3 crawled pages$/);
    // The console line's count is the JSON document's count.
    const seoFindings = doc.findings.filter((f) => /^seo:/.test(f.type));
    const line = r.stderr.split('\n').find((l) => /ran against/.test(l));
    assert.ok(line, r.stderr);
    assert.match(line, new RegExp(`: seo \\(${seoFindings.length} findings? on 3 of 3 crawled pages\\)`));
    assert.equal(doc.exitCode, 1, 'the missing description is a blocking finding');
  });

  it('CONTROL PAIR: --crawl-check-pages 1 audits the entry page only, names the 2 unchecked pages, and /pricing is no longer cited', async () => {
    const r = await runCli([...base(), '--module', 'seo', '--crawl-check-pages', '1']);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.pageChecks, { crawled: 3, checked: 1, notChecked: 2, cap: 1 }, JSON.stringify(doc));
    assert.equal(doc.findings.filter(isDescription).length, 0, JSON.stringify(doc.findings));
    assert.match(r.stderr, /on 1 of 3 crawled pages; 2 pages not checked \(--crawl-check-pages 1\)/, r.stderr);
    assert.equal(doc.pagesScanned, 3, 'the crawl itself still visited every page');
  });

  it('webHeaders: identical header findings across the site fold to one finding listing every page', async () => {
    const r = await runCli([...base(), '--module', 'webHeaders']);
    const doc = JSON.parse(r.stdout);
    const hsts = doc.findings.find((f) => f.type === 'webHeaders:web-headers:live-missing-hsts');
    assert.ok(hsts, JSON.stringify(doc.findings));
    assert.deepEqual(hsts.pages, [site.url, `${site.url}pricing`, `${site.url}login`]);
    assert.equal(hsts.url, site.url);
    assert.equal(doc.findings.filter((f) => /live-missing-hsts/.test(f.type)).length, 1, 'one finding, not three');
  });
});
