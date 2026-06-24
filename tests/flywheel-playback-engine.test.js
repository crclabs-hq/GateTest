'use strict';
/**
 * Tests for src/core/flywheel-playback-engine.js
 *
 * All four public functions are exercised end-to-end using a tmpdir as the
 * events JSONL / recipe store path. No Claude API key required — playback
 * and distillation go through auto-distill which is also tested without
 * a network call.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const {
  recordFixEvent,
  clusterBugLineages,
  executePlaybackSimulation,
  distillRecipes,
  _fingerprint,
} = require('../src/core/flywheel-playback-engine');

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gt-flywheel-test-'));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── module shape ──────────────────────────────────────────────────────────────

describe('flywheel-playback-engine shape', () => {
  test('exports recordFixEvent as a function', () => {
    assert.equal(typeof recordFixEvent, 'function');
  });

  test('exports clusterBugLineages as a function', () => {
    assert.equal(typeof clusterBugLineages, 'function');
  });

  test('exports executePlaybackSimulation as a function', () => {
    assert.equal(typeof executePlaybackSimulation, 'function');
  });

  test('exports distillRecipes as a function', () => {
    assert.equal(typeof distillRecipes, 'function');
  });

  test('exports _fingerprint as a function', () => {
    assert.equal(typeof _fingerprint, 'function');
  });
});

// ── _fingerprint ──────────────────────────────────────────────────────────────

describe('_fingerprint', () => {
  test('returns a 16-character hex string', () => {
    const fp = _fingerprint('tlsSecurity', 'js-reject-unauthorized', '.js');
    assert.equal(typeof fp, 'string');
    assert.equal(fp.length, 16);
    assert.match(fp, /^[0-9a-f]+$/);
  });

  test('is deterministic — same inputs always produce same output', () => {
    const a = _fingerprint('mod', 'rule', '.ts');
    const b = _fingerprint('mod', 'rule', '.ts');
    assert.equal(a, b);
  });

  test('is sensitive to each component', () => {
    const base = _fingerprint('mod', 'rule', '.js');
    assert.notEqual(_fingerprint('other', 'rule', '.js'), base);
    assert.notEqual(_fingerprint('mod', 'other', '.js'), base);
    assert.notEqual(_fingerprint('mod', 'rule', '.ts'), base);
  });

  test('tolerates empty strings without throwing', () => {
    const fp = _fingerprint('', '', '');
    assert.equal(typeof fp, 'string');
    assert.equal(fp.length, 16);
  });
});

// ── recordFixEvent ────────────────────────────────────────────────────────────

describe('recordFixEvent', () => {
  test('returns recorded:true on successful write', () => {
    const dir = makeTmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    try {
      const result = recordFixEvent({
        ruleKey: 'js-reject-unauthorized',
        module: 'tlsSecurity',
        fileExt: '.js',
        layer: 'claude',
        success: true,
        durationMs: 1234,
        bidirectionalCertified: true,
        hypothesisName: 'Alpha',
        lineDelta: 2,
        attempt: 1,
        eventsPath,
      });
      assert.equal(result.recorded, true);
      assert.equal(fs.existsSync(eventsPath), true);
    } finally { cleanup(dir); }
  });

  test('appended JSONL line has required fields', () => {
    const dir = makeTmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    try {
      recordFixEvent({
        ruleKey: 'empty-catch',
        module: 'errorSwallow',
        fileExt: '.ts',
        layer: 'claude',
        success: false,
        durationMs: 500,
        bidirectionalCertified: false,
        attempt: 2,
        eventsPath,
      });
      const line = fs.readFileSync(eventsPath, 'utf-8').trim();
      const rec = JSON.parse(line);
      assert.equal(typeof rec.ts, 'string');
      assert.equal(typeof rec.fingerprint, 'string');
      assert.equal(rec.ruleKey, 'empty-catch');
      assert.equal(rec.module, 'errorSwallow');
      assert.equal(rec.fileExt, '.ts');
      assert.equal(rec.layer, 'claude');
      assert.equal(rec.success, false);
      assert.equal(rec.certified, false);
      assert.equal(rec.attempt, 2);
    } finally { cleanup(dir); }
  });

  test('multiple events append as separate lines', () => {
    const dir = makeTmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    try {
      recordFixEvent({ ruleKey: 'rule-a', eventsPath });
      recordFixEvent({ ruleKey: 'rule-b', eventsPath });
      recordFixEvent({ ruleKey: 'rule-c', eventsPath });
      const lines = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n');
      assert.equal(lines.length, 3);
      assert.equal(JSON.parse(lines[0]).ruleKey, 'rule-a');
      assert.equal(JSON.parse(lines[2]).ruleKey, 'rule-c');
    } finally { cleanup(dir); }
  });

  test('does not expose file path in the JSONL record', () => {
    const dir = makeTmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    try {
      recordFixEvent({
        ruleKey: 'src/sensitive/file.js', // path-like ruleKey — should be sanitised
        eventsPath,
      });
      const rec = JSON.parse(fs.readFileSync(eventsPath, 'utf-8').trim());
      // Path separators should be stripped
      assert.ok(!rec.ruleKey.includes('/'), 'forward slashes must not appear in ruleKey');
      assert.ok(!rec.ruleKey.includes('\\'), 'backslashes must not appear in ruleKey');
    } finally { cleanup(dir); }
  });

  test('returns recorded:true even when called with no opts (graceful default)', () => {
    const dir = makeTmpDir();
    const eventsPath = path.join(dir, 'empty.jsonl');
    try {
      // Pass eventsPath to avoid writing to the real home dir in CI
      const result = recordFixEvent({ eventsPath });
      assert.equal(result.recorded, true);
    } finally { cleanup(dir); }
  });

  test('never throws on pathological input', () => {
    assert.doesNotThrow(() => recordFixEvent(null));
    assert.doesNotThrow(() => recordFixEvent(undefined));
    assert.doesNotThrow(() => recordFixEvent({ eventsPath: '/nonexistent/__deep__/path.jsonl' }));
  });
});

// ── clusterBugLineages ────────────────────────────────────────────────────────

describe('clusterBugLineages', () => {
  test('returns empty clusters when events file does not exist', async () => {
    const result = await clusterBugLineages({ eventsPath: '/nonexistent/path/events.jsonl' });
    assert.deepEqual(result.clusters, []);
    assert.equal(result.totalEvents, 0);
  });

  test('clusters events by fingerprint', async () => {
    const dir = makeTmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    try {
      // Write 4 events for the same ruleKey+module+ext — 3 successes, 1 failure
      for (let i = 0; i < 3; i++) {
        recordFixEvent({ ruleKey: 'js-reject-unauthorized', module: 'tlsSecurity', fileExt: '.js', success: true, eventsPath });
      }
      recordFixEvent({ ruleKey: 'js-reject-unauthorized', module: 'tlsSecurity', fileExt: '.js', success: false, eventsPath });

      const { clusters, totalEvents } = await clusterBugLineages({ eventsPath });
      assert.equal(totalEvents, 4);
      assert.equal(clusters.length, 1);
      assert.equal(clusters[0].successCount, 3);
      assert.equal(clusters[0].totalCount, 4);
      assert.ok(clusters[0].confidence >= 0.74, 'confidence should be 3/4 = 0.75');
    } finally { cleanup(dir); }
  });

  test('rank 1 cluster when confidence ≥ 0.85 AND count ≥ 3', async () => {
    const dir = makeTmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    try {
      for (let i = 0; i < 5; i++) {
        recordFixEvent({ ruleKey: 'missing-header', module: 'webHeaders', fileExt: '.ts', success: true, eventsPath });
      }
      const { clusters } = await clusterBugLineages({ eventsPath });
      assert.equal(clusters[0].rank, 1);
      assert.ok(clusters[0].confidence >= 0.85);
    } finally { cleanup(dir); }
  });

  test('rank 2 cluster when count < 3 even at 100% confidence', async () => {
    const dir = makeTmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    try {
      // Only 2 events — too few for rank 1
      recordFixEvent({ ruleKey: 'rare-rule', module: 'mod', fileExt: '.js', success: true, eventsPath });
      recordFixEvent({ ruleKey: 'rare-rule', module: 'mod', fileExt: '.js', success: true, eventsPath });
      const { clusters } = await clusterBugLineages({ eventsPath });
      assert.equal(clusters[0].rank, 2);
    } finally { cleanup(dir); }
  });

  test('multiple clusters are returned and sorted rank ASC', async () => {
    const dir = makeTmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    try {
      // Rank-1 cluster: 5 successes
      for (let i = 0; i < 5; i++) {
        recordFixEvent({ ruleKey: 'rule-A', module: 'modA', fileExt: '.js', success: true, eventsPath });
      }
      // Rank-2 cluster: 2 events
      for (let i = 0; i < 2; i++) {
        recordFixEvent({ ruleKey: 'rule-B', module: 'modB', fileExt: '.ts', success: true, eventsPath });
      }

      const { clusters } = await clusterBugLineages({ eventsPath });
      assert.equal(clusters.length, 2);
      assert.equal(clusters[0].rank, 1);  // rank-1 first
      assert.equal(clusters[1].rank, 2);
    } finally { cleanup(dir); }
  });

  test('since filter excludes old events', async () => {
    const dir = makeTmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    try {
      recordFixEvent({ ruleKey: 'old-rule', module: 'mod', fileExt: '.js', success: true, eventsPath });
      const future = new Date(Date.now() + 60_000);
      const { clusters, totalEvents } = await clusterBugLineages({ eventsPath, since: future });
      assert.equal(totalEvents, 0);
      assert.equal(clusters.length, 0);
    } finally { cleanup(dir); }
  });

  test('never throws on malformed JSONL lines', async () => {
    const dir = makeTmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    try {
      fs.writeFileSync(eventsPath, 'not-json\n{"ts":"2026-01-01","fingerprint":"abc","success":true}\nbad\n', 'utf-8');
      const result = await clusterBugLineages({ eventsPath });
      assert.ok(Array.isArray(result.clusters));
    } finally { cleanup(dir); }
  });
});

// ── executePlaybackSimulation ─────────────────────────────────────────────────

describe('executePlaybackSimulation', () => {
  test('returns hit:false when content is not a string', () => {
    const result = executePlaybackSimulation({ content: null, issues: ['rule'] });
    assert.equal(result.hit, false);
    assert.equal(result.layer, 'recipe');
  });

  test('returns hit:false when issues is empty', () => {
    const result = executePlaybackSimulation({ content: 'x', issues: [] });
    assert.equal(result.hit, false);
  });

  test('returns hit:false when no recipePath is provided (no local store)', () => {
    const result = executePlaybackSimulation({
      content: 'const x = 1;',
      issues:  ['some-rule'],
      recipePath: null,
    });
    assert.equal(result.hit, false);
  });

  test('returns hit:false when recipe store does not exist at recipePath', () => {
    const dir = makeTmpDir();
    const recipePath = path.join(dir, 'nonexistent-recipes.json');
    try {
      const result = executePlaybackSimulation({
        content: 'const x = 1;',
        issues:  ['some-rule'],
        recipePath,
      });
      assert.equal(result.hit, false);
    } finally { cleanup(dir); }
  });

  test('never throws on pathological input', () => {
    assert.doesNotThrow(() => executePlaybackSimulation(null));
    assert.doesNotThrow(() => executePlaybackSimulation(undefined));
    assert.doesNotThrow(() => executePlaybackSimulation({ content: 42, issues: null }));
  });

  test('returns layer:recipe on miss', () => {
    const result = executePlaybackSimulation({ content: 'x', issues: ['r'] });
    assert.equal(result.layer, 'recipe');
  });
});

// ── distillRecipes ────────────────────────────────────────────────────────────

describe('distillRecipes', () => {
  test('returns distilled:false when content args are missing', () => {
    const r = distillRecipes({});
    assert.equal(r.distilled, false);
  });

  test('returns distilled:false when original === fixed (no change)', () => {
    const r = distillRecipes({
      originalContent: 'const x = 1;',
      fixedContent:    'const x = 1;',
      recipePath: '/any/path.json',
    });
    assert.equal(r.distilled, false);
    assert.equal(r.reason, 'no-change');
  });

  test('returns distilled:false when no recipePath provided', () => {
    const r = distillRecipes({
      originalContent: 'const x = 1;',
      fixedContent:    'const x = 2;',
    });
    assert.equal(r.distilled, false);
    assert.equal(r.reason, 'no-recipe-path');
  });

  test('never throws on pathological input', () => {
    assert.doesNotThrow(() => distillRecipes(null));
    assert.doesNotThrow(() => distillRecipes(undefined));
    assert.doesNotThrow(() => distillRecipes({ originalContent: null, fixedContent: null }));
  });

  test('returns an object with distilled boolean in all cases', () => {
    const cases = [
      {},
      { originalContent: 'a', fixedContent: 'b' },
      { originalContent: 'a', fixedContent: 'b', recipePath: '/tmp/r.json' },
    ];
    for (const c of cases) {
      const r = distillRecipes(c);
      assert.equal(typeof r.distilled, 'boolean');
    }
  });
});

// ── integration: record → cluster round-trip ──────────────────────────────────

describe('record → cluster round-trip', () => {
  test('events written by recordFixEvent are visible to clusterBugLineages', async () => {
    const dir = makeTmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    try {
      const opts = { ruleKey: 'py-float-cast', module: 'moneyFloat', fileExt: '.py', eventsPath };
      for (let i = 0; i < 4; i++) {
        recordFixEvent({ ...opts, success: true, bidirectionalCertified: true });
      }

      const { clusters } = await clusterBugLineages({ eventsPath });
      assert.ok(clusters.length >= 1);
      const c = clusters[0];
      assert.equal(c.ruleKey, 'py-float-cast');
      assert.equal(c.module, 'moneyFloat');
      assert.equal(c.successCount, 4);
      assert.equal(c.certifiedCount, 4);
      assert.equal(c.rank, 1);
    } finally { cleanup(dir); }
  });
});
