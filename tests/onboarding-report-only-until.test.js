'use strict';
/**
 * Onboarding mode — `--report-only-until <date>` and `gatetest baseline
 * --init` (LAUNCH_BOARD row 15 / the Fifty, move 15).
 *
 * Covers the pure date logic (src/core/onboarding-mode.js) as units, then
 * the CLI end to end: a future date reports without blocking, a past date
 * enforces and warns, an invalid date is a usage error, the `.gatetest.json`
 * key resolves identically to the flag, `--strict` wins over an active
 * window, and the baseline wizard writes the file and prints the recap.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { isValidIsoDate, resolveReportOnlyUntil } = require('../src/core/onboarding-mode');
const { isoDatePlusDays } = require('../bin/gatetest-baseline');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'gatetest.js');

// A well-known AWS example key already used as a fixture elsewhere in this
// suite (tests/scan-honours-gitignore.test.js, tests/mcp-verify-fix.test.js)
// — real enough in shape to fire the secrets module at blocking confidence,
// fake enough to commit.
const BLOCKING_SECRET = 'AKIAIOSFODNN7EXAMPLE';

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-onboard-'));
  fs.writeFileSync(path.join(root, 'app.js'), `const AWS_KEY = '${BLOCKING_SECRET}';\n`);
  return root;
}

function runCli(args, opts = {}) {
  const env = { ...process.env, GATETEST_NO_TELEMETRY: '1', NO_COLOR: '1' };
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 120000, env, ...opts });
}

describe('onboarding-mode — isValidIsoDate', () => {
  it('accepts real calendar dates, including a leap day', () => {
    assert.equal(isValidIsoDate('2026-10-15'), true);
    assert.equal(isValidIsoDate('2024-02-29'), true);
  });

  it('rejects malformed strings and calendar overflow', () => {
    assert.equal(isValidIsoDate('bogus'), false);
    assert.equal(isValidIsoDate('2026-13-01'), false); // no month 13
    assert.equal(isValidIsoDate('2026-02-30'), false); // February has no 30th
    assert.equal(isValidIsoDate('2023-02-29'), false); // 2023 is not a leap year
    assert.equal(isValidIsoDate('2026-1-5'), false);   // not zero-padded
    assert.equal(isValidIsoDate(''), false);
    assert.equal(isValidIsoDate(null), false);
    assert.equal(isValidIsoDate(undefined), false);
  });
});

describe('onboarding-mode — resolveReportOnlyUntil', () => {
  const NOW = new Date('2026-09-26T12:00:00Z');

  it('returns null when nothing was set (mode not requested)', () => {
    assert.equal(resolveReportOnlyUntil(null, NOW), null);
    assert.equal(resolveReportOnlyUntil(undefined, NOW), null);
    assert.equal(resolveReportOnlyUntil('', NOW), null);
  });

  it('flags a malformed date without throwing', () => {
    assert.deepEqual(resolveReportOnlyUntil('not-a-date', NOW), { valid: false, raw: 'not-a-date' });
  });

  it('is active with the correct days-left count before the date', () => {
    const r = resolveReportOnlyUntil('2026-10-15', NOW);
    assert.equal(r.valid, true);
    assert.equal(r.active, true);
    assert.equal(r.expired, false);
    assert.equal(r.daysLeft, 19);
  });

  it('is expired ON the date itself (daysLeft 0) — enforcement starts that day', () => {
    const r = resolveReportOnlyUntil('2026-09-26', NOW);
    assert.equal(r.active, false);
    assert.equal(r.expired, true);
    assert.equal(r.daysLeft, 0);
  });

  it('is expired after the date, with a negative days-left', () => {
    const r = resolveReportOnlyUntil('2026-09-01', NOW);
    assert.equal(r.active, false);
    assert.equal(r.expired, true);
    assert.ok(r.daysLeft < 0);
  });
});

describe('gatetest baseline --init — isoDatePlusDays', () => {
  it('adds calendar days in UTC, independent of local time', () => {
    assert.equal(isoDatePlusDays(14, new Date('2026-09-26T23:59:00Z')), '2026-10-10');
    assert.equal(isoDatePlusDays(0, new Date('2026-09-26T00:00:00Z')), '2026-09-26');
  });
});

describe('CLI --report-only-until — end to end', () => {
  it('a future date exits 0 with the blocking finding still reported, and every surface says report-only-until', () => {
    const root = tmpRepo();
    const future = isoDatePlusDays(30);
    const r = runCli(['--project', root, '--suite', 'quick', '--report-only-until', future, '--format', 'json']);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.enforcing, false);
    assert.equal(doc.gateStatus, 'PASSED');
    assert.equal(doc.reportOnlyUntil.date, future);
    assert.equal(doc.reportOnlyUntil.active, true);
    // Report-only never means empty: the finding is still visible.
    assert.ok(doc.counts.errors >= 1, 'the blocking-shaped finding must still be reported');
  });

  it('the console line says report-only-until and the days left', () => {
    const root = tmpRepo();
    const future = isoDatePlusDays(30);
    const r = runCli(['--project', root, '--suite', 'quick', '--report-only-until', future]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`report-only until ${future} \\(\\d+ days? left\\)`));
  });

  it('a past date enforces (non-zero exit) and warns once', () => {
    const root = tmpRepo();
    const r = runCli(['--project', root, '--suite', 'quick', '--report-only-until', '2020-01-01', '--format', 'json']);
    assert.notEqual(r.status, 0);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.enforcing, true);
    assert.equal(doc.reportOnlyUntil.expired, true);
    assert.match(r.stderr, /--report-only-until 2020-01-01 has passed — the gate is enforcing/);
  });

  it('an invalid date is a usage error (exit 2) — nothing scanned', () => {
    const root = tmpRepo();
    const r = runCli(['--project', root, '--suite', 'quick', '--report-only-until', 'not-a-date']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /expects an ISO date \(YYYY-MM-DD\)/);
  });

  it('the .gatetest.json reportOnlyUntil key resolves identically to the flag', () => {
    const root = tmpRepo();
    const future = isoDatePlusDays(30);
    fs.writeFileSync(path.join(root, '.gatetest.json'), JSON.stringify({ reportOnlyUntil: future }));
    const r = runCli(['--project', root, '--suite', 'quick', '--format', 'json']);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.reportOnlyUntil.date, future);
    assert.equal(doc.enforcing, false);
  });

  it('the CLI flag wins over the .gatetest.json key when both are set', () => {
    const root = tmpRepo();
    const future = isoDatePlusDays(30);
    fs.writeFileSync(path.join(root, '.gatetest.json'), JSON.stringify({ reportOnlyUntil: '2020-01-01' }));
    const r = runCli(['--project', root, '--suite', 'quick', '--report-only-until', future, '--format', 'json']);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.reportOnlyUntil.date, future);
    assert.equal(doc.reportOnlyUntil.active, true);
  });

  it('a malformed .gatetest.json value warns and is treated as absent, never crashes the scan', () => {
    const root = tmpRepo();
    fs.writeFileSync(path.join(root, '.gatetest.json'), JSON.stringify({ reportOnlyUntil: 'bogus' }));
    const r = runCli(['--project', root, '--suite', 'quick', '--format', 'json']);
    assert.equal(r.status, 1, 'no valid onboarding window — the real blocking finding enforces');
    assert.match(r.stderr, /"reportOnlyUntil" in \.gatetest\.json is not a valid ISO date/);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.reportOnlyUntil, null);
  });

  it('--strict wins over an active --report-only-until window', () => {
    const root = tmpRepo();
    const future = isoDatePlusDays(30);
    const r = runCli(['--project', root, '--suite', 'quick', '--report-only-until', future, '--strict', '--format', 'json']);
    assert.notEqual(r.status, 0);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.enforcing, true);
    assert.equal(doc.reportOnlyUntil.active, false);
    assert.equal(doc.reportOnlyUntil.overriddenByStrict, true);
  });
});

describe('gatetest baseline --init — end to end', () => {
  it('writes .gatetest/baseline.json, prints the per-module count, snippet, and CI line', () => {
    const root = tmpRepo();
    const r = runCli(['baseline', '--init', '--project', root, '--suite', 'quick', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const recap = JSON.parse(r.stdout);
    assert.ok(recap.captured >= 1);
    assert.ok(recap.byModule.secrets >= 1, 'the secrets finding must be attributed to its module');
    assert.ok(fs.existsSync(path.join(root, '.gatetest', 'baseline.json')));
    assert.match(recap.reportOnlyUntil, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(recap.configSnippet.reportOnlyUntil, recap.reportOnlyUntil);
    assert.match(recap.ciLine, /gatetest\.js/);

    // A second scan now enforces on NEW findings only — the pre-existing
    // secret is baselined and does not block ("clean as you code").
    const r2 = runCli(['--project', root, '--suite', 'quick', '--format', 'json']);
    assert.equal(r2.status, 0, r2.stderr);
    const doc2 = JSON.parse(r2.stdout);
    assert.equal(doc2.gateStatus, 'PASSED');
  });

  it('the text recap names the per-module count and the snippet', () => {
    const root = tmpRepo();
    const r = runCli(['baseline', '--init', '--project', root, '--suite', 'quick']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Baseline captured: \d+ finding\(s\) grandfathered/);
    assert.match(r.stdout, /secrets/);
    assert.match(r.stdout, /"reportOnlyUntil"/);
    assert.match(r.stdout, /--report-only-until \d{4}-\d{2}-\d{2}/);
  });

  it('without --init, prints usage and exits 2', () => {
    const root = tmpRepo();
    const r = runCli(['baseline', '--project', root]);
    assert.equal(r.status, 2);
  });
});
