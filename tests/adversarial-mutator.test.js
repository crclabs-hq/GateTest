// =============================================================================
// ADVERSARIAL MUTATOR TRAINER TEST
// =============================================================================

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AM = require('../website/app/lib/trainers/adversarial-mutator.js');

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-am-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function fakeRepo(files = []) {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'repo-'));
  for (const rel of files) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '// sample\nconst x = 1;\nif (x === 1) { return true; }\n');
  }
  return root;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('adversarial-mutator — shape', () => {
  it('exports run + renderMarkdown', () => {
    assert.strictEqual(typeof AM.run, 'function');
    assert.strictEqual(typeof AM.renderMarkdown, 'function');
  });
});

// ---------------------------------------------------------------------------
// listSourceFiles — selection
// ---------------------------------------------------------------------------

describe('adversarial-mutator — listSourceFiles', () => {
  it('finds JS/TS files under src/ and website/app/lib/', () => {
    const repo = fakeRepo([
      'src/modules/foo.js',
      'src/core/bar.js',
      'website/app/lib/baz.js',
    ]);
    const files = AM._listSourceFiles(repo);
    assert.ok(files.some((f) => f.endsWith('foo.js')));
    assert.ok(files.some((f) => f.endsWith('bar.js')));
    assert.ok(files.some((f) => f.endsWith('baz.js')));
  });

  it('excludes node_modules / .next / tests / .test.js', () => {
    const repo = fakeRepo([
      'src/modules/x.js',
      'src/modules/x.test.js',
      'node_modules/dep/index.js',
      'tests/x.test.js',
      '.next/static/y.js',
    ]);
    const files = AM._listSourceFiles(repo);
    assert.ok(files.some((f) => f === 'src/modules/x.js'));
    assert.ok(!files.some((f) => f.includes('node_modules')));
    assert.ok(!files.some((f) => f.endsWith('.test.js')));
    assert.ok(!files.some((f) => f.startsWith('.next')));
  });

  it('caps to maxFiles', () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/modules/m${i}.js`);
    const repo = fakeRepo(many);
    const files = AM._listSourceFiles(repo, { maxFiles: 5 });
    assert.ok(files.length <= 5);
  });
});

// ---------------------------------------------------------------------------
// errorCountByRule
// ---------------------------------------------------------------------------

describe('adversarial-mutator — errorCountByRule', () => {
  it('counts only error-severity findings, grouped by rule', () => {
    const report = {
      checks: [
        { rule: 'security:eval', severity: 'error' },
        { rule: 'security:eval', severity: 'error' },
        { rule: 'lint:semi', severity: 'warning' },
        { rule: 'tls:reject', severity: 'error' },
      ],
    };
    const counts = AM._errorCountByRule(report);
    assert.strictEqual(counts.get('security:eval'), 2);
    assert.strictEqual(counts.get('tls:reject'), 1);
    assert.strictEqual(counts.has('lint:semi'), false);
  });

  it('handles missing checks array', () => {
    assert.strictEqual(AM._errorCountByRule(null).size, 0);
    assert.strictEqual(AM._errorCountByRule({}).size, 0);
  });

  it('accepts `findings` as fallback array name', () => {
    const counts = AM._errorCountByRule({ findings: [{ rule: 'r', severity: 'error' }] });
    assert.strictEqual(counts.get('r'), 1);
  });
});

// ---------------------------------------------------------------------------
// mutationWasCaught
// ---------------------------------------------------------------------------

describe('adversarial-mutator — mutationWasCaught', () => {
  it('true when mutated report introduces a brand-new error rule', () => {
    const baseline = { checks: [{ rule: 'a', severity: 'error' }] };
    const mutated  = { checks: [{ rule: 'a', severity: 'error' }, { rule: 'b', severity: 'error' }] };
    assert.strictEqual(AM._mutationWasCaught(baseline, mutated), true);
  });

  it('true when mutated raises the count of an existing rule', () => {
    const baseline = { checks: [{ rule: 'a', severity: 'error' }] };
    const mutated  = { checks: [{ rule: 'a', severity: 'error' }, { rule: 'a', severity: 'error' }] };
    assert.strictEqual(AM._mutationWasCaught(baseline, mutated), true);
  });

  it('false when nothing changes', () => {
    const baseline = { checks: [{ rule: 'a', severity: 'error' }] };
    const mutated  = { checks: [{ rule: 'a', severity: 'error' }] };
    assert.strictEqual(AM._mutationWasCaught(baseline, mutated), false);
  });

  it('false when mutated has FEWER errors (mutation removed a finding)', () => {
    const baseline = { checks: [{ rule: 'a', severity: 'error' }, { rule: 'a', severity: 'error' }] };
    const mutated  = { checks: [{ rule: 'a', severity: 'error' }] };
    assert.strictEqual(AM._mutationWasCaught(baseline, mutated), false);
  });
});

// ---------------------------------------------------------------------------
// parseJsonSafe
// ---------------------------------------------------------------------------

describe('adversarial-mutator — parseJsonSafe', () => {
  it('extracts JSON from output with leading banner lines', () => {
    const text = 'GateTest scanning…\n{"checks":[{"rule":"a","severity":"error"}]}\nDone.\n';
    const parsed = AM._parseJsonSafe(text);
    assert.ok(parsed && Array.isArray(parsed.checks));
    assert.strictEqual(parsed.checks[0].rule, 'a');
  });

  it('returns null on garbage', () => {
    assert.strictEqual(AM._parseJsonSafe('not json'), null);
    assert.strictEqual(AM._parseJsonSafe(''), null);
    assert.strictEqual(AM._parseJsonSafe(null), null);
  });
});

// ---------------------------------------------------------------------------
// run — dryRun mode (no gate invocation)
// ---------------------------------------------------------------------------

describe('adversarial-mutator — run (dryRun)', () => {
  it('enumerates mutations without invoking the gate', async () => {
    const repo = fakeRepo([
      'src/modules/foo.js',
      'src/modules/bar.js',
    ]);
    const result = await AM.run({ repoRoot: repo, dryRun: true, maxFiles: 5, maxMutationsPerFile: 2 });
    assert.strictEqual(typeof result.mutationsTried, 'number');
    assert.strictEqual(typeof result.files, 'number');
    assert.strictEqual(result.coverageHoles.length, 0, 'dryRun produces no holes');
    assert.strictEqual(result.mutationsCaught, 0, 'dryRun does not catch');
  });

  it('handles empty repo gracefully', async () => {
    const repo = fakeRepo([]);
    const result = await AM.run({ repoRoot: repo, dryRun: true });
    assert.strictEqual(result.files, 0);
    assert.strictEqual(result.mutationsTried, 0);
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe('adversarial-mutator — renderMarkdown', () => {
  it('renders empty report', () => {
    const md = AM.renderMarkdown({
      generatedAt: new Date().toISOString(),
      suite: 'quick',
      files: 0,
      mutationsTried: 0,
      mutationsCaught: 0,
      coverageHoles: [],
      errors: [],
    });
    assert.ok(md.includes('# Adversarial Mutator'));
    assert.ok(md.includes('No coverage holes'));
  });

  it('renders coverage-hole table', () => {
    const md = AM.renderMarkdown({
      generatedAt: new Date().toISOString(),
      suite: 'quick',
      files: 1,
      mutationsTried: 5,
      mutationsCaught: 4,
      coverageHoles: [{
        file: 'src/modules/foo.js',
        line: 42,
        operator: 'eq-flip',
        before: 'a === b',
        after: 'a !== b',
        note: 'slipped',
      }],
      errors: [],
    });
    assert.ok(md.includes('foo.js'));
    assert.ok(md.includes('eq-flip'));
    assert.ok(md.includes('a === b'));
  });
});
