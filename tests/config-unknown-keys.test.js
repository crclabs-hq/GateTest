/**
 * `.gatetest.json` keys nothing reads must warn, not vanish.
 *
 * Origin (2026-08-26): a protected platform's config pinned `aiReview.model`
 * at the ROOT of the file. Module config lives under `modules.<name>`, so the
 * key had been decorative since the day it was written — and `_deepMerge`
 * accepts any key, so nothing anywhere said so. Same failure shape as a CI
 * workflow that can never fire: it looks configured, it is not.
 *
 * The negative half of this suite matters as much as the positive half. Keys
 * consumed OUTSIDE this process (`owner`/`admin`/`mode` by the husky pre-push
 * hook and the website's repo-mode detection, `telemetry` by scan-telemetry)
 * are legitimate. A warning that cries wolf on those gets muted by customers,
 * and then it protects nobody.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { GateTestConfig } = require('../src/core/config.js');

let tmpRoot;

function projectWith(config, name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.gatetest.json'), JSON.stringify(config, null, 2));
  return dir;
}

/** Load a config with stderr captured, so the assertions can read the warning. */
function loadQuietly(dir) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const cfg = new GateTestConfig(dir);
    return { cfg, stderr: lines.join('\n') };
  } finally {
    console.error = original;
  }
}

describe('config: unrecognised .gatetest.json keys', () => {
  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-config-'));
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('flags a root-level key nothing reads', () => {
    const dir = projectWith({ doctrine: { claudeMd: 'CLAUDE.md' } }, 'unknown-key');
    const { cfg, stderr } = loadQuietly(dir);

    assert.deepStrictEqual(cfg.unknownKeys, ['doctrine']);
    assert.match(stderr, /does not read/);
    assert.match(stderr, /doctrine/);
  });

  test('names the right home when the key is a module name', () => {
    // The exact bug: `aiReview` at the root instead of `modules.aiReview`.
    const dir = projectWith({ aiReview: { model: 'claude-sonnet-5' } }, 'module-at-root');
    const { cfg, stderr } = loadQuietly(dir);

    assert.deepStrictEqual(cfg.unknownKeys, ['aiReview']);
    assert.match(stderr, /modules\.aiReview/);
  });

  test('stays silent on keys consumed outside this process', () => {
    // owner/admin/mode: husky pre-push + website repo-mode. telemetry:
    // scan-telemetry.js. None are read by GateTestConfig, all are real.
    const dir = projectWith({
      owner: 'crclabs-hq',
      admin: true,
      mode: 'strict',
      telemetry: false,
      gatetest_source: 'https://github.com/crclabs-hq/gatetest',
      $schema: './schema.json',
    }, 'external-keys');
    const { cfg, stderr } = loadQuietly(dir);

    assert.deepStrictEqual(cfg.unknownKeys, []);
    assert.strictEqual(stderr, '');
  });

  test('stays silent on every key the engine itself defines', () => {
    const dir = projectWith({
      thresholds: { maxFileLength: 800 },
      modules: { prSize: { maxLinesChangedError: 3000 } },
      suites: {},
      reporting: {},
      scanning: {},
      gate: {},
      incremental: {},
    }, 'known-keys');
    const { cfg, stderr } = loadQuietly(dir);

    assert.deepStrictEqual(cfg.unknownKeys, []);
    assert.strictEqual(stderr, '');
  });

  test('warning is advisory — the rest of the config still loads', () => {
    // A stale key must never cost a customer their scan.
    const dir = projectWith({
      aiReview: { model: 'claude-sonnet-5' },
      thresholds: { maxFileLength: 800 },
    }, 'still-loads');
    const { cfg } = loadQuietly(dir);

    assert.strictEqual(cfg.getThreshold('maxFileLength'), 800);
    assert.ok(Array.isArray(cfg.getSuite('quick')), 'defaults survive the warning');
  });

  test('no config file means nothing to warn about', () => {
    const dir = path.join(tmpRoot, 'no-config');
    fs.mkdirSync(dir, { recursive: true });
    const { cfg, stderr } = loadQuietly(dir);

    assert.deepStrictEqual(cfg.unknownKeys, []);
    assert.strictEqual(stderr, '');
  });

  test('CONTROL PAIR — known-only config emits no config:unknown-keys check; severity+gating names exactly those two, with hints', () => {
    const cleanDir = projectWith({ thresholds: { maxFileLength: 800 }, ignore: ['secrets:apiKey'] }, 'check-clean');
    const cleanCfg = new GateTestConfig(cleanDir);
    assert.strictEqual(cleanCfg.getUnknownKeysCheck(), null, 'no unknown keys → no check at all');

    const dirtyDir = projectWith({ severity: 'error', gating: { blockOnFailure: true } }, 'check-dirty');
    const { cfg: dirtyCfg } = loadQuietly(dirtyDir);
    const check = dirtyCfg.getUnknownKeysCheck();
    assert.ok(check, 'unknown keys → a check is emitted');
    assert.strictEqual(check.name, 'config:unknown-keys');
    assert.strictEqual(check.passed, false);
    assert.strictEqual(check.severity, 'info');
    assert.deepStrictEqual(check.keys.sort(), ['gating', 'severity']);
    assert.strictEqual(check.hints.gating, 'gate', '"gating" maps to the real "gate" key');
    assert.strictEqual(check.hints.severity, null, 'no severity-override mechanism exists — honest "no equivalent"');
    assert.match(check.message, /severity \(no equivalent in this version\)/);
    assert.match(check.message, /gating \(did you mean "gate"\?\)/);
  });

  test('a key starting with `$` is documentation, never unknown, at any name', () => {
    const dir = projectWith({ $comment: 'internal notes', $id: 'x', thresholds: {} }, 'dollar-keys');
    const { cfg, stderr } = loadQuietly(dir);
    assert.deepStrictEqual(cfg.unknownKeys, []);
    assert.strictEqual(stderr, '');
  });

  test('the protection-marker keys install.sh writes (protected, do_not_remove, integration_version) are known, not unknown', () => {
    const dir = projectWith({
      protected: true,
      gatetest_source: 'https://github.com/crclabs-hq/gatetest',
      do_not_remove: 'This repo is protected by GateTest.',
      integration_version: 2,
      mode: 'advisory',
    }, 'marker-keys');
    const { cfg, stderr } = loadQuietly(dir);
    assert.deepStrictEqual(cfg.unknownKeys, []);
    assert.strictEqual(stderr, '');
  });

  test('a malformed config warns about parsing, not about keys', () => {
    const dir = path.join(tmpRoot, 'malformed');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gatetest.json'), '{ not json');
    const { cfg, stderr } = loadQuietly(dir);

    assert.deepStrictEqual(cfg.unknownKeys, []);
    assert.match(stderr, /Failed to parse/);
    assert.doesNotMatch(stderr, /does not read/);
  });
});
