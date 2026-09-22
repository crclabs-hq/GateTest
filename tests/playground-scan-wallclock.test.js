/**
 * Issue #651 (N3 partial, Tallrig re-walk 2 on #647) — wallMs is the free
 * scan's headline duration, but it started its clock after `await
 * req.json()` in both website/app/api/playground/scan/stream/route.ts and
 * its non-stream sibling website/app/api/playground/scan/route.ts. Every
 * millisecond spent receiving/parsing the request body (or any future
 * queue wait placed before the fetch) was silently dropped from the
 * number, which is why an independent stopwatch measured 19% more wall
 * time than the headline in 2 of 3 live runs.
 *
 * Fix: `startedAt = Date.now()` is now the first statement in each
 * handler, before `req.json()`. Two things are pinned:
 *
 *   1. Structural (both routes): `startedAt` is assigned textually before
 *      the `await req.json()` call — this is the actual mechanism of the
 *      fix, and a regex/order check is cheap and exact.
 *   2. Behavioral (stream route): the real POST handler, run with mocked
 *      dependencies, reports a wallMs that accounts for a deliberate delay
 *      placed INSIDE the mocked `req.json()` — i.e. before any fetch or
 *      engine work even starts. A build that reverted to timing from after
 *      the body parse would report a wallMs far below this test's
 *      threshold and fail it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STREAM_ROUTE = 'website/app/api/playground/scan/stream/route.ts';
const NON_STREAM_ROUTE = 'website/app/api/playground/scan/route.ts';
const TS_COMPILER_PATH = path.join(ROOT, 'website/node_modules/typescript/lib/typescript.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('wallMs starts at handler entry, before the body is parsed', () => {
  for (const rel of [STREAM_ROUTE, NON_STREAM_ROUTE]) {
    it(`${rel}: startedAt is assigned before \`await req.json()\``, () => {
      const src = read(rel);
      const startedAtIdx = src.indexOf('const startedAt = Date.now();');
      // The actual body-parse call, not a comment mentioning it — disambiguated
      // by the `body = ` prefix so a doc comment quoting "req.json()" can't
      // false-positive this check.
      const jsonIdx = src.indexOf('body = await req.json();');
      assert.notStrictEqual(startedAtIdx, -1, 'startedAt assignment not found — was it renamed?');
      assert.notStrictEqual(jsonIdx, -1, 'req.json() call not found — did the body-parsing shape change?');
      assert.ok(
        startedAtIdx < jsonIdx,
        `startedAt must be captured before the body is parsed, so no pre-fetch wait is dropped from wallMs ` +
          `(startedAt at ${startedAtIdx}, req.json() at ${jsonIdx})`,
      );
    });

    it(`${rel}: startedAt is the first statement inside POST (nothing awaited before it)`, () => {
      const src = read(rel);
      const postIdx = src.indexOf('export async function POST(');
      const startedAtIdx = src.indexOf('const startedAt = Date.now();');
      const body = src.slice(postIdx, startedAtIdx);
      assert.doesNotMatch(body, /\bawait\b/, `an await before startedAt would drop that wait from wallMs — found one between POST( and startedAt in ${rel}`);
    });
  }
});

if (!fs.existsSync(TS_COMPILER_PATH)) {
  throw new Error(`typescript compiler not found at ${TS_COMPILER_PATH} — recreate the website/node_modules junction first`);
}
const ts = require(TS_COMPILER_PATH);

/**
 * Transpile the stream route to plain JS and swap its external
 * dependencies (scan-modules, gluecron-client, modules-data,
 * free-scan-viewer, customer-session, scan-grade) for test doubles hung
 * off `global`, exactly as tests/gluecron-client-resolve-sha.test.js and
 * tests/badge-free-scan-honesty.test.js already do for TS files node
 * cannot `require()` directly.
 */
function loadStreamPost(mocks) {
  const source = read(STREAM_ROUTE);
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: path.join(ROOT, STREAM_ROUTE),
  });

  const replacements = [
    ['require("@/app/lib/scan-modules")', 'global.__PG_MOCK_SCAN_MODULES__'],
    ['require("@/app/lib/gluecron-client")', 'global.__PG_MOCK_GLUECRON_CLIENT__'],
    ['require("@/app/components/howitworks/modules-data")', 'global.__PG_MOCK_MODULES_DATA__'],
    ['require("@/app/lib/free-scan-viewer")', 'global.__PG_MOCK_FREE_SCAN_VIEWER__'],
    ['require("@/app/lib/customer-session")', 'global.__PG_MOCK_CUSTOMER_SESSION__'],
    ['require("@/app/lib/scan-grade")', 'global.__PG_MOCK_SCAN_GRADE__'],
  ];
  let patched = outputText;
  for (const [from, to] of replacements) {
    assert.ok(patched.includes(from), `expected to find ${from} in the transpiled stream route — source shape changed`);
    patched = patched.replace(from, to);
  }

  global.__PG_MOCK_SCAN_MODULES__ = mocks.scanModules;
  global.__PG_MOCK_GLUECRON_CLIENT__ = mocks.gluecronClient;
  global.__PG_MOCK_MODULES_DATA__ = mocks.modulesData;
  global.__PG_MOCK_FREE_SCAN_VIEWER__ = mocks.freeScanViewer;
  global.__PG_MOCK_CUSTOMER_SESSION__ = mocks.customerSession;
  global.__PG_MOCK_SCAN_GRADE__ = mocks.scanGrade;

  const Module = require('node:module');
  const modPath = path.join(ROOT, STREAM_ROUTE);
  const mod = new Module(modPath, module);
  mod.filename = modPath;
  mod.paths = Module._nodeModulePaths(path.dirname(modPath));
  mod._compile(patched, modPath);
  return mod.exports.POST;
}

function fakeScanGrade() {
  return {
    severityForModule: () => 'info',
    computeScanGrade: () => ({
      summary: 'clean', score: 100, grade: 'A', gradeColor: '#059669',
      blocking: 0, warnings: 0, info: 0, countLabel: '0 issues',
    }),
    computeCoverage: (scanned, total) => ({ scanned, total, partial: scanned < total }),
    coverageQualifier: () => '',
    formatResultHeader: () => 'GateTest: acme/widgets @ deadbeef',
    describeScanScope: () => '1 of 1 files',
  };
}

describe('POST /api/playground/scan/stream — wallMs accounts for the body-parse wait', () => {
  it('wallMs covers the deliberate delay inside req.json(), not just fetch+engine time', async () => {
    const JSON_PARSE_DELAY_MS = 90; // simulates any pre-fetch wait — body parse today, a queue wait tomorrow
    const FETCH_DELAY_MS = 15;
    const ENGINE_REPORTED_MS = 8;

    const POST = loadStreamPost({
      scanModules: {
        runTier: async (_tier, _ctx, onModuleComplete) => {
          const mod = { name: 'syntax', status: 'passed', checks: 3, issues: 0, duration: ENGINE_REPORTED_MS, details: [] };
          onModuleComplete(mod);
          return { modules: [mod], totalIssues: 0 };
        },
      },
      gluecronClient: {
        resolveRepoAuth: async () => ({ token: '' }),
        loadRepoFiles: async () => {
          await sleep(FETCH_DELAY_MS);
          return {
            paths: ['index.js'],
            fileContents: [{ path: 'index.js', content: 'console.log(1)' }],
            source: 'anonymous-archive',
            truncated: false,
          };
        },
        resolveBaseBranchSha: async () => ({ sha: 'a'.repeat(40), defaultBranch: 'main', source: 'github' }),
      },
      modulesData: { MODULE_CATEGORIES: [], totalModuleCount: () => 4 },
      freeScanViewer: { resolveFreeScanViewer: async () => ({ signedIn: false, canSignIn: false, login: null, canFix: false }) },
      customerSession: { CUSTOMER_COOKIE_NAME: 'gt_customer' },
      scanGrade: fakeScanGrade(),
    });

    const fakeReq = {
      json: async () => {
        await sleep(JSON_PARSE_DELAY_MS); // the wait the old code dropped from wallMs
        return { repo_url: 'https://github.com/acme/widgets' };
      },
      cookies: { get: () => undefined },
    };

    const before = Date.now();
    const response = await POST(fakeReq);
    const text = await response.text();
    const totalElapsed = Date.now() - before;

    const completeEvent = text.split('\n\n').map((chunk) => chunk.trim()).find((chunk) => chunk.startsWith('event: complete'));
    assert.ok(completeEvent, `expected a "complete" SSE event, got: ${text.slice(0, 500)}`);
    const dataLine = completeEvent.split('\n').find((l) => l.startsWith('data: '));
    const payload = JSON.parse(dataLine.slice('data: '.length));

    const { wallMs, fetchMs, engineMs } = payload.coverage;

    // The literal ask: wallMs is never less than the sum of its own parts.
    assert.ok(wallMs >= fetchMs + engineMs, `wallMs (${wallMs}) must be >= fetchMs (${fetchMs}) + engineMs (${engineMs})`);

    // The actual regression guard: wallMs must also cover the delay that
    // happened BEFORE fetch/engine ever started. Before the fix, startedAt
    // was captured after `await req.json()`, so wallMs would be roughly
    // FETCH_DELAY_MS + ENGINE work only (tens of ms) — well under this
    // threshold, which sits just below the full injected delay to absorb
    // scheduler jitter.
    const expectedFloor = JSON_PARSE_DELAY_MS + FETCH_DELAY_MS - 20;
    assert.ok(
      wallMs >= expectedFloor,
      `wallMs (${wallMs}) must include the pre-fetch body-parse delay (${JSON_PARSE_DELAY_MS}ms) — ` +
        `expected at least ~${expectedFloor}ms. A wallMs this low means the clock started after req.json() again.`,
    );

    // Sanity: wallMs cannot exceed the test's own observed wall-clock window.
    assert.ok(wallMs <= totalElapsed + 5, `wallMs (${wallMs}) must not exceed the actual elapsed time (${totalElapsed}ms)`);
  });
});
