'use strict';

/**
 * KI #107 — admin softening of the CI/CLI gate, control pair.
 *
 * Reproduction (2026-09-16) established that BEFORE this fix, `.gatetest.json`
 * carrying `admin: true` / `owner: "crclabs-hq"` did NOTHING to the plain
 * scan/gate path — `bin/gatetest.js` and `src/core/runner.js` never read
 * either key, so a blocking finding returned `GATE: BLOCKED` / exit 1
 * regardless. Forbidden #25 in CLAUDE.md promised the opposite ("admin paths
 * ... auto-fix and pass"); the gap between promise and code was the actual
 * defect this fix closes: the softening is now real, but ONLY as a per-run
 * environment opt-in (`GATETEST_ADMIN=1`), never a `.gatetest.json` default —
 * see src/core/admin-override.js for the full reasoning.
 *
 * Control pair:
 *   (a) blocking finding, no env var           → gate exits non-zero
 *   (b) same finding, GATETEST_ADMIN=1          → softened result reported,
 *                                                  AND the output says so —
 *                                                  never a silent pass.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { GateTestRunner } = require('../src/core/runner');
const { buildJsonOutput, scanExitCode } = require('../src/core/json-output');
const adminOverride = require('../src/core/admin-override');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'gatetest.js');
const FAKE_KEY = ['sk_live_51', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'].join(''); // split so this file isn't its own finding

/** A fixture whose `.gatetest.json` carries the SAME admin config as this repo's. */
function makeAdminFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-admin-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', private: true }));
  fs.writeFileSync(path.join(dir, '.gatetest.json'), JSON.stringify({ owner: 'crclabs-hq', admin: true }));
  fs.writeFileSync(path.join(dir, 'bad.js'), `const stripeKey = "${FAKE_KEY}";\nmodule.exports = { stripeKey };\n`);
  return dir;
}

function runCli(args, extraEnv = {}) {
  const env = { ...process.env, GATETEST_NO_TELEMETRY: '1', NO_COLOR: '1' };
  delete env.GATETEST_ADMIN; // baseline: no override unless a test opts in below
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60000, env });
}

function makeRunner(options = {}) {
  return new GateTestRunner({ projectRoot: process.cwd() }, options);
}

/** A module that reports one confident, blocking error. */
function blockingModule() {
  return {
    async run(result) {
      result.addCheck('blocking-finding', false, {
        severity: 'error',
        confidence: 1.0,
        message: 'a real, blocking finding',
        file: 'src/lib/foo.js',
      });
    },
  };
}

/** Sets an env var for the duration of an ASYNC fn — restores only after it settles. */
async function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[key] = prev; else delete process.env[key];
  }
}

/** Captures console.error output across an ASYNC fn — restores only after it settles. */
async function withCapturedConsoleError(asyncFn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    const result = await asyncFn();
    return { result, lines };
  } finally {
    console.error = orig;
  }
}

// ─── admin-override.js unit behaviour ──────────────────────────────────────

test('admin-override.isRequested is true only for the literal string "1"', () => {
  assert.equal(adminOverride.isRequested({}), false);
  assert.equal(adminOverride.isRequested({ GATETEST_ADMIN: 'true' }), false);
  assert.equal(adminOverride.isRequested({ GATETEST_ADMIN: 'yes' }), false);
  assert.equal(adminOverride.isRequested({ GATETEST_ADMIN: '0' }), false);
  assert.equal(adminOverride.isRequested({ GATETEST_ADMIN: '1' }), true);
});

test('admin-override.notice names both the env var and the counts', () => {
  const msg = adminOverride.notice({ totalBlockingErrors: 2, failedModules: 1 });
  assert.match(msg, /GATETEST_ADMIN=1/);
  assert.match(msg, /SOFTENED/);
  assert.match(msg, /2 blocking/);
  assert.match(msg, /1 failed module/);
});

// ─── (a) CONTROL: blocking finding, no env var → gate exits non-zero ───────

test('(a) blocking finding, GATETEST_ADMIN unset → gate BLOCKED, exit non-zero', async () => {
  await withEnv('GATETEST_ADMIN', undefined, async () => {
    const runner = makeRunner();
    runner.register('m', blockingModule());
    const summary = await runner.run(['m']);

    assert.equal(summary.gateStatus, 'BLOCKED');
    assert.equal(summary.rawGateStatus, 'BLOCKED');
    assert.equal(summary.adminOverride, false);

    const exitCode = scanExitCode(summary);
    assert.equal(exitCode, 1, 'no env var set — the gate must fail closed');

    const doc = buildJsonOutput(summary, { projectRoot: process.cwd(), exitCode });
    assert.equal(doc.gateStatus, 'BLOCKED');
    assert.equal(doc.exitCode, 1);
    assert.equal(doc.adminOverride, false);
    assert.equal(doc.rawGateStatus, 'BLOCKED');
  });
});

// ─── (b) CONTROL: same finding, GATETEST_ADMIN=1 → softened, never silent ──

test('(b) same finding, GATETEST_ADMIN=1 → softened result reported, gate exits 0, and it says so', async () => {
  await withEnv('GATETEST_ADMIN', '1', async () => {
    const runner = makeRunner();
    runner.register('m', blockingModule());

    const { result: resolved, lines } = await withCapturedConsoleError(() => runner.run(['m']));

    // Softened, but the underlying verdict is preserved for anyone who asks.
    assert.equal(resolved.gateStatus, 'PASSED', 'GATETEST_ADMIN=1 softens the exit path');
    assert.equal(resolved.rawGateStatus, 'BLOCKED', 'the real verdict is never erased');
    assert.equal(resolved.adminOverride, true);
    // The finding itself is still there — softening reports, never silences.
    assert.equal(resolved.checks.blockingErrors, 1);
    assert.equal(resolved.checks.errors, 1);

    const exitCode = scanExitCode(resolved);
    assert.equal(exitCode, 0, 'GATETEST_ADMIN=1 softens the exit code');

    // Never a SILENT pass (Forbidden #16): a loud notice must be printed,
    // naming both the env var and that the gate was softened.
    const notice = lines.join('\n');
    assert.match(notice, /GATETEST_ADMIN=1/);
    assert.match(notice, /SOFTENED/);

    // ... and the same disclosure travels in the JSON contract, not just stderr.
    const doc = buildJsonOutput(resolved, { projectRoot: process.cwd(), exitCode });
    assert.equal(doc.gateStatus, 'PASSED');
    assert.equal(doc.exitCode, 0);
    assert.equal(doc.adminOverride, true, 'JSON consumers must be able to see the override too');
    assert.equal(doc.rawGateStatus, 'BLOCKED');
  });
});

// ─── Config-level admin/owner must NEVER soften — only the env var may ────

test('a clean run needs no override: adminOverride is false and rawGateStatus === gateStatus', async () => {
  await withEnv('GATETEST_ADMIN', undefined, async () => {
    const runner = makeRunner();
    runner.register('m', { async run() {} });
    const summary = await runner.run(['m']);
    assert.equal(summary.gateStatus, 'PASSED');
    assert.equal(summary.rawGateStatus, 'PASSED');
    assert.equal(summary.adminOverride, false);
  });
});

test('GATETEST_ADMIN=1 is a no-op when nothing is blocking (nothing to soften)', async () => {
  await withEnv('GATETEST_ADMIN', '1', async () => {
    const runner = makeRunner();
    runner.register('m', { async run() {} });
    const summary = await runner.run(['m']);
    assert.equal(summary.gateStatus, 'PASSED');
    assert.equal(summary.rawGateStatus, 'PASSED');
    assert.equal(summary.adminOverride, false, 'nothing was blocked, so nothing was overridden');
  });
});

// ─── End-to-end, spawned CLI — the same shape as the manual KI #107 repro ──
// Fixture's `.gatetest.json` is byte-for-byte the same admin config this
// repo carried before the fix (`owner: "crclabs-hq"`, `admin: true`). The
// control pair proves that config NEVER softens the gate — only the env var
// does, and only for the run it's set on.

describe('gatetest CLI — KI #107 control pair (spawned, real secrets fixture)', () => {
  let fixture;
  before(() => { fixture = makeAdminFixture(); });
  after(() => { fs.rmSync(fixture, { recursive: true, force: true }); });

  test('(a) admin:true + owner:crclabs-hq in .gatetest.json, no env var → still BLOCKED, exit 1', () => {
    const r = runCli(['--module', 'secrets', '--project', fixture]);
    assert.equal(r.status, 1, `.gatetest.json admin:true must not soften the gate:\n${r.stdout}`);
    assert.match(r.stdout, /GATE: BLOCKED/);
  });

  test('(b) same fixture, GATETEST_ADMIN=1 → exit 0, and stderr says the gate was softened', () => {
    const r = runCli(['--module', 'secrets', '--project', fixture], { GATETEST_ADMIN: '1' });
    assert.equal(r.status, 0, `GATETEST_ADMIN=1 must soften the exit code:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /GATETEST_ADMIN=1/, 'stderr must name the env var — never a silent pass');
    assert.match(r.stderr, /SOFTENED/i);
    // The finding is still visible in the report, not hidden by the override.
    assert.match(r.stdout, /secrets/);
  });

  test('(c) .gatetest.json WITHOUT admin/owner, GATETEST_ADMIN unset → BLOCKED (sanity: the fixture itself is a real blocking finding)', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-admin-plain-'));
    try {
      fs.writeFileSync(path.join(plain, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', private: true }));
      fs.writeFileSync(path.join(plain, 'bad.js'), `const stripeKey = "${FAKE_KEY}";\nmodule.exports = { stripeKey };\n`);
      const r = runCli(['--module', 'secrets', '--project', plain]);
      assert.equal(r.status, 1);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
