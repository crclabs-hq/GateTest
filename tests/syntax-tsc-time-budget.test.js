const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SyntaxModule = require('../src/modules/syntax');

// Issue #630: syntax.js's TypeScript check runs a real `npx tsc --noEmit`
// subprocess PER real tsconfig.json it finds. On a 76-package monorepo
// fixture (~4200 files) this measured at 272s of a 273s quick-suite total —
// the very next-slowest module took ~50s — because the loop is O(real
// tsconfigs found), not O(files), and `_exec` is synchronous (execSync),
// so it also blocked the event loop for every other --parallel module.
// The fix bounds the WALL-CLOCK the whole TypeScript phase may spend,
// checked only BETWEEN projects, so a repo with one real tsconfig (the
// common case, and every repo in the precision corpus) always gets its one
// compile in full.

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

// A synchronous sleep — `_exec` in real life is `execSync`, which blocks
// the event loop for the duration of the subprocess. Simulating that with
// a real (if tiny) blocking wait, rather than an async delay, is the
// faithful stand-in: it reproduces "the loop cannot check the clock any
// faster than one subprocess at a time finishes."
function blockFor(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function writeRealTsconfig(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir) }));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2020', module: 'commonjs' },
  }));
  // `_checkTypeScript` requires an own node_modules dir before it will
  // run tsc in a non-root directory (base-module.js's existing "deps
  // aren't installed" skip) — an empty marker file is enough to satisfy
  // `fs.existsSync(node_modules)`.
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', '.keep'), '');
}

describe('SyntaxModule — TypeScript check time budget (issue #630)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-syn-budget-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('bounds wall-clock on a tree with many real tsconfigs, and discloses what was skipped', () => {
    const PKG_COUNT = 20;
    for (let i = 0; i < PKG_COUNT; i++) {
      const dir = path.join(tmp, 'packages', `pkg-${i}`);
      writeRealTsconfig(dir);
      fs.writeFileSync(path.join(dir, 'index.ts'), `export const x${i} = ${i};\n`);
    }

    const mod = new SyntaxModule();
    let execCalls = 0;
    // Each simulated `npx tsc` costs 60ms of REAL blocked wall-clock —
    // enough that a 150ms budget can only afford a couple of projects.
    mod._exec = () => { execCalls += 1; blockFor(60); return { exitCode: 0, stdout: '', stderr: '' }; };

    const result = makeResult();
    const config = { getModuleConfig: (name) => (name === 'syntax' ? { tsTimeBudgetMs: 150 } : {}) };

    const started = Date.now();
    mod._checkTypeScript(tmp, result, config);
    const elapsedMs = Date.now() - started;

    // Unbounded, this would be PKG_COUNT * 60ms = 1200ms; bounded, it must
    // stay well under that — generous margin for slow CI machines.
    assert.ok(
      elapsedMs < 800,
      `expected the tsc phase to stay under budget + margin, took ${elapsedMs}ms for ${execCalls} call(s)`,
    );
    assert.ok(execCalls < PKG_COUNT, `expected fewer than ${PKG_COUNT} tsc invocations, got ${execCalls}`);
    assert.ok(execCalls >= 1, 'the budget must not zero out the FIRST project');

    const budgetCheck = result.checks.find((c) => c.name === 'typescript-strict:budget');
    assert.ok(budgetCheck, 'a skipped-projects tree must report what was not checked (Doctrine #1/#6)');
    assert.match(budgetCheck.message, /not type-checked/i);
    assert.strictEqual(budgetCheck.severity, 'info');
  });

  it('does NOT cut off the single-project case — the common repo always gets its full compile', () => {
    // Only one real tsconfig exists: the budget is consulted BETWEEN
    // projects, so with nothing after it to skip, this one always runs to
    // completion regardless of how long it takes or how small the budget is.
    writeRealTsconfig(tmp);
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), 'export const x = 1;\n');

    const mod = new SyntaxModule();
    let execCalls = 0;
    mod._exec = () => { execCalls += 1; blockFor(120); return { exitCode: 0, stdout: '', stderr: '' }; };

    const result = makeResult();
    // A deliberately tiny budget — must not matter for a single project.
    const config = { getModuleConfig: () => ({ tsTimeBudgetMs: 10 }) };

    mod._checkTypeScript(tmp, result, config);

    assert.strictEqual(execCalls, 1, 'the only real tsconfig must still be compiled, budget notwithstanding');
    assert.strictEqual(
      result.checks.find((c) => c.name === 'typescript-strict:budget'),
      undefined,
      'nothing was skipped, so there is nothing to disclose',
    );
    assert.deepStrictEqual(result.checks.find((c) => c.name === 'typescript-strict'), { name: 'typescript-strict', passed: true });
  });

  it('control pair: a real syntax error in a normal source file still fires even on a large, budget-capped tree', async () => {
    for (let i = 0; i < 10; i++) {
      const dir = path.join(tmp, 'packages', `pkg-${i}`);
      writeRealTsconfig(dir);
      fs.writeFileSync(path.join(dir, 'index.ts'), `export const x${i} = ${i};\n`);
    }
    // The real defect: a plain CJS file with unbalanced syntax. Caught by
    // `_checkJsSyntax` (vm.Script), which is entirely independent of the
    // tsc time budget — it runs over every .js file regardless.
    fs.writeFileSync(path.join(tmp, 'packages', 'pkg-0', 'broken.js'), 'function broken( {\n  return 1;\n}\nmodule.exports = broken;\n');

    const mod = new SyntaxModule();
    mod._exec = () => { blockFor(40); return { exitCode: 0, stdout: '', stderr: '' }; };

    const result = makeResult();
    // Force the budget to cut off most projects, proving the cap is active
    // in this same run.
    await mod.run(result, { projectRoot: tmp, getModuleConfig: () => ({ tsTimeBudgetMs: 80 }) });

    const budgetCheck = result.checks.find((c) => c.name === 'typescript-strict:budget');
    assert.ok(budgetCheck, 'expected the budget to actually engage in this fixture');

    const brokenCheck = result.checks.find((c) => c.name && c.name.includes('broken.js'));
    assert.ok(brokenCheck, 'the real syntax error must still be reported');
    assert.strictEqual(brokenCheck.passed, false);
  });
});
