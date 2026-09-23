'use strict';

/**
 * Issue #677 item 2 — the `--crawl` exit code must derive ONLY from the
 * findings this run's own report prints, never from the runner's generic
 * module-crashed/timed-out status.
 *
 * THE BUG (reproduced once, 2026-09-22, against tallrig.com at commit
 * 7cd5f6c1): a 40-page crawl printed "RESULT: ALL CLEAR, no errors, broken
 * links, or broken images found" on stdout and still exited 1. A 15-page
 * rerun of the same site exited 0 with the same text; a 40-page crawl of a
 * different site exited 0 too. The report and the exit code had come from
 * two different sources of truth: the report from the crawl's own findings,
 * the exit code from `summary.gateStatus`, which the runner's outer
 * wall-clock race can set to BLOCKED (via `result.fail(err)`) even after the
 * module's own (abandoned but still-running) `run()` call finished writing
 * a clean report to disk moments later. A CI gate on a clean site would fail
 * with no explanation anywhere in the report.
 *
 * THE FIX — `crawlExitCode()` (src/modules/live-crawler-report.js) computes
 * the verdict purely from the same `data` object `generateFeedbackReport`
 * prints from, and bin/gatetest.js's `runCrawl` reads that back from disk
 * (this run's own JSON report, keyed and URL-verified the same way the
 * .md report already was) instead of trusting `summary.gateStatus`. Hard
 * findings (broken links/images/scripts/stylesheets, page errors) always
 * fail; a page that merely timed out or was never attempted because the
 * wall-clock budget ran out only fails the gate once the NOT-CHECKED share
 * exceeds `NOT_CHECKED_BLOCK_SHARE` (20%) — a documented policy, not a
 * silent one, and the same number both the report's "N pages not checked
 * (reason)" line and the exit code read.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  crawlExitCode,
  notCheckedLine,
  crawlResultLabel,
  NOT_CHECKED_BLOCK_SHARE,
} = require('../src/modules/live-crawler-report');

const GATETEST_BIN = path.join(__dirname, '..', 'bin', 'gatetest.js');

function runCli(args, { cwd, env, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATETEST_BIN, ...args], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, GATETEST_NO_TELEMETRY: '1', ...(env || {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
  });
}

// ============================================================================
// Unit control pair — crawlExitCode() itself, no process/server involved.
// ============================================================================
describe('crawlExitCode() — the not-checked policy (issue #677 item 2)', () => {
  const base = { baseUrl: 'https://example.com', pagesScanned: 4, maxPages: 4,
    errors: [], brokenLinks: [], brokenImages: [], brokenScripts: [], brokenStylesheets: [],
    timedOutPages: [], budgetExhausted: false };

  it('CONTROL — a fully clean crawl exits 0 and claims ALL CLEAR', () => {
    assert.equal(crawlExitCode(base), 0);
    assert.equal(crawlResultLabel(base), 'ALL CLEAR');
    assert.equal(notCheckedLine(base), null);
  });

  it('a hard finding (broken link) always fails, regardless of not-checked share', () => {
    const data = { ...base, brokenLinks: [{ page: 'https://example.com/', link: 'https://example.com/dead', status: 404 }] };
    assert.equal(crawlExitCode(data), 1);
    assert.equal(crawlResultLabel(data), 'ISSUES FOUND');
  });

  it('a not-checked share AT the threshold does not fail (policy is "exceeds", not "reaches")', () => {
    // 1 of 5 in-scope pages not checked = exactly NOT_CHECKED_BLOCK_SHARE.
    const data = { ...base, pagesScanned: 4, maxPages: 4,
      timedOutPages: [{ url: 'https://example.com/hang', elapsedMs: 500 }] };
    assert.equal(1 / (4 + 1), NOT_CHECKED_BLOCK_SHARE);
    assert.equal(crawlExitCode(data), 0);
    assert.match(notCheckedLine(data), /1 page not checked \(timed out\)/);
    assert.equal(crawlResultLabel(data), 'ISSUES FOUND', 'a timeout is still disclosed even though it does not fail the gate');
  });

  it('a not-checked share ABOVE the threshold fails', () => {
    // 3 of 5 in-scope pages not checked = 60% > 20%.
    const data = { ...base, pagesScanned: 2, maxPages: 2,
      timedOutPages: [{ url: 'a' }, { url: 'b' }, { url: 'c' }] };
    assert.ok(3 / (2 + 3) > NOT_CHECKED_BLOCK_SHARE);
    assert.equal(crawlExitCode(data), 1);
  });

  it('a budget-exhausted crawl measures the share against maxPages, not just what was attempted', () => {
    // 8 of 10 configured pages never attempted at all.
    const data = { ...base, pagesScanned: 2, maxPages: 10, budgetExhausted: true, timedOutPages: [] };
    assert.equal(crawlExitCode(data), 1);
    assert.match(notCheckedLine(data), /8 pages not checked \(crawl budget exhausted\)/);
  });

  it('zero pages scanned and zero errors is never a green "clean" off zero observations', () => {
    const data = { ...base, pagesScanned: 0, maxPages: 4 };
    assert.equal(crawlExitCode(data), 1);
  });
});

// ============================================================================
// CLI integration — the exit code the operator actually sees.
// ============================================================================
describe('gatetest --crawl exit code (issue #677 item 2, CLI level)', () => {
  it('a fully clean crawl exits 0', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Home</title></head><body>a perfectly ordinary home page with plenty of visible text on it</body></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/`;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-exitcode-clean-'));

    try {
      const result = await runCli(['--crawl', baseUrl, '--project', projectRoot, '--crawl-max', '5', '--crawl-page-timeout', '2000']);
      assert.match(result.stdout, /ALL CLEAR/, `expected a clean report.\nstdout:\n${result.stdout}`);
      assert.equal(result.code, 0, `expected exit 0 for a clean crawl.\nstdout:\n${result.stdout}`);
    } finally {
      server.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('one stalled page out of five (20% — AT, not above, the threshold) prints the not-checked line and exits 0', async () => {
    const hangingSockets = new Set();
    const server = http.createServer((req, res) => {
      if (req.url === '/hang') return; // never respond — socket stays open
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const page = req.url === '/' ? 'home' : req.url.replace(/\W/g, '');
      res.end(`<html><head><title>${page}</title></head><body>page ${page}, plenty of visible text here so it is not blank
        ${req.url === '/' ? '<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a><a href="/hang">hang</a>' : ''}
      </body></html>`);
    });
    server.on('connection', (socket) => hangingSockets.add(socket));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/`;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-exitcode-atthreshold-'));

    try {
      const result = await runCli([
        '--crawl', baseUrl, '--project', projectRoot,
        '--crawl-max', '10', '--crawl-page-timeout', '500',
      ]);
      assert.match(result.stdout, /1 page not checked \(timed out\)/,
        `expected the not-checked line.\nstdout:\n${result.stdout}`);
      assert.equal(result.code, 0,
        `a single stalled page out of five must not fail the gate (20% is AT the threshold, not above it).\nstdout:\n${result.stdout}`);
    } finally {
      server.close();
      for (const socket of hangingSockets) socket.destroy();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('three stalled pages out of five (60% — above the threshold) exits non-zero', async () => {
    const hangingSockets = new Set();
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/hang')) return; // never respond
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const page = req.url === '/' ? 'home' : req.url.replace(/\W/g, '');
      res.end(`<html><head><title>${page}</title></head><body>page ${page}, plenty of visible text here so it is not blank
        ${req.url === '/' ? '<a href="/a">a</a><a href="/hang1">h1</a><a href="/hang2">h2</a><a href="/hang3">h3</a>' : ''}
      </body></html>`);
    });
    server.on('connection', (socket) => hangingSockets.add(socket));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/`;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-exitcode-abovethreshold-'));

    try {
      const result = await runCli([
        '--crawl', baseUrl, '--project', projectRoot,
        '--crawl-max', '10', '--crawl-page-timeout', '500',
      ]);
      assert.match(result.stdout, /3 pages not checked \(timed out\)/,
        `expected the not-checked line.\nstdout:\n${result.stdout}`);
      assert.notEqual(result.code, 0,
        `three of five pages not checked (60%) must fail the gate.\nstdout:\n${result.stdout}`);
    } finally {
      server.close();
      for (const socket of hangingSockets) socket.destroy();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
