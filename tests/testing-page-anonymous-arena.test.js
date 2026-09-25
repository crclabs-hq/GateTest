/**
 * /testing (website/app/testing/arena-fetch.ts) — the public "Live arena"
 * page must not tell visitors the arena repo "hasn't been created yet" when
 * the real cause is the box's own GitHub credential being refused.
 *
 * Verified live 2026-09-25: https://gatetest.io/testing showed "Arena not
 * reachable ... got back: github-api-401 ... If the arena repo hasn't been
 * created yet, see arena-scaffold/README.md" — the arena repo is PUBLIC, so
 * a refused token should never have produced that message.
 *
 * Fix under test (arena-fetch.ts's fetchArenaPRs, built on
 * gluecron-client.ts's githubGetWithAnonymousFallback — see
 * tests/gluecron-client-anonymous-github-get.test.js for that unit in
 * isolation):
 *   - refused token (401/403) -> anonymous read succeeds -> kind "ok".
 *   - anonymous read hits GitHub's public rate limit (403 + x-ratelimit-
 *     remaining: 0) -> kind "rate-limited", not the missing-repo copy.
 *   - repo truly not found (404) -> kind "not-found" (the one case where
 *     the missing-repo copy is honest).
 *   - control: after one "ok" fetch, a later failing fetch still serves the
 *     cached snapshot instead of losing the last known-good data.
 *
 * Harness: arena-fetch.ts is TypeScript with no compiled JS. Transpile with
 * the vendored `typescript` package and swap its
 * `require("../lib/gluecron-client")` for a hand-rolled stub — this test
 * exercises arena-fetch.ts's own classification/cache logic, not
 * gluecron-client.ts's internals (covered separately).
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'website/app/testing/arena-fetch.ts');
const TS_COMPILER_PATH = path.join(ROOT, 'website/node_modules/typescript/lib/typescript.js');

if (!fs.existsSync(TS_COMPILER_PATH)) {
  throw new Error(
    `typescript compiler not found at ${TS_COMPILER_PATH} — recreate the website/node_modules junction before running this test file.`,
  );
}
const ts = require(TS_COMPILER_PATH);

function jsonResponse(status, body, headers) {
  const h = new Map(Object.entries(headers || {}));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (h.has(k) ? h.get(k) : null) },
    json: async () => body,
  };
}

/** Loads a fresh copy of arena-fetch.ts with `require("../lib/gluecron-client")`
 * swapped for the given stub, so each test starts with a clean module-level
 * `lastGoodSnapshot` cache. */
function loadArenaFetch(gluecronClientStub) {
  const source = fs.readFileSync(SRC_PATH, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: SRC_PATH,
  });

  const patched = outputText.replace('require("../lib/gluecron-client")', 'global.__GT_MOCK_GLUECRON_CLIENT__');
  assert.notStrictEqual(
    patched.indexOf('global.__GT_MOCK_GLUECRON_CLIENT__'),
    -1,
    'gluecron-client require() was not found to patch — source shape changed',
  );

  global.__GT_MOCK_GLUECRON_CLIENT__ = gluecronClientStub;

  const mod = new Module(SRC_PATH, module);
  mod.filename = SRC_PATH;
  mod.paths = Module._nodeModulePaths(path.dirname(SRC_PATH));
  mod._compile(patched, SRC_PATH);
  delete global.__GT_MOCK_GLUECRON_CLIENT__;
  return mod.exports;
}

function stub({ res, usedAnonymous = false, token = 'ghp_stale_box_token_0000000000000000' }) {
  return {
    getGithubToken: () => token,
    githubGetWithAnonymousFallback: async () => ({ res, usedAnonymous }),
  };
}

describe('fetchArenaPRs — refused box credential must not read as "repo missing"', () => {
  it('refused token, anonymous read succeeds -> kind "ok" with the PR list', async () => {
    const prs = [{ number: 1, title: 'arena(bug): x', state: 'open', created_at: 't', merged_at: null, html_url: 'h', user: null, body: null }];
    const { fetchArenaPRs } = loadArenaFetch(stub({ res: jsonResponse(200, prs), usedAnonymous: true }));

    const result = await fetchArenaPRs('crclabs-hq/gatetest-arena');

    assert.strictEqual(result.kind, 'ok');
    assert.deepStrictEqual(result.prs, prs);
  });

  it('anonymous read rate-limited (403, x-ratelimit-remaining: 0) -> kind "rate-limited", not the missing-repo copy', async () => {
    const resetEpochSeconds = 1_800_000_000;
    const res = jsonResponse(403, { message: 'rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpochSeconds) });
    const { fetchArenaPRs } = loadArenaFetch(stub({ res, usedAnonymous: true }));

    const result = await fetchArenaPRs('crclabs-hq/gatetest-arena');

    assert.strictEqual(result.kind, 'rate-limited');
    assert.strictEqual(result.resetAt, resetEpochSeconds * 1000);
  });

  it('control: repo truly not found (404) -> kind "not-found" (the one case where the missing-repo copy is honest)', async () => {
    const { fetchArenaPRs } = loadArenaFetch(stub({ res: jsonResponse(404, { message: 'Not Found' }), usedAnonymous: true }));

    const result = await fetchArenaPRs('crclabs-hq/does-not-exist');

    assert.strictEqual(result.kind, 'not-found');
  });

  it('a later failure still serves the last successful snapshot instead of losing the data', async () => {
    const prs = [{ number: 2, title: 'arena(bug): y', state: 'open', created_at: 't', merged_at: null, html_url: 'h', user: null, body: null }];

    let callCount = 0;
    const gluecronStub = {
      getGithubToken: () => 'ghp_x',
      githubGetWithAnonymousFallback: async () => {
        callCount++;
        return callCount === 1
          ? { res: jsonResponse(200, prs), usedAnonymous: false }
          : { res: jsonResponse(500, { message: 'upstream outage' }), usedAnonymous: false };
      },
    };
    const arenaFetch = loadArenaFetch(gluecronStub);

    const first = await arenaFetch.fetchArenaPRs('crclabs-hq/gatetest-arena');
    assert.strictEqual(first.kind, 'ok');
    assert.deepStrictEqual(arenaFetch.getLastGoodSnapshot().prs, prs);

    const second = await arenaFetch.fetchArenaPRs('crclabs-hq/gatetest-arena');
    assert.strictEqual(second.kind, 'error');
    assert.deepStrictEqual(
      arenaFetch.getLastGoodSnapshot().prs,
      prs,
      'the cached snapshot from the first successful read must survive a later failed read',
    );
    assert.match(arenaFetch.describeArenaFailure(second), /error/i);
  });
});
