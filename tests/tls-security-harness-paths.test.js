'use strict';

// =============================================================================
// tlsSecurity — a benchmark is a harness, the same kind of code as a test
// =============================================================================
// sindresorhus/got @ main, scanned 2026-09-14: `benchmark/index.ts` builds an
// `https.Agent({ rejectUnauthorized: false })` and three client option sets
// with the same flag / `strictSSL: false`, all pointed at the benchmark's own
// `https://127.0.0.1:8081`. Four gate-BLOCKING findings at confidence 1.0, in
// the file that times the library and never ships.
//
// The engine already said a benchmark is not shipped code twice —
// `HARNESS_DIR_RE` (scan-scope.js) and `NOT_SHIPPED_RE`
// (dependency-reachability.js) — but the predicate the severity ladders read,
// `_isTestPath` (src/core/test-paths.js), did not. It now does, for
// `benchmark/`, `benchmarks/`, `bench/` and `examples/`, so every module that
// calibrates on it (7486a78d did this for flakyTests / secrets / hardcodedUrl
// under `tests/`) agrees. This file is the control pair for tlsSecurity: the
// got lines verbatim under benchmark/ → warning, still on the report; the same
// lines under source/ → error.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const TlsSecurityModule = require('../src/modules/tls-security');

function makeResult() {
  return { checks: [], addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); } };
}
function run(projectRoot) {
  const mod = new TlsSecurityModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
const fired = (r) => r.checks
  .filter((c) => !c.passed && /^tls-security:js-/.test(c.name))
  .map((c) => ({ name: c.name.replace(/\\/g, '/'), severity: c.severity, line: c.line }))
  .sort((a, b) => a.line - b.line);

// got/benchmark/index.ts, lines 1-36 verbatim (tabs and all).
const GOT_BENCHMARK = [
  "import https from 'node:https';",
  "/// import axios from 'axios';",
  "import Benchmark from 'benchmark';",
  "import fetch from 'node-fetch';",
  "import request from 'request';",
  "import got from '../source/index.js';",
  "import Request from '../source/core/index.js';",
  "import Options, {type OptionsInit} from '../source/core/options.js';",
  '',
  '// Configuration',
  'const httpsAgent = new https.Agent({',
  '\tkeepAlive: true,',
  '\trejectUnauthorized: false,',
  '});',
  '',
  "const url = new URL('https://127.0.0.1:8081');",
  'const urlString = url.toString();',
  '',
  'const gotOptions: OptionsInit = {',
  '\tagent: {',
  '\t\thttps: httpsAgent,',
  '\t},',
  '\thttps: {',
  '\t\trejectUnauthorized: false,',
  '\t},',
  '\tretry: {',
  '\t\tlimit: 0,',
  '\t},',
  '};',
  '',
  'const normalizedGotOptions = new Options(url, gotOptions);',
  '',
  'const requestOptions = {',
  '\t// eslint-disable-next-line @typescript-eslint/naming-convention',
  '\tstrictSSL: false,',
  '\tagent: httpsAgent,',
  '};',
  '',
].join('\n');

describe('tlsSecurity — got/benchmark/index.ts', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tls-bench-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('the three bypasses under benchmark/ are warnings — reported, not blocking', async () => {
    write(tmp, 'benchmark/index.ts', GOT_BENCHMARK);
    const hits = fired(await run(tmp));
    assert.deepStrictEqual(hits, [
      { name: 'tls-security:js-reject-unauthorized:benchmark/index.ts:13', severity: 'warning', line: 13 },
      { name: 'tls-security:js-reject-unauthorized:benchmark/index.ts:24', severity: 'warning', line: 24 },
      { name: 'tls-security:js-strict-ssl:benchmark/index.ts:35', severity: 'warning', line: 35 },
    ]);
  });

  it('POSITIVE CONTROL — the same file under source/ blocks on all three', async () => {
    write(tmp, 'source/core/agent.ts', GOT_BENCHMARK);
    const hits = fired(await run(tmp));
    assert.strictEqual(hits.length, 3);
    for (const h of hits) assert.strictEqual(h.severity, 'error', `${h.name} must block in shipped code`);
  });

  for (const dir of ['benchmarks', 'bench', 'packages/core/benchmark']) {
    it(`${dir}/ is a harness directory too`, async () => {
      write(tmp, `${dir}/client.ts`, 'const agent = new https.Agent({ rejectUnauthorized: false });\n');
      const hits = fired(await run(tmp));
      assert.strictEqual(hits.length, 1);
      assert.strictEqual(hits[0].severity, 'warning');
    });
  }

  it('NEGATIVE CONTROL — the word inside a file name or an identifier directory is not a harness', async () => {
    write(tmp, 'src/benchmark.ts', 'const agent = new https.Agent({ rejectUnauthorized: false });\n');
    write(tmp, 'src/benchmarking/client.ts', 'const agent = new https.Agent({ rejectUnauthorized: false });\n');
    const hits = fired(await run(tmp));
    assert.strictEqual(hits.length, 2);
    for (const h of hits) assert.strictEqual(h.severity, 'error', `${h.name} is shipped code`);
  });

  it('NEGATIVE CONTROL — examples/ is NOT a harness: tRPC keeps real workspaces there, so a bypass in one still blocks', async () => {
    // Tried on 2026-09-14 and reverted the same day — tests/new-modules.test.js
    // pins that trpcContract reads a router under examples/big/. Sample code
    // is a per-module judgement (claude-compliance makes it), not a path class.
    write(tmp, 'examples/session/index.ts', 'const agent = new https.Agent({ rejectUnauthorized: false });\n');
    const hits = fired(await run(tmp));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].severity, 'error');
  });
});
