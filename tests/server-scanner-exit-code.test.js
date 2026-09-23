'use strict';

/**
 * Issue #677 item 3 — a warning-only `--server` result must exit 0 unless
 * `--strict` is given, and the summary line must say "N warning(s), N
 * error(s)" instead of "N ISSUES" (a CSP `'unsafe-inline'` warning was
 * failing the gate the same way an SSL failure would, both scans of
 * tallrig.com and gluecron.com reporting one issue — the warning — and
 * both exiting 1).
 *
 * `ServerScanner.countSeverities/exitCode/summaryLabel` (src/scanners/
 * server-scanner.js) are the one definition of the severity split; this
 * file tests them directly against both synthetic results (every
 * combination the policy cares about) and a REAL result fragment from
 * `_checkDNS('127.0.0.1')` — a loopback "hostname" reliably produces
 * exactly one warning (no DMARC record) and zero errors from real,
 * deterministic, network-free-in-practice code (DNS resolution of an IP
 * literal as a hostname is ENOTFOUND everywhere, no external network
 * needed), without requiring a trusted TLS certificate to exercise the SSL
 * module cleanly (self-signed/loopback HTTPS is out of scope here — the
 * `--server` flag always forces the SSL check, so a genuinely zero-error,
 * warning-only run of the FULL CLI would need a trusted cert, which this
 * suite does not set up; see the CLI-level test below for what IS verified
 * end-to-end without one).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ServerScanner = require('../src/scanners/server-scanner');

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
      reject(new Error(`CLI did not exit within ${timeoutMs}ms.\nstdout:\n${stdout}`));
    }, timeoutMs);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
  });
}

function fakeResult(modules) {
  return { modules };
}

// ============================================================================
// Unit control pair — synthetic results, every combination the policy cares about.
// ============================================================================
describe('ServerScanner severity policy (issue #677 item 3)', () => {
  it('CONTROL — a clean result (0 errors, 0 warnings) exits 0 and says CLEAN', () => {
    const result = fakeResult([{ name: 'ssl', details: ['pass: SSL certificate valid for 90 days'] }]);
    assert.deepEqual(ServerScanner.countSeverities(result), { errors: 0, warnings: 0 });
    assert.equal(ServerScanner.exitCode(result), 0);
    assert.equal(ServerScanner.exitCode(result, { strict: true }), 0);
    assert.equal(ServerScanner.summaryLabel(result), 'CLEAN');
  });

  it('a warning-only result exits 0 by default and says "N warning(s), N error(s)"', () => {
    const result = fakeResult([
      { name: 'headers', details: ["warning: CSP contains 'unsafe-inline' in script-src"] },
    ]);
    assert.deepEqual(ServerScanner.countSeverities(result), { errors: 0, warnings: 1 });
    assert.equal(ServerScanner.exitCode(result), 0, 'a warning alone must not fail the gate');
    assert.equal(ServerScanner.summaryLabel(result), '1 warning, 0 errors',
      'must say "1 warning, 0 errors", not "1 ISSUES"');
  });

  it('the SAME warning-only result exits non-zero under --strict', () => {
    const result = fakeResult([
      { name: 'headers', details: ["warning: CSP contains 'unsafe-inline' in script-src"] },
    ]);
    assert.equal(ServerScanner.exitCode(result, { strict: true }), 1);
  });

  it('any error always fails the gate, with or without --strict', () => {
    const result = fakeResult([
      { name: 'ssl', details: ['error: SSL certificate EXPIRED 3 days ago'] },
      { name: 'headers', details: ['warning: Missing X-Frame-Options header'] },
    ]);
    assert.deepEqual(ServerScanner.countSeverities(result), { errors: 1, warnings: 1 });
    assert.equal(ServerScanner.exitCode(result), 1);
    assert.equal(ServerScanner.exitCode(result, { strict: true }), 1);
    assert.equal(ServerScanner.summaryLabel(result), '1 warning, 1 error');
  });

  it('pluralises correctly', () => {
    const result = fakeResult([
      { name: 'headers', details: ['warning: a', 'warning: b', 'error: c', 'error: d'] },
    ]);
    assert.equal(ServerScanner.summaryLabel(result), '2 warnings, 2 errors');
  });
});

// ============================================================================
// Real (non-synthetic) warning-only fragment — genuine DNS module output
// against a loopback "hostname", not a hand-built fixture.
// ============================================================================
describe('ServerScanner severity policy against a REAL result fragment', () => {
  it('_checkDNS("127.0.0.1") genuinely produces exactly one warning (no DMARC record) and zero errors', async () => {
    const scanner = new ServerScanner();
    const dnsMod = await scanner._checkDNS('127.0.0.1');
    const result = fakeResult([{ name: 'dns', ...dnsMod }]);

    assert.deepEqual(ServerScanner.countSeverities(result), { errors: 0, warnings: 1 },
      `expected exactly one warning, got: ${JSON.stringify(dnsMod.details)}`);
    assert.equal(ServerScanner.exitCode(result), 0, 'a real warning-only result must exit 0 by default');
    assert.equal(ServerScanner.exitCode(result, { strict: true }), 1, 'the same result must exit non-zero under --strict');
    assert.equal(ServerScanner.summaryLabel(result), '1 warning, 0 errors');
  });
});

// ============================================================================
// CLI level — the actual `--server` process. Real target, real exit code.
//
// This cannot demonstrate the exit-0 warning-only case end to end: `--server`
// always runs the SSL module, and a plain HTTP target is an SSL *error* (not
// a warning) by design ("Site not using HTTPS"), while a genuinely trusted
// HTTPS target would need a real or CA-trusted certificate this suite does
// not set up. What IS verified here is the plumbing: the new "N warning(s),
// N error(s)" wording actually reaches stdout (replacing "N ISSUES"), and the
// exit code still fails a scan that has a real error.
// ============================================================================
describe('gatetest --server CLI wiring (issue #677 item 3)', () => {
  it('the summary line uses the new wording, not "ISSUES"', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>ok</body></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;

    try {
      const result = await runCli(['--server', url]);
      assert.match(result.stdout, /SERVER: \d+ warnings?, \d+ errors?/,
        `expected the new wording.\nstdout:\n${result.stdout}`);
      assert.ok(!/ISSUES/.test(result.stdout), `must not print the old "ISSUES" wording.\nstdout:\n${result.stdout}`);
      // A plain-HTTP target always carries the SSL "not HTTPS" error, so this
      // scan is expected to fail regardless of --strict.
      assert.equal(result.code, 1);
    } finally {
      server.close();
    }
  });
});
