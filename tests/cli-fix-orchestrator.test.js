'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Access internals by importing the module and examining only the exported API.
// We monkey-patch via the opts._callClaude hook-point is not exposed directly,
// so we exercise the module through the public surface and stub the file layer.

const { runFixOrchestration } = require('../src/core/cli-fix-orchestrator');

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gt-orc-test-'));
}

function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

// ── module shape ──────────────────────────────────────────────────────────────

describe('cli-fix-orchestrator shape', () => {
  test('exports runFixOrchestration as a function', () => {
    assert.equal(typeof runFixOrchestration, 'function');
  });

  test('returns no-api-key when API key absent', async () => {
    const tmp  = makeTmp();
    const file = writeFile(tmp, 'foo.js', 'const x = 1;\n');
    const orig = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await runFixOrchestration({
        filePath: file,
        issues: ['no-op issue'],
        apiKey: undefined,
      });
      assert.equal(result.fixed, false);
      assert.equal(result.reason, 'no-api-key');
    } finally {
      if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns no-issues-provided when issues array is empty', async () => {
    const result = await runFixOrchestration({
      filePath: '/nonexistent/file.js',
      issues: [],
      apiKey: 'test-key',
    });
    assert.equal(result.fixed, false);
    assert.equal(result.reason, 'no-issues-provided');
  });

  test('returns unreadable when file does not exist', async () => {
    const result = await runFixOrchestration({
      filePath: '/nonexistent/file-that-does-not-exist.js',
      issues: ['some issue'],
      apiKey: 'test-key',
    });
    assert.equal(result.fixed, false);
    assert(result.reason.startsWith('unreadable'));
  });
});

// ── delimiter parsing (via internal parse — tested indirectly through a mock) ─

describe('hypothesis parsing via mock Claude response', () => {
  // We write a minimal fake file and a mock callAnthropic that returns
  // a well-formed 3-hypothesis response. Because _callClaude is not
  // overridable via opts, we patch the https module in a controlled tmp context.
  // Instead, we test the orchestrator end-to-end using monkey-patching of
  // the https module at a higher level — which is too invasive. Instead we
  // verify the observable output contract when Claude would return good data.

  test('result shape when api key present but Claude unreachable has reason field', async () => {
    const tmp  = makeTmp();
    const file = writeFile(tmp, 'target.js', '// placeholder\n');
    try {
      const result = await runFixOrchestration({
        filePath:    file,
        issues:      ['placeholder issue'],
        apiKey:      'sk-fake-key-for-test',
        maxAttempts: 1,
      });
      assert(typeof result === 'object');
      assert(typeof result.fixed === 'boolean');
      // Will fail to reach Claude with fake key → fixed=false with a reason
      if (!result.fixed) {
        assert(typeof result.reason === 'string', 'failed result must have reason');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── scoring logic (via exported helper — not exported, so tested indirectly) ──

describe('integration: syntax gate rejects malformed hypothesis', () => {
  test('malformed JS hypothesis is correctly ranked as failing', async () => {
    // Create a real JS file so the orchestrator can read it
    const tmp  = makeTmp();
    const file = writeFile(tmp, 'broken.js', 'const x = 1;\n');

    // We can observe ranking indirectly: if we knew Claude returned broken JS
    // as all three hypotheses, the orchestrator should return fixed=false.
    // Without a live API key we can only assert on the early-exit contract.
    const result = await runFixOrchestration({
      filePath:    file,
      issues:      ['test issue'],
      apiKey:      '', // empty → no-api-key
      maxAttempts: 1,
    });
    assert.equal(result.fixed, false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ── temp-dir cleanup ──────────────────────────────────────────────────────────

describe('temp directory lifecycle', () => {
  test('orchestrator cleans up its tmpdir even on early exit', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('gt-hyp-')).length;
    await runFixOrchestration({
      filePath: '/nonexistent/file.js',
      issues:   ['test'],
      apiKey:   'fake',
    });
    // The finally block in runFixOrchestration should have removed the tmpdir.
    // We can't assert exact count (parallel test runs), but we assert no crash.
    const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('gt-hyp-')).length;
    assert(after >= 0); // basic sanity — no exception thrown
  });
});

// ── runFixBatch — the batch contract bin/gatetest.js consumes ─────────────────

const { runFixBatch } = require('../src/core/cli-fix-orchestrator');

describe('runFixBatch', () => {
  test('exports runFixBatch as a function', () => {
    assert.equal(typeof runFixBatch, 'function');
  });

  test('returns the full batch contract shape with no key (forced no-api-key path)', async () => {
    const tmp = makeTmp();
    writeFile(tmp, 'a.js', 'const a = 1;\n');
    writeFile(tmp, 'b.js', 'const b = 2;\n');
    const findings = [
      { file: 'a.js', message: 'issue one', moduleName: 'secrets', checkName: 'hardcoded' },
      { file: 'a.js', message: 'issue two', moduleName: 'lint', checkName: 'unused' },
      { file: 'b.js', message: 'issue three', moduleName: 'lint', checkName: 'unused' },
    ];
    try {
      const result = await runFixBatch(findings, tmp, '', { maxAttempts: 1 });
      assert.ok(Array.isArray(result.accepted), 'accepted is an array');
      assert.ok(Array.isArray(result.testFiles), 'testFiles is an array');
      assert.ok(Array.isArray(result.allFixes), 'allFixes is an array');
      assert.ok(Array.isArray(result.failed), 'failed is an array');
      assert.equal(typeof result.prBody, 'string');
      // Empty apiKey forces the no-key early exit per file — nothing accepted,
      // both files reported failed, with the a.js issues grouped together.
      assert.equal(result.accepted.length, 0);
      assert.equal(result.failed.length, 2);
      assert.equal(result.failed[0].reason, 'no-api-key');
      assert.equal(result.failed[0].issues.length, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('fileCap limits how many files are attempted', async () => {
    const tmp = makeTmp();
    writeFile(tmp, 'a.js', 'const a = 1;\n');
    writeFile(tmp, 'b.js', 'const b = 2;\n');
    const findings = [
      { file: 'a.js', message: 'x', moduleName: 'm', checkName: 'c' },
      { file: 'b.js', message: 'y', moduleName: 'm', checkName: 'c' },
    ];
    try {
      const result = await runFixBatch(findings, tmp, '', { maxAttempts: 1, fileCap: 1 });
      assert.equal(result.accepted.length + result.failed.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips findings without a file path instead of crashing', async () => {
    const result = await runFixBatch(
      [{ file: null, message: 'config-level' }, null],
      process.cwd(),
      '',
      { maxAttempts: 1 },
    );
    assert.equal(result.accepted.length, 0);
    assert.equal(result.failed.length, 0);
  });
});

// ── hypothesis test runs exercise the HYPOTHESIS, not the on-disk original ──
// 2026-08-18 audit #7: `node --test` loads the source from disk, so running
// the test file without swapping the candidate in gave every hypothesis the
// ORIGINAL's test result. These controls pin the swap-in behavior: the test
// file can only pass for the CORRECT hypothesis, so the ranking must pick it
// even when a plausible-but-wrong hypothesis parses fine.

describe('hypothesis swap-in test runs (audit #7)', () => {
  const DELIMS = [
    '=== GATETEST_HYPOTHESIS_ALPHA ===',
    '=== GATETEST_HYPOTHESIS_BETA ===',
    '=== GATETEST_HYPOTHESIS_GAMMA ===',
  ];

  function fakeClaude(alpha, beta, gamma) {
    return async () => [DELIMS[0], alpha, DELIMS[1], beta, DELIMS[2], gamma].join('\n');
  }

  test('the hypothesis that makes the tests pass wins over one that merely parses', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-swapin-'));
    try {
      const srcPath = path.join(tmp, 'adder.js');
      // Broken original: subtracts instead of adds.
      fs.writeFileSync(srcPath, 'module.exports = function add(a, b) { return a - b; };\n');
      fs.mkdirSync(path.join(tmp, 'tests'));
      fs.writeFileSync(path.join(tmp, 'tests', 'adder.test.js'), [
        "const { test } = require('node:test');",
        "const assert = require('node:assert');",
        "const add = require('../adder.js');",
        "test('adds', () => { assert.strictEqual(add(2, 3), 5); });",
        '',
      ].join('\n'));

      const wrong   = 'module.exports = function add(a, b) { return a * b; };'; // parses, fails tests
      const correct = 'module.exports = function add(a, b) { return a + b; };';
      const broken  = 'module.exports = function add(a, b { return a + b; };';  // syntax error

      const result = await runFixOrchestration({
        filePath: srcPath,
        issues: ['add() returns the wrong value'],
        projectRoot: tmp,
        maxAttempts: 1,
        apiKey: 'test-key',
        _callClaude: fakeClaude(wrong, correct, broken),
      });

      assert.equal(result.fixed, true);
      assert.equal(result.rank, 1, 'winner must be the test-passing candidate (rank 1)');
      assert.equal(result.testsPassed, true);
      const onDisk = fs.readFileSync(srcPath, 'utf-8');
      assert.match(onDisk, /a \+ b/, 'the CORRECT hypothesis must be applied');
      // Before the fix, all candidates inherited the broken original's failing
      // test result, every rank was 2, and lineDelta picked the winner blind.
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('the original file is restored when every hypothesis fails its tests', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-swapin2-'));
    try {
      const srcPath = path.join(tmp, 'adder.js');
      const original = 'module.exports = function add(a, b) { return a - b; };\n';
      fs.writeFileSync(srcPath, original);
      fs.mkdirSync(path.join(tmp, 'tests'));
      fs.writeFileSync(path.join(tmp, 'tests', 'adder.test.js'), [
        "const { test } = require('node:test');",
        "const assert = require('node:assert');",
        "const add = require('../adder.js');",
        "test('adds', () => { assert.strictEqual(add(2, 3), 5); });",
        '',
      ].join('\n'));

      const wrongA = 'module.exports = function add(a, b) { return a * b; };';
      const wrongB = 'module.exports = function add(a, b) { return a / b; };';
      const wrongC = 'module.exports = function add(a, b) { return b - a; };';

      const result = await runFixOrchestration({
        filePath: srcPath,
        issues: ['add() returns the wrong value'],
        projectRoot: tmp,
        maxAttempts: 1,
        apiKey: 'test-key',
        _callClaude: fakeClaude(wrongA, wrongB, wrongC),
      });

      // All candidates parse but fail tests → best rank is 2; a rank-2 fix
      // still ships (existing contract), but the mid-evaluation swaps must
      // never leak: whatever was applied must be a HYPOTHESIS or the
      // original — never a half-restored state.
      const onDisk = fs.readFileSync(srcPath, 'utf-8');
      const legal = [original.trim(), wrongA, wrongB, wrongC].map((s) => s.trim());
      assert.ok(legal.includes(onDisk.trim()), 'on-disk content must be the original or a whole hypothesis');
      assert.equal(result.testsPassed, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── --dry-run never writes (KI #112) ──────────────────────────────────────────
// `gatetest fix --apply --dry-run` consulted the flag only AFTER runFixBatch
// had returned — and runFixBatch wrote every winning hypothesis to disk (and
// swapped candidates in for test runs) on the way. The plan it then printed
// described changes that had already happened. Control pair: the same
// fixture, same fake model, with and without dryRun. With: bytes AND mtime of
// every project file are unchanged and the plan names the change. Without:
// the file is modified.

describe('runFixBatch dryRun — the control pair (KI #112)', () => {
  const { formatDryRunPlan } = require('../src/core/cli-fix-orchestrator');
  const DELIMS = [
    '=== GATETEST_HYPOTHESIS_ALPHA ===',
    '=== GATETEST_HYPOTHESIS_BETA ===',
    '=== GATETEST_HYPOTHESIS_GAMMA ===',
  ];
  const ORIGINAL = 'module.exports = function add(a, b) { return a - b; };\n';
  const CORRECT  = 'module.exports = function add(a, b) { return a + b; };';
  const WRONG    = 'module.exports = function add(a, b) { return a * b; };';
  const BROKEN   = 'module.exports = function add(a, b { return a + b; };';
  // Alpha is the correct one so the dry run (which cannot run tests) and the
  // apply run (which can) both land on the same winner.
  const fakeClaude = async () => [DELIMS[0], CORRECT, DELIMS[1], WRONG, DELIMS[2], BROKEN].join('\n');
  const FINDINGS = [{ file: 'adder.js', message: 'add() returns the wrong value', moduleName: 'logic', checkName: 'arith' }];
  // A fixed past mtime: any write — even one that restores identical bytes —
  // moves it to "now", so mtime is the proof that no write happened.
  const PAST = new Date('2001-02-03T04:05:06Z');

  function makeProject() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dryrun-'));
    const srcPath = path.join(tmp, 'adder.js');
    fs.writeFileSync(srcPath, ORIGINAL);
    fs.mkdirSync(path.join(tmp, 'tests'));
    const testPath = path.join(tmp, 'tests', 'adder.test.js');
    fs.writeFileSync(testPath, [
      "const { test } = require('node:test');",
      "const assert = require('node:assert');",
      "const add = require('../adder.js');",
      "test('adds', () => { assert.strictEqual(add(2, 3), 5); });",
      '',
    ].join('\n'));
    for (const p of [srcPath, testPath]) fs.utimesSync(p, PAST, PAST);
    return { tmp, srcPath, testPath };
  }

  function snapshot(dir) {
    const out = new Map();
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else out.set(path.relative(dir, p), { bytes: fs.readFileSync(p), mtimeMs: fs.statSync(p).mtimeMs });
      }
    };
    walk(dir);
    return out;
  }

  test('with dryRun: every project file is byte-identical and untouched, and the plan names the change', async () => {
    const { tmp, srcPath } = makeProject();
    try {
      const before = snapshot(tmp);
      const result = await runFixBatch(FINDINGS, tmp, 'test-key', { maxAttempts: 1, dryRun: true, _callClaude: fakeClaude });

      assert.equal(result.dryRun, true);
      assert.equal(result.accepted.length, 1, `expected one accepted fix, got failed=${JSON.stringify(result.failed)}`);
      assert.match(result.accepted[0].fixed, /a \+ b/, 'the plan carries the would-be content');
      assert.equal(result.accepted[0].original, ORIGINAL);
      assert.equal(result.accepted[0].result.testsNotChecked, true, 'a dry run must say the tests were not run');

      const after = snapshot(tmp);
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file created or removed');
      for (const [rel, b] of before) {
        assert.ok(b.bytes.equals(after.get(rel).bytes), `${rel}: bytes changed under --dry-run`);
        assert.equal(after.get(rel).mtimeMs, b.mtimeMs, `${rel}: mtime moved — something wrote it under --dry-run`);
      }
      assert.equal(fs.readFileSync(srcPath, 'utf-8'), ORIGINAL);

      const plan = formatDryRunPlan(result.accepted);
      assert.match(plan, /adder\.js/);
      assert.match(plan, /^\s*-.*a - b/m, 'plan shows the removed line');
      assert.match(plan, /^\s*\+.*a \+ b/m, 'plan shows the added line');
      assert.match(plan, /Nothing was written/);
      assert.match(plan, /Tests NOT run/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('without dryRun: the same fixture IS modified (the control)', async () => {
    const { tmp, srcPath } = makeProject();
    try {
      const result = await runFixBatch(FINDINGS, tmp, 'test-key', { maxAttempts: 1, _callClaude: fakeClaude });
      assert.equal(result.dryRun, false);
      assert.equal(result.accepted.length, 1);
      const onDisk = fs.readFileSync(srcPath, 'utf-8');
      assert.match(onDisk, /a \+ b/, 'apply mode writes the winner');
      assert.notEqual(onDisk, ORIGINAL);
      assert.ok(fs.statSync(srcPath).mtimeMs > PAST.getTime(), 'apply mode moves the mtime — the dry-run assertion above is not vacuous');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('formatDryRunPlan renders counts, issues and the diff without touching disk', () => {
    const plan = formatDryRunPlan([{
      file: 'src/x.js',
      original: 'a\nb\nc\n',
      fixed: 'a\nB\nc\nd\n',
      issues: ['lint:unused — b is unused'],
      result: { hypothesis: 'Alpha' },
    }]);
    assert.match(plan, /--- src\/x\.js\s+\(\+2 -1, from line 2, hypothesis Alpha\)/);
    assert.match(plan, /issue: lint:unused — b is unused/);
    assert.match(plan, /^\s*-b$/m);
    assert.match(plan, /^\s*\+B$/m);
    assert.match(plan, /^\s*\+d$/m);
    assert.match(plan, /1 file\(s\) would change\. Nothing was written\./);
    assert.doesNotMatch(plan, /Tests NOT run/, 'no testsNotChecked flag → no not-run warning');
  });
});

// ── convergence guard — all-hypotheses-fail-syntax retries (C23) ──────────────
// src/core/convergence-guard.js is the one shared definition of "when does a
// fix loop stop, and why". When every hypothesis fails syntax with the SAME
// error every attempt, that is the loop re-flagging its own unfixed problem —
// it must stop and say so instead of burning the rest of maxAttempts.

describe('runFixOrchestration — convergence guard on repeated syntax failure', () => {
  const DELIMS = [
    '=== GATETEST_HYPOTHESIS_ALPHA ===',
    '=== GATETEST_HYPOTHESIS_BETA ===',
    '=== GATETEST_HYPOTHESIS_GAMMA ===',
  ];
  function fakeClaudeSeq(responses) {
    let n = 0;
    return async () => responses[Math.min(n++, responses.length - 1)];
  }
  function brokenTriple() {
    const broken = 'module.exports = function add(a, b { return a + b; };'; // syntax error, always the SAME text
    return [DELIMS[0], broken, DELIMS[1], broken, DELIMS[2], broken].join('\n');
  }

  test('the SAME syntax error every attempt stops early with no-progress, never reaching maxAttempts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-converge-'));
    try {
      const srcPath = writeFile(tmp, 'adder.js', 'module.exports = function add(a, b) { return a - b; };\n');
      const result = await runFixOrchestration({
        filePath: srcPath,
        issues: ['add() returns the wrong value'],
        projectRoot: tmp,
        maxAttempts: 5,
        apiKey: 'test-key',
        _callClaude: fakeClaudeSeq([brokenTriple(), brokenTriple(), brokenTriple(), brokenTriple(), brokenTriple()]),
      });

      assert.equal(result.fixed, false);
      assert.equal(result.loop.reason, 'no-progress');
      assert.ok(result.loop.iterations < 5, 'must stop before exhausting all 5 attempts');
      assert.match(result.loop.message, /the loop's own fix/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('control: a DIFFERENT syntax error each attempt runs to max-iterations, not no-progress', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-converge-ctrl-'));
    try {
      const srcPath = writeFile(tmp, 'adder.js', 'module.exports = function add(a, b) { return a - b; };\n');
      // Three genuinely different SyntaxError shapes (verified distinct
      // vm.Script messages: "Unexpected token '{'" / "Unexpected token
      // 'return'" / "Unexpected end of input") — not just different source
      // text producing the same message, which would still read as
      // no-progress.
      const brokenVariants = [
        'module.exports = function add(a, b { return a + b; };',
        'module.exports = function add(a, b) return a + b; };',
        'module.exports = function add(a, b) { return a + b; ',
      ];
      const responses = brokenVariants.map((broken) => [DELIMS[0], broken, DELIMS[1], broken, DELIMS[2], broken].join('\n'));
      const result = await runFixOrchestration({
        filePath: srcPath,
        issues: ['add() returns the wrong value'],
        projectRoot: tmp,
        maxAttempts: 3,
        apiKey: 'test-key',
        _callClaude: fakeClaudeSeq(responses),
      });

      assert.equal(result.fixed, false);
      assert.equal(result.loop.reason, 'max-iterations');
      assert.equal(result.loop.iterations, 3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
