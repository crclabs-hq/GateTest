// ============================================================================
// FIX-ATTEMPT-LOOP TEST — Phase 1 of THE FIX-FIRST BUILD PLAN
// ============================================================================
// Covers website/app/lib/fix-attempt-loop.js — the iterative fix loop that
// no competitor ships today. Pure JS with injected dependencies, so we can
// test every outcome path (success, validation-fail, quality-fail,
// claude-error) deterministically without touching the Anthropic API.
//
// Outcome paths covered:
//   - success on attempt 1 (happy path, single call)
//   - success on attempt 3 after 2× quality-fail (the loop's purpose)
//   - validation-fail on attempt 1 stops the loop early (refusals don't
//     self-heal by re-asking)
//   - quality-fail every attempt = total failure with full attempt log
//   - claude-error retries up to maxAttempts and records every error
//   - issue-enrichment carries previous-attempt failures into next prompt
//   - input validation rejects bad arguments
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attemptFixWithRetries, summariseAttempts } = require('../website/app/lib/fix-attempt-loop.js');

// Deterministic clock: returns 1000, 1100, 1200, ... — each call advances 100ms.
function makeClock(start = 1000, step = 100) {
  let t = start;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

// Stub helpers shared across tests.
const okValidation = () => ({ ok: true });
const cleanQuality = () => ({ clean: true, newIssues: [] });
const badValidation = (reason) => () => ({ ok: false, reason });
const dirtyQuality = (newIssues) => () => ({ clean: false, newIssues });

test('success on attempt 1 — single call, single attempt logged', async () => {
  let calls = 0;
  const result = await attemptFixWithRetries({
    askClaude: async () => { calls++; return 'fixed-content'; },
    validateFix: okValidation,
    verifyFixQuality: cleanQuality,
    originalContent: 'original',
    filePath: 'src/foo.js',
    issues: ['issue-1'],
    maxAttempts: 3,
    now: makeClock(),
  });

  assert.equal(calls, 1);
  assert.equal(result.success, true);
  assert.equal(result.fixed, 'fixed-content');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].outcome, 'success');
  assert.equal(result.attempts[0].attemptNumber, 1);
  assert.equal(result.attempts[0].durationMs, 100);
  assert.equal(result.finalReason, null);
  assert.equal(result.loop.reason, 'converged');
  assert.equal(result.loop.iterations, 1);
});

test('success on attempt 3 after 2 quality-fails — loop carries forward', async () => {
  let calls = 0;
  // Sequence: attempt 1 quality-fail (introduces console.log),
  //           attempt 2 quality-fail (introduces var),
  //           attempt 3 succeeds
  const verifySequence = [
    { clean: false, newIssues: ['Line 5: console.log introduced'] },
    { clean: false, newIssues: ['Line 7: var declaration introduced'] },
    { clean: true, newIssues: [] },
  ];

  const passedIssuesByAttempt = [];
  const result = await attemptFixWithRetries({
    askClaude: async (currentIssues) => { passedIssuesByAttempt.push(currentIssues); calls++; return `fix-v${calls}`; },
    validateFix: okValidation,
    verifyFixQuality: () => verifySequence.shift(),
    originalContent: 'original',
    filePath: 'src/foo.js',
    issues: ['issue-A'],
    maxAttempts: 3,
    now: makeClock(),
  });

  assert.equal(calls, 3);
  assert.equal(result.success, true);
  assert.equal(result.fixed, 'fix-v3');
  assert.equal(result.attempts.length, 3);
  assert.equal(result.attempts[0].outcome, 'quality-fail');
  assert.deepEqual(result.attempts[0].qualityIssues, ['Line 5: console.log introduced']);
  assert.equal(result.attempts[1].outcome, 'quality-fail');
  assert.deepEqual(result.attempts[1].qualityIssues, ['Line 7: var declaration introduced']);
  assert.equal(result.attempts[2].outcome, 'success');

  // Enrichment: attempt 1 sees only original. Attempt 2 sees original +
  // attempt-1 feedback. Attempt 3 sees original + attempt-2 feedback
  // (NOT compounded — we re-derive from attempt N-1, not accumulate).
  assert.deepEqual(passedIssuesByAttempt[0], ['issue-A']);
  assert.equal(passedIssuesByAttempt[1].length, 2);
  assert.equal(passedIssuesByAttempt[1][0], 'issue-A');
  assert.match(passedIssuesByAttempt[1][1], /YOUR PREVIOUS ATTEMPT INTRODUCED: Line 5: console\.log/);
  assert.equal(passedIssuesByAttempt[2].length, 2);
  assert.equal(passedIssuesByAttempt[2][0], 'issue-A');
  assert.match(passedIssuesByAttempt[2][1], /YOUR PREVIOUS ATTEMPT INTRODUCED: Line 7: var declaration/);
});

test('validation-fail on attempt 1 stops loop early — refusals do not self-heal', async () => {
  let calls = 0;
  const result = await attemptFixWithRetries({
    askClaude: async () => { calls++; return 'I cannot help with that'; },
    validateFix: badValidation('Claude refused'),
    verifyFixQuality: cleanQuality,
    originalContent: 'original',
    filePath: 'src/foo.js',
    issues: ['issue-1'],
    maxAttempts: 3,
    now: makeClock(),
  });

  assert.equal(calls, 1, 'should not retry after a validation-fail');
  assert.equal(result.success, false);
  assert.equal(result.fixed, null);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].outcome, 'validation-fail');
  assert.equal(result.attempts[0].validationReason, 'Claude refused');
  assert.match(result.finalReason, /attempt 1: validation failed/);
  assert.equal(result.loop.reason, 'fix-rejected');
});

test('quality-fail with a NEW issue every attempt — burns all maxAttempts (control)', async () => {
  // Control pair for the test below: when the fix keeps introducing a
  // DIFFERENT issue each time (real progress being attempted, just not
  // enough of it), the convergence guard must NOT stop the loop early —
  // maxAttempts still governs.
  let calls = 0;
  const result = await attemptFixWithRetries({
    askClaude: async () => { calls++; return `attempt-${calls}-output`; },
    validateFix: okValidation,
    verifyFixQuality: () => ({ clean: false, newIssues: [`Line ${calls}: issue introduced`] }),
    originalContent: 'original',
    filePath: 'src/foo.js',
    issues: ['issue-1'],
    maxAttempts: 3,
    now: makeClock(),
  });

  assert.equal(calls, 3, 'should make exactly maxAttempts calls');
  assert.equal(result.success, false);
  assert.equal(result.fixed, null);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.loop.reason, 'max-iterations');
  assert.equal(result.loop.iterations, 3);
});

test('quality-fail re-introducing the SAME issue every attempt — convergence guard stops early (C23)', async () => {
  // The loop's own fix keeps failing the exact same way. Complaint C23:
  // a loop that re-flags the fix it just made must stop and say why,
  // instead of burning the rest of maxAttempts on a fix that plainly did
  // not hold.
  let calls = 0;
  const result = await attemptFixWithRetries({
    askClaude: async () => { calls++; return `attempt-${calls}-output`; },
    validateFix: okValidation,
    verifyFixQuality: dirtyQuality(['Line 1: var introduced']),
    originalContent: 'original',
    filePath: 'src/foo.js',
    issues: ['issue-1'],
    maxAttempts: 3,
    now: makeClock(),
  });

  assert.equal(calls, 2, 'stops after the re-flag on attempt 2, never reaching attempt 3');
  assert.equal(result.success, false);
  assert.equal(result.fixed, null);
  assert.equal(result.attempts.length, 2);
  result.attempts.forEach((a, i) => {
    assert.equal(a.outcome, 'quality-fail');
    assert.equal(a.attemptNumber, i + 1);
    assert.deepEqual(a.qualityIssues, ['Line 1: var introduced']);
  });
  assert.match(result.finalReason, /no progress after iteration 2/);
  assert.equal(result.loop.reason, 'no-progress');
  assert.equal(result.loop.iterations, 2);
  assert.equal(result.loop.unresolved.length, 1);
  assert.equal(result.loop.unresolved[0].origin, 'own-fix');
  assert.match(result.loop.unresolved[0].lastAttempt, /attempt 1 introduced/);
});

test('claude-error retries up to maxAttempts and records every error', async () => {
  const errors = ['ECONNRESET', 'EPROTO', 'ETIMEDOUT'];
  let calls = 0;
  const result = await attemptFixWithRetries({
    askClaude: async () => {
      const e = new Error(errors[calls]);
      calls++;
      throw e;
    },
    validateFix: okValidation,
    verifyFixQuality: cleanQuality,
    originalContent: 'original',
    filePath: 'src/foo.js',
    issues: ['issue-1'],
    maxAttempts: 3,
    now: makeClock(),
  });

  assert.equal(calls, 3);
  assert.equal(result.success, false);
  assert.equal(result.fixed, null);
  assert.equal(result.attempts.length, 3);
  assert.deepEqual(result.attempts.map((a) => a.outcome), ['claude-error', 'claude-error', 'claude-error']);
  assert.deepEqual(result.attempts.map((a) => a.claudeError), errors);
  assert.match(result.finalReason, /attempt 3: ETIMEDOUT/);
});

test('claude-error then success — transient API hiccup recovers', async () => {
  let calls = 0;
  const result = await attemptFixWithRetries({
    askClaude: async () => {
      calls++;
      if (calls === 1) throw new Error('ECONNRESET');
      return 'fixed';
    },
    validateFix: okValidation,
    verifyFixQuality: cleanQuality,
    originalContent: 'original',
    filePath: 'src/foo.js',
    issues: ['issue-1'],
    maxAttempts: 3,
    now: makeClock(),
  });

  assert.equal(calls, 2);
  assert.equal(result.success, true);
  assert.equal(result.fixed, 'fixed');
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].outcome, 'claude-error');
  assert.equal(result.attempts[0].claudeError, 'ECONNRESET');
  assert.equal(result.attempts[1].outcome, 'success');
});

test('mixed sequence — claude-error then quality-fail then success', async () => {
  let calls = 0;
  const verifySequence = [
    { clean: false, newIssues: ['Line 3: eval introduced'] },
    { clean: true, newIssues: [] },
  ];
  const passedIssuesByAttempt = [];
  const result = await attemptFixWithRetries({
    askClaude: async (currentIssues) => {
      calls++;
      passedIssuesByAttempt.push(currentIssues);
      if (calls === 1) throw new Error('EPROTO');
      return `fix-v${calls}`;
    },
    validateFix: okValidation,
    verifyFixQuality: () => verifySequence.shift(),
    originalContent: 'original',
    filePath: 'src/foo.js',
    issues: ['issue-A'],
    maxAttempts: 3,
    now: makeClock(),
  });

  assert.equal(calls, 3);
  assert.equal(result.success, true);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.attempts[0].outcome, 'claude-error');
  assert.equal(result.attempts[1].outcome, 'quality-fail');
  assert.equal(result.attempts[2].outcome, 'success');

  // claude-error doesn't enrich — attempt 2 sees the same issues as attempt 1.
  // Only quality-fail enriches.
  assert.deepEqual(passedIssuesByAttempt[0], ['issue-A']);
  assert.deepEqual(passedIssuesByAttempt[1], ['issue-A']);
  assert.equal(passedIssuesByAttempt[2].length, 2);
  assert.match(passedIssuesByAttempt[2][1], /YOUR PREVIOUS ATTEMPT INTRODUCED: Line 3: eval/);
});

test('respects maxAttempts=1 — single shot, no retry', async () => {
  let calls = 0;
  const result = await attemptFixWithRetries({
    askClaude: async () => { calls++; return 'output'; },
    validateFix: okValidation,
    verifyFixQuality: dirtyQuality(['Line 1: console.log']),
    originalContent: 'original',
    filePath: 'src/foo.js',
    issues: ['issue-1'],
    maxAttempts: 1,
    now: makeClock(),
  });

  assert.equal(calls, 1);
  assert.equal(result.success, false);
  assert.equal(result.attempts.length, 1);
});

test('input validation — rejects bad arguments', async () => {
  await assert.rejects(
    () => attemptFixWithRetries({ validateFix: okValidation, verifyFixQuality: cleanQuality, originalContent: 'x', filePath: 'f', issues: ['i'] }),
    /askClaude must be a function/
  );
  await assert.rejects(
    () => attemptFixWithRetries({ askClaude: async () => '', verifyFixQuality: cleanQuality, originalContent: 'x', filePath: 'f', issues: ['i'] }),
    /validateFix must be a function/
  );
  await assert.rejects(
    () => attemptFixWithRetries({ askClaude: async () => '', validateFix: okValidation, originalContent: 'x', filePath: 'f', issues: ['i'] }),
    /verifyFixQuality must be a function/
  );
  await assert.rejects(
    () => attemptFixWithRetries({ askClaude: async () => '', validateFix: okValidation, verifyFixQuality: cleanQuality, filePath: 'f', issues: ['i'] }),
    /originalContent must be a string/
  );
  await assert.rejects(
    () => attemptFixWithRetries({ askClaude: async () => '', validateFix: okValidation, verifyFixQuality: cleanQuality, originalContent: 'x', issues: ['i'] }),
    /filePath must be a string/
  );
  await assert.rejects(
    () => attemptFixWithRetries({ askClaude: async () => '', validateFix: okValidation, verifyFixQuality: cleanQuality, originalContent: 'x', filePath: 'f', issues: [] }),
    /issues must be a non-empty array/
  );
  await assert.rejects(
    () => attemptFixWithRetries({ askClaude: async () => '', validateFix: okValidation, verifyFixQuality: cleanQuality, originalContent: 'x', filePath: 'f', issues: ['i'], maxAttempts: 0 }),
    /maxAttempts must be a positive integer/
  );
});

test('summariseAttempts — empty input', () => {
  assert.equal(summariseAttempts([]), 'no attempts');
  assert.equal(summariseAttempts(null), 'no attempts');
  assert.equal(summariseAttempts(undefined), 'no attempts');
});

test('summariseAttempts — formats success and breakdown', () => {
  const attempts = [
    { outcome: 'quality-fail', durationMs: 500, attemptNumber: 1, startedAt: 0, validationReason: null, qualityIssues: [], claudeError: null },
    { outcome: 'success', durationMs: 600, attemptNumber: 2, startedAt: 0, validationReason: null, qualityIssues: [], claudeError: null },
  ];
  const summary = summariseAttempts(attempts);
  assert.match(summary, /2 attempt\(s\)/);
  assert.match(summary, /1100ms total/);
  assert.match(summary, /final: success/);
  assert.match(summary, /1× quality-fail/);
  assert.match(summary, /1× success/);
});
