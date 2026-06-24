// =============================================================================
// RULE-BASED-FIXER LOADER TEST
// =============================================================================
// Validates the opt-in loader for auto-promoted pending rules.
// =============================================================================

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOADER = require('../website/app/lib/rule-based-fixer-loader.js');

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-rfl-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function pendingDir(name) {
  const d = path.join(tmpRoot, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeRule(dir, fname, body) {
  const p = path.join(dir, fname);
  fs.writeFileSync(p, body);
  return p;
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('rule-based-fixer-loader — shape', () => {
  it('exports loadActiveRules, applyRulesWithAuto, selectionFromEnv, listPendingRuleFiles', () => {
    assert.strictEqual(typeof LOADER.loadActiveRules, 'function');
    assert.strictEqual(typeof LOADER.applyRulesWithAuto, 'function');
    assert.strictEqual(typeof LOADER.selectionFromEnv, 'function');
    assert.strictEqual(typeof LOADER.listPendingRuleFiles, 'function');
  });

  it('exports static applyRules as fallback', () => {
    assert.strictEqual(typeof LOADER.applyRulesStatic, 'function');
  });
});

// ---------------------------------------------------------------------------
// selectionFromEnv — parse env-var semantics
// ---------------------------------------------------------------------------

describe('rule-based-fixer-loader — selectionFromEnv', () => {
  it('disables when env-var unset / empty', () => {
    const s = LOADER.selectionFromEnv('');
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.allowAll, false);
  });

  it('disables on explicit 0 / false / off', () => {
    for (const v of ['0', 'false', 'off', 'FALSE', 'Off']) {
      assert.strictEqual(LOADER.selectionFromEnv(v).enabled, false);
    }
  });

  it('enables all on 1 / true / all', () => {
    for (const v of ['1', 'true', 'all', 'TRUE', 'All']) {
      const s = LOADER.selectionFromEnv(v);
      assert.strictEqual(s.enabled, true);
      assert.strictEqual(s.allowAll, true);
    }
  });

  it('enables a named selection when comma-separated', () => {
    const s = LOADER.selectionFromEnv('auto-x,auto-y,  auto-z  ');
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.allowAll, false);
    assert.ok(s.names.has('auto-x'));
    assert.ok(s.names.has('auto-y'));
    assert.ok(s.names.has('auto-z'));
  });
});

// ---------------------------------------------------------------------------
// listPendingRuleFiles
// ---------------------------------------------------------------------------

describe('rule-based-fixer-loader — listPendingRuleFiles', () => {
  it('returns empty for missing dir', () => {
    assert.deepStrictEqual(LOADER.listPendingRuleFiles('/tmp/__doesnt_exist__/' + Math.random()), []);
  });

  it('lists .js files in the dir', () => {
    const dir = pendingDir('list-1');
    fs.writeFileSync(path.join(dir, 'a.js'), '');
    fs.writeFileSync(path.join(dir, 'b.js'), '');
    fs.writeFileSync(path.join(dir, 'c.txt'), '');
    fs.writeFileSync(path.join(dir, '.hidden.js'), '');
    fs.writeFileSync(path.join(dir, '_private.js'), '');
    const found = LOADER.listPendingRuleFiles(dir).map((p) => path.basename(p)).sort();
    assert.deepStrictEqual(found, ['a.js', 'b.js']);
  });
});

// ---------------------------------------------------------------------------
// loadActiveRules — the meat
// ---------------------------------------------------------------------------

describe('rule-based-fixer-loader — loadActiveRules', () => {
  it('returns base rules only when env-var is off', () => {
    const dir = pendingDir('off-test');
    writeRule(dir, 'auto-x.js', `
      module.exports = { rule: { name: 'auto-x', auto: true,
        matches: () => true, apply: (c) => c + ' modified' } };
    `);
    const r = LOADER.loadActiveRules({ envVar: '', pendingDir: dir });
    assert.strictEqual(r.autoLoaded.length, 0);
    assert.ok(r.rules.length > 0, 'base rules should still come through');
    assert.ok(!r.rules.some((rule) => rule.name === 'auto-x'), 'auto-x should NOT be loaded');
  });

  it('loads all auto rules when env-var is "1"', () => {
    const dir = pendingDir('all-test');
    writeRule(dir, 'auto-x.js', `
      module.exports = { rule: { name: 'auto-x', auto: true,
        matches: () => true, apply: (c) => c } };
    `);
    writeRule(dir, 'auto-y.js', `
      module.exports = { rule: { name: 'auto-y', auto: true,
        matches: () => true, apply: (c) => c } };
    `);
    const r = LOADER.loadActiveRules({ envVar: '1', pendingDir: dir });
    assert.deepStrictEqual(r.autoLoaded.sort(), ['auto-x', 'auto-y']);
    assert.ok(r.rules.some((rule) => rule.name === 'auto-x'));
    assert.ok(r.rules.some((rule) => rule.name === 'auto-y'));
  });

  it('loads only selected names when env-var is a list', () => {
    const dir = pendingDir('select-test');
    writeRule(dir, 'auto-x.js', `
      module.exports = { rule: { name: 'auto-x', auto: true,
        matches: () => true, apply: (c) => c } };
    `);
    writeRule(dir, 'auto-y.js', `
      module.exports = { rule: { name: 'auto-y', auto: true,
        matches: () => true, apply: (c) => c } };
    `);
    const r = LOADER.loadActiveRules({ envVar: 'auto-x', pendingDir: dir });
    assert.deepStrictEqual(r.autoLoaded, ['auto-x']);
    assert.ok(r.autoSkipped.includes('auto-y'));
  });

  it('refuses to load a pending file missing the `auto` flag', () => {
    const dir = pendingDir('no-auto-test');
    writeRule(dir, 'fake.js', `
      module.exports = { rule: { name: 'fake',
        matches: () => true, apply: (c) => c } };  // no auto:true
    `);
    const r = LOADER.loadActiveRules({ envVar: '1', pendingDir: dir });
    assert.strictEqual(r.autoLoaded.length, 0);
    assert.ok(r.autoSkipped.includes('fake.js'));
  });

  it('skips a pending file with a syntax error', () => {
    const dir = pendingDir('syntax-err-test');
    writeRule(dir, 'broken.js', `
      this is not valid javascript ;;;
    `);
    const r = LOADER.loadActiveRules({ envVar: '1', pendingDir: dir });
    assert.strictEqual(r.autoLoaded.length, 0);
    assert.ok(r.autoSkipped.includes('broken.js'));
  });

  it('skips a pending file missing the `rule` export', () => {
    const dir = pendingDir('no-rule-test');
    writeRule(dir, 'orphan.js', `module.exports = { somethingElse: true };`);
    const r = LOADER.loadActiveRules({ envVar: '1', pendingDir: dir });
    assert.strictEqual(r.autoLoaded.length, 0);
    assert.ok(r.autoSkipped.includes('orphan.js'));
  });
});

// ---------------------------------------------------------------------------
// applyRulesWithAuto — end-to-end
// ---------------------------------------------------------------------------

describe('rule-based-fixer-loader — applyRulesWithAuto', () => {
  it('applies an auto-loaded rule', () => {
    const dir = pendingDir('apply-test');
    writeRule(dir, 'auto-swap.js', `
      module.exports = { rule: {
        name: 'auto-swap',
        auto: true,
        matches: (issue) => issue.includes('FOO'),
        apply: (c) => c.split('FOO').join('BAR'),
      } };
    `);
    const result = LOADER.applyRulesWithAuto(
      'const x = "FOO";',
      'test.js',
      ['something FOO'],
      { envVar: '1', pendingDir: dir },
    );
    assert.strictEqual(result.content, 'const x = "BAR";');
    assert.deepStrictEqual(result.handled, ['something FOO']);
  });

  it('falls back to unhandled when no rule matches', () => {
    const dir = pendingDir('no-match-test');
    const result = LOADER.applyRulesWithAuto(
      'const x = 1;',
      'test.js',
      ['NEVER_GONNA_MATCH_ANYTHING_XYZ'],
      { envVar: '', pendingDir: dir },
    );
    assert.deepStrictEqual(result.handled, []);
    assert.deepStrictEqual(result.unhandled, ['NEVER_GONNA_MATCH_ANYTHING_XYZ']);
  });

  it('throws on bad input types (same contract as base applyRules)', () => {
    assert.throws(() => LOADER.applyRulesWithAuto(123, 'f', []), TypeError);
    assert.throws(() => LOADER.applyRulesWithAuto('content', 'f', 'not-array'), TypeError);
  });
});
