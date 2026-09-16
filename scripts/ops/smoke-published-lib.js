'use strict';

/**
 * Pure helpers for scripts/ops/smoke-published.js — no I/O, no network, so
 * tests/smoke-published.test.js can pin every decision with a control pair.
 *
 * The decisions that live here:
 *   - result classification: PASS / FAIL / KNOWN GAP / NOT CHECKED
 *   - "known gap vs failure": a channel that is EXPECTED to be missing until
 *     a given release is on npm is a gap, not a failure — and becomes a
 *     failure the moment that release ships
 *   - what a crash looks like from outside a CLI (exit code, stack trace)
 *   - JSON-RPC framing over stdio (newline-delimited JSON, as MCP speaks it)
 *   - the table the operator reads and the exit code CI acts on
 */

const RESULT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  KNOWN_GAP: 'KNOWN GAP',
  NOT_CHECKED: 'NOT CHECKED',
});

/** The first @gatetest/cli release that ships the `cli` bin (bare `npx @gatetest/cli`) and the ghcr image. */
const BARE_NPX_SINCE = '1.61.1';

/** Parse "1.61.0", "v1.61.0" or "1.61.0-rc.1" into [major, minor, patch]; null when it is not a version. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1 like a comparator; throws on a non-version so a bad `npm view` cannot silently sort as "older". */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`not a version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Is a channel that ships with BARE_NPX_SINCE allowed to be missing right now?
 * True while the published cli is older than that release. An unparseable
 * version is NOT a gap — the caller has to treat it as a failure to read npm.
 */
function gapStillExpected(publishedVersion, since = BARE_NPX_SINCE) {
  if (!parseVersion(publishedVersion)) return false;
  return compareVersions(publishedVersion, since) < 0;
}

/**
 * Classify a channel that may be a known gap.
 *   ok=true                       -> PASS (a gap that already works is a pass, never a gap)
 *   ok=false, gap still expected  -> KNOWN GAP
 *   ok=false, gap no longer expected -> FAIL
 */
function classifyGapChannel({ ok, publishedVersion, since = BARE_NPX_SINCE }) {
  if (ok) return RESULT.PASS;
  return gapStillExpected(publishedVersion, since) ? RESULT.KNOWN_GAP : RESULT.FAIL;
}

/** A stack trace as Node prints one: an "at" frame with a file:line:col. */
const STACK_FRAME_RE = /^\s+at (?:.+ \()?[^\n]*:\d+:\d+\)?\s*$/m;

function hasStackTrace(text) {
  return STACK_FRAME_RE.test(String(text || ''));
}

/**
 * Did a `gatetest --suite …` run crash, as opposed to pass (0) or block (1)?
 * Exit 2 is the CLI's usage error — not a crash, but a stranger's valid
 * command line producing it is still a broken artifact. Anything else, a
 * signal, or a stack trace on stderr is a crash.
 */
function classifyScanRun({ code, signal, stderr }) {
  if (hasStackTrace(stderr)) return { result: RESULT.FAIL, reason: 'stack trace on stderr' };
  if (signal) return { result: RESULT.FAIL, reason: `killed by ${signal}` };
  if (code === 0 || code === 1) return { result: RESULT.PASS, reason: code === 0 ? 'gate passed (exit 0)' : 'gate blocked (exit 1) — findings, not a crash' };
  if (code === 2) return { result: RESULT.FAIL, reason: 'usage error (exit 2) on a valid command line' };
  return { result: RESULT.FAIL, reason: `crash (exit ${code})` };
}

/** One JSON-RPC message, framed the way MCP stdio transports read it: one JSON object per line. */
function frameJsonRpc(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('frameJsonRpc: message must be an object');
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  if (body.includes('\n')) throw new Error('frameJsonRpc: JSON.stringify produced a newline'); // cannot happen; guards the framing invariant
  return `${body}\n`;
}

/** The `initialize` request an MCP client sends first. */
function initializeRequest(id = 1) {
  return {
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'gatetest-smoke-published', version: '1' },
    },
  };
}

/**
 * Split a stdio stream into parsed JSON-RPC messages and the lines that were
 * NOT JSON (a protocol violation — anything but JSON on an MCP server's
 * stdout breaks every client). CRLF-tolerant.
 */
function parseJsonRpcStream(text) {
  const messages = [];
  const nonJson = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      nonJson.push(line); // error-ok — collected and reported, never swallowed
    }
  }
  return { messages, nonJson };
}

/** A valid `initialize` result: a reply to our id carrying result.serverInfo.name and a protocolVersion. */
function isValidInitializeResult(message, id = 1) {
  if (!message || message.id !== id || !message.result || typeof message.result !== 'object') return false;
  const { serverInfo, protocolVersion } = message.result;
  return Boolean(serverInfo && typeof serverInfo.name === 'string' && serverInfo.name && typeof protocolVersion === 'string');
}

const COLUMNS = ['channel', 'version', 'result', 'detail'];

/** Fixed-width text table: `channel | version | result | detail`, one row per channel, header underlined. */
function renderTable(rows) {
  const cells = rows.map((r) => COLUMNS.map((c) => String(r[c] == null || r[c] === '' ? '-' : r[c]).replace(/\s+/g, ' ')));
  const widths = COLUMNS.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i].length)));
  const line = (row) => row.map((v, i) => (i === row.length - 1 ? v : v.padEnd(widths[i]))).join(' | ').trimEnd();
  return [line(COLUMNS), widths.map((w) => '-'.repeat(w)).join('-+-'), ...cells.map(line)].join('\n');
}

/** Counts per result kind. */
function summarize(rows) {
  const s = { pass: 0, fail: 0, knownGap: 0, notChecked: 0 };
  for (const r of rows) {
    if (r.result === RESULT.PASS) s.pass += 1;
    else if (r.result === RESULT.FAIL) s.fail += 1;
    else if (r.result === RESULT.KNOWN_GAP) s.knownGap += 1;
    else s.notChecked += 1;
  }
  return s;
}

/** Exit 1 only when a row FAILED. Gaps and not-checked rows are printed, not exited on. */
function exitCodeFor(rows) {
  return rows.some((r) => r.result === RESULT.FAIL) ? 1 : 0;
}

/** Channels for the failure issue title: "Published artifact is broken: npm-cli, mcp-server". */
function failedChannels(rows) {
  return rows.filter((r) => r.result === RESULT.FAIL).map((r) => r.id);
}

module.exports = {
  RESULT,
  BARE_NPX_SINCE,
  COLUMNS,
  parseVersion,
  compareVersions,
  gapStillExpected,
  classifyGapChannel,
  hasStackTrace,
  classifyScanRun,
  frameJsonRpc,
  initializeRequest,
  parseJsonRpcStream,
  isValidInitializeResult,
  renderTable,
  summarize,
  exitCodeFor,
  failedChannels,
};
