'use strict';

/**
 * Issue #802 — `--crawl` used to run the live crawler ALONE: every `--module`
 * / `--suite` beside it was silently ignored (Tallrig's e2e passed
 * `--module ...` with `--crawl` for weeks and none of them ran; a customer
 * crawl of a 40-page site reported "Checks: 3/4 passed").
 *
 * Contract, each half proved against a real fixture server through the real
 * CLI:
 *   - `--crawl <url>` alone: unchanged, the crawl only.
 *   - `--crawl <url> --module seo`: seo runs against the site and its
 *     findings are in the output; the crawl still ran; a clean page passes.
 *   - members that are not crawl-capable are named on ONE line
 *     ("not crawl-capable, skipped: ...") and recorded in summary.deferred.
 *   - a selection with no crawl-capable member is a usage error (exit 2)
 *     under --strict or in CI, and a loud warning (exit unchanged) otherwise.
 *   - the crawl-capable list has one home (CRAWL_CAPABLE_MODULES in
 *     src/core/config.js), a subset of the hosted /web scan's module list.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { CRAWL_CAPABLE_MODULES, partitionCrawlSelection, DEFAULT_CONFIG } = require('../src/core/config');
const { ModuleRegistry } = require('../src/core/registry');

const GATETEST_BIN = path.join(__dirname, '..', 'bin', 'gatetest.js');

const CLEAN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Crawl fixture home page for the modules test</title>
<meta name="description" content="A tiny fixture page with a title, a description, one heading and nothing else that any page-level check would object to on a home page.">
<link rel="canonical" href="/"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><main><h1>Fixture home</h1><p>Plenty of visible text on this page so the crawler does not call it blank.</p></main></body></html>`;

// No description, no h1: seo has something real to say about it.
const SEO_POOR_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Crawl fixture page that is short on seo</title></head>
<body><p>Plenty of visible text on this page so the crawler does not call it blank at all.</p></body></html>`;

function runCli(args, { env, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATETEST_BIN, ...args], {
      env: { ...process.env, GATETEST_NO_TELEMETRY: '1', CI: '', ...(env || {}) },
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

function serve(html) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
  }));
}

describe('CRAWL_CAPABLE_MODULES: one definition (issue #802)', () => {
  it('every member is a module of the hosted /web scan (suites.web), in that order, and is registered', () => {
    const web = DEFAULT_CONFIG.suites.web;
    const registry = new ModuleRegistry();
    registry.loadBuiltIn();
    let last = -1;
    for (const name of CRAWL_CAPABLE_MODULES) {
      const at = web.indexOf(name);
      assert.ok(at > -1, `${name} is crawl-capable but not in suites.web, a second list has drifted`);
      assert.ok(at > last, `${name} is out of suites.web order (liveCrawler must precede links)`);
      last = at;
      assert.ok(registry.get(name), `${name} is not a registered module`);
    }
    assert.ok(web.indexOf('liveCrawler') < web.indexOf('links'));
  });

  it('partitionCrawlSelection splits capable from skipped and keeps a stranger out of capable', () => {
    assert.deepEqual(partitionCrawlSelection(['seo']), { capable: ['seo'], skipped: [] });
    assert.deepEqual(partitionCrawlSelection(['unitTests', 'seo', 'lint']), { capable: ['seo'], skipped: ['unitTests', 'lint'] });
    assert.deepEqual(partitionCrawlSelection(['unitTests']), { capable: [], skipped: ['unitTests'] });
    assert.deepEqual(partitionCrawlSelection([]), { capable: [], skipped: [] });
  });

  it('the CLI help names the modules from the definition, not a copy', () => {
    const src = fs.readFileSync(GATETEST_BIN, 'utf8');
    assert.match(src, /CRAWL_CAPABLE_MODULES\.join\(', '\)/);
    assert.doesNotMatch(src, /'cookieSecurity',\s*'accessibility'/, 'bin/gatetest.js must not carry its own module list');
  });
});

describe('gatetest --crawl honours --module / --suite (issue #802, CLI level)', () => {
  let poor;
  let clean;
  let projectRoot;
  before(async () => {
    poor = await serve(SEO_POOR_PAGE);
    clean = await serve(CLEAN_PAGE);
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-modules-'));
  });
  after(() => {
    poor.server.close();
    clean.server.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const base = (url) => ['--crawl', url, '--project', projectRoot, '--crawl-max', '3', '--crawl-page-timeout', '3000', '--no-artifacts'];

  it('CONTROL: `--crawl` alone is unchanged, the crawl runs and no page-level module does', async () => {
    const r = await runCli(base(poor.url));
    assert.match(r.stdout, /Modules: liveCrawler\b/, r.stdout);
    assert.doesNotMatch(r.stdout, /\[RUN\] seo/, 'seo must not run on a bare --crawl');
    assert.doesNotMatch(r.stdout, /not crawl-capable/);
    assert.doesNotMatch(r.stderr, /ignored with --crawl/);
  });

  it('`--crawl --module seo`: seo findings are present, liveCrawler still ran, exit is 1', async () => {
    const r = await runCli([...base(poor.url), '--module', 'seo']);
    assert.match(r.stdout, /Modules: liveCrawler, seo/, r.stdout);
    assert.match(r.stdout, /\[RUN\] liveCrawler/);
    assert.match(r.stdout, /\[RUN\] seo \[FAIL\]/, r.stdout);
    assert.match(r.stdout, /seo:description:/, 'the missing meta description finding reaches the output');
    assert.match(r.stdout, /ran against .*: seo \(\d+ findings?\)/);
    assert.equal(r.code, 1, r.stdout);
  });

  it('POSITIVE CONTROL: `--crawl --module seo` on a clean page runs seo and passes (exit 0)', async () => {
    const r = await runCli([...base(clean.url), '--module', 'seo']);
    assert.match(r.stdout, /\[RUN\] seo \[PASS\]/, r.stdout);
    // Warnings (missing Open Graph tags) are findings but do not block.
    assert.match(r.stdout, /ran against .*: seo \(\d+ findings?\)/);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  });

  it('`--crawl --module unitTests` (non-strict): warns, names it on the skipped line and in Deferred, exit 0', async () => {
    const r = await runCli([...base(clean.url), '--module', 'unitTests']);
    assert.match(r.stderr, /--module unitTests is ignored with --crawl/);
    assert.match(r.stdout, /not crawl-capable, skipped: unitTests/);
    assert.match(r.stdout, /Deferred: unitTests/);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  });

  it('`--crawl --module unitTests --strict`: usage error, exit 2, nothing crawled', async () => {
    const r = await runCli([...base(clean.url), '--module', 'unitTests', '--strict']);
    assert.equal(r.code, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /--module unitTests is ignored with --crawl/);
    assert.doesNotMatch(r.stdout, /Crawling/);
  });

  it('`--crawl --module unitTests` in CI: usage error, exit 2', async () => {
    const r = await runCli([...base(clean.url), '--module', 'unitTests'], { env: { CI: 'true' } });
    assert.equal(r.code, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /ignored with --crawl/);
  });

  it('`--crawl --suite web` runs the crawl-capable members and names the rest on one line', async () => {
    const r = await runCli([...base(clean.url), '--suite', 'web']);
    for (const m of ['liveCrawler', 'webHeaders', 'seo', 'links']) {
      assert.match(r.stdout, new RegExp(`\\[RUN\\] ${m} `), `${m} should have run\n${r.stdout}`);
    }
    const line = r.stdout.split('\n').find((l) => /not crawl-capable, skipped:/.test(l));
    assert.ok(line, r.stdout);
    const listed = line.split('skipped:')[1].split(',').map((x) => x.trim());
    for (const m of ['tlsSecurity', 'performance', 'crossBrowser']) assert.ok(listed.includes(m), `${m} missing from: ${line}`);
    for (const m of CRAWL_CAPABLE_MODULES) assert.ok(!listed.includes(m), `${m} is capable but was listed skipped`);
  });

  it('--format json: the document names what ran and what was not crawl-capable, stdout stays one document', async () => {
    const r = await runCli([...base(poor.url), '--module', 'seo', '--format', 'json']);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.modules, { ran: ['liveCrawler', 'seo'], notCrawlCapable: [] });
    assert.ok(doc.findings.some((f) => /^seo:/.test(f.type)), JSON.stringify(doc.findings));
    assert.equal(doc.exitCode, 1);
  });
});
