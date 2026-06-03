/**
 * Regression tests for fetchWorkflowLogs + the 302-redirect-follow path.
 *
 * The arena demo's first real run failed silently because GitHub's
 * `/actions/jobs/{id}/logs` endpoint returns a 302 with a `Location:` header
 * pointing at a signed blob URL — we were treating the 302 body (empty)
 * as the log, the regex matched 0 files, and the fixer bailed out with
 * "no-files" despite obvious test failures upstream.
 *
 * These tests pin the redirect-follow contract so we never regress.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const fixer = require('../scripts/ai-ci-fixer');

/**
 * Build a fake HTTPS transport that returns the given responses for matched
 * hostnames + paths. Each entry: { hostname?, match, status, body, headers }.
 * Allows mocking BOTH the github API call AND the signed-blob follow-up.
 */
function fakeTransport(responses) {
  return {
    request(opts, cb) {
      const match = responses.find((r) => {
        if (r.hostname && r.hostname !== opts.hostname) return false;
        if (r.match instanceof RegExp) return r.match.test(opts.path);
        if (typeof r.match === 'string') return opts.path === r.match || opts.path.includes(r.match);
        return false;
      });
      const payload = match || { status: 404, body: { message: 'unmatched' }, headers: {} };
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
      return { on() {}, write() {}, end() {}, destroy() {} };
    },
  };
}

test('fetchWorkflowLogs follows 302 redirect to signed blob URL', async () => {
  const SIGNED_URL = 'https://pipelines.actions.githubusercontent.com/abc/log.txt?sig=xyz';
  const LOG_BODY = `# Subtest: add: positive integers
not ok 1 - add: positive integers
  location: '/home/runner/work/repo/repo/tests/math.test.js:16:1'`;

  const transport = fakeTransport([
    // 1. Job list
    {
      hostname: 'api.github.com',
      match:    /\/actions\/runs\/99\/jobs/,
      status:   200,
      body:     { jobs: [{ id: 42, conclusion: 'failure', name: 'test' }] },
    },
    // 2. Job log endpoint → 302 redirect
    {
      hostname: 'api.github.com',
      match:    /\/actions\/jobs\/42\/logs/,
      status:   302,
      body:     '',
      headers:  { location: SIGNED_URL, 'content-type': 'text/plain' },
    },
    // 3. Signed blob URL → real log body
    {
      hostname: 'pipelines.actions.githubusercontent.com',
      match:    /\/abc\/log\.txt/,
      status:   200,
      body:     LOG_BODY,
      headers:  { 'content-type': 'text/plain' },
    },
  ]);

  const result = await fixer.fetchWorkflowLogs('token', 'owner/repo', '99', { transport });
  assert.equal(result.ok, true);
  assert.equal(result.followedRedirect, true);
  assert.match(result.text, /not ok 1/);
  assert.match(result.text, /math\.test\.js:16/);
});

test('fetchWorkflowLogs returns empty text gracefully if redirect-follow fails', async () => {
  const transport = fakeTransport([
    {
      hostname: 'api.github.com',
      match:    /\/actions\/runs\/99\/jobs/,
      status:   200,
      body:     { jobs: [{ id: 42, conclusion: 'failure', name: 'test' }] },
    },
    {
      hostname: 'api.github.com',
      match:    /\/actions\/jobs\/42\/logs/,
      status:   302,
      body:     '',
      headers:  { location: 'https://bad.host.example/missing', 'content-type': 'text/plain' },
    },
    // 404 on the redirect target
    {
      hostname: 'bad.host.example',
      match:    /\/missing/,
      status:   404,
      body:     'Not Found',
      headers:  {},
    },
  ]);

  const result = await fixer.fetchWorkflowLogs('token', 'owner/repo', '99', { transport });
  // Still resolves; text is the 404 body (no error thrown). The fixer's
  // downstream regex will simply match 0 files — same graceful-no-op as
  // before, just without silently swallowing a real log on 302.
  assert.equal(result.ok, true);
  assert.equal(result.followedRedirect, true);
  assert.match(result.text, /Not Found/);
});

test('fetchWorkflowLogs reads body directly when log endpoint returns 200', async () => {
  // Some self-hosted runners / GHE flavours return the log inline (no
  // redirect). Make sure we still handle that path.
  const transport = fakeTransport([
    {
      hostname: 'api.github.com',
      match:    /\/actions\/runs\/99\/jobs/,
      status:   200,
      body:     { jobs: [{ id: 42, conclusion: 'failure' }] },
    },
    {
      hostname: 'api.github.com',
      match:    /\/actions\/jobs\/42\/logs/,
      status:   200,
      body:     'inline log content with tests/x.js:5 in it',
      headers:  { 'content-type': 'text/plain' },
    },
  ]);

  const result = await fixer.fetchWorkflowLogs('token', 'owner/repo', '99', { transport });
  assert.equal(result.ok, true);
  assert.equal(result.followedRedirect, undefined);
  assert.match(result.text, /inline log content/);
});

test('fetchWorkflowLogs returns ok=true with empty text when no jobs failed', async () => {
  const transport = fakeTransport([
    {
      hostname: 'api.github.com',
      match:    /\/actions\/runs\/99\/jobs/,
      status:   200,
      body:     { jobs: [{ id: 42, conclusion: 'success' }] },
    },
  ]);
  const result = await fixer.fetchWorkflowLogs('token', 'owner/repo', '99', { transport });
  assert.equal(result.ok, true);
  assert.equal(result.text, '');
  assert.deepEqual(result.failedJobs, []);
});

test('fetchUrl makes a GET with no auth header and returns plain body', async () => {
  let captured = null;
  const transport = {
    request(opts, cb) {
      captured = opts;
      setImmediate(() => {
        cb({
          statusCode: 200,
          headers: { 'content-type': 'text/plain' },
          on(event, fn) {
            if (event === 'data') fn(Buffer.from('hello world'));
            if (event === 'end')  fn();
          },
        });
      });
      return { on() {}, write() {}, end() {}, destroy() {} };
    },
  };
  const res = await fixer.fetchUrl('https://blob.example.com/path?sig=abc', { transport });
  assert.equal(res.status, 200);
  assert.equal(res.body, 'hello world');
  // No `Authorization` — signed URLs include their own credentials in
  // the query string. Leaking the GitHub token to a 3rd-party blob host
  // would be a real bug.
  assert.equal(captured.headers.Authorization, undefined);
  assert.equal(captured.headers['User-Agent'], 'gatetest-ai-ci-fixer');
  assert.equal(captured.hostname, 'blob.example.com');
  assert.equal(captured.path, '/path?sig=abc');
});

test('fetchUrl rejects malformed URLs without crashing the fixer', async () => {
  await assert.rejects(
    () => fixer.fetchUrl('not-a-real-url', {}),
    /invalid URL/i,
  );
});

test('REGRESSION: end-to-end — fixer extracts failing files from a 302-redirected log', async () => {
  // This is the exact failure mode the arena hit. The fixer fetches the
  // log via 302 → signed blob, the blob body contains real test-failure
  // paths, and extractFailingFiles parses them.
  const LOG_BODY = `# Subtest: add: positive integers
not ok 1 - add: positive integers
  ---
  location: '/home/runner/work/gatetest-arena/gatetest-arena/tests/math.test.js:16:1'
  stack: |-
    TestContext.<anonymous> (/home/runner/work/gatetest-arena/gatetest-arena/tests/math.test.js:17:10)`;

  const transport = fakeTransport([
    {
      hostname: 'api.github.com',
      match:    /\/actions\/runs\/99\/jobs/,
      status:   200,
      body:     { jobs: [{ id: 42, conclusion: 'failure', name: 'test' }] },
    },
    {
      hostname: 'api.github.com',
      match:    /\/actions\/jobs\/42\/logs/,
      status:   302,
      body:     '',
      headers:  { location: 'https://blob.example/log.txt' },
    },
    {
      hostname: 'blob.example',
      match:    /\/log\.txt/,
      status:   200,
      body:     LOG_BODY,
      headers:  {},
    },
  ]);

  const result = await fixer.fetchWorkflowLogs('token', 'owner/repo', '99', { transport });
  // Sanity: log content reached us
  assert.match(result.text, /math\.test\.js/);
  // The orchestrator's extractor recognises this shape — pre-redirect-fix
  // this would have returned [].
  const files = fixer.extractFailingFiles(result.text, '/home/runner/work/gatetest-arena/gatetest-arena');
  assert.ok(files.some((f) => f.includes('math.test.js')), `expected math.test.js in ${JSON.stringify(files)}`);
});
