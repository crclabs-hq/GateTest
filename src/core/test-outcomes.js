'use strict';
/**
 * Per-test outcomes from a node:test run — the one reader of "which tests
 * passed and which failed" that the flaky-test ledger (src/core/flaky-ledger.js)
 * stands on.
 *
 * Reads the two reporters `node --test` prints: TAP (`--test-reporter=tap`,
 * what GateTest's own detected command asks for) and spec (what Node 24 prints
 * to a pipe by default, i.e. what a customer's `npm test` gives us). Other
 * runners (jest, mocha, pytest, go, cargo) are NOT read: a name scraped from a
 * `✕ name` line is not an identity worth building a verdict on, and a ledger
 * that mis-keys tests would quarantine the wrong thing. Those runs report
 * `format: null` and the caller says "not measured" (Doctrine 1/6).
 *
 * The result is only trusted for a decision when `complete` is true:
 *   - the runner printed its own summary (`# fail N` / `ℹ fail N`),
 *   - nothing was cancelled,
 *   - every failure the summary counts was parsed as a failure line, and
 *   - every failing container (a `describe`, or a test with subtests) has at
 *     least one failing descendant — a container that failed on its own (a
 *     `before` hook, an assertion after its subtests) is a failure this file
 *     cannot attribute to a leaf test.
 * An incomplete parse may still be RECORDED (the passes and failures it did
 * read are true), but it never downgrades a failure to a warning.
 */

const TAP_SUBTEST_RE = /^(\s*)# Subtest: (.*)$/;
const TAP_RESULT_RE = /^(\s*)(not ok|ok) \d+(?: - (.*?))?(?:\s+# (SKIP|TODO)\b.*)?\s*$/;
const TAP_FAIL_TYPE_RE = /^\s*failureType:\s*'([^']*)'/;
const TAP_TYPE_RE = /^\s*type:\s*'([^']*)'/;
const TAP_LOCATION_RE = /^\s*location:\s*'([^']*)'/;
const TAP_SUMMARY_FAIL_RE = /^# fail (\d+)\s*$/;
const TAP_SUMMARY_CANCELLED_RE = /^# cancelled (\d+)\s*$/;
const TAP_SUMMARY_TESTS_RE = /^# tests (\d+)\s*$/;

const SPEC_HEADER_RE = /^(\s*)▶ (.*)$/;
const SPEC_RESULT_RE = /^(\s*)([✔✓✖✗×﹣]) (.*?) \((\d+(?:\.\d+)?)(?:ms|s)\)(\s+# (?:SKIP|TODO).*)?\s*$/;
const SPEC_SUMMARY_TESTS_RE = /^ℹ tests (\d+)\s*$/;
const SPEC_SUMMARY_FAIL_RE = /^ℹ fail (\d+)\s*$/;
const SPEC_SUMMARY_CANCELLED_RE = /^ℹ cancelled (\d+)\s*$/;

/** `not ok` failure types that are a TEST failing, as opposed to the harness. */
const TEST_FAILURE_TYPES = new Set(['testCodeFailure', 'testTimeoutFailure']);

function _indentOf(s) { return s.length; }

/**
 * @param {string} out raw stdout+stderr of the run
 * @returns {{
 *   format: 'tap'|'spec'|null,
 *   outcomes: Array<{ path: string[], name: string, ok: boolean, container: boolean,
 *                     testFailure: boolean, file: string|null, line: number|null }>,
 *   summary: { tests: number|null, fail: number|null, cancelled: number|null },
 *   complete: boolean,
 *   incompleteReason: string|null,
 * }}
 */
function parseTestOutcomes(out) {
  const text = String(out || '').replace(/\x1b\[[0-9;]*m/g, '');
  const lines = text.split(/\r?\n/);
  if (lines.some((l) => /^TAP version \d+/.test(l))) return _parseTap(lines);
  if (lines.some((l) => SPEC_RESULT_RE.test(l)) && lines.some((l) => SPEC_SUMMARY_TESTS_RE.test(l))) {
    return _parseSpec(lines);
  }
  return { format: null, outcomes: [], summary: { tests: null, fail: null, cancelled: null }, complete: false, incompleteReason: 'runner output is not node:test TAP or spec' };
}

function _finish(format, outcomes, summary, suiteFailCount) {
  // Container bookkeeping: a failing container needs a failing descendant.
  let complete = true;
  let reason = null;
  if (summary.fail === null) { complete = false; reason = 'the runner printed no summary'; }
  else if (summary.cancelled) { complete = false; reason = `${summary.cancelled} test(s) were cancelled`; }
  if (complete) {
    const failing = outcomes.filter((o) => !o.ok);
    const accountedFor = failing.length - suiteFailCount;
    // TAP names a `describe` suite (`type: 'suite'`), which the runner's own
    // `# fail` does not count — exact equality. Spec cannot tell a suite from
    // a test with subtests, so it can only require that nothing counted by
    // the summary went unparsed.
    const enough = format === 'tap' ? accountedFor === summary.fail : failing.length >= summary.fail;
    if (!enough) { complete = false; reason = `the summary counts ${summary.fail} failure(s) but ${accountedFor} were read`; }
  }
  if (complete) {
    for (const c of outcomes) {
      if (c.ok || !c.container) continue;
      const hasFailingLeaf = outcomes.some((o) => !o.ok && !o.container && o.path.length > c.path.length
        && c.path.every((seg, i) => o.path[i] === seg));
      if (!hasFailingLeaf) { complete = false; reason = `"${c.name}" failed on its own, not through a failing test inside it`; break; }
    }
  }
  return { format, outcomes, summary, complete, incompleteReason: reason };
}

function _parseTap(lines) {
  const outcomes = [];
  const summary = { tests: null, fail: null, cancelled: null };
  let suiteFailCount = 0;
  const stack = []; // open `# Subtest:` headers: { indent, name, hasChildren }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = TAP_SUMMARY_TESTS_RE.exec(line);
    if (m) { summary.tests = parseInt(m[1], 10); continue; }
    m = TAP_SUMMARY_FAIL_RE.exec(line);
    if (m) { summary.fail = parseInt(m[1], 10); continue; }
    m = TAP_SUMMARY_CANCELLED_RE.exec(line);
    if (m) { summary.cancelled = parseInt(m[1], 10); continue; }

    m = TAP_SUBTEST_RE.exec(line);
    if (m) {
      const indent = _indentOf(m[1]);
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      stack.push({ indent, name: m[2], hasChildren: false });
      continue;
    }

    m = TAP_RESULT_RE.exec(line);
    if (!m) continue;
    const indent = _indentOf(m[1]);
    const ok = m[2] === 'ok';
    const name = (m[3] || '').trim();
    if (m[4]) { // SKIP / TODO — neither a pass nor a fail
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      continue;
    }
    // The YAML block that follows carries type / failureType / location.
    let type = null; let failureType = null; let location = null;
    for (let j = i + 1; j < lines.length && j < i + 40; j++) {
      const l = lines[j];
      if (TAP_RESULT_RE.test(l) || TAP_SUBTEST_RE.test(l)) break;
      let mm;
      if ((mm = TAP_TYPE_RE.exec(l)) && type === null) type = mm[1];
      else if ((mm = TAP_FAIL_TYPE_RE.exec(l)) && failureType === null) failureType = mm[1];
      else if ((mm = TAP_LOCATION_RE.exec(l)) && location === null) location = mm[1];
      if (/^\s*\.\.\.\s*$/.test(l)) break;
    }
    const ancestors = stack.filter((s) => s.indent < indent);
    const own = stack.find((s) => s.indent === indent);
    const container = failureType === 'subtestsFailed' || Boolean(own && own.hasChildren);
    for (const a of ancestors) a.hasChildren = true;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

    if (!ok && type === 'suite') suiteFailCount++;
    let file = null; let lineNo = null;
    if (location) {
      const parts = /^(.*):(\d+):(\d+)$/.exec(location);
      if (parts) { file = parts[1]; lineNo = parseInt(parts[2], 10); } else file = location;
    }
    outcomes.push({
      path: [...ancestors.map((a) => a.name), name],
      name,
      ok,
      container,
      // Only an assertion or a timeout in a test body is a test failure. A
      // hook failure, an uncaught exception, a cancelled child are the
      // harness — never quarantined.
      testFailure: ok ? false : (failureType === null || TEST_FAILURE_TYPES.has(failureType)),
      file,
      line: lineNo,
    });
  }
  return _finish('tap', outcomes, summary, suiteFailCount);
}

function _parseSpec(lines) {
  const outcomes = [];
  const summary = { tests: null, fail: null, cancelled: null };
  const stack = []; // open `▶` containers: { indent, name, hasChildren }
  for (const line of lines) {
    // The failure recap after the summary repeats every ✖ line — stop first.
    let m = SPEC_SUMMARY_TESTS_RE.exec(line);
    if (m) { summary.tests = parseInt(m[1], 10); continue; }
    m = SPEC_SUMMARY_FAIL_RE.exec(line);
    if (m) { summary.fail = parseInt(m[1], 10); continue; }
    m = SPEC_SUMMARY_CANCELLED_RE.exec(line);
    if (m) { summary.cancelled = parseInt(m[1], 10); continue; }
    if (summary.tests !== null) continue;

    m = SPEC_HEADER_RE.exec(line);
    if (m) {
      const indent = _indentOf(m[1]);
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      stack.push({ indent, name: m[2].replace(/\s+\(\d+(?:\.\d+)?(?:ms|s)\)$/, ''), hasChildren: false });
      continue;
    }
    m = SPEC_RESULT_RE.exec(line);
    if (!m) continue;
    const indent = _indentOf(m[1]);
    const symbol = m[2];
    const name = m[3].trim();
    if (symbol === '﹣' || m[5]) { // skipped / todo
      continue;
    }
    const ok = symbol === '✔' || symbol === '✓';
    const own = stack.find((s) => s.indent === indent && s.name === name);
    const ancestors = stack.filter((s) => s.indent < indent);
    for (const a of ancestors) a.hasChildren = true;
    const container = Boolean(own && own.hasChildren);
    // Drop this container (and anything deeper) once its own result is read.
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    outcomes.push({
      path: [...ancestors.map((a) => a.name), name],
      name,
      ok,
      container,
      testFailure: !ok,
      file: null,
      line: null,
    });
  }
  return _finish('spec', outcomes, summary, 0);
}

module.exports = { parseTestOutcomes, TEST_FAILURE_TYPES };
