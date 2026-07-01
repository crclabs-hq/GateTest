// =============================================================================
// POST-SCAN-SUMMARY-COMMENT TEST — scripts/post-scan-summary-comment.js
// =============================================================================
// Covers grade computation (must match the website's playground formula),
// top-findings extraction, and comment body rendering. The GitHub-API
// posting flow itself is a thin fetch wrapper already covered by the same
// pattern post-inline-suggestions.test.js exercises elsewhere — not
// duplicated here.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { computeGrade, topFindings, renderBody } = require('../scripts/post-scan-summary-comment');

describe('computeGrade', () => {
  it('returns grade A for a clean scan with all modules passing', () => {
    const report = { summary: { modules: { total: 10, passed: 10 }, checks: { errors: 0, warnings: 0 } } };
    const g = computeGrade(report);
    assert.strictEqual(g.grade, 'A');
    assert.strictEqual(g.score, 100);
  });

  it('applies a 3-point penalty per error, capped at 50', () => {
    const report = { summary: { modules: { total: 10, passed: 10 }, checks: { errors: 20, warnings: 0 } } };
    const g = computeGrade(report);
    // base 100, penalty min(50, 60) = 50 -> score 50
    assert.strictEqual(g.score, 50);
    assert.strictEqual(g.grade, 'D');
  });

  it('returns F with score 0 when total modules is 0 (nothing ran)', () => {
    const report = { summary: { modules: { total: 0, passed: 0 }, checks: { errors: 0, warnings: 0 } } };
    const g = computeGrade(report);
    assert.strictEqual(g.grade, 'F');
    assert.strictEqual(g.score, 0);
  });

  it('grade boundaries match the website playground scale exactly', () => {
    const mk = (score) => {
      // base = passed/total*100, no errors -> score = base. Pick total=100 for exact scores.
      const report = { summary: { modules: { total: 100, passed: score }, checks: { errors: 0, warnings: 0 } } };
      return computeGrade(report).grade;
    };
    assert.strictEqual(mk(90), 'A');
    assert.strictEqual(mk(89), 'B');
    assert.strictEqual(mk(75), 'B');
    assert.strictEqual(mk(74), 'C');
    assert.strictEqual(mk(60), 'C');
    assert.strictEqual(mk(59), 'D');
    assert.strictEqual(mk(40), 'D');
    assert.strictEqual(mk(39), 'F');
  });

  it('handles missing summary/modules/checks gracefully (malformed report)', () => {
    const g = computeGrade({});
    assert.strictEqual(g.grade, 'F');
    assert.strictEqual(g.score, 0);
  });
});

describe('topFindings', () => {
  it('extracts only failed error/warning checks, skipping passed ones', () => {
    const report = {
      results: [
        {
          module: 'secrets',
          checks: [
            { severity: 'error', passed: false, name: 'secrets:hardcoded-key', details: { message: 'API key found' } },
            { severity: 'info', passed: true, name: 'secrets:summary', details: { message: 'ok' } },
            { severity: 'warning', passed: false, name: 'secrets:weak-hash', details: { message: 'MD5 used' } },
          ],
        },
      ],
    };
    const findings = topFindings(report);
    assert.strictEqual(findings.length, 2);
    assert.strictEqual(findings[0].severity, 'error');
    assert.strictEqual(findings[0].message, 'API key found');
    assert.strictEqual(findings[1].severity, 'warning');
  });

  it('respects the limit parameter across multiple modules', () => {
    const report = {
      results: [
        { module: 'a', checks: Array.from({ length: 5 }, (_, i) => ({ severity: 'error', passed: false, name: `a${i}`, details: { message: `msg${i}` } })) },
        { module: 'b', checks: Array.from({ length: 5 }, (_, i) => ({ severity: 'error', passed: false, name: `b${i}`, details: { message: `msg${i}` } })) },
      ],
    };
    const findings = topFindings(report, 3);
    assert.strictEqual(findings.length, 3);
  });

  it('returns an empty array for a clean report', () => {
    const report = { results: [{ module: 'secrets', checks: [{ severity: 'info', passed: true, name: 'ok', details: {} }] }] };
    assert.deepStrictEqual(topFindings(report), []);
  });
});

describe('renderBody', () => {
  it('includes the idempotency marker, grade, and counts', () => {
    const body = renderBody({
      grade: { grade: 'B', score: 78, passed: 8, total: 10, errors: 2, warnings: 1, findings: [] },
      runUrl: 'https://github.com/o/r/actions/runs/123',
    });
    assert.match(body, /<!-- gatetest-scan-summary -->/);
    assert.match(body, /Grade B \(78\/100\)/);
    assert.match(body, /8\/10.*modules passed/);
    assert.match(body, /2.*error/);
    assert.match(body, /https:\/\/github\.com\/o\/r\/actions\/runs\/123/);
  });

  it('omits the findings <details> block when there are no findings', () => {
    const body = renderBody({
      grade: { grade: 'A', score: 100, passed: 10, total: 10, errors: 0, warnings: 0, findings: [] },
      runUrl: 'https://example.com',
    });
    assert.doesNotMatch(body, /<details>/);
  });

  it('lists each finding with severity and module when present', () => {
    const body = renderBody({
      grade: {
        grade: 'C', score: 65, passed: 6, total: 10, errors: 3, warnings: 1,
        findings: [{ module: 'secrets', severity: 'error', message: 'API key found' }],
      },
      runUrl: 'https://example.com',
    });
    assert.match(body, /<details>/);
    assert.match(body, /\*\*\[error\]\*\* `secrets` — API key found/);
  });
});
