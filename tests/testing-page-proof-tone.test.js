/**
 * GT-01 (outside reviewer, 2026-09-26): gatetest.io/testing rendered
 * "AUTO-FIXED 0 % (0/40), MEDIAN FIX TIME —, PENDING 40" in success-green —
 * a reader skimming colour alone came away thinking the arena was
 * succeeding. The fix lives in the pure, React-free
 * website/app/lib/testing-proof-tone.ts so the tone decision is testable
 * without rendering the page: this file drives that module directly.
 *
 * Three cases, per the brief:
 *   - 0 fixed of 40 -> warning (the exact live incident).
 *   - 5 of 40, most recent fix within 7 days -> success.
 *   - 5 of 40, most recent fix older than 7 days -> warning (stale proof).
 *
 * Harness: testing-proof-tone.ts is TypeScript with no compiled JS.
 * Transpile with the vendored `typescript` package, same approach as
 * tests/testing-page-anonymous-arena.test.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'website/app/lib/testing-proof-tone.ts');
const TS_COMPILER_PATH = path.join(ROOT, 'website/node_modules/typescript/lib/typescript.js');

if (!fs.existsSync(TS_COMPILER_PATH)) {
  throw new Error(
    `typescript compiler not found at ${TS_COMPILER_PATH} — recreate the website/node_modules junction before running this test file.`,
  );
}
const ts = require(TS_COMPILER_PATH);

function loadProofTone() {
  const source = fs.readFileSync(SRC_PATH, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: SRC_PATH,
  });
  const mod = new Module(SRC_PATH, module);
  mod.filename = SRC_PATH;
  mod.paths = Module._nodeModulePaths(path.dirname(SRC_PATH));
  mod._compile(outputText, SRC_PATH);
  return mod.exports;
}

const { selectProofTone, PROOF_STALE_MS } = loadProofTone();

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe('selectProofTone — GT-01: the page never wears success-green over a failure', () => {
  it('0 fixed of 40 (the exact live incident) -> warning, with an honest zero-fix sentence', () => {
    const result = selectProofTone({ fixed: 0, total: 40, lastFixedAt: null }, NOW);
    assert.equal(result.tone, 'warning');
    assert.match(result.headline, /40 cycles ran/);
    assert.match(result.headline, /none produced a merged fix yet/);
  });

  it('5 of 40, most recent fix 1 day ago -> success', () => {
    const lastFixedAt = new Date(NOW - ONE_DAY_MS).toISOString();
    const result = selectProofTone({ fixed: 5, total: 40, lastFixedAt }, NOW);
    assert.equal(result.tone, 'success');
    assert.match(result.headline, /5 of 40/);
  });

  it('5 of 40, most recent fix 10 days ago -> warning (stale proof, not "still succeeding")', () => {
    const lastFixedAt = new Date(NOW - 10 * ONE_DAY_MS).toISOString();
    const result = selectProofTone({ fixed: 5, total: 40, lastFixedAt }, NOW);
    assert.equal(result.tone, 'warning');
    assert.match(result.headline, /No fix has landed in the last 7 days/);
    assert.match(result.headline, /10 days ago/);
  });

  it('boundary: a fix exactly at the 7-day mark still counts as recent', () => {
    const lastFixedAt = new Date(NOW - PROOF_STALE_MS).toISOString();
    const result = selectProofTone({ fixed: 3, total: 10, lastFixedAt }, NOW);
    assert.equal(result.tone, 'success');
  });

  it('an optional reason is folded into the zero-fix headline when known', () => {
    const result = selectProofTone(
      { fixed: 0, total: 12, lastFixedAt: null, reason: 'fixes are in flight but none has merged yet' },
      NOW,
    );
    assert.equal(result.tone, 'warning');
    assert.match(result.headline, /fixes are in flight but none has merged yet/);
  });

  it('zero cycles total is not the same failure — no cycles have run at all, not "fixes did not land"', () => {
    const result = selectProofTone({ fixed: 0, total: 0, lastFixedAt: null }, NOW);
    // total === 0 skips the "cycles ran; none fixed" branch and falls through
    // to the no-recent-fix branch, which is still an honest warning.
    assert.equal(result.tone, 'warning');
    assert.match(result.headline, /No fix has landed yet/);
  });
});
