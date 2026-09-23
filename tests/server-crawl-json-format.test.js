'use strict';

/**
 * Issue #677 item 1 — `--format json` (and `--json`) was ignored by
 * `--server` and `--crawl`: both printed the text report to stdout
 * regardless of the flag, so a CI consumer asking for JSON got prose and a
 * parse failure. Both now print exactly ONE JSON document on stdout, with
 * the documented top-level keys, progress routed to stderr; text output is
 * unchanged without the flag.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('gatetest --server --format json (issue #677 item 1)', () => {
  it('prints exactly one JSON document on stdout, with the documented top-level keys', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>ok</body></html>');
    });
    const url = `http://127.0.0.1:${server.address().port}/`;

    try {
      const result = await runCli(['--server', url, '--format', 'json']);
      let doc;
      assert.doesNotThrow(() => { doc = JSON.parse(result.stdout); },
        `stdout must be exactly one JSON document.\nstdout:\n${result.stdout}`);
      for (const key of ['target', 'startedAt', 'durationMs', 'groups', 'summary', 'exitCode']) {
        assert.ok(Object.prototype.hasOwnProperty.call(doc, key), `expected top-level key "${key}"`);
      }
      assert.equal(doc.target, url);
      assert.ok(Array.isArray(doc.groups) && doc.groups.length > 0, 'expected non-empty groups');
      for (const group of doc.groups) {
        assert.ok(typeof group.name === 'string');
        assert.ok(Array.isArray(group.checks));
        for (const check of group.checks) {
          assert.ok(typeof check.name === 'string');
          assert.ok(typeof check.passed === 'boolean');
          assert.ok(['error', 'warning', 'info'].includes(check.severity), `unexpected severity ${check.severity}`);
          assert.ok(typeof check.message === 'string');
        }
      }
      // Progress and the human report went to stderr, not stdout.
      assert.match(result.stderr, /GATETEST — Server Scan/);
    } finally {
      server.close();
    }
  });

  it('--json is the same as --format json', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>ok</body></html>');
    });
    const url = `http://127.0.0.1:${server.address().port}/`;

    try {
      const result = await runCli(['--server', url, '--json']);
      const doc = JSON.parse(result.stdout);
      assert.equal(doc.target, url);
    } finally {
      server.close();
    }
  });

  it('without the flag, text output is unchanged (not JSON, still shows the new wording)', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>ok</body></html>');
    });
    const url = `http://127.0.0.1:${server.address().port}/`;

    try {
      const result = await runCli(['--server', url]);
      assert.throws(() => JSON.parse(result.stdout), 'plain text output must not parse as JSON');
      assert.match(result.stdout, /GATETEST — Server Scan/);
    } finally {
      server.close();
    }
  });
});

describe('gatetest --crawl --format json (issue #677 item 1)', () => {
  it('prints exactly one JSON document on stdout, with the documented top-level keys', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Home</title></head><body>a perfectly ordinary home page with plenty of visible text</body></html>');
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const fs = require('fs');
    const os = require('os');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-json-'));

    try {
      const result = await runCli(['--crawl', url, '--project', projectRoot, '--crawl-max', '3', '--format', 'json']);
      let doc;
      assert.doesNotThrow(() => { doc = JSON.parse(result.stdout); },
        `stdout must be exactly one JSON document.\nstdout:\n${result.stdout}`);
      for (const key of ['url', 'pagesScanned', 'generatedAt', 'result', 'findings']) {
        assert.ok(Object.prototype.hasOwnProperty.call(doc, key), `expected top-level key "${key}"`);
      }
      assert.equal(doc.url, url);
      assert.equal(doc.pagesScanned, 1);
      assert.equal(doc.result, 'ALL CLEAR');
      assert.equal(doc.exitCode, 0);
      assert.deepEqual(doc.findings, []);
      // Progress and the human report went to stderr, not stdout.
      assert.match(result.stderr, /Crawling/);
      assert.equal(result.code, 0);
    } finally {
      server.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('without the flag, text output is unchanged (not JSON, still shows the markdown report)', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Home</title></head><body>a perfectly ordinary home page with plenty of visible text</body></html>');
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const fs = require('fs');
    const os = require('os');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-json-text-'));

    try {
      const result = await runCli(['--crawl', url, '--project', projectRoot, '--crawl-max', '3']);
      assert.throws(() => JSON.parse(result.stdout), 'plain text output must not parse as JSON');
      assert.match(result.stdout, /ALL CLEAR/);
      assert.equal(result.code, 0);
    } finally {
      server.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // Regression — a JSON document large enough to exceed a pipe's buffer
  // (64KB on Linux) must still arrive complete on stdout.
  //
  // CI on Linux failed here: `process.stdout.write(doc, () => process.exit
  // (code))` calls exit from inside the write's own callback, but a piped
  // stdout is asynchronous on POSIX (synchronous only on Windows — this is
  // documented Node.js behaviour, not a bug in the write itself), so the
  // parent sometimes saw an EMPTY stream. This reproduces the failure mode
  // with a document over 64KB; the fix (bin/gatetest.js) never calls
  // process.exit() after a stdout write — it sets process.exitCode and lets
  // the event loop drain, which cannot race the write on ANY platform. This
  // test can't force the Linux-only async pipe timing on a Windows dev
  // machine, but it does prove the document survives a large write intact,
  // and CI on Linux exercises the exact race this was written for.
  // ==========================================================================
  it('a JSON document over 64KB (many broken images) still arrives complete on stdout', async () => {
    const BROKEN_IMAGE_COUNT = 800; // ~120 bytes/finding once serialized => well over 64KB
    const server = await startServer((req, res) => {
      if (req.url === '/') {
        const imgTags = Array.from({ length: BROKEN_IMAGE_COUNT }, (_, i) => `<img src="/img/${i}.png">`).join('');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><title>Home</title></head><body>plenty of visible text on this page to avoid the blank-page check${imgTags}</body></html>`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const fs = require('fs');
    const os = require('os');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-json-large-'));

    try {
      const result = await runCli(
        ['--crawl', url, '--project', projectRoot, '--crawl-max', '1', '--format', 'json'],
        { timeoutMs: 60000 },
      );
      const stdoutBytes = Buffer.byteLength(result.stdout, 'utf8');
      assert.ok(stdoutBytes > 65536, `expected stdout to exceed the 64KB pipe buffer, got ${stdoutBytes} bytes`);

      let doc;
      assert.doesNotThrow(() => { doc = JSON.parse(result.stdout); },
        `a large document must still parse as exactly one complete JSON document (${stdoutBytes} bytes).\n` +
        `stdout tail:\n${result.stdout.slice(-300)}`);
      assert.equal(doc.findings.length, BROKEN_IMAGE_COUNT,
        'every broken-image finding must survive the write, not just the ones that fit before a truncation point');
      assert.equal(doc.exitCode, 1, 'broken images are hard findings and must fail the gate');
      assert.equal(result.code, 1);
    } finally {
      server.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
