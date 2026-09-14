// =============================================================================
// SCORE BADGE — the public grade was computed from inverted inputs
// =============================================================================
// /api/score renders the badge customers paste into their README. It read
// `fixes_log` — a log of auto-fix PRs, not scans — and every input was
// inverted against the name it was given:
//
//   errors_fixed AS errors          -> score -= errors * 5
//        The more errors GateTest FIXED for a customer, the WORSE their
//        public grade became.
//   array_length(modules_fired,1) AS modules_passed -> score += passRate * 10
//        `modules_fired` is the modules that FOUND something (capped at 20 on
//        write), presented as modules that PASSED — so the more of our modules
//        reported problems, the HIGHER the grade.
//   totalModules: 90                hardcoded
//        A hand-typed denominator driving a customer-facing letter grade, in a
//        repo whose rule is "never hand-write a module count". It escaped
//        tests/module-count-sync.test.js because that test matches three-digit
//        claims and 90 has two digits.
//
// Now sourced from `scan_history`, which records real scans with a real
// per-run module count.
//
// These tests assert the DIRECTION of each term. A grade is only meaningful if
// worse code scores lower, and that is precisely what was broken — the old
// code would have passed any test that merely checked the score was a number
// between 0 and 100.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROUTE = path.join(__dirname, '..', 'website', 'app', 'api', 'score', 'route.ts');
const src = fs.readFileSync(ROUTE, 'utf8');

/**
 * The scoring function is TypeScript inside a Next route, so it is evaluated
 * here by extracting it rather than imported. Reimplementing it in the test
 * would prove nothing — it would test the copy.
 */
function loadComputeScore() {
  // Route-private (a Next route file exports only handlers + segment config);
  // the function itself is what is evaluated, not its export status.
  const start = src.indexOf('function computeScore');
  assert.ok(start !== -1, 'computeScore not found — was it renamed?');

  // Strip the TypeScript parameter annotation FIRST. Balancing braces before
  // this counts the `{` that opens the parameter's object TYPE, so the scan
  // ends at the type's closing brace and yields only a signature fragment.
  const stripped = src
    .slice(start)
    .replace(/\(scan:\s*\{[\s\S]*?\}\s*\)\s*:\s*number/, '(scan)');

  const open = stripped.indexOf('{');
  let depth = 0;
  let end = -1;
  for (let i = open; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end !== -1, 'could not find the end of computeScore');
  const body = stripped.slice(0, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return computeScore;`)();
}

const computeScore = loadComputeScore();
const now = new Date().toISOString();
const base = { issues: 0, modulesPassed: 0, totalModules: 100, tier: 'full', scannedAt: now };

describe('score — direction of each term', () => {
  it('more issues scores LOWER', () => {
    const clean = computeScore({ ...base, issues: 0 });
    const dirty = computeScore({ ...base, issues: 5 });
    assert.ok(dirty < clean, `expected 5 issues to score below 0 issues, got ${dirty} vs ${clean}`);
  });

  it('more modules PASSING scores HIGHER', () => {
    // `issues: 4` creates headroom: with 0 issues the score saturates at the
    // 100 cap and both cases tie, which would hide the term entirely.
    const few = computeScore({ ...base, issues: 4, modulesPassed: 10 });
    const many = computeScore({ ...base, issues: 4, modulesPassed: 90 });
    assert.ok(many > few, `expected 90 passing to beat 10 passing, got ${many} vs ${few}`);
  });

  it('a stale scan scores lower than a fresh one', () => {
    const old = new Date(Date.now() - 60 * 86400000).toISOString();
    assert.ok(computeScore({ ...base, scannedAt: old }) < computeScore(base));
  });

  it('stays within 0..100', () => {
    assert.strictEqual(computeScore({ ...base, issues: 1000 }) >= 0, true);
    assert.strictEqual(computeScore({ ...base, modulesPassed: 100, tier: 'nuclear' }) <= 100, true);
  });
});

describe('score — no invented denominator', () => {
  it('uses the run\'s own totalModules, never a literal', () => {
    // Same passing count, different denominators, must differ.
    const of100 = computeScore({ ...base, issues: 4, modulesPassed: 50, totalModules: 100 });
    const of50 = computeScore({ ...base, issues: 4, modulesPassed: 50, totalModules: 50 });
    assert.ok(of50 > of100, 'passRate must use the run\'s real module count');
  });

  it('does not award a pass bonus when the module count is unknown', () => {
    const unknown = computeScore({ ...base, issues: 4, modulesPassed: 0, totalModules: 0 });
    assert.strictEqual(unknown, computeScore({ ...base, issues: 4, totalModules: 0 }));
  });

  it('the hardcoded 90 denominator is gone', () => {
    // Comment lines are exempt: the doc comment above getLatestScan quotes the
    // old `totalModules: 90` deliberately, as the record of what was wrong.
    // A literal in CODE is the thing that must not come back.
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    assert.ok(
      !/totalModules:\s*90\b/.test(code),
      'a hardcoded module count is back in the score route',
    );
  });
});

describe('score — reads scans, not the fix log', () => {
  it('queries scan_history', () => {
    assert.match(src, /FROM scan_history/);
  });

  it('does not read fixes_log', () => {
    // Comments explaining the old bug are fine; a query is not.
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    assert.ok(
      !/FROM\s+fixes_log/.test(code),
      'the score badge is reading the auto-fix log again',
    );
    assert.ok(
      !/errors_fixed|modules_fired/.test(code),
      'fix-log columns are back in the score route',
    );
  });
});
