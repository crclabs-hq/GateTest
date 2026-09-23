'use strict';

/**
 * Issue #703 — a crawl's recap counted a warning it never printed anywhere.
 *
 * Reproduced against a sibling platform's clean build: the recap printed
 * `[PASS] (4 checks, 15679ms, 1 warnings)` and `Warnings: 1`, the crawl's
 * own report said `## RESULT: ALL CLEAR`, and the warning's text appeared in
 * NEITHER stdout, NOR the report file, NOR `--feedback`. A customer sees a
 * count with nothing behind it.
 *
 * THE FIX — every warning-severity `addCheck()` call in live-crawler.js now
 * ALSO records a `{module, url, message}` entry into a `warnings` array
 * (src/modules/live-crawler.js `_pushWarning`/`_itemUrl`), built from the
 * SAME collector data as the check itself so the two can never drift.
 * `generateFeedbackReport` (src/modules/live-crawler-report.js) prints that
 * array under a "### Warnings" heading regardless of the ALL CLEAR/ISSUES
 * FOUND verdict (a warning never flips that verdict), writes it into the
 * JSON report file as `data.warnings`, and `buildCrawlFindings` folds it
 * into the `--format json` findings array too — so the text report, the
 * console recap (same content, printed by `printOwnCrawlReport`),
 * `--feedback` (reads the same file), and the JSON output all agree.
 *
 * `crawl:page-timeouts` is deliberately excluded from the generic
 * collection — it already has its own "Page Timeouts" report section and a
 * `timeout` JSON finding type, so folding it in again would double-print
 * the same finding.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { generateFeedbackReport, buildCrawlFindings } = require('../src/modules/live-crawler-report');

const GATETEST_BIN = path.join(__dirname, '..', 'bin', 'gatetest.js');

function runCli(args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATETEST_BIN, ...args], {
      env: { ...process.env, GATETEST_NO_TELEMETRY: '1' },
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

// ============================================================================
// Unit control pair — generateFeedbackReport() / buildCrawlFindings()
// called directly, no server or CLI process involved.
// ============================================================================
describe('generateFeedbackReport + buildCrawlFindings — every counted warning is visible (issue #703)', () => {
  it('a warning entry appears in the text report AND the JSON report file AND the JSON findings', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-warnings-unit-'));
    const data = {
      baseUrl: 'https://example.com/',
      pagesScanned: 3,
      errors: [], brokenLinks: [], brokenImages: [], brokenScripts: [], brokenStylesheets: [],
      timedOutPages: [], budgetExhausted: false, maxPages: 3, crawlElapsedMs: 500,
      warnings: [{
        module: 'liveCrawler',
        key: 'crawl:duplicate-titles',
        url: 'https://example.com/a, https://example.com/b',
        message: '1 title(s) used by multiple pages — confuses users + dilutes SEO',
      }],
    };

    const { mdPath, jsonPath } = generateFeedbackReport({ projectRoot }, data);
    const report = fs.readFileSync(mdPath, 'utf-8');
    // The verdict is unaffected — a warning never flips ALL CLEAR — but the
    // report must ALSO carry the warning's own text (module, page URL(s),
    // message), which is exactly what #703 says was missing.
    assert.match(report, /## RESULT: ALL CLEAR/);
    assert.match(report, /### Warnings \(1\)/);
    assert.match(report, /liveCrawler/);
    assert.match(report, /confuses users \+ dilutes SEO/);
    assert.match(report, /example\.com\/a/);
    assert.match(report, /example\.com\/b/);

    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    assert.ok(Array.isArray(jsonData.warnings), 'the report file must carry a warnings array');
    assert.equal(jsonData.warnings.length, 1);
    assert.equal(jsonData.warnings[0].message, data.warnings[0].message);

    const findings = buildCrawlFindings(data);
    assert.equal(findings.length, 1, 'the JSON --format json findings must be kept in sync with data.warnings');
    assert.equal(findings[0].severity, 'warning');
    assert.equal(findings[0].type, 'duplicate-titles');
    assert.match(findings[0].message, /confuses users/);
    assert.match(findings[0].url, /example\.com\/a/);

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('CONTROL — a crawl with no warnings prints no "Warnings" section and an empty warnings array', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-warnings-control-'));
    const data = {
      baseUrl: 'https://example.com/',
      pagesScanned: 1,
      errors: [], brokenLinks: [], brokenImages: [], brokenScripts: [], brokenStylesheets: [],
      timedOutPages: [], budgetExhausted: false, maxPages: 1, crawlElapsedMs: 200,
      warnings: [],
    };

    const { mdPath, jsonPath } = generateFeedbackReport({ projectRoot }, data);
    const report = fs.readFileSync(mdPath, 'utf-8');
    assert.doesNotMatch(report, /### Warnings/);

    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    assert.deepEqual(jsonData.warnings, []);
    assert.deepEqual(buildCrawlFindings(data), []);

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});

// ============================================================================
// CLI integration — the exact fixture from the issue: a duplicate <title>
// across two pages is a real warning the crawler emits, on an otherwise
// clean site (everything else has a meta description and a canonical tag,
// sitemap/robots/favicon all resolve, so this is the crawl's ONLY warning).
// ============================================================================
describe('gatetest --crawl — a duplicate-title warning is visible everywhere (issue #703, CLI level)', () => {
  function pageBody(url) {
    if (url === '/') {
      return `<html><head><title>Home</title><meta name="description" content="The home page, with a perfectly normal description."><link rel="canonical" href="/"></head><body>Home page, plenty of visible text so the blank-page check stays quiet.<a href="/a">a</a><a href="/b">b</a></body></html>`;
    }
    if (url === '/a' || url === '/b') {
      return `<html><head><title>Shared Page Title</title><meta name="description" content="A perfectly normal per-page description."><link rel="canonical" href="${url}"></head><body>Page ${url}, plenty of visible text so the blank-page check stays quiet.</body></html>`;
    }
    return null;
  }

  function startServer() {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const url = (req.url || '/').split('?')[0];
        if (url === '/sitemap.xml') {
          res.writeHead(200, { 'Content-Type': 'application/xml' });
          res.end('<?xml version="1.0"?><urlset></urlset>');
          return;
        }
        if (url === '/robots.txt') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('User-agent: *\nAllow: /');
          return;
        }
        if (url === '/favicon.ico') {
          res.writeHead(200, { 'Content-Type': 'image/x-icon' });
          res.end('');
          return;
        }
        const body = pageBody(url);
        if (body) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(body);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('<html><head><title>Not Found</title></head><body>not found, plenty of text here too so it is not blank</body></html>');
        }
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  it('the recap, the report file, --feedback, and --format json all show the same one warning', async () => {
    const server = await startServer();
    const baseUrl = `http://127.0.0.1:${server.address().port}/`;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-warnings-cli-'));

    try {
      // 1) Plain text run — stdout carries BOTH the recap's module/suite
      // summary (console-reporter.js's "N warnings" / "Warnings: N" lines)
      // AND the crawl's own report (printOwnCrawlReport prints the exact
      // file generateFeedbackReport wrote) — this is "the recap" issue #703
      // means: one stdout stream, with the count backed by real text.
      const textResult = await runCli([
        '--crawl', baseUrl, '--project', projectRoot,
        '--crawl-max', '5', '--crawl-page-timeout', '3000',
      ]);
      assert.equal(textResult.code, 0, `expected a clean (warning-only) crawl to exit 0.\nstdout:\n${textResult.stdout}`);
      assert.match(textResult.stdout, /ALL CLEAR/, 'a warning alone must not flip the verdict');
      assert.match(textResult.stdout, /Warnings: 1\b/, 'expected the recap to count exactly one warning');
      assert.match(textResult.stdout, /### Warnings \(1\)/, 'expected the new Warnings section in the printed report');
      assert.match(textResult.stdout, /confuses users \+ dilutes SEO/, "expected the duplicate-title warning's own text");
      assert.match(textResult.stdout, /liveCrawler/);

      // 2) `--feedback` reads back the SAME file — must show the same text.
      const feedbackResult = await runCli(['--feedback', '--project', projectRoot]);
      assert.match(feedbackResult.stdout, /### Warnings \(1\)/);
      assert.match(feedbackResult.stdout, /confuses users \+ dilutes SEO/);

      // 3) `--format json` (issue #697) must list the SAME warning as a
      // finding, kept in sync with the text report and the recap's count.
      const jsonResult = await runCli([
        '--crawl', baseUrl, '--project', projectRoot,
        '--crawl-max', '5', '--crawl-page-timeout', '3000', '--format', 'json',
      ]);
      const doc = JSON.parse(jsonResult.stdout);
      assert.equal(doc.result, 'ALL CLEAR');
      assert.equal(doc.exitCode, 0);
      assert.equal(doc.findings.length, 1, `expected exactly the one duplicate-title finding.\n${JSON.stringify(doc.findings)}`);
      assert.equal(doc.findings[0].severity, 'warning');
      assert.equal(doc.findings[0].type, 'duplicate-titles');
      assert.match(doc.findings[0].message, /confuses users \+ dilutes SEO/);
      assert.ok(doc.findings[0].url && /\/(a|b)\b/.test(doc.findings[0].url));
    } finally {
      server.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
