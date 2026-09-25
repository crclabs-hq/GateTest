/**
 * A PUBLIC repository must load even when GateTest's own git-host credential
 * is refused AND the public archive is over the snapshot cap.
 *
 * 2026-09-25: the production readiness probe reported "could not read repo
 * file tree" on every run. Its canary — this repository, public — has a
 * tarball over the 40 MB cap, so both archive rungs failed honestly, and the
 * only rung left was the tree API with the box's refused token (401). No
 * rung ever asked anonymously. The fix adds two last-resort rungs:
 * `GET /git/trees/{ref}?recursive=1` with no Authorization header, and
 * raw.githubusercontent.com for the blobs.
 *
 * Control pair: the same stub with the anonymous tree answering 404 (a
 * private repo) must still fail, and the failure must still name OUR 401 as
 * the cause. Plus one budget assertion: the per-blob archive retry that the
 * new blob rung would otherwise trigger 200 times per scan is memoised.
 *
 * Harness: the subject is TypeScript; transpile it with the vendored
 * `typescript` and swap the three external requires for test doubles, the
 * way tests/gluecron-client-resolve-sha.test.js does.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'website/app/lib/gluecron-client.ts');
const TS_COMPILER_PATH = path.join(ROOT, 'website/node_modules/typescript/lib/typescript.js');

if (!fs.existsSync(TS_COMPILER_PATH)) {
  throw new Error(`typescript compiler not found at ${TS_COMPILER_PATH} — install website/node_modules before running this file.`);
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

const OVER_CAP = 'public archive for o/r exceeded the 41943040-byte snapshot cap';
const snapshotCalls = { n: 0 };
function overCapSnapshot() {
  const reject = async () => { snapshotCalls.n++; throw new Error(OVER_CAP); };
  return { fetchPublicRepoSnapshot: reject, fetchPublicGitlabSnapshot: reject };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function textResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => { throw new Error('not json'); } };
}

const TREE = [
  { path: 'src/a.js', type: 'blob' },
  { path: 'src/nested dir/b.ts', type: 'blob' },
  { path: 'src', type: 'tree' },
];

/** Fetch stub keyed on endpoint × whether an Authorization header was sent. */
function makeFetchStub({ anonTreeStatus }) {
  const seen = { authTree: 0, anonTree: 0, authContents: 0, raw: [] };
  const stub = async function fetchStub(url, options = {}) {
    const u = String(url);
    const hasAuth = Boolean((options.headers || {}).Authorization);
    if (u.includes('/git/trees/')) {
      if (hasAuth) { seen.authTree++; return jsonResponse(401, { message: 'Bad credentials' }); }
      seen.anonTree++;
      return anonTreeStatus === 200
        ? jsonResponse(200, { tree: TREE, truncated: false })
        : jsonResponse(anonTreeStatus, { message: 'Not Found' });
    }
    if (u.includes('/contents/')) { seen.authContents++; return jsonResponse(401, { message: 'Bad credentials' }); }
    if (u.startsWith('https://raw.githubusercontent.com/')) {
      seen.raw.push(u);
      assert.ok(!hasAuth, 'raw.githubusercontent.com must be read anonymously');
      return textResponse(200, `// contents of ${decodeURIComponent(u.split('/HEAD/')[1])}`);
    }
    throw new Error(`unexpected fetch url in test: ${u}`);
  };
  stub.seen = seen;
  return stub;
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
  for (const marker of ['global.__GT_MOCK_HTTPS__', 'global.__GT_MOCK_HTTP__', 'global.__GT_MOCK_REPO_SNAPSHOT__']) {
    assert.notStrictEqual(patched.indexOf(marker), -1, `${marker} not found to patch — source shape changed`);
  }
  global.__GT_MOCK_HTTPS__ = fakeUnreachableTransport();
  global.__GT_MOCK_HTTP__ = fakeUnreachableTransport();
  global.__GT_MOCK_REPO_SNAPSHOT__ = overCapSnapshot();
  const mod = new Module(SRC_PATH, module);
  mod.filename = SRC_PATH;
  mod.paths = Module._nodeModulePaths(path.dirname(SRC_PATH));
  mod._compile(patched, SRC_PATH);
  return mod.exports;
}

const HOST_ENV_KEYS = ['GLUECRON_API_TOKEN', 'GITHUB_TOKEN', 'GATETEST_GITHUB_TOKEN', 'GLUECRON_BASE_URL'];
let savedEnv, savedFetch, savedWarn, savedError;

before(() => {
  savedEnv = {};
  for (const key of HOST_ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  savedFetch = global.fetch;
  savedWarn = console.warn;
  savedError = console.error;
  console.warn = () => {};
  console.error = () => {};
});
after(() => {
  for (const key of HOST_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  global.fetch = savedFetch;
  console.warn = savedWarn;
  console.error = savedError;
});
beforeEach(() => { snapshotCalls.n = 0; });

describe('loadRepoFiles — public repo, refused credential, archive over the cap', () => {
  it('serves the tree anonymously and the blobs from raw.githubusercontent.com', async () => {
    const stub = makeFetchStub({ anonTreeStatus: 200 });
    global.fetch = stub;
    const { loadRepoFiles } = loadGluecronClient(); // fresh module: fresh memos
    const result = await loadRepoFiles('o', 'r', 'HEAD', 'ghp_refused', { maxFiles: 10, maxBlobReads: 10 });

    assert.deepStrictEqual(result.paths.sort(), ['src/a.js', 'src/nested dir/b.ts']);
    assert.strictEqual(result.fileContents.length, 2, 'both blobs must be read');
    for (const f of result.fileContents) {
      assert.strictEqual(f.content, `// contents of ${f.path}`);
    }
    assert.strictEqual(stub.seen.authTree, 1, 'the credentialed tree read is still tried first');
    assert.strictEqual(stub.seen.anonTree, 1, 'exactly one anonymous tree read');
    assert.strictEqual(stub.seen.raw.length, 2);
    assert.ok(stub.seen.raw.every((u) => u.startsWith('https://raw.githubusercontent.com/o/r/HEAD/src/')), stub.seen.raw.join('\n'));
    assert.ok(stub.seen.raw.some((u) => u.includes('nested%20dir')), 'path segments are URL-encoded');
  });

  it('does not re-download the archive once per blob (a failed snapshot is memoised for the scan)', async () => {
    global.fetch = makeFetchStub({ anonTreeStatus: 200 });
    const { loadRepoFiles } = loadGluecronClient();
    await loadRepoFiles('o', 'r', 'HEAD', 'ghp_refused', { maxFiles: 10, maxBlobReads: 10 });
    // loadRepoFiles: two archive attempts (auth, anon); fetchTree: one public
    // snapshot; fetchBlob ×2: served from the memoised failure, no new call.
    assert.ok(snapshotCalls.n <= 3, `archive fetched ${snapshotCalls.n} times for a 2-blob scan — the failure memo is gone`);
  });

  it('control: a private repo (anonymous tree 404) still fails, and the failure still names OUR 401', async () => {
    const stub = makeFetchStub({ anonTreeStatus: 404 });
    global.fetch = stub;
    const { loadRepoFiles } = loadGluecronClient();
    await assert.rejects(
      loadRepoFiles('o', 'r', 'HEAD', 'ghp_refused', { maxFiles: 10, maxBlobReads: 10 }),
      (err) => {
        assert.match(err.message, /Could not read the file tree for o\/r/);
        assert.match(err.message, /401 Bad credentials/, 'our credential failure must stay the headline cause');
        assert.match(err.message, /anonymous tree read: .*404/, 'the anonymous attempt is reported, not hidden');
        assert.match(err.message, /snapshot cap/, 'the archive failure is reported too');
        return true;
      },
    );
    assert.strictEqual(stub.seen.anonTree, 1);
    assert.strictEqual(stub.seen.raw.length, 0, 'no blob reads without a tree');
  });

  it('with no credential at all, the anonymous tree rung still serves a public repo', async () => {
    const stub = makeFetchStub({ anonTreeStatus: 200 });
    global.fetch = stub;
    const { loadRepoFiles } = loadGluecronClient();
    const result = await loadRepoFiles('o', 'r', 'HEAD', '', { maxFiles: 10, maxBlobReads: 10 });
    assert.strictEqual(result.paths.length, 2);
    assert.strictEqual(result.fileContents.length, 2);
    assert.strictEqual(stub.seen.authTree, 0, 'no token, no credentialed attempt');
    assert.strictEqual(stub.seen.anonTree, 1);
  });
});
