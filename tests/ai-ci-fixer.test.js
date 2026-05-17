/**
 * Tests for scripts/ai-ci-fixer.js.
 *
 * No real HTTP, no real GitHub, no real Claude — every external call is
 * injected via dependency injection (deps.callClaude / deps.runner /
 * deps.transport) so tests run hermetically.
 */

'use strict';

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');

const fixer = require('../scripts/ai-ci-fixer');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ci-fixer-test-'));
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Build a fake HTTPS transport that returns the given responses for matched
 * paths. Each entry: { match: /regex/ | string, status, body, headers }.
 */
function fakeTransport(responses) {
  return {
    request(opts, cb) {
      const match = responses.find((r) => {
        if (r.match instanceof RegExp) return r.match.test(opts.path);
        if (typeof r.match === 'string') return opts.path === r.match || opts.path.includes(r.match);
        return false;
      });
      const payload = match || { status: 404, body: { message: 'unmatched' }, headers: {} };
      // Defer to simulate async I/O.
      setImmediate(() => {
        const raw = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
        const res = {
          statusCode: payload.status,
          headers: { 'content-type': 'application/json', ...(payload.headers || {}) },
          on(event, fn) {
            if (event === 'data') fn(Buffer.from(raw));
            if (event === 'end')  fn();
          },
        };
        cb(res);
      });
      return {
        on() {},
        write() {},
        end() {},
        destroy() {},
      };
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('runFixer returns disabled when ANTHROPIC_API_KEY is missing', async () => {
  const result = await fixer.runFixer({
    env: { GITHUB_TOKEN: 'x', GITHUB_REPOSITORY: 'o/r', WORKFLOW_RUN_ID: '1' },
  });
  assert.equal(result.status, 'disabled');
  assert.match(result.reason, /ANTHROPIC_API_KEY/);
});

test('runFixer returns disabled when GITHUB_TOKEN is missing', async () => {
  const result = await fixer.runFixer({
    env: { ANTHROPIC_API_KEY: 'x', GITHUB_REPOSITORY: 'o/r', WORKFLOW_RUN_ID: '1' },
  });
  assert.equal(result.status, 'disabled');
  assert.match(result.reason, /GITHUB_TOKEN/);
});

test('runFixer returns disabled when WORKFLOW_RUN_ID is missing', async () => {
  const result = await fixer.runFixer({
    env: { ANTHROPIC_API_KEY: 'x', GITHUB_TOKEN: 'y', GITHUB_REPOSITORY: 'o/r' },
  });
  assert.equal(result.status, 'disabled');
  assert.match(result.reason, /WORKFLOW_RUN_ID/);
});

test('readEnv parses MAX_FIX_ATTEMPTS and CLAUDE_MODEL', () => {
  const env = {
    ANTHROPIC_API_KEY: 'k',
    GITHUB_TOKEN:      't',
    GITHUB_REPOSITORY: 'o/r',
    WORKFLOW_RUN_ID:   '42',
    MAX_FIX_ATTEMPTS:  '5',
    CLAUDE_MODEL:      'claude-opus-4-7',
  };
  const cfg = fixer.readEnv(env);
  assert.equal(cfg.ok, true);
  assert.equal(cfg.maxAttempts, 5);
  assert.equal(cfg.model, 'claude-opus-4-7');
});

test('readEnv falls back to defaults when MAX_FIX_ATTEMPTS is unset/invalid', () => {
  const cfg1 = fixer.readEnv({
    ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', WORKFLOW_RUN_ID: '1',
  });
  assert.equal(cfg1.maxAttempts, fixer.DEFAULT_MAX_ATTEMPTS);
  assert.equal(cfg1.model, fixer.DEFAULT_MODEL);

  const cfg2 = fixer.readEnv({
    ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', WORKFLOW_RUN_ID: '1',
    MAX_FIX_ATTEMPTS: 'not-a-number',
  });
  assert.equal(cfg2.maxAttempts, fixer.DEFAULT_MAX_ATTEMPTS);
});

test('parseClaudeResponse extracts FILE/PATCH/END_PATCH blocks', () => {
  const text = `FILE: src/foo.js
PATCH:
console.log('hello');
const x = 1;
END_PATCH

FILE: src/bar.js
PATCH:
module.exports = 42;
END_PATCH`;
  const patches = fixer.parseClaudeResponse(text);
  assert.equal(patches.length, 2);
  assert.equal(patches[0].file, 'src/foo.js');
  assert.match(patches[0].content, /console\.log/);
  assert.equal(patches[1].file, 'src/bar.js');
  assert.match(patches[1].content, /module\.exports = 42/);
});

test('parseClaudeResponse rejects path traversal and absolute paths', () => {
  const text = `FILE: ../outside.js
PATCH:
evil = true;
END_PATCH

FILE: /etc/passwd
PATCH:
root::0:0
END_PATCH

FILE: safe.js
PATCH:
ok = 1;
END_PATCH`;
  const patches = fixer.parseClaudeResponse(text);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].file, 'safe.js');
});

test('parseClaudeResponse returns [] for GIVE_UP', () => {
  assert.deepEqual(fixer.parseClaudeResponse('GIVE_UP'), []);
  assert.deepEqual(fixer.parseClaudeResponse('  GIVE_UP \n'), []);
});

test('parseClaudeResponse returns [] for malformed responses without crashing', () => {
  assert.deepEqual(fixer.parseClaudeResponse(''), []);
  assert.deepEqual(fixer.parseClaudeResponse(null), []);
  assert.deepEqual(fixer.parseClaudeResponse(undefined), []);
  assert.deepEqual(fixer.parseClaudeResponse('Just some random text'), []);
  assert.deepEqual(fixer.parseClaudeResponse('FILE: foo.js\nPATCH:\nno end marker'), []);
  assert.deepEqual(fixer.parseClaudeResponse({ not: 'a string' }), []);
});

test('applyPatches writes files to a tmpdir', () => {
  const dir = makeTmpDir();
  try {
    const written = fixer.applyPatches([
      { file: 'a.js',          content: 'console.log("a");' },
      { file: 'sub/b.js',      content: 'console.log("b");' },
    ], dir);
    assert.equal(written.length, 2);
    assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf-8'),     'console.log("a");');
    assert.equal(fs.readFileSync(path.join(dir, 'sub/b.js'), 'utf-8'), 'console.log("b");');
  } finally {
    cleanup(dir);
  }
});

test('applyPatches refuses path-traversal patches', () => {
  const dir = makeTmpDir();
  try {
    const written = fixer.applyPatches([
      { file: '../escape.js', content: 'bad' },
      { file: '/etc/passwd',  content: 'bad' },
      { file: 'good.js',      content: 'ok'  },
    ], dir);
    assert.equal(written.length, 1);
    assert.equal(written[0], 'good.js');
    assert.equal(fs.existsSync(path.join(dir, '..', 'escape.js')), false);
  } finally {
    cleanup(dir);
  }
});

test('extractFailingFiles parses "at /path/file.js:LINE" patterns', () => {
  const dir = makeTmpDir();
  try {
    const log = `
Error: something blew up
    at ${dir}/src/broken.js:42
    at ${dir}/src/other.js:7:13
    at internal node:internal/foo.js:1
`;
    const files = fixer.extractFailingFiles(log, dir);
    assert.ok(files.includes('src/broken.js'));
    assert.ok(files.includes('src/other.js'));
    // node-internal frames should not appear as repo files
    assert.equal(files.some((f) => f.includes('internal')), false);
  } finally {
    cleanup(dir);
  }
});

test('extractFailingFiles drops node_modules paths', () => {
  const dir = makeTmpDir();
  try {
    const log = `at ${dir}/node_modules/foo/bar.js:1`;
    const files = fixer.extractFailingFiles(log, dir);
    assert.equal(files.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('readFilesForClaude reads existing files and skips missing/huge ones', () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'small.js'), 'small content');
    fs.writeFileSync(path.join(dir, 'huge.js'),  'x'.repeat(60_000));
    const files = fixer.readFilesForClaude(['small.js', 'huge.js', 'missing.js'], dir);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'small.js');
    assert.equal(files[0].content, 'small content');
  } finally {
    cleanup(dir);
  }
});

test('buildClaudePrompt caps input around 8K tokens (~32K chars)', () => {
  const longLog = 'x'.repeat(40_000);
  const files = [
    { path: 'a.js', content: 'y'.repeat(20_000) },
    { path: 'b.js', content: 'z'.repeat(20_000) },
  ];
  const prompt = fixer.buildClaudePrompt(longLog, files);
  // We want a reasonable hard ceiling — exactly the documented budget.
  assert.ok(prompt.length <= fixer.MAX_INPUT_CHARS, `prompt is ${prompt.length} chars, expected <= ${fixer.MAX_INPUT_CHARS}`);
});

test('buildClaudePrompt includes the log and at least one file when within budget', () => {
  const log = 'an error happened';
  const files = [{ path: 'src/foo.js', content: 'function foo() {}' }];
  const prompt = fixer.buildClaudePrompt(log, files);
  assert.match(prompt, /an error happened/);
  assert.match(prompt, /FILE: src\/foo\.js/);
  assert.match(prompt, /function foo/);
});

test('tailLines returns the last N lines of a multiline string', () => {
  const text = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n');
  const tail = fixer.tailLines(text, 50);
  const lines = tail.split('\n');
  assert.equal(lines.length, 50);
  assert.equal(lines[lines.length - 1], 'line499');
});

test('isRateLimited detects 429 and 403-with-zero-remaining', () => {
  assert.equal(fixer.isRateLimited({ status: 429, headers: {} }), true);
  assert.equal(fixer.isRateLimited({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }), true);
  assert.equal(fixer.isRateLimited({ status: 403, body: { message: 'You have exceeded a secondary rate limit' }, headers: {} }), true);
  assert.equal(fixer.isRateLimited({ status: 200, headers: {} }), false);
  assert.equal(fixer.isRateLimited(null), false);
});

test('runFixer caps at MAX_FIX_ATTEMPTS when Claude returns unparseable responses', async () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'broken.js'), 'broken file content');

    const env = {
      ANTHROPIC_API_KEY: 'k',
      GITHUB_TOKEN:      't',
      GITHUB_REPOSITORY: 'o/r',
      WORKFLOW_RUN_ID:   '99',
      MAX_FIX_ATTEMPTS:  '2',
    };

    // GitHub responses: run found, jobs returns one failing job, logs return log text.
    const logText = `Error: something\n    at ${dir}/broken.js:1`;
    const transport = fakeTransport([
      { match: /\/actions\/runs\/99$/,          status: 200, body: { html_url: 'http://example/run/99', head_branch: 'feature' } },
      { match: /\/actions\/runs\/99\/jobs/,     status: 200, body: { jobs: [{ id: 1, conclusion: 'failure', name: 'test' }] } },
      { match: /\/actions\/jobs\/1\/logs/,      status: 200, body: logText },
      // We never expect createIssue or createPR to fire here when Claude gives up,
      // but the "give up" path tries to open an issue:
      { match: /\/issues$/,                     status: 201, body: { number: 7, html_url: 'http://example/issue/7' } },
    ]);

    let claudeCalls = 0;
    const result = await fixer.runFixer({
      env,
      repoRoot:    dir,
      transport,
      callClaude:  async () => { claudeCalls += 1; return 'nonsense response with no FILE blocks'; },
      runner:      () => ({ status: 0, stdout: '', stderr: '' }),
      gate:        () => ({ ok: false, stdout: '', stderr: '' }),
      git:         () => ({ ok: true, status: 0, stdout: '', stderr: '' }),
    });

    assert.equal(claudeCalls, 2, `expected exactly 2 Claude calls (MAX_FIX_ATTEMPTS=2), got ${claudeCalls}`);
    assert.ok(['gave-up', 'gave-up-no-issue', 'no-files'].includes(result.status), `unexpected status: ${result.status}`);
  } finally {
    cleanup(dir);
  }
});

test('runFixer exits cleanly when GitHub is rate-limited', async () => {
  const env = {
    ANTHROPIC_API_KEY: 'k',
    GITHUB_TOKEN:      't',
    GITHUB_REPOSITORY: 'o/r',
    WORKFLOW_RUN_ID:   '1',
  };
  const transport = fakeTransport([
    { match: /\/actions\/runs\/1$/, status: 429, body: { message: 'rate limited' }, headers: {} },
  ]);
  const result = await fixer.runFixer({
    env, transport,
    callClaude: async () => 'should not be called',
  });
  assert.equal(result.status, 'rate-limited');
});

test('runFixer exits cleanly when Claude throws on every attempt', async () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'broken.js'), 'content');
    const env = {
      ANTHROPIC_API_KEY: 'k',
      GITHUB_TOKEN:      't',
      GITHUB_REPOSITORY: 'o/r',
      WORKFLOW_RUN_ID:   '5',
      MAX_FIX_ATTEMPTS:  '2',
    };
    const logText = `at ${dir}/broken.js:1`;
    const transport = fakeTransport([
      { match: /\/actions\/runs\/5$/,        status: 200, body: { html_url: 'http://example/run/5', head_branch: 'main' } },
      { match: /\/actions\/runs\/5\/jobs/,   status: 200, body: { jobs: [{ id: 1, conclusion: 'failure' }] } },
      { match: /\/actions\/jobs\/1\/logs/,   status: 200, body: logText },
      { match: /\/issues$/,                  status: 201, body: { number: 9 } },
    ]);
    let claudeCalls = 0;
    const result = await fixer.runFixer({
      env, repoRoot: dir, transport,
      callClaude: async () => { claudeCalls += 1; throw new Error('Claude timed out'); },
      git:  () => ({ ok: true, stdout: '', stderr: '' }),
      gate: () => ({ ok: false, stdout: '', stderr: '' }),
    });
    assert.equal(claudeCalls, 2);
    assert.ok(['gave-up', 'gave-up-no-issue'].includes(result.status));
  } finally {
    cleanup(dir);
  }
});

test('runFixer opens a PR when gate goes green', async () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'broken.js'), 'old content');
    const env = {
      ANTHROPIC_API_KEY: 'k',
      GITHUB_TOKEN:      't',
      GITHUB_REPOSITORY: 'o/r',
      WORKFLOW_RUN_ID:   '77',
    };
    const logText = `Error: bug\n    at ${dir}/broken.js:1`;
    let prCreated = false;
    const transport = fakeTransport([
      { match: /\/actions\/runs\/77$/,        status: 200, body: { html_url: 'http://example/run/77', head_branch: 'feature/x' } },
      { match: /\/actions\/runs\/77\/jobs/,   status: 200, body: { jobs: [{ id: 1, conclusion: 'failure' }] } },
      { match: /\/actions\/jobs\/1\/logs/,    status: 200, body: logText },
      { match: /\/pulls$/,                    status: 201, body: { number: 42, html_url: 'http://example/pr/42' } },
    ]);

    const claudeResponse = `FILE: broken.js
PATCH:
new content
END_PATCH`;

    const gitCalls = [];
    const result = await fixer.runFixer({
      env, repoRoot: dir, transport,
      callClaude: async () => claudeResponse,
      git:  (args) => { gitCalls.push(args); return { ok: true, stdout: '', stderr: '' }; },
      gate: () => ({ ok: true, stdout: '', stderr: '' }),
    });
    // Patch should have been written
    assert.equal(fs.readFileSync(path.join(dir, 'broken.js'), 'utf-8'), 'new content');
    assert.equal(result.status, 'pr-opened');
    assert.equal(result.pr.status, 201);
    // Git commit + push should have been attempted
    const commitCall = gitCalls.find((a) => a[0] === 'commit');
    const pushCall   = gitCalls.find((a) => a[0] === 'push');
    assert.ok(commitCall, 'expected git commit');
    assert.ok(pushCall,   'expected git push');
  } finally {
    cleanup(dir);
  }
});

test('runFixer returns no-files when log has no parseable file references', async () => {
  const env = {
    ANTHROPIC_API_KEY: 'k',
    GITHUB_TOKEN:      't',
    GITHUB_REPOSITORY: 'o/r',
    WORKFLOW_RUN_ID:   '11',
  };
  const transport = fakeTransport([
    { match: /\/actions\/runs\/11$/,      status: 200, body: { html_url: 'http://example/run/11', head_branch: 'main' } },
    { match: /\/actions\/runs\/11\/jobs/, status: 200, body: { jobs: [{ id: 1, conclusion: 'failure' }] } },
    { match: /\/actions\/jobs\/1\/logs/,  status: 200, body: 'Some abstract error message, no paths.' },
  ]);
  const result = await fixer.runFixer({
    env, transport,
    callClaude: async () => 'never called',
  });
  assert.equal(result.status, 'no-files');
});

test('buildPrBody and buildIssueBody render the expected content', () => {
  const pr = fixer.buildPrBody({
    runUrl:     'http://example/run/1',
    logExcerpt: 'line1\nline2\nline3',
    attempt:    2,
    model:      'claude-sonnet-4-5',
  });
  assert.match(pr, /AI CI-fixer/);
  assert.match(pr, /Failing workflow.*http:\/\/example\/run\/1/);
  assert.match(pr, /Attempt.*2/);
  assert.match(pr, /Powered by Claude/);

  const issue = fixer.buildIssueBody({
    runUrl:     'http://example/run/1',
    logExcerpt: 'failing log',
    attempted:  [{ attempt: 1, patchCount: 0 }, { attempt: 2, patchCount: 1 }],
    lastError:  new Error('gate red'),
    model:      'claude-sonnet-4-5',
  });
  assert.match(issue, /couldn't repair/);
  assert.match(issue, /attempt 1: 0 patch/);
  assert.match(issue, /attempt 2: 1 patch/);
  assert.match(issue, /gate red/);
});

// ── Flywheel integration ────────────────────────────────────────────────────

test('flywheel: AST layer fix is taken before Claude is ever called', () => {
  // The flywheel try is direct — no async, no I/O. We verify that for a
  // file the AST fixer can handle, the flywheel returns a patch and the
  // file is marked as handled, so the orchestrator wouldn't send it to
  // Claude.
  const flywheel = {
    available: true,
    astFixer: {
      isJsOrTs: (p) => p.endsWith('.js'),
      tryAstFix: (content) => content.replace('rejectUnauthorized: false', 'rejectUnauthorized: true'),
    },
    ruleFixer: { tryRuleBasedFix: () => null },
    telemetry: { recordFixAttempt: () => {} },
    distill: { distillClaudeFix: () => {} },
  };
  const result = fixer._tryFlywheel({
    files: [{ path: 'src/x.js', content: 'const opts = { rejectUnauthorized: false };' }],
    repoRoot: '/tmp',
    flywheel,
  });
  assert.equal(result.patches.length, 1);
  assert.equal(result.patches[0].path, 'src/x.js');
  assert.match(result.patches[0].content, /rejectUnauthorized: true/);
  assert.ok(result.filesHandled.has('src/x.js'));
});

test('flywheel: Rule layer is tried when AST returns no change', () => {
  const flywheel = {
    available: true,
    astFixer: {
      isJsOrTs: () => true,
      tryAstFix: (content) => content, // no change
    },
    ruleFixer: {
      tryRuleBasedFix: (content) => content + '\n// fixed-by-rule',
    },
    telemetry: { recordFixAttempt: () => {} },
    distill: { distillClaudeFix: () => {} },
  };
  const result = fixer._tryFlywheel({
    files: [{ path: 'src/y.js', content: 'console.log("hi");' }],
    repoRoot: '/tmp',
    flywheel,
  });
  assert.equal(result.patches.length, 1);
  assert.match(result.patches[0].content, /fixed-by-rule/);
});

test('flywheel: returns empty when neither layer fires', () => {
  const flywheel = {
    available: true,
    astFixer: { isJsOrTs: () => true, tryAstFix: () => null },
    ruleFixer: { tryRuleBasedFix: () => null },
    telemetry: { recordFixAttempt: () => {} },
    distill: { distillClaudeFix: () => {} },
  };
  const result = fixer._tryFlywheel({
    files: [{ path: 'src/z.js', content: 'novel pattern' }],
    repoRoot: '/tmp',
    flywheel,
  });
  assert.equal(result.patches.length, 0);
  assert.equal(result.filesHandled.size, 0);
});

test('flywheel: crash in AST falls through to Rule, no throw', () => {
  const flywheel = {
    available: true,
    astFixer: {
      isJsOrTs: () => true,
      tryAstFix: () => { throw new Error('boom'); },
    },
    ruleFixer: { tryRuleBasedFix: (c) => c + '\n// rule-recovered' },
    telemetry: { recordFixAttempt: () => {} },
    distill: { distillClaudeFix: () => {} },
  };
  const result = fixer._tryFlywheel({
    files: [{ path: 'src/q.js', content: 'x' }],
    repoRoot: '/tmp',
    flywheel,
  });
  assert.equal(result.patches.length, 1);
  assert.match(result.patches[0].content, /rule-recovered/);
});

test('flywheel: distillClaudeWins calls auto-distill for every patched file', () => {
  const distilled = [];
  const flywheel = {
    available: true,
    distill: {
      distillClaudeFix: (entry) => distilled.push(entry),
    },
  };
  fixer._distillClaudeWins(
    flywheel,
    [
      { path: 'a.js', content: 'fixed a' },
      { path: 'b.js', content: 'fixed b' },
    ],
    { 'a.js': 'orig a', 'b.js': 'orig b' },
    'claude-sonnet-4-5',
  );
  assert.equal(distilled.length, 2);
  assert.equal(distilled[0].patchedContent, 'fixed a');
  assert.equal(distilled[0].originalContent, 'orig a');
  assert.equal(distilled[0].provenance.originalModel, 'claude-sonnet-4-5');
});

test('flywheel: distill silently skips when no original captured', () => {
  const distilled = [];
  const flywheel = {
    available: true,
    distill: { distillClaudeFix: (e) => distilled.push(e) },
  };
  fixer._distillClaudeWins(
    flywheel,
    [{ path: 'unknown.js', content: 'fixed' }],
    {}, // no original
    'claude-sonnet-4-5',
  );
  assert.equal(distilled.length, 0);
});

test('flywheel: loadFlywheel returns { available: false } gracefully when layers missing', () => {
  // The real loadFlywheel uses require — it'll find the real flywheel files
  // in this repo. So this test just verifies the function exists and
  // returns the expected shape.
  const result = fixer._loadFlywheel();
  assert.ok(result);
  assert.equal(typeof result.available, 'boolean');
});

// ── Smart default activation (Task 1) ──────────────────────────────────────
// The fixer is enabled whenever ANTHROPIC_API_KEY is present. The
// GATETEST_AI_CI_FIXER variable is an OPT-OUT escape hatch — only "0"
// disables. Any other value (including unset / "1" / "true") leaves the
// fixer enabled.

test('readEnv: ANTHROPIC_API_KEY present + GATETEST_AI_CI_FIXER undefined → enabled', () => {
  const cfg = fixer.readEnv({
    ANTHROPIC_API_KEY: 'k',
    GITHUB_TOKEN:      't',
    GITHUB_REPOSITORY: 'o/r',
    WORKFLOW_RUN_ID:   '1',
    // GATETEST_AI_CI_FIXER deliberately omitted
  });
  assert.equal(cfg.ok, true);
});

test('readEnv: GATETEST_AI_CI_FIXER="0" + key present → disabled with explicit-opt-out reason', () => {
  const cfg = fixer.readEnv({
    ANTHROPIC_API_KEY:    'k',
    GITHUB_TOKEN:         't',
    GITHUB_REPOSITORY:    'o/r',
    WORKFLOW_RUN_ID:      '1',
    GATETEST_AI_CI_FIXER: '0',
  });
  assert.equal(cfg.ok, false);
  assert.match(cfg.reason, /opted out/i);
  assert.match(cfg.reason, /GATETEST_AI_CI_FIXER/);
});

test('readEnv: GATETEST_AI_CI_FIXER="1" + key present → enabled (no different from undefined)', () => {
  const cfg = fixer.readEnv({
    ANTHROPIC_API_KEY:    'k',
    GITHUB_TOKEN:         't',
    GITHUB_REPOSITORY:    'o/r',
    WORKFLOW_RUN_ID:      '1',
    GATETEST_AI_CI_FIXER: '1',
  });
  assert.equal(cfg.ok, true);
});

test('readEnv: no ANTHROPIC_API_KEY → disabled regardless of GATETEST_AI_CI_FIXER flag', () => {
  // Flag set to "1" should NOT enable the fixer without the key.
  const cfg1 = fixer.readEnv({
    GITHUB_TOKEN:         't',
    GITHUB_REPOSITORY:    'o/r',
    WORKFLOW_RUN_ID:      '1',
    GATETEST_AI_CI_FIXER: '1',
  });
  assert.equal(cfg1.ok, false);
  assert.match(cfg1.reason, /ANTHROPIC_API_KEY/);

  // Flag set to "0" → still ANTHROPIC_API_KEY error path (key check runs first).
  const cfg2 = fixer.readEnv({
    GITHUB_TOKEN:         't',
    GITHUB_REPOSITORY:    'o/r',
    WORKFLOW_RUN_ID:      '1',
    GATETEST_AI_CI_FIXER: '0',
  });
  assert.equal(cfg2.ok, false);
  assert.match(cfg2.reason, /ANTHROPIC_API_KEY/);
});

// ── Branch-collision handling (Task 2) ─────────────────────────────────────
// When a previous AI fix-PR for the same workflow run still exists, rotate
// the branch name through ai-fix/<runId>-attempt-2 … -attempt-10 until a
// free slot is found. Cap at 10, then give up.

/**
 * Build a transport that returns the given status for the canonical branch
 * name and for each `-attempt-N` variant. Map keys are branch names; values
 * are HTTP statuses (200 = exists, 404 = free, anything else = treated as
 * exists per the spec).
 */
function branchTransport(statusByBranch) {
  return {
    request(opts, cb) {
      // path looks like /repos/o/r/branches/<branch> (URL-encoded)
      const m = /\/repos\/[^/]+\/[^/]+\/branches\/(.+)$/.exec(opts.path);
      const branch = m ? decodeURIComponent(m[1]) : '';
      const status = statusByBranch[branch] ?? 404;
      const body = status === 200
        ? { name: branch, commit: { sha: 'abc' } }
        : { message: status === 404 ? 'Branch not found' : 'error' };
      setImmediate(() => {
        const raw = JSON.stringify(body);
        const res = {
          statusCode: status,
          headers: { 'content-type': 'application/json' },
          on(event, fn) {
            if (event === 'data') fn(Buffer.from(raw));
            if (event === 'end')  fn();
          },
        };
        cb(res);
      });
      return { on() {}, write() {}, end() {}, destroy() {} };
    },
  };
}

test('findFreeBranchName: free branch on first try returns ai-fix/<runId>', async () => {
  const transport = branchTransport({}); // every branch 404 = free
  const result = await fixer.findFreeBranchName({
    token: 't', repo: 'o/r', baseRunId: '100', transport,
  });
  assert.deepEqual(result, { branch: 'ai-fix/100', attemptNumber: 1 });
});

test('findFreeBranchName: canonical branch taken, attempt-2 free → ai-fix/<runId>-attempt-2', async () => {
  const transport = branchTransport({
    'ai-fix/200': 200,
  });
  const result = await fixer.findFreeBranchName({
    token: 't', repo: 'o/r', baseRunId: '200', transport,
  });
  assert.deepEqual(result, { branch: 'ai-fix/200-attempt-2', attemptNumber: 2 });
});

test('findFreeBranchName: through attempt-9, free on attempt-10', async () => {
  const statusMap = { 'ai-fix/300': 200 };
  for (let n = 2; n <= 9; n++) {
    statusMap[`ai-fix/300-attempt-${n}`] = 200;
  }
  const transport = branchTransport(statusMap);
  const result = await fixer.findFreeBranchName({
    token: 't', repo: 'o/r', baseRunId: '300', transport,
  });
  assert.deepEqual(result, { branch: 'ai-fix/300-attempt-10', attemptNumber: 10 });
});

test('findFreeBranchName: all 10 attempts taken → returns null', async () => {
  const statusMap = { 'ai-fix/400': 200 };
  for (let n = 2; n <= 10; n++) {
    statusMap[`ai-fix/400-attempt-${n}`] = 200;
  }
  const transport = branchTransport(statusMap);
  const result = await fixer.findFreeBranchName({
    token: 't', repo: 'o/r', baseRunId: '400', transport,
  });
  assert.equal(result, null);
});

test('findFreeBranchName: API error on every check → returns null (every branch treated as exists)', async () => {
  // Every call returns 429 — per the spec, "any other status" is treated as
  // exists (safer to rotate than to clobber). After cycling through all 10
  // candidates, we return null.
  const transport = {
    request(opts, cb) {
      setImmediate(() => {
        const raw = JSON.stringify({ message: 'rate limited' });
        const res = {
          statusCode: 429,
          headers: { 'content-type': 'application/json' },
          on(event, fn) {
            if (event === 'data') fn(Buffer.from(raw));
            if (event === 'end')  fn();
          },
        };
        cb(res);
      });
      return { on() {}, write() {}, end() {}, destroy() {} };
    },
  };
  const result = await fixer.findFreeBranchName({
    token: 't', repo: 'o/r', baseRunId: '500', transport,
  });
  assert.equal(result, null);
});

test('findFreeBranchName: transport that throws is treated as exists, eventually returns null', async () => {
  // A transport that throws synchronously simulates a hard network error
  // mid-call. branchExists must catch and treat as exists; findFreeBranchName
  // must walk through all 10 candidates without crashing and return null.
  const transport = {
    request() {
      throw new Error('network down');
    },
  };
  const result = await fixer.findFreeBranchName({
    token: 't', repo: 'o/r', baseRunId: '600', transport,
  });
  assert.equal(result, null);
});

test('openFixPr: uses findFreeBranchName and rotates title when attempt > 1', async () => {
  const dir = makeTmpDir();
  try {
    // GitHub responses: canonical branch exists, -attempt-2 free, pulls 201.
    const transport = fakeTransport([
      { match: /\/branches\/ai-fix%2F700$/,           status: 200, body: { name: 'ai-fix/700' } },
      { match: /\/branches\/ai-fix%2F700-attempt-2$/, status: 404, body: { message: 'not found' } },
      { match: /\/pulls$/,                            status: 201, body: { number: 11, html_url: 'http://example/pr/11' } },
    ]);

    let createdPrPayload = null;
    const captureTransport = {
      request(opts, cb) {
        // Capture POST /pulls body so we can assert the title.
        if (opts.method === 'POST' && opts.path.endsWith('/pulls')) {
          // We need to capture writes to the request body.
          let bodyChunks = '';
          const reqShim = {
            on() {},
            write(chunk) { bodyChunks += chunk; },
            end() {
              try { createdPrPayload = JSON.parse(bodyChunks); } catch { /* ignore */ }
              setImmediate(() => {
                const raw = JSON.stringify({ number: 11, html_url: 'http://example/pr/11' });
                const res = {
                  statusCode: 201,
                  headers: { 'content-type': 'application/json' },
                  on(event, fn) {
                    if (event === 'data') fn(Buffer.from(raw));
                    if (event === 'end')  fn();
                  },
                };
                cb(res);
              });
            },
            destroy() {},
          };
          return reqShim;
        }
        // Branch checks fall through to fakeTransport-style routing.
        return transport.request(opts, cb);
      },
    };

    const gitCalls = [];
    const result = await fixer.openFixPr({
      token: 't', repo: 'o/r', runId: '700',
      runUrl: 'http://example/run/700',
      logExcerpt: 'log',
      attempt: 1,
      model: 'claude-sonnet-4-5',
      baseRef: 'main',
      git: (args) => { gitCalls.push(args); return { ok: true, stdout: '', stderr: '' }; },
      transport: captureTransport,
    });
    assert.equal(result.status, 201);
    assert.ok(createdPrPayload, 'PR creation payload should have been captured');
    assert.match(createdPrPayload.title, /\(attempt 2\)/);
    assert.equal(createdPrPayload.head, 'ai-fix/700-attempt-2');
    // Verify git checkout used the rotated branch name.
    const checkoutCall = gitCalls.find((a) => a[0] === 'checkout');
    assert.ok(checkoutCall, 'expected git checkout');
    assert.equal(checkoutCall[checkoutCall.length - 1], 'ai-fix/700-attempt-2');
  } finally {
    cleanup(dir);
  }
});

test('openFixPr: returns all-branches-taken when every slot is occupied', async () => {
  // Build a transport that returns 200 for ai-fix/800 AND every
  // -attempt-N variant. findFreeBranchName will return null and
  // openFixPr should short-circuit before touching git.
  const statusMap = { 'ai-fix/800': 200 };
  for (let n = 2; n <= 10; n++) statusMap[`ai-fix/800-attempt-${n}`] = 200;
  const transport = branchTransport(statusMap);

  let gitCallCount = 0;
  const result = await fixer.openFixPr({
    token: 't', repo: 'o/r', runId: '800',
    runUrl: 'http://example/run/800',
    logExcerpt: 'log',
    attempt: 1,
    model: 'claude-sonnet-4-5',
    baseRef: 'main',
    git: () => { gitCallCount += 1; return { ok: true, stdout: '', stderr: '' }; },
    transport,
  });
  assert.equal(result.status, 'all-branches-taken');
  assert.equal(gitCallCount, 0, 'should not invoke git when no free branch exists');
});
