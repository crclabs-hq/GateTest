'use strict';

// scripts/generate-rule-demotions.js — the Fifty, move 08. Unit tests over
// the pure decision function (buildDemotions) plus one filesystem test for
// the "no data yet" default the script ships with today (no production
// ledger exists — THE-FIFTY: "Move 08 waits on flywheel data that cannot
// exist until production ships").

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { buildDemotions, readSnapshotRows, parseArgs, OUT_PATH } = require('../scripts/generate-rule-demotions.js');
const { MIN_SCANS, MIN_FINDINGS_FLOOR, DEFAULT_MIN_SILENCED_RATE } = require('../website/app/lib/rule-noise');

const row = (rules) => ({ ts: '2026-09-05T00:00:00Z', rules });

test('empty/missing rows: empty demotion list, status not-enough-data (the shipped default — no ledger yet)', () => {
  const built = buildDemotions(null);
  assert.deepEqual(built.demotions, {});
  assert.deepEqual(built.notEnoughData, []);
  assert.equal(built.status, 'not-enough-data');
  assert.equal(built.scans, 0);

  const empty = buildDemotions([]);
  assert.equal(empty.status, 'not-enough-data');
});

test('control pair (a): silencedRate 0.35, sampleSize above the floor -> demoted, reason attached, status ok', () => {
  const rows = Array.from({ length: MIN_SCANS }, () => row([
    { id: 'retire:me', fired: 13, silenced: 7 }, // 100 total, 35%
  ]));
  const built = buildDemotions(rows);
  assert.equal(built.status, 'ok');
  assert.ok(built.demotions['retire:me']);
  const d = built.demotions['retire:me'];
  assert.equal(d.from, 'error');
  assert.equal(d.to, 'warning');
  assert.equal(d.silencedRate, 0.35);
  assert.equal(d.sampleSize, 100);
  assert.match(d.reason, /35%/);
  assert.deepEqual(built.notEnoughData, []);
});

test('control pair (b): same 0.35 rate but below the floor -> not demoted, reported as not-enough-data, status not-enough-data', () => {
  // Same 35% rate as control pair (a), just fewer underlying findings:
  // 13 fired + 7 silenced = 20 total, over MIN_SCANS (5) scans so it is not
  // "thin" — the floor that matters here is MIN_FINDINGS_FLOOR (50), not
  // MIN_SCANS.
  const rows = [
    row([{ id: 'retire:me', fired: 3, silenced: 2 }]),
    row([{ id: 'retire:me', fired: 3, silenced: 2 }]),
    row([{ id: 'retire:me', fired: 3, silenced: 1 }]),
    row([{ id: 'retire:me', fired: 3, silenced: 1 }]),
    row([{ id: 'retire:me', fired: 1, silenced: 1 }]),
  ];
  const built = buildDemotions(rows);
  assert.deepEqual(built.demotions, {}, 'not demoted — not silently, either: see notEnoughData');
  assert.equal(built.notEnoughData.length, 1);
  assert.equal(built.notEnoughData[0].id, 'retire:me');
  assert.equal(built.notEnoughData[0].silencedRate, 0.35);
  assert.equal(built.notEnoughData[0].sampleSize, 20);
  assert.ok(built.notEnoughData[0].sampleSize < MIN_FINDINGS_FLOOR);
  assert.equal(built.status, 'not-enough-data');
});

test('control pair (c): a rule at 0.10 -> untouched, and status is "ok" (real, sufficient data — just clean)', () => {
  const rows = Array.from({ length: MIN_SCANS }, () => row([
    { id: 'keep:me', fired: 45, silenced: 5 }, // 250 total, 10%
  ]));
  const built = buildDemotions(rows);
  assert.deepEqual(built.demotions, {});
  assert.deepEqual(built.notEnoughData, []);
  assert.equal(built.status, 'ok', 'sufficient data exists — a clean rate is a measured fact, not missing data');
});

test('a rule below MIN_SCANS (thin) is reported as not-enough-data even with a huge rate, never silently demoted', () => {
  const rows = [row([{ id: 'seen:once', fired: 0, silenced: 90 }])]; // 1 scan, 100%, well above the floor
  const built = buildDemotions(rows);
  assert.deepEqual(built.demotions, {});
  assert.equal(built.notEnoughData.length, 1);
  assert.match(built.notEnoughData[0].reason, /MIN_SCANS|scan/);
});

test('OUT_PATH (the default --out) points at the checked-in data/rule-demotions.json', () => {
  const { DEFAULT_PATH } = require('../src/core/rule-demotion');
  assert.equal(path.resolve(OUT_PATH), path.resolve(DEFAULT_PATH), 'the generator and the loader must agree on one file');
});

test('default thresholds match the one definition in website/app/lib/rule-noise.js', () => {
  const opts = parseArgs([]);
  assert.equal(opts.rate, DEFAULT_MIN_SILENCED_RATE);
  assert.equal(opts.floor, MIN_FINDINGS_FLOOR);
});

test('readSnapshotRows: missing/unreadable/malformed snapshot is null, never throws', () => {
  assert.equal(readSnapshotRows(null), null);
  assert.equal(readSnapshotRows(path.join(os.tmpdir(), 'gatetest-does-not-exist.json')), null);
  const bad = path.join(os.tmpdir(), `gatetest-rd-bad-${process.pid}.json`);
  fs.writeFileSync(bad, '{ not json');
  try {
    assert.equal(readSnapshotRows(bad), null);
  } finally {
    fs.unlinkSync(bad);
  }
});

test('readSnapshotRows accepts a bare array or a {rows: [...]} wrapper', () => {
  const arrFile = path.join(os.tmpdir(), `gatetest-rd-arr-${process.pid}.json`);
  const wrapFile = path.join(os.tmpdir(), `gatetest-rd-wrap-${process.pid}.json`);
  fs.writeFileSync(arrFile, JSON.stringify([row([{ id: 'x:y', fired: 1, silenced: 0 }])]));
  fs.writeFileSync(wrapFile, JSON.stringify({ rows: [row([{ id: 'x:y', fired: 1, silenced: 0 }])] }));
  try {
    assert.equal(readSnapshotRows(arrFile).length, 1);
    assert.equal(readSnapshotRows(wrapFile).length, 1);
  } finally {
    fs.unlinkSync(arrFile);
    fs.unlinkSync(wrapFile);
  }
});

test('CLI --dry-run over a snapshot prints the same payload buildDemotions computes, without writing', () => {
  const snap = path.join(os.tmpdir(), `gatetest-rd-cli-${process.pid}.json`);
  const rows = Array.from({ length: MIN_SCANS }, () => row([{ id: 'retire:me', fired: 13, silenced: 7 }]));
  fs.writeFileSync(snap, JSON.stringify(rows));
  const out = path.join(os.tmpdir(), `gatetest-rd-cli-out-${process.pid}.json`);
  try {
    if (fs.existsSync(out)) fs.unlinkSync(out);
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'generate-rule-demotions.js'),
      '--snapshot', snap, '--dry-run',
    ], { encoding: 'utf-8' });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'ok');
    assert.ok(payload.demotions['retire:me']);
    assert.equal(fs.existsSync(out), false, '--dry-run must not write a file');
  } finally {
    fs.unlinkSync(snap);
    if (fs.existsSync(out)) fs.unlinkSync(out);
  }
});

test('CLI with no --snapshot writes an empty list with status not-enough-data, and prints the one summary line', () => {
  const out = path.join(os.tmpdir(), `gatetest-rd-cli-empty-${process.pid}.json`);
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'generate-rule-demotions.js'),
      '--out', out,
    ], { encoding: 'utf-8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 rule\(s\) demoted, status not-enough-data/);
    const written = JSON.parse(fs.readFileSync(out, 'utf-8'));
    assert.deepEqual(written.demotions, {});
    assert.equal(written.status, 'not-enough-data');
    assert.ok(written.generatedAt);
  } finally {
    if (fs.existsSync(out)) fs.unlinkSync(out);
  }
});

test('the checked-in data/rule-demotions.json is valid, generated, and readable by src/core/rule-demotion.js', () => {
  const { loadDemotions, DEFAULT_PATH } = require('../src/core/rule-demotion');
  assert.ok(fs.existsSync(DEFAULT_PATH), 'data/rule-demotions.json must be checked in');
  const raw = JSON.parse(fs.readFileSync(DEFAULT_PATH, 'utf-8'));
  assert.ok(raw.generatedAt);
  assert.ok(['ok', 'not-enough-data'].includes(raw.status));
  assert.equal(typeof raw.demotions, 'object');
  const loaded = loadDemotions(DEFAULT_PATH);
  assert.equal(typeof loaded.demotions, 'object');
});
