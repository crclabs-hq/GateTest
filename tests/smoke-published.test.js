'use strict';
/**
 * scripts/ops/smoke-published.js — the pure parts, each with a control pair.
 *
 * The smoke's job is to say FAIL when a published artifact is broken and
 * KNOWN GAP when it is expected to be missing until a release ships. Those
 * two must never be confused in either direction: a gap reported as a
 * failure trains everyone to ignore the job (readiness-probe, 2026-08-16),
 * and a failure reported as a gap is the 1.61.0 / 1.1.3 night all over
 * again. Nothing here touches the network — tests/heavy/smoke-published.test.js
 * runs the real thing.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const smoke = require('../scripts/ops/smoke-published');
const {
  RESULT, BARE_NPX_SINCE, parseVersion, compareVersions, gapStillExpected, classifyGapChannel,
  hasStackTrace, classifyScanRun, frameJsonRpc, initializeRequest, parseJsonRpcStream,
  isValidInitializeResult, renderTable, summarize, exitCodeFor, failedChannels, parseArgs, CHANNELS,
} = smoke;

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'post-publish-smoke.yml');

describe('versions', () => {
  it('parses plain, v-prefixed and prerelease versions; rejects junk', () => {
    assert.deepEqual(parseVersion('1.61.0'), [1, 61, 0]);
    assert.deepEqual(parseVersion('v1.61.1'), [1, 61, 1]);
    assert.deepEqual(parseVersion('1.62.0-rc.1'), [1, 62, 0]);
    assert.equal(parseVersion(''), null);
    assert.equal(parseVersion('latest'), null);
    assert.equal(parseVersion(undefined), null);
  });

  it('compares numerically, not lexically (1.61.0 < 1.61.1 < 1.100.0)', () => {
    assert.equal(compareVersions('1.61.0', '1.61.1'), -1);
    assert.equal(compareVersions('1.61.1', '1.61.1'), 0);
    assert.equal(compareVersions('1.100.0', '1.61.1'), 1);
    assert.throws(() => compareVersions('nope', '1.0.0'), /not a version/);
  });
});

describe('known gap vs failure', () => {
  it(`BARE_NPX_SINCE is the release the gaps are pinned to (${BARE_NPX_SINCE})`, () => {
    assert.equal(BARE_NPX_SINCE, '1.61.1');
  });

  it('POSITIVE CONTROL — a missing channel while npm serves 1.61.0 is a KNOWN GAP', () => {
    assert.equal(gapStillExpected('1.61.0'), true);
    assert.equal(classifyGapChannel({ ok: false, publishedVersion: '1.61.0' }), RESULT.KNOWN_GAP);
  });

  it('NEGATIVE CONTROL — the same missing channel once 1.61.1 (or later) is on npm is a FAIL', () => {
    assert.equal(gapStillExpected('1.61.1'), false);
    assert.equal(classifyGapChannel({ ok: false, publishedVersion: '1.61.1' }), RESULT.FAIL);
    assert.equal(classifyGapChannel({ ok: false, publishedVersion: '1.62.0' }), RESULT.FAIL);
  });

  it('a channel that already works is a PASS regardless of version — a gap never masks a pass', () => {
    assert.equal(classifyGapChannel({ ok: true, publishedVersion: '1.61.0' }), RESULT.PASS);
    assert.equal(classifyGapChannel({ ok: true, publishedVersion: null }), RESULT.PASS);
  });

  it('an unreadable npm version cannot excuse a missing channel — that is a FAIL, not a gap', () => {
    assert.equal(gapStillExpected(null), false);
    assert.equal(gapStillExpected('ECONNRESET'), false);
    assert.equal(classifyGapChannel({ ok: false, publishedVersion: null }), RESULT.FAIL);
  });
});

describe('what a crash looks like from outside the CLI', () => {
  const TRACE = "node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module './site-url'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)\n    at require (node:internal/modules/helpers:177:18)\n";

  it('recognises a Node stack frame, and not ordinary stderr chatter', () => {
    assert.equal(hasStackTrace(TRACE), true);
    assert.equal(hasStackTrace('    at Object.<anonymous> (C:\\Users\\x\\bin\\gatetest.js:12:3)\n'), true);
    assert.equal(hasStackTrace('[GateTest] telemetry disabled\nwarning: 3 findings at line 12\n'), false);
    assert.equal(hasStackTrace(''), false);
  });

  it('POSITIVE CONTROL — exit 0 and exit 1 with clean stderr are PASS (passed / blocked, both are the product working)', () => {
    assert.equal(classifyScanRun({ code: 0, signal: null, stderr: '' }).result, RESULT.PASS);
    assert.equal(classifyScanRun({ code: 1, signal: null, stderr: 'GATE: BLOCKED 2 error(s)\n' }).result, RESULT.PASS);
  });

  it('NEGATIVE CONTROL — any other exit, a signal, or a stack trace is a FAIL', () => {
    assert.equal(classifyScanRun({ code: 2, signal: null, stderr: '' }).result, RESULT.FAIL);
    assert.match(classifyScanRun({ code: 2, signal: null, stderr: '' }).reason, /usage error/);
    assert.equal(classifyScanRun({ code: 137, signal: null, stderr: '' }).result, RESULT.FAIL);
    assert.equal(classifyScanRun({ code: null, signal: 'SIGKILL', stderr: '' }).result, RESULT.FAIL);
    // The MCP 1.1.3 shape: a stack trace with exit 1 — exit 1 alone would have read as "blocked".
    const traced = classifyScanRun({ code: 1, signal: null, stderr: TRACE });
    assert.equal(traced.result, RESULT.FAIL);
    assert.match(traced.reason, /stack trace/);
    assert.equal(classifyScanRun({ code: 0, signal: null, stderr: TRACE }).result, RESULT.FAIL, 'a trace on a green exit is still a crash');
  });
});

describe('JSON-RPC framing over stdio', () => {
  it('frames one message per line with jsonrpc 2.0, exactly one trailing newline', () => {
    const frame = frameJsonRpc(initializeRequest(1));
    assert.ok(frame.endsWith('\n') && !frame.slice(0, -1).includes('\n'));
    const msg = JSON.parse(frame);
    assert.equal(msg.jsonrpc, '2.0');
    assert.equal(msg.id, 1);
    assert.equal(msg.method, 'initialize');
    assert.equal(msg.params.protocolVersion, '2024-11-05');
    assert.equal(typeof msg.params.clientInfo.name, 'string');
  });

  it('refuses to frame a non-object', () => {
    assert.throws(() => frameJsonRpc('initialize'), /must be an object/);
    assert.throws(() => frameJsonRpc([1]), /must be an object/);
  });

  it('parses a CRLF stream and keeps the non-JSON lines as evidence', () => {
    const out = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\r\nstarting server...\r\n\r\n{"jsonrpc":"2.0","id":2,"result":{}}\n';
    const { messages, nonJson } = parseJsonRpcStream(out);
    assert.deepEqual(messages.map((m) => m.id), [1, 2]);
    assert.deepEqual(nonJson, ['starting server...']);
    assert.deepEqual(parseJsonRpcStream(''), { messages: [], nonJson: [] });
  });

  it('POSITIVE CONTROL — a real initialize result is valid', () => {
    const ok = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'gatetest', version: '1.61.0' } } };
    assert.equal(isValidInitializeResult(ok, 1), true);
  });

  it('NEGATIVE CONTROL — an error reply, the wrong id, or a result without serverInfo is not', () => {
    assert.equal(isValidInitializeResult({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }, 1), false);
    assert.equal(isValidInitializeResult({ jsonrpc: '2.0', id: 2, result: { protocolVersion: 'x', serverInfo: { name: 'gatetest' } } }, 1), false);
    assert.equal(isValidInitializeResult({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 'x' } }, 1), false);
    assert.equal(isValidInitializeResult({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'gatetest' } } }, 1), false, 'no protocolVersion');
    assert.equal(isValidInitializeResult(undefined, 1), false);
  });
});

describe('the table and the exit code', () => {
  const rows = [
    { id: 'npm-cli', channel: 'npm @gatetest/cli', version: '1.61.0', result: RESULT.PASS, detail: '--version printed 1.61.0' },
    { id: 'npm-cli-bare', channel: 'npm @gatetest/cli (bare npx)', version: '1.61.0', result: RESULT.KNOWN_GAP, detail: "no 'cli' bin before 1.61.1" },
    { id: 'mcp-server', channel: 'npm @gatetest/mcp-server', version: '', result: RESULT.FAIL, detail: "exited 1 before replying; Cannot find module './site-url'" },
    { id: 'ghcr-image', channel: 'ghcr.io/crclabs-hq/gatetest:latest', version: null, result: RESULT.NOT_CHECKED, detail: 'multi\nline  detail' },
  ];

  it('renders channel | version | result | detail with a header, one line per row, dashes for empty cells', () => {
    const text = renderTable(rows);
    const lines = text.split('\n');
    assert.equal(lines.length, 2 + rows.length);
    assert.match(lines[0], /^channel\s+\| version \| result\s+\| detail$/);
    assert.match(lines[1], /^-+-\+-{9}\+-+-\+-+$/);
    assert.match(lines[4], /\| -\s+\| FAIL\s+\| exited 1 before replying/);
    assert.match(lines[5], /\| -\s+\| NOT CHECKED \| multi line detail$/, 'newlines inside a cell are collapsed');
    const cols = lines.slice(2).map((l) => l.split(' | ').length);
    assert.deepEqual(cols, rows.map(() => 4));
  });

  it('summarize counts every kind exactly once', () => {
    assert.deepEqual(summarize(rows), { pass: 1, fail: 1, knownGap: 1, notChecked: 1 });
  });

  it('NEGATIVE CONTROL — one FAIL row exits 1 and names the channel', () => {
    assert.equal(exitCodeFor(rows), 1);
    assert.deepEqual(failedChannels(rows), ['mcp-server']);
  });

  it('POSITIVE CONTROL — PASS + KNOWN GAP + NOT CHECKED exits 0 (gaps are printed, never exited on)', () => {
    const clean = rows.filter((r) => r.result !== RESULT.FAIL);
    assert.equal(exitCodeFor(clean), 0);
    assert.deepEqual(failedChannels(clean), []);
    assert.equal(exitCodeFor([]), 0);
  });
});

describe('the script as a module', () => {
  it('requiring it does not run it, and every channel id is unique', () => {
    assert.ok(Array.isArray(CHANNELS) && CHANNELS.length === 5);
    const ids = CHANNELS.flatMap((c) => c.ids);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(CHANNELS.map((c) => c.key), ['npm', 'mcp', 'vscode', 'action', 'ghcr']);
  });

  it('parseArgs: --json, --only with known keys; an unknown channel is an error, not a silent empty run', () => {
    assert.deepEqual(parseArgs(['--json']), { json: true, only: null, keep: false });
    assert.deepEqual(parseArgs(['--only', 'npm,mcp']).only, ['npm', 'mcp']);
    assert.throws(() => parseArgs(['--only', 'docker']), /unknown channel/);
  });
});

describe('.github/workflows/post-publish-smoke.yml', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  const nameOf = (file) => /^name:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(ROOT, '.github', 'workflows', file), 'utf8'))[1].replace(/^["']|["']$/g, '');

  it('chains off the two publish workflows BY THEIR CURRENT NAMES (generated over typed — a rename here breaks the chain silently)', () => {
    const m = /workflow_run:\s*\r?\n\s*workflows:\s*\[([^\]]+)\]/.exec(src);
    assert.ok(m, 'workflow_run.workflows list missing');
    const listed = m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
    assert.deepEqual(listed.sort(), [nameOf('publish.yml'), nameOf('publish-vscode.yml')].sort());
    assert.match(src, /types:\s*\[completed\]/);
  });

  it('runs every 6 hours, on dispatch, on Node 22, and uploads the JSON', () => {
    assert.match(src, /cron:\s*'[^']*\*\/6 \* \* \*'/);
    assert.match(src, /^\s*workflow_dispatch:/m);
    assert.match(src, /node-version:\s*'22'/);
    assert.match(src, /node scripts\/ops\/smoke-published\.js --json/);
    assert.match(src, /upload-artifact@/);
  });

  it('declares the permissions the job needs and no more (ciSecurity: workflow_run needs actions: read; gh needs issues: write)', () => {
    assert.match(src, /^permissions:\s*\r?\n(?:\s+\S.*\r?\n)+/m);
    // A trailing `# why` comment on a permission line is allowed — the value is what matters.
    assert.match(src, /^\s+contents:\s*read\b/m);
    assert.match(src, /^\s+issues:\s*write\b/m);
    assert.match(src, /^\s+actions:\s*read\b/m);
    assert.doesNotMatch(src, /^\s+(?:contents|pull-requests|packages):\s*write\b/m);
    assert.doesNotMatch(src, /secrets\.(?!GITHUB_TOKEN\b)/, 'no secrets beyond GITHUB_TOKEN');
  });

  it('never soft-fails and never interpolates ${{ }} inside a run block', () => {
    assert.doesNotMatch(src, /continue-on-error:\s*true/);
    for (const block of src.split(/\n\s+run:\s*\|/).slice(1)) {
      const body = block.split(/\n\s{6}- /)[0];
      assert.doesNotMatch(body, /\$\{\{/, `\${{ }} inside a run: block:\n${body.slice(0, 200)}`);
    }
  });

  it('opens or updates ONE issue with the agreed title prefix', () => {
    assert.match(src, /Published artifact is broken:/);
    assert.match(src, /gh issue list/);
    assert.match(src, /gh issue (?:edit|comment)/);
    assert.match(src, /gh issue create/);
  });
});
