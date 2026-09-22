/**
 * Issue #651 (Tallrig re-walk 2 on #647), item 1 — a public repo must never
 * show a customer "GitHub rejected the credential (401)" when the box's own
 * GITHUB_TOKEN / GATETEST_GITHUB_TOKEN has gone stale. `resolveBaseBranchSha`
 * (website/app/lib/gluecron-client.ts) sent Authorization: Bearer <token> on
 * every GitHub attempt and never retried anonymously, so a dead host
 * credential made every public repo look broken to the customer.
 *
 * Fix under test: on 401/403 from a credentialed GitHub read, retry the same
 * calls with no Authorization header. A public repo then resolves (sha, no
 * reason); the stale-credential fact is logged server-side only. Only when
 * the anonymous retry ALSO fails does a reason reach the customer, and that
 * reason names the repo's own ambiguous state (private-or-missing), never
 * "our credential".
 *
 * The subject file is TypeScript with no CommonJS/ESM interop path a plain
 * `node --test` file can `require()` directly (it mixes top-level `import`
 * with a local `require("./repo-snapshot")`, which only resolves once
 * Next.js's tsc build has flattened both to CommonJS). This harness
 * transpiles the source with the `typescript` package already vendored
 * under website/node_modules (module: commonjs) and swaps the three
 * external `require(...)` targets (https, http, ./repo-snapshot) for
 * test doubles hung off `global` before compiling — resolveBaseBranchSha
 * itself never touches repo-snapshot, and https/http are only exercised by
 * the Gluecron leg, which this harness fails fast and quiet instead of
 * hitting the real network.
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
    `typescript compiler not found at ${TS_COMPILER_PATH} — recreate the website/node_modules junction ` +
      '(see .claude/agents/builder.md) before running this test file.',
  );
}

const ts = require(TS_COMPILER_PATH);

// A transport whose `.request()` fails fast and asynchronously instead of
// making a real network call — used for both `https` and `http` so the
// Gluecron leg of resolveBaseBranchSha (which does not go through fetch)
// fails quickly rather than hanging or hitting gluecron.com from a test.
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

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * Fetch mock keyed on: which GitHub endpoint (repo metadata vs. branch ref),
 * and whether the call carried an Authorization header (bearer vs.
 * anonymous). Each call site in resolveBaseBranchSha/attemptGithubBaseBranchSha
 * re-derives its own headers per attempt, so keying on header presence
 * (rather than call order) mirrors what the real GitHub API sees.
 */
function makeFetchMock({ bearerRepoStatus, anonRepoStatus, bearerRefStatus, anonRefStatus, bearerRefSha, anonRefSha, defaultBranch }) {
  return async function fetchMock(url, options = {}) {
    const headers = options.headers || {};
    const hasAuth = Boolean(headers.Authorization);
    if (/\/repos\/[^/]+\/[^/]+$/.test(String(url))) {
      const status = hasAuth ? bearerRepoStatus : anonRepoStatus;
      return jsonResponse(status, { default_branch: defaultBranch || 'main' });
    }
    if (String(url).includes('/git/refs/heads/')) {
      const status = hasAuth ? (bearerRefStatus ?? 200) : (anonRefStatus ?? 200);
      const sha = hasAuth ? bearerRefSha : anonRefSha;
      return jsonResponse(status, sha ? { object: { sha } } : {});
    }
    throw new Error(`unexpected fetch url in test: ${url}`);
  };
}

/** Transpile gluecron-client.ts to CommonJS and load it with test doubles. */
function loadGluecronClient() {
  const source = fs.readFileSync(SRC_PATH, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: SRC_PATH,
  });

  const patched = outputText
    .replace('require("https")', 'global.__GT_MOCK_HTTPS__')
    .replace('require("http")', 'global.__GT_MOCK_HTTP__')
    .replace('require("./repo-snapshot")', 'global.__GT_MOCK_REPO_SNAPSHOT__');

  assert.notStrictEqual(patched.indexOf('global.__GT_MOCK_HTTPS__'), -1, 'https require() was not found to patch — source shape changed');
  assert.notStrictEqual(patched.indexOf('global.__GT_MOCK_HTTP__'), -1, 'http require() was not found to patch — source shape changed');
  assert.notStrictEqual(
    patched.indexOf('global.__GT_MOCK_REPO_SNAPSHOT__'),
    -1,
    './repo-snapshot require() was not found to patch — source shape changed',
  );

  global.__GT_MOCK_HTTPS__ = fakeUnreachableTransport();
  global.__GT_MOCK_HTTP__ = fakeUnreachableTransport();
  global.__GT_MOCK_REPO_SNAPSHOT__ = stubRepoSnapshot();

  const mod = new Module(SRC_PATH, module);
  mod.filename = SRC_PATH;
  mod.paths = Module._nodeModulePaths(path.dirname(SRC_PATH));
  mod._compile(patched, SRC_PATH);
  return mod.exports;
}

const HOST_ENV_KEYS = ['GLUECRON_API_TOKEN', 'GITHUB_TOKEN', 'GATETEST_GITHUB_TOKEN', 'GLUECRON_BASE_URL'];
let savedEnv;
let savedFetch;
let savedWarn;
let warnLines;

before(() => {
  savedEnv = {};
  for (const key of HOST_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  savedFetch = global.fetch;
  savedWarn = console.warn;
});

after(() => {
  for (const key of HOST_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  global.fetch = savedFetch;
  console.warn = savedWarn;
  delete global.__GT_MOCK_HTTPS__;
  delete global.__GT_MOCK_HTTP__;
  delete global.__GT_MOCK_REPO_SNAPSHOT__;
});

function withMocks(fetchMock, fn) {
  global.fetch = fetchMock;
  warnLines = [];
  console.warn = (...args) => warnLines.push(args.map(String).join(' '));
  return fn();
}

describe('resolveBaseBranchSha — public repo survives a stale host credential (issue #651)', () => {
  it('bearer 401, anonymous 200 → sha resolved, reason null, credential problem logged server-side only', async () => {
    const sha = 'a'.repeat(40);
    const fetchMock = makeFetchMock({
      bearerRepoStatus: 401,
      anonRepoStatus: 200,
      anonRefStatus: 200,
      anonRefSha: sha,
      defaultBranch: 'main',
    });

    const result = await withMocks(fetchMock, async () => {
      const { resolveBaseBranchSha } = loadGluecronClient();
      return resolveBaseBranchSha('expressjs', 'express', '', 'ghp_stale_host_token_0000000000000000');
    });

    assert.strictEqual(result.sha, sha, `expected the sha to resolve, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.source, 'github');
    assert.ok(!result.reason, `expected no customer-facing reason on a resolved sha, got: ${result.reason}`);

    // The stale-credential fact must reach an operator, just never the customer.
    const warned = warnLines.join('\n');
    assert.ok(/401/.test(warned) && /credential/i.test(warned), `expected a server-side warn about the rejected host credential, got: ${JSON.stringify(warnLines)}`);
  });

  it('bearer 401, anonymous 404 → reason names a private-or-missing repo, not our credential', async () => {
    const fetchMock = makeFetchMock({
      bearerRepoStatus: 401,
      anonRepoStatus: 404,
    });

    const result = await withMocks(fetchMock, async () => {
      const { resolveBaseBranchSha } = loadGluecronClient();
      return resolveBaseBranchSha('someowner', 'privaterepo', '', 'ghp_stale_host_token_0000000000000000');
    });

    assert.strictEqual(result.sha, null);
    assert.ok(result.reason, 'expected a reason when neither the bearer nor the anonymous attempt resolved a sha');
    assert.ok(
      /private/i.test(result.reason) && /(does not exist|missing|renamed)/i.test(result.reason),
      `expected the reason to name a private-or-missing repo, got: ${result.reason}`,
    );
    assert.ok(!/rejected the credential/i.test(result.reason), `reason must not blame our credential, got: ${result.reason}`);
    assert.ok(!/our credential/i.test(result.reason), `reason must not blame our credential, got: ${result.reason}`);
  });

  it('control: no token at all, public repo (F1/F4) — anonymous free scans keep working', async () => {
    const sha = 'b'.repeat(40);
    const fetchMock = makeFetchMock({
      anonRepoStatus: 200,
      anonRefStatus: 200,
      anonRefSha: sha,
      defaultBranch: 'main',
    });

    const result = await withMocks(fetchMock, async () => {
      const { resolveBaseBranchSha } = loadGluecronClient();
      return resolveBaseBranchSha('expressjs', 'express', '', '');
    });

    assert.strictEqual(result.sha, sha);
    assert.strictEqual(result.source, 'github');
    assert.ok(!result.reason, `expected no reason for a resolved anonymous public-repo lookup, got: ${result.reason}`);
  });
});
