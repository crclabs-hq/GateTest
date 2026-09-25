// ============================================================================
// CONVERGENCE GUARD TEST
// ============================================================================
// Covers src/core/convergence-guard.js — the one definition (doctrine #4) of
// when an iterative review/fix loop stops and why, shared by
// website/app/lib/fix-attempt-loop.js, src/core/cli-fix-orchestrator.js and
// bin/gatetest.js's --crawl-loop.
//
// Complaint C23 (CodeRabbit G2): a loop that re-flags the fix it just made,
// or burns its whole budget with no stated reason. Every scenario below has
// a control pair: the shape that must fire the reason, and the neighbouring
// shape that must NOT.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConvergenceGuard, hashFindingSet, REASONS } = require('../src/core/convergence-guard.js');

test('converged — empty finding set stops immediately', () => {
  const guard = createConvergenceGuard({ maxIterations: 5 });
  const r = guard.step({ findingIds: [] });
  assert.equal(r.done, true);
  assert.equal(r.reason, REASONS.CONVERGED);
  assert.match(r.message, /^stopped: converged after iteration 1/);
  assert.equal(guard.getResult().iterations, 1);
});

test('converged — control: a non-empty set on the same call does NOT converge', () => {
  const guard = createConvergenceGuard({ maxIterations: 5 });
  const r = guard.step({ findingIds: ['finding-a'] });
  assert.equal(r.done, false);
  assert.equal(guard.getResult().reason, null);
});

test('no-progress — the identical finding set comes back next iteration', () => {
  const guard = createConvergenceGuard({ maxIterations: 5 });
  const first = guard.step({ findingIds: ['a', 'b', 'c'] });
  assert.equal(first.done, false);
  const second = guard.step({ findingIds: ['c', 'b', 'a'] }); // same set, different order
  assert.equal(second.done, true);
  assert.equal(second.reason, REASONS.NO_PROGRESS);
  assert.match(second.message, /the same 3 findings came back/);
  const res = guard.getResult();
  assert.equal(res.iterations, 2);
  assert.equal(res.unresolved.length, 3);
});

test('no-progress — control: a genuinely different set each iteration keeps going', () => {
  const guard = createConvergenceGuard({ maxIterations: 5 });
  guard.step({ findingIds: ['a', 'b'] });
  const r = guard.step({ findingIds: ['a', 'c'] }); // overlaps but is not identical
  assert.equal(r.done, false);
});

test('own-fix re-flag — a finding the loop just fixed reappears with the same id', () => {
  const guard = createConvergenceGuard({ maxIterations: 5 });
  const first = guard.step({
    findingIds: ['rule:console-log'],
    fixed: [{ id: 'rule:console-log', change: 'attempt 1: removed console.log on line 5' }],
  });
  assert.equal(first.done, false);

  const second = guard.step({ findingIds: ['rule:console-log'] });
  assert.equal(second.done, true);
  assert.equal(second.reason, REASONS.NO_PROGRESS);
  assert.match(second.message, /the loop's own fix/);

  const { unresolved } = guard.getResult();
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].id, 'rule:console-log');
  assert.equal(unresolved[0].origin, 'own-fix');
  assert.match(unresolved[0].lastAttempt, /attempt 1: removed console\.log/);
});

test('own-fix — control: a DIFFERENT finding on the same file does not count as a re-flag', () => {
  const guard = createConvergenceGuard({ maxIterations: 5 });
  guard.step({
    findingIds: ['rule:console-log'],
    fixed: [{ id: 'rule:console-log', change: 'attempt 1: removed console.log' }],
  });
  const r = guard.step({ findingIds: ['rule:unused-var'] }); // new, unrelated finding
  assert.equal(r.done, false, 'a new finding id must not be treated as a re-flag of a different one');
});

test('oscillating — the finding set alternates between two states', () => {
  const guard = createConvergenceGuard({ maxIterations: 5 });
  guard.step({ findingIds: ['a'] });        // state A
  guard.step({ findingIds: ['b'] });        // state B
  const third = guard.step({ findingIds: ['a'] }); // back to A
  assert.equal(third.done, true);
  assert.equal(third.reason, REASONS.OSCILLATING);
  assert.match(third.message, /alternating between two states/);
});

test('oscillating — control: three genuinely different sets in a row do not oscillate', () => {
  const guard = createConvergenceGuard({ maxIterations: 5 });
  guard.step({ findingIds: ['a'] });
  guard.step({ findingIds: ['b'] });
  const r = guard.step({ findingIds: ['c'] });
  assert.equal(r.done, false);
});

test('max-iterations — hits the cap when findings keep changing but never resolve', () => {
  const guard = createConvergenceGuard({ maxIterations: 2 });
  const first = guard.step({ findingIds: ['a'] });
  assert.equal(first.done, false);
  const second = guard.step({ findingIds: ['b'] }); // different from 'a' — not no-progress/oscillating
  assert.equal(second.done, true);
  assert.equal(second.reason, REASONS.MAX_ITERATIONS);
  assert.match(second.message, /reached the max-iterations cap \(2\)/);
});

test('max-iterations — control: converging on the final allowed iteration reports converged, not max-iterations', () => {
  const guard = createConvergenceGuard({ maxIterations: 2 });
  guard.step({ findingIds: ['a'] });
  const r = guard.step({ findingIds: [] });
  assert.equal(r.reason, REASONS.CONVERGED);
});

test('budget — a wall-clock ceiling stops the loop even with iterations left', () => {
  let t = 0;
  const now = () => t;
  const guard = createConvergenceGuard({ maxIterations: 100, budgetMs: 500, now });
  t = 100;
  const first = guard.step({ findingIds: ['a'] });
  assert.equal(first.done, false);
  t = 700; // now well past the 500ms budget
  const second = guard.step({ findingIds: ['b'] });
  assert.equal(second.done, true);
  assert.equal(second.reason, REASONS.BUDGET);
  assert.match(second.message, /time\/token budget hit/);
});

test('budget — control: staying under budget with room on the iteration cap keeps going', () => {
  let t = 0;
  const now = () => t;
  const guard = createConvergenceGuard({ maxIterations: 100, budgetMs: 500, now });
  t = 100;
  guard.step({ findingIds: ['a'] });
  t = 200;
  const r = guard.step({ findingIds: ['b'] });
  assert.equal(r.done, false);
});

test('fix-rejected — tests/fake-fix detector rejecting the change stops immediately', () => {
  const guard = createConvergenceGuard({ maxIterations: 5 });
  const r = guard.step({ findingIds: ['rule:x'], fixRejected: true });
  assert.equal(r.done, true);
  assert.equal(r.reason, REASONS.FIX_REJECTED);
  assert.match(r.message, /did not pass validation/);
  assert.equal(guard.getResult().iterations, 1);
});

test('fix-rejected — control: fixRejected:false with the same findings does not stop', () => {
  const guard = createConvergenceGuard({ maxIterations: 5 });
  const r = guard.step({ findingIds: ['rule:x'], fixRejected: false });
  assert.equal(r.done, false);
});

test('reason line format — every terminal message starts "stopped: <reason-shaped text>"', () => {
  const scenarios = [
    () => { const g = createConvergenceGuard({ maxIterations: 5 }); return g.step({ findingIds: [] }); },
    () => { const g = createConvergenceGuard({ maxIterations: 5 }); g.step({ findingIds: ['a'] }); return g.step({ findingIds: ['a'] }); },
    () => { const g = createConvergenceGuard({ maxIterations: 5 }); g.step({ findingIds: ['a'] }); g.step({ findingIds: ['b'] }); return g.step({ findingIds: ['a'] }); },
    () => { const g = createConvergenceGuard({ maxIterations: 1 }); return g.step({ findingIds: ['a'] }); },
    () => { const g = createConvergenceGuard({ maxIterations: 5, budgetMs: 0, now: () => 1 }); return g.step({ findingIds: ['a'] }); },
    () => { const g = createConvergenceGuard({ maxIterations: 5 }); return g.step({ findingIds: ['a'], fixRejected: true }); },
  ];
  for (const run of scenarios) {
    const r = run();
    assert.equal(r.done, true);
    assert.match(r.message, /^stopped: /);
    assert.ok(Object.values(REASONS).includes(r.reason), `${r.reason} must be one of the six canonical reasons`);
  }
});

test('a finished guard keeps returning the same result on further step() calls', () => {
  const guard = createConvergenceGuard({ maxIterations: 5 });
  const first = guard.step({ findingIds: [] });
  const again = guard.step({ findingIds: ['whatever'] });
  assert.equal(again.reason, first.reason);
  assert.equal(guard.getResult().iterations, 1, 'a call after done must not add another iteration');
});

test('input validation — maxIterations must be a positive integer', () => {
  assert.throws(() => createConvergenceGuard({ maxIterations: 0 }), RangeError);
  assert.throws(() => createConvergenceGuard({ maxIterations: -1 }), RangeError);
  assert.throws(() => createConvergenceGuard({ maxIterations: 1.5 }), RangeError);
});

// ── hashFindingSet — pure identity-set hashing (order/dup independent) ──────

test('hashFindingSet is order-independent and de-duplicates', () => {
  const a = hashFindingSet(['x', 'y', 'z']);
  const b = hashFindingSet(['z', 'x', 'y']);
  const c = hashFindingSet(['x', 'y', 'y', 'z']);
  assert.equal(a.hash, b.hash);
  assert.equal(a.hash, c.hash);
  assert.deepEqual(a.ids, ['x', 'y', 'z']);
});

test('hashFindingSet — control: a genuinely different set hashes differently', () => {
  const a = hashFindingSet(['x', 'y']);
  const b = hashFindingSet(['x', 'y', 'z']);
  assert.notEqual(a.hash, b.hash);
});
