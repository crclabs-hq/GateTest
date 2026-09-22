/**
 * plain-summary — the recap the CLI prints after a scan.
 *
 * The line that matters is the first-contact one (Fifty, move 23): a full
 * scan of an existing repo with no baseline blocks on backlog the author did
 * not write, and the recap must lead with `gatetest --baseline`. The controls
 * are the runs where that hint would be WRONG — a diff-scoped scan (the
 * findings are the new code) and a repo that already carries a baseline (the
 * findings are new by definition).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { plainSummaryLines, plainSummaryContext, isDiffScoped } = require('../src/core/plain-summary');
const { baselinePath } = require('../src/core/baseline');

const blocked = (n, extra = {}) => ({ gateStatus: 'FAILED', checks: { blockingErrors: n, softErrors: 0, warnings: 0, baselined: 0 }, ...extra });
const text = (summary, ctx) => plainSummaryLines(summary, ctx, { color: false }).join('\n');

test('full scan, no baseline, blocked: the recap leads with gatetest --baseline', () => {
  const out = text(blocked(137), { hasBaseline: false, diffScoped: false });
  const lines = out.split('\n');
  const whatNow = lines.findIndex((l) => l.includes('What now?'));
  assert.ok(whatNow >= 0, out);
  assert.match(lines[whatNow + 1], /gatetest --baseline/, 'the baseline is the first option, not the third');
  assert.match(out, /Grandfather these 137 as today's debt/);
  assert.match(text(blocked(1), { hasBaseline: false, diffScoped: false }), /Grandfather it as today's debt/);
  assert.match(out, /commit \.gatetest\/baseline\.json/);
  assert.match(out, /gatetest fix --apply/, 'the other options stay');
});

test('control: a diff-scoped run never suggests baselining — those findings are the new code', () => {
  const out = text(blocked(2), { hasBaseline: false, diffScoped: true });
  assert.doesNotMatch(out, /--baseline/);
  assert.match(out, /gatetest fix --apply/);
});

test('control: a repo that already has a baseline is not told to create one', () => {
  const out = text(blocked(2), { hasBaseline: true, diffScoped: false });
  assert.doesNotMatch(out, /gatetest --baseline\s+—/);
});

test('a passed run says so, and says NEW when something was grandfathered', () => {
  const clean = text({ gateStatus: 'PASSED', checks: { blockingErrors: 0, softErrors: 0, warnings: 0, baselined: 0 } }, {});
  assert.match(clean, /You're good\. Nothing is blocking/);
  assert.doesNotMatch(clean, /baseline/);

  const grandfathered = text({ gateStatus: 'PASSED', checks: { blockingErrors: 0, softErrors: 1, warnings: 2, baselined: 6 } }, {});
  assert.match(grandfathered, /6 pre-existing finding\(s\) baselined — not blocking/);
  assert.match(grandfathered, /Nothing NEW is blocking/);
  assert.match(grandfathered, /3 low-priority note\(s\)/);
});

// Issue #657: the ignore-suppression count (`.gatetest.json` `ignore` +
// `.gatetestignore`, combined) needs its own visible line, same shape as
// the baseline transparency line above it, so a customer can see the
// suppression actually took.
test('ignore-suppressed findings get their own visible line, combined across both sources', () => {
  const clean = text({ gateStatus: 'PASSED', checks: { blockingErrors: 0, softErrors: 0, warnings: 0, baselined: 0 } }, {});
  assert.doesNotMatch(clean, /suppressed by ignore/);

  const suppressed = text({ gateStatus: 'PASSED', checks: { blockingErrors: 0, softErrors: 0, warnings: 0, baselined: 0, ignoreSuppressed: 754 } }, {});
  assert.match(suppressed, /754 findings suppressed by ignore \(config \+ \.gatetestignore\)/);
});

test('singular and plural are both right', () => {
  assert.match(text(blocked(1), { diffScoped: true }), /1 issue is blocking/);
  assert.match(text(blocked(2), { diffScoped: true }), /2 issues are blocking/);
});

test('color on by default, off on request — same words either way', () => {
  const on = plainSummaryLines(blocked(1), {}).join('\n');
  const off = text(blocked(1), {});
  assert.match(on, /\x1b\[/);
  assert.doesNotMatch(off, /\x1b\[/);
  assert.equal(on.replace(/\x1b\[[0-9;]*m/g, ''), off);
});

test('isDiffScoped reads the summary the runner actually emits', () => {
  assert.equal(isDiffScoped({ diffOnly: true, incremental: null }), true, '--diff');
  assert.equal(isDiffScoped({ diffOnly: false, incremental: { fileCount: 3 } }), true, '--pr / --since');
  assert.equal(isDiffScoped({ diffOnly: false, incremental: null }), false, 'full scan');
  assert.equal(isDiffScoped({}), false, 'a summary with neither field is a full scan, not a crash');
});

test('plainSummaryContext looks for the baseline where the engine writes it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-plain-'));
  try {
    assert.deepEqual(plainSummaryContext({ diffOnly: false, incremental: null }, root), { hasBaseline: false, diffScoped: false });
    fs.mkdirSync(path.dirname(baselinePath(root)), { recursive: true });
    fs.writeFileSync(baselinePath(root), '{}');
    assert.deepEqual(plainSummaryContext({ diffOnly: true, incremental: null }, root), { hasBaseline: true, diffScoped: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bin/gatetest.js prints the shared recap rather than its own copy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'gatetest.js'), 'utf-8');
  assert.match(src, /require\('\.\.\/src\/core\/plain-summary'\)/);
  assert.doesNotMatch(src, /What now\?/, 'the copy has one home');
});
