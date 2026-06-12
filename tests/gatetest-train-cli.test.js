// =============================================================================
// gatetest train CLI — UNIT TESTS
// =============================================================================
// Tests parseTrainArgs (pure) + the TRAINERS catalogue (pure shape).
// End-to-end smoke (running the actual subcommand) is covered by the
// process-exit path in main(), tested via a mocked module loader.
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const train = require('../bin/gatetest-train.js');

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('gatetest train — module shape', () => {
  it('exports main, parseTrainArgs, TRAINERS', () => {
    assert.strictEqual(typeof train.main, 'function');
    assert.strictEqual(typeof train.parseTrainArgs, 'function');
    assert.ok(Array.isArray(train.TRAINERS));
  });

  it('TRAINERS catalogue lists all 8 trainers (incl hacker-news-monitor, Craig-authorized 2026-06-12)', () => {
    const names = train.TRAINERS.map((t) => t.name).sort();
    assert.deepStrictEqual(names, [
      'adversarial-mutator',
      'confidence-calibrator',
      'cross-repo-promoter',
      'hacker-news-monitor',
      'pattern-miner',
      'recipe-auto-promoter',
      'recipe-promoter',
      'regression-test-generator',
    ]);
  });

  it('every trainer has name + flag + modulePath + method', () => {
    for (const t of train.TRAINERS) {
      assert.strictEqual(typeof t.name, 'string', `${t.name} has string name`);
      assert.strictEqual(typeof t.flag, 'string', `${t.name} has flag`);
      assert.strictEqual(typeof t.modulePath, 'string', `${t.name} has modulePath`);
      assert.strictEqual(typeof t.method, 'string', `${t.name} has method`);
      assert.ok(t.modulePath.endsWith('.js'), `${t.name} modulePath ends with .js`);
    }
  });

  it('flags are unique and lowercase', () => {
    const flags = train.TRAINERS.map((t) => t.flag);
    const lower = flags.every((f) => f === f.toLowerCase());
    assert.ok(lower, 'flags must be lowercase');
    assert.strictEqual(new Set(flags).size, flags.length, 'flags must be unique');
  });

  it('adversarial-mutator is flagged as slow', () => {
    const adv = train.TRAINERS.find((t) => t.name === 'adversarial-mutator');
    assert.strictEqual(adv.slow, true);
  });
});

// ---------------------------------------------------------------------------
// parseTrainArgs
// ---------------------------------------------------------------------------

describe('gatetest train — parseTrainArgs', () => {
  it('returns defaults for empty argv', () => {
    const opts = train.parseTrainArgs([]);
    assert.strictEqual(opts.only, null);
    assert.strictEqual(opts.json, false);
    assert.strictEqual(opts.noIngest, false);
    assert.strictEqual(opts.noAdversarial, false);
    assert.strictEqual(opts.help, false);
    assert.strictEqual(typeof opts.repoRoot, 'string');
  });

  it('parses --json', () => {
    assert.strictEqual(train.parseTrainArgs(['--json']).json, true);
  });

  it('parses --no-ingest', () => {
    assert.strictEqual(train.parseTrainArgs(['--no-ingest']).noIngest, true);
  });

  it('parses --no-adversarial', () => {
    assert.strictEqual(train.parseTrainArgs(['--no-adversarial']).noAdversarial, true);
  });

  it('parses --help and -h', () => {
    assert.strictEqual(train.parseTrainArgs(['--help']).help, true);
    assert.strictEqual(train.parseTrainArgs(['-h']).help, true);
  });

  it('parses --only <name>', () => {
    assert.strictEqual(train.parseTrainArgs(['--only', 'pattern']).only, 'pattern');
    assert.strictEqual(train.parseTrainArgs(['--only', 'recipe']).only, 'recipe');
  });

  it('parses --repo <path>', () => {
    const opts = train.parseTrainArgs(['--repo', '/tmp/somewhere']);
    assert.ok(opts.repoRoot.includes('/tmp/somewhere'));
  });

  it('combines multiple flags', () => {
    const opts = train.parseTrainArgs(['--json', '--no-adversarial', '--only', 'pattern']);
    assert.strictEqual(opts.json, true);
    assert.strictEqual(opts.noAdversarial, true);
    assert.strictEqual(opts.only, 'pattern');
  });
});

// ---------------------------------------------------------------------------
// main() returns help cleanly
// ---------------------------------------------------------------------------

describe('gatetest train — main()', () => {
  it('returns 0 immediately for --help', async () => {
    // Capture stdout to avoid polluting the test output.
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = (chunk) => { captured += String(chunk); return true; };
    try {
      const code = await train.main(['--help']);
      assert.strictEqual(code, 0);
      assert.ok(captured.includes('gatetest train'), 'help text rendered');
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
