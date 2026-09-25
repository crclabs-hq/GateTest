/**
 * `githubGetWithAnonymousFallback` (website/app/lib/gluecron-client.ts) —
 * the generic bearer→anonymous retry factored out of
 * `attemptGithubBaseBranchSha` (issue #651) for callers outside this file.
 *
 * Added 2026-09-25 for the /testing page fix: the box's GITHUB_TOKEN is now
 * refused (401) by GitHub, and the arena repo it reads is PUBLIC, so a
 * refused token must fall back to an anonymous read instead of the page
 * reporting "arena not reachable" / "hasn't been created yet".
 *
 * Control pair:
 *   1. bearer 401 (refused token) → anonymous 200 → the anonymous response
 *      is returned, usedAnonymous: true.
 *   2. bearer 404 (real 404, not a credential problem) → NOT retried
 *      anonymously — the bearer 404 is returned as-is, usedAnonymous: false.
 *
 * Harness: TypeScript source, no compiled JS. Transpile with the vendored
 * `typescript` package (same technique as
 * tests/gluecron-client-resolve-sha.test.js) and swap the external
 * requires (https, http, ./repo-snapshot) for test doubles — this function
 * itself only calls global `fetch`, but the module has unconditional
 * top-level requires for all three that must resolve to load at all.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'website/app/lib/gluecron-client.ts');
const TS_COMPILER_PATH = path.join(ROOT, 'website/node_modules/typescript/lib/typescript.js');

if (!fs.existsSync(TS_COMPILER_PATH)) {
  throw new Error(
    `typescript compiler not found at ${TS_COMPILER_PATH} — recreate the website/node_modules junction before running this test file.`,
  );
}
const ts = require(TS_COMPILER_PATH);

function fakeUnreachableTransport() {
  return {
    request() {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.setTimeout = () => {};
      req.destroy = () => {};
      process.nextTick(() => req.emit('error', new Error('mock: transport unreachable in test')));
      return req;
    },
  };
}

function stubRepoSnapshot() {
  const empty = async () => ({ paths: [], contents: new Map(), truncated: false, warning: null, source: 'stub' });
  return { fetchPublicRepoSnapshot: empty, fetchPublicGitlabSnapshot: empty };
}

function jsonResponse(status, body, headers) {
  const h = new Map(Object.entries(headers || {}));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (h.has(k) ? h.get(k) : null) },
    json: async () => body,
  };
}

function loadGluecronClient() {
  const source = fs.readFileSync(SRC_PATH, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: SRC_PATH,
  });

  const patched = outputText
    .replace('require("https")', 'global.__GT_MOCK_HTTPS__')
    .replace('require("http")', 'global.__GT_MOCK_HTTP__')
    .replace('require("./repo-snapshot")', 'global.__GT_MOCK_REPO_SNAPSHOT__');

  assert.notStrictEqual(patched.indexOf('global.__GT_MOCK_HTTPS__'), -1, 'https require() was not found to patch');
  assert.notStrictEqual(patched.indexOf('global.__GT_MOCK_HTTP__'), -1, 'http require() was not found to patch');
  assert.notStrictEqual(patched.indexOf('global.__GT_MOCK_REPO_SNAPSHOT__'), -1, './repo-snapshot require() was not found to patch');

  global.__GT_MOCK_HTTPS__ = fakeUnreachableTransport();
  global.__GT_MOCK_HTTP__ = fakeUnreachableTransport();
  global.__GT_MOCK_REPO_SNAPSHOT__ = stubRepoSnapshot();

  const mod = new Module(SRC_PATH, module);
  mod.filename = SRC_PATH;
  mod.paths = Module._nodeModulePaths(path.dirname(SRC_PATH));
  mod._compile(patched, SRC_PATH);
  return mod.exports;
}

let savedFetch;
before(() => {
  savedFetch = global.fetch;
});
after(() => {
  global.fetch = savedFetch;
  delete global.__GT_MOCK_HTTPS__;
  delete global.__GT_MOCK_HTTP__;
  delete global.__GT_MOCK_REPO_SNAPSHOT__;
});

describe('githubGetWithAnonymousFallback — refused token falls back to an anonymous read', () => {
  it('bearer 401 (refused token) -> anonymous 200: returns the anonymous response, usedAnonymous true', async () => {
    const calls = [];
    global.fetch = async (url, options = {}) => {
      const hasAuth = Boolean((options.headers || {}).Authorization);
      calls.push({ url: String(url), hasAuth });
      return hasAuth ? jsonResponse(401, { message: 'Bad credentials' }) : jsonResponse(200, [{ number: 1 }]);
    };

    const { githubGetWithAnonymousFallback } = loadGluecronClient();
    const { res, usedAnonymous } = await githubGetWithAnonymousFallback(
      '/repos/crclabs-hq/gatetest-arena/pulls?state=all',
      'ghp_stale_box_token_0000000000000000',
    );

    assert.strictEqual(usedAnonymous, true);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 2, `expected a bearer attempt then an anonymous retry, got: ${JSON.stringify(calls)}`);
    assert.strictEqual(calls[0].hasAuth, true);
    assert.strictEqual(calls[1].hasAuth, false);
  });

  it('control: bearer 404 (repo truly not found) is NOT retried anonymously', async () => {
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), hasAuth: Boolean((options.headers || {}).Authorization) });
      return jsonResponse(404, { message: 'Not Found' });
    };

    const { githubGetWithAnonymousFallback } = loadGluecronClient();
    const { res, usedAnonymous } = await githubGetWithAnonymousFallback(
      '/repos/crclabs-hq/gatetest-arena/pulls?state=all',
      'ghp_valid_token_0000000000000000000',
    );

    assert.strictEqual(usedAnonymous, false);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(calls.length, 1, `expected only the single bearer attempt on a real 404, got: ${JSON.stringify(calls)}`);
  });

  it('control: no token configured — the single call is already anonymous, usedAnonymous true', async () => {
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ hasAuth: Boolean((options.headers || {}).Authorization) });
      return jsonResponse(200, []);
    };

    const { githubGetWithAnonymousFallback } = loadGluecronClient();
    const { res, usedAnonymous } = await githubGetWithAnonymousFallback('/repos/o/r/pulls', '');

    assert.strictEqual(usedAnonymous, true);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 1, `expected exactly one call when there is no token, got: ${JSON.stringify(calls)}`);
    assert.strictEqual(calls[0].hasAuth, false);
  });
});
