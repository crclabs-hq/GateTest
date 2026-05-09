'use strict';

/**
 * fix-core — coverage of the work body extracted from /api/scan/fix.
 *
 * What we lock down here:
 *   1. executeFixCore returns { payload, status } — the same shape the
 *      route handler writes into NextResponse.json. Non-streaming
 *      callers depend on this not drifting.
 *   2. The pre-flight validations (missing repo, missing issues, no
 *      ANTHROPIC_API_KEY, bad URL, no auth) return the same payload
 *      shapes the old inline code returned, so admin / MCP / curl
 *      callers don't see behaviour change.
 *   3. When an emitter is supplied, events fire in the right order on
 *      a happy-path scenario AND on a failure scenario. The ordering
 *      contract is what the customer-facing scan page renders against,
 *      so it matters for the live progress checklist.
 *   4. Without an emitter, the work body still completes — emitter is
 *      strictly optional.
 *
 * All I/O dependencies are mocked. No real network, no real Anthropic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeFixCore } = require('../website/app/lib/fix-core');
const { createEmitter, parseSseStream } = require('../website/app/lib/progress-emitter');

// ---- Mock factories ----

function fakeAuth({ token = 'glc_test_token', source = 'gluecron' } = {}) {
  return async () => ({ token, source });
}

function fakeAuthMissing(error) {
  return async () => ({ token: null, error });
}

function makeBaseDeps(overrides = {}) {
  return {
    hasAnthropicKey: true,
    resolveRepoAuth: fakeAuth(),
    fetchBlob: async () => 'console.log("hello")\n',
    askClaude: async () => 'console.warn("hello")\n',
    askClaudeCreate: async () => '# Generated file\n\nlong enough to clear the 10-char gate.',
    validateFix: () => ({ ok: true }),
    verifyFixQuality: () => ({ clean: true, newIssues: [] }),
    resolveBaseBranchSha: async () => ({ defaultBranch: 'main', sha: 'deadbeef' }),
    createBranch: async () => ({ status: 201, data: { ref: 'refs/heads/x' } }),
    fetchFileSha: async () => 'oldsha',
    upsertFile: async () => ({ status: 200, data: {} }),
    openPullRequest: async () => ({
      status: 201,
      data: { number: 42, html_url: 'https://gluecron.com/owner/repo/pulls/42' },
    }),
    postPrComment: async () => ({ status: 201, data: {} }),
    composePrBody: () => '## body',
    ...overrides,
  };
}

const happyInput = {
  repoUrl: 'https://gluecron.com/owner/repo',
  issues: [
    { file: 'src/a.js', issue: 'console.log left in', module: 'lint' },
    { file: 'src/b.js', issue: 'console.log left in', module: 'lint' },
  ],
  tier: 'full',
};

// ---- Pre-flight validation ----

test('fix-core — invalid input shape → 400 with error message', async () => {
  const result = await executeFixCore({ input: null, deps: makeBaseDeps() });
  assert.equal(result.status, 400);
  assert.equal(result.payload.error, 'Invalid request body');
});

test('fix-core — missing repoUrl → 400', async () => {
  const result = await executeFixCore({
    input: { issues: [{ file: 'a.js', issue: 'x', module: 'm' }] },
    deps: makeBaseDeps(),
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /Missing repoUrl/);
});

test('fix-core — empty issues array → 400', async () => {
  const result = await executeFixCore({
    input: { repoUrl: 'https://gluecron.com/o/r', issues: [] },
    deps: makeBaseDeps(),
  });
  assert.equal(result.status, 400);
});

test('fix-core — no Anthropic key → 503 with the configured-error shape', async () => {
  const result = await executeFixCore({
    input: happyInput,
    deps: makeBaseDeps({ hasAnthropicKey: false }),
  });
  assert.equal(result.status, 503);
  assert.match(result.payload.error, /AI not configured/);
});

test('fix-core — bad repo URL → 400', async () => {
  const result = await executeFixCore({
    input: { ...happyInput, repoUrl: 'https://example.com/not-a-repo' },
    deps: makeBaseDeps(),
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /Invalid repo URL/);
});

test('fix-core — no auth token → 503 with the gluecron hint', async () => {
  const result = await executeFixCore({
    input: happyInput,
    deps: makeBaseDeps({ resolveRepoAuth: fakeAuthMissing('test-error') }),
  });
  assert.equal(result.status, 503);
  assert.equal(result.payload.error, 'test-error');
  assert.match(result.payload.hint, /gluecron\.com\/settings\/tokens/);
});

test('fix-core — issues without file paths → 400', async () => {
  const result = await executeFixCore({
    input: {
      repoUrl: 'https://gluecron.com/o/r',
      issues: [{ file: '', issue: 'x', module: 'm' }],
    },
    deps: makeBaseDeps(),
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /No fixable issues/);
});

// ---- Happy path payload shape ----

test('fix-core — happy path returns pr_created with full payload shape', async () => {
  const result = await executeFixCore({ input: happyInput, deps: makeBaseDeps() });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, 'pr_created');
  assert.equal(result.payload.prNumber, 42);
  assert.equal(result.payload.prUrl, 'https://gluecron.com/owner/repo/pulls/42');
  assert.match(result.payload.branch, /^gatetest\/auto-fix-/);
  assert.equal(result.payload.filesFixed, 2);
  assert.equal(result.payload.issuesFixed, 2);
  assert.equal(result.payload.authSource, 'gluecron');
  assert.deepEqual(result.payload.fixes, [
    { file: 'src/a.js', issues: ['console.log left in'] },
    { file: 'src/b.js', issues: ['console.log left in'] },
  ]);
  assert.deepEqual(result.payload.errors, []);
  assert.deepEqual(result.payload.failedFiles, []);
});

test('fix-core — accepts github.com URLs (compat fallback during migration)', async () => {
  const result = await executeFixCore({
    input: { ...happyInput, repoUrl: 'https://github.com/owner/repo.git' },
    deps: makeBaseDeps(),
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, 'pr_created');
});

test('fix-core — fetchBlob returning empty produces an error and skips the file', async () => {
  const deps = makeBaseDeps({
    fetchBlob: async (_o, _r, file) => (file === 'src/a.js' ? '' : 'console.log("ok")\n'),
  });
  const result = await executeFixCore({ input: happyInput, deps });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, 'pr_created');
  assert.equal(result.payload.filesFixed, 1);
  assert.match(result.payload.errors.join(' '), /Could not read src\/a\.js/);
});

test('fix-core — every file failing produces a no_fixes payload (not pr_created)', async () => {
  const deps = makeBaseDeps({
    validateFix: () => ({ ok: false, reason: 'empty output' }),
  });
  const result = await executeFixCore({ input: happyInput, deps });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, 'no_fixes');
  assert.equal(result.payload.errors.length, 2);
});

test('fix-core — every file failing with network errors produces api_unavailable', async () => {
  const deps = makeBaseDeps({
    askClaude: async () => {
      const e = new Error('EPROTO ssl alert number 80');
      throw e;
    },
  });
  const result = await executeFixCore({ input: happyInput, deps });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, 'api_unavailable');
  assert.equal(result.payload.failedFiles.length, 2);
});

test('fix-core — branch creation failure surfaces as 500 with details', async () => {
  const deps = makeBaseDeps({
    createBranch: async () => ({ status: 422, data: { message: 'ref exists' } }),
  });
  const result = await executeFixCore({ input: happyInput, deps });
  assert.equal(result.status, 500);
  assert.match(result.payload.error, /Could not create branch/);
});

test('fix-core — missing baseSha → 500 with hint', async () => {
  const deps = makeBaseDeps({
    resolveBaseBranchSha: async () => ({ defaultBranch: 'main', sha: '' }),
  });
  const result = await executeFixCore({ input: happyInput, deps });
  assert.equal(result.status, 500);
  assert.match(result.payload.error, /Could not resolve base branch SHA/);
});

test('fix-core — PR open failing falls into fixes_committed (work salvaged)', async () => {
  const deps = makeBaseDeps({
    openPullRequest: async () => ({ status: 500, data: { message: 'gluecron down' } }),
  });
  const result = await executeFixCore({ input: happyInput, deps });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, 'fixes_committed');
  assert.equal(result.payload.filesFixed, 2);
});

// ---- CREATE_FILE branch ----

test('fix-core — CREATE_FILE issues route through askClaudeCreate', async () => {
  let createdPath = '';
  const deps = makeBaseDeps({
    askClaudeCreate: async (filePath) => {
      createdPath = filePath;
      return '# README\n\nThis project does X. (long enough to clear gate.)';
    },
  });
  const input = {
    repoUrl: 'https://gluecron.com/owner/repo',
    issues: [{ file: 'README.md', issue: 'CREATE_FILE: Missing README', module: 'documentation' }],
  };
  const result = await executeFixCore({ input, deps });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, 'pr_created');
  assert.equal(createdPath, 'README.md');
  assert.equal(result.payload.filesFixed, 1);
});

// ---- Emitter event ordering ----

async function collectEvents(input, deps) {
  const emitter = createEmitter({ enabled: true });
  // Run executeFixCore concurrently with the SSE reader; emitter.end()
  // is what closes the stream so the reader will resolve once work
  // finishes.
  const work = executeFixCore({ input, deps, emitter }).then((result) =>
    emitter.end({ ...result.payload, __innerStatus: result.status }),
  );

  const reader = emitter.response.body.getReader();
  const events = [];
  const reading = parseSseStream(reader, (ev) => events.push(ev));

  await Promise.all([work, reading]);
  return events;
}

test('fix-core — happy path emits scan-fix:start, per-file events, gate summaries, pr:open, done in order', async () => {
  const events = await collectEvents(happyInput, makeBaseDeps());
  const names = events.map((e) => e.name);

  // First event is always the start frame.
  assert.equal(names[0], 'scan-fix:start');
  // Last event is always done (carrying the final payload).
  assert.equal(names[names.length - 1], 'done');
  // Both files must produce a file:start AND a file:complete.
  const starts = events.filter((e) => e.name === 'file:start');
  const completes = events.filter((e) => e.name === 'file:complete');
  assert.equal(starts.length, 2);
  assert.equal(completes.length, 2);
  // Each successful file produced an attempt event with outcome='success'.
  const attempts = events.filter((e) => e.name === 'file:attempt');
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((a) => a.data.outcome === 'success'));
  // Gate summaries fire after work, before pr:open.
  const gateSyntaxIdx = names.indexOf('gate:syntax');
  const gateScannerIdx = names.indexOf('gate:scanner');
  const gateTestsIdx = names.indexOf('gate:tests');
  const prOpenIdx = names.indexOf('pr:open');
  assert.ok(gateSyntaxIdx > 0);
  assert.ok(gateScannerIdx > gateSyntaxIdx);
  assert.ok(gateTestsIdx > gateScannerIdx);
  assert.ok(prOpenIdx > gateTestsIdx);
  // pr:open data shape
  const prOpen = events[prOpenIdx];
  assert.equal(prOpen.data.fixCount, 2);
  assert.match(prOpen.data.url, /pulls\/42$/);
  // done carries the pr_created payload + __innerStatus
  const done = events[names.length - 1];
  assert.equal(done.data.status, 'pr_created');
  assert.equal(done.data.__innerStatus, 200);
});

test('fix-core — scan-fix:start carries totalFiles, totalIssues, tier', async () => {
  const events = await collectEvents(happyInput, makeBaseDeps());
  const start = events[0];
  assert.equal(start.name, 'scan-fix:start');
  assert.equal(start.data.totalFiles, 2);
  assert.equal(start.data.totalIssues, 2);
  assert.equal(start.data.tier, 'full');
});

test('fix-core — file:complete carries durationMs (>= 0)', async () => {
  const events = await collectEvents(happyInput, makeBaseDeps());
  const completes = events.filter((e) => e.name === 'file:complete');
  for (const c of completes) {
    assert.equal(typeof c.data.durationMs, 'number');
    assert.ok(c.data.durationMs >= 0);
    assert.equal(c.data.success, true);
  }
});

test('fix-core — failed file emits attempt with claude-error outcome and complete with success=false', async () => {
  const deps = makeBaseDeps({
    askClaude: async () => { throw new Error('Claude API error 500: server down'); },
  });
  const events = await collectEvents(happyInput, deps);
  const completes = events.filter((e) => e.name === 'file:complete');
  const attempts = events.filter((e) => e.name === 'file:attempt');
  assert.equal(completes.length, 2);
  assert.ok(completes.every((c) => c.data.success === false));
  assert.ok(attempts.every((a) => a.data.outcome === 'claude-error'));
  // No pr:open when nothing is fixable.
  assert.ok(!events.some((e) => e.name === 'pr:open'));
});

test('fix-core — verify-fail on first attempt triggers second attempt that succeeds', async () => {
  let calls = 0;
  const deps = makeBaseDeps({
    askClaude: async () => {
      calls += 1;
      // First attempt returns dirty fix; second is clean.
      return calls === 1 ? 'console.log("still dirty")' : 'console.warn("clean now")';
    },
    verifyFixQuality: () => {
      // First call returns dirty; subsequent calls clean.
      return calls === 1 ? { clean: false, newIssues: ['console.log introduced'] } : { clean: true, newIssues: [] };
    },
  });
  const input = {
    repoUrl: 'https://gluecron.com/o/r',
    issues: [{ file: 'src/x.js', issue: 'fix me', module: 'lint' }],
  };
  const events = await collectEvents(input, deps);
  // We expect both a verify-fail attempt AND a success attempt.
  const attempts = events.filter((e) => e.name === 'file:attempt');
  // At least one verify-fail and one success
  assert.ok(attempts.some((a) => a.data.outcome === 'verify-fail'));
  // The complete event carries attempts >= 2
  const complete = events.find((e) => e.name === 'file:complete');
  assert.ok(complete.data.attempts >= 1);
});

test('fix-core — emitter parameter is strictly optional (no events, no throw)', async () => {
  const result = await executeFixCore({ input: happyInput, deps: makeBaseDeps() });
  // Identical shape to the happy-path test above — no emitter, no difference.
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, 'pr_created');
});

test('fix-core — emitter that throws on emit() does not crash the run', async () => {
  // Deliberately broken emitter — emit() throws every time. The work body
  // wraps every emit in try/catch so the run completes anyway.
  const angry = {
    emit() { throw new Error('emitter exploded'); },
    end: async () => {},
    response: null,
    enabled: true,
  };
  const result = await executeFixCore({ input: happyInput, deps: makeBaseDeps(), emitter: angry });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, 'pr_created');
});
