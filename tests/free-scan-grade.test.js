// =============================================================================
// THE FREE SCAN'S GRADE IS THE GATE'S RULE — blocking findings set it.
// =============================================================================
// Measured 2026-09-22 on gatetest.io: a free scan of expressjs/express showed
// "Grade F, 0/100 HEALTH SCORE, 71 issues found" where every one of the 71 was
// a WARNING (legacy `var`, console.log in examples/*.js). The same repository
// sits at 0 blocking findings in the homepage precision table, and the gate
// would have passed it. Two surfaces, two answers.
//
// The control pair this file exists for (Doctrine #3):
//   positive — 1 blocking finding grades BELOW the non-failing band
//   negative — 71 warnings and no blocking findings stay INSIDE it
//
// It also pins the result header fields a reader needs to reproduce a scan
// (Doctrine #6: say what was not checked) and the one-definition rule — the
// two free-scan routes must import the grade, not re-derive it.
// =============================================================================
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GRADE = require('../website/app/lib/scan-grade.js');
const { scoreToGrade } = require('../website/app/lib/health-score.js');

const FREE_SCAN_ROUTES = [
  'website/app/api/playground/scan/route.ts',
  'website/app/api/playground/scan/stream/route.ts',
];

const {
  computeScanGrade,
  countFindingsBySeverity,
  severityForModule,
  describeScanScope,
  formatResultHeader,
  computeCoverage,
  coverageQualifier,
  NON_FAILING_SCORE,
  WARNING_PENALTY_CAP,
} = GRADE;

/** The express shape: syntax + secrets clean, lint + codeQuality warning-only. */
function expressLikeModules() {
  return [
    { name: 'syntax', status: 'passed', checks: 50, issues: 0, duration: 10 },
    { name: 'secrets', status: 'passed', checks: 50, issues: 0, duration: 10 },
    { name: 'lint', status: 'failed', checks: 50, issues: 40, duration: 10 },
    { name: 'codeQuality', status: 'failed', checks: 50, issues: 31, duration: 10 },
  ];
}

describe('free-scan grade — blocking findings set the grade', () => {
  it('control pair: 0 blocking + 71 warnings stays in the non-failing band; 1 blocking drops below it', () => {
    const warningsOnly = computeScanGrade(expressLikeModules());
    assert.strictEqual(warningsOnly.blocking, 0, 'express-like modules have no blocking findings');
    assert.strictEqual(warningsOnly.warnings, 71, 'all 71 findings are warnings');
    assert.ok(
      warningsOnly.score >= NON_FAILING_SCORE,
      `71 warnings must not fail: got ${warningsOnly.score}/100 (${warningsOnly.grade})`
    );
    assert.ok(
      ['A', 'B'].includes(warningsOnly.grade),
      `expected B or better with no blocking findings, got ${warningsOnly.grade}`
    );

    // The positive control: one error-severity module firing once.
    const oneBlocking = computeScanGrade([
      { name: 'secrets', status: 'failed', checks: 50, issues: 1, duration: 10 },
      { name: 'syntax', status: 'passed', checks: 50, issues: 0, duration: 10 },
      { name: 'lint', status: 'passed', checks: 50, issues: 0, duration: 10 },
      { name: 'codeQuality', status: 'passed', checks: 50, issues: 0, duration: 10 },
    ]);
    assert.strictEqual(oneBlocking.blocking, 1);
    assert.ok(
      oneBlocking.score < NON_FAILING_SCORE,
      `1 blocking finding must fail: got ${oneBlocking.score}/100 (${oneBlocking.grade})`
    );
    assert.ok(
      warningsOnly.score > oneBlocking.score,
      'a warning-only result must never grade worse than a blocking one'
    );
  });

  it('warnings alone can never reach the failing band, at any count', () => {
    for (const count of [1, 10, 71, 500, 100000]) {
      const v = computeScanGrade([
        { name: 'lint', status: 'failed', checks: 1, issues: count, duration: 1 },
        { name: 'syntax', status: 'passed', checks: 1, issues: 0, duration: 1 },
      ]);
      assert.strictEqual(v.blocking, 0, `${count} warnings produced a blocking count`);
      assert.ok(
        v.score >= 100 - WARNING_PENALTY_CAP,
        `${count} warnings cost more than the cap: ${v.score}/100`
      );
      assert.ok(v.score >= NON_FAILING_SCORE, `${count} warnings fell out of the non-failing band`);
    }
  });

  it('both numbers are always in the label a reader sees', () => {
    assert.strictEqual(computeScanGrade(expressLikeModules()).countLabel, '0 blocking · 71 warnings');
    assert.strictEqual(
      computeScanGrade([{ name: 'secrets', status: 'failed', checks: 1, issues: 1, duration: 1 }]).countLabel,
      '1 blocking · 0 warnings'
    );
  });

  it('severity comes from one map: secrets/syntax block, lint/codeQuality warn', () => {
    assert.strictEqual(severityForModule('secrets'), 'error');
    assert.strictEqual(severityForModule('syntax'), 'error');
    assert.strictEqual(severityForModule('lint'), 'warning');
    assert.strictEqual(severityForModule('codeQuality'), 'warning');
    // An unclassified module is a warning, never a surprise blocker.
    assert.strictEqual(severityForModule('somethingNew'), 'warning');
    assert.strictEqual(severityForModule('constructor'), 'warning');
  });

  it('skipped modules contribute nothing, and a scan with no module result is "not checked"', () => {
    const skipped = computeScanGrade([
      { name: 'lint', status: 'skipped', checks: 0, issues: 0, duration: 0 },
    ]);
    assert.strictEqual(skipped.notChecked, true, 'an all-skipped scan is the third state');
    assert.strictEqual(skipped.score, null, 'not-checked has no score');
    assert.notStrictEqual(skipped.grade, 'F', 'not checked must never print as F');
    assert.strictEqual(computeScanGrade([]).notChecked, true);
  });

  it('the letter scale is health-score.js, not a second copy', () => {
    for (const warnings of [0, 3, 71, 900]) {
      for (const blocking of [0, 1, 4, 20]) {
        const v = computeScanGrade([
          { name: 'lint', status: warnings ? 'failed' : 'passed', checks: 1, issues: warnings, duration: 1 },
          { name: 'secrets', status: blocking ? 'failed' : 'passed', checks: 1, issues: blocking, duration: 1 },
        ]);
        assert.strictEqual(
          v.grade,
          scoreToGrade(v.score),
          `grade for ${blocking} blocking / ${warnings} warnings did not come from scoreToGrade`
        );
      }
    }
  });

  it('counts sum to the total findings reported', () => {
    const counts = countFindingsBySeverity(expressLikeModules());
    assert.strictEqual(counts.total, 71);
    assert.strictEqual(counts.blocking + counts.warnings + counts.info, counts.total);
  });
});

describe('free-scan result header — a reader can reproduce the run', () => {
  it('names the repo, the 7-char sha, the scan time and the report id', () => {
    const header = formatResultHeader({
      repoSlug: 'expressjs/express',
      commitSha: '4f1e2ab9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3',
      branch: 'master',
      scannedAt: '2026-09-22T09:14:03.000Z',
      scanId: 'scn_0123456789abcdef01',
    });
    assert.match(header, /^expressjs\/express @ 4f1e2ab \(master\)/);
    assert.ok(header.includes('scanned 2026-09-22T09:14:03.000Z'), header);
    assert.ok(header.includes('report scn_0123456789abcdef01'), header);
    assert.ok(!header.includes('4f1e2ab9c8'), 'the sha is abbreviated to 7 chars');
  });

  it('says the sha was not resolved rather than inventing one', () => {
    const header = formatResultHeader({ repoSlug: 'owner/repo', commitSha: null, scannedAt: null, scanId: null });
    assert.ok(header.includes('commit not resolved'), header);
    assert.ok(header.includes('scan time not recorded'), header);
    assert.ok(header.includes('report id not issued'), header);
  });

  it('rejects a sha-shaped value that is not a sha', () => {
    const header = formatResultHeader({ repoSlug: 'owner/repo', commitSha: 'HEAD', scanId: 'scn_x' });
    assert.ok(header.includes('commit not resolved'), header);
  });
});

describe('free-scan scope label — the numbers say what actually ran', () => {
  it('names the file count, the read mechanism and both timings', () => {
    const label = describeScanScope({
      filesAnalysed: 50,
      filesInRepo: 1247,
      source: 'archive-anonymous',
      engineMs: 100,
      fetchMs: 1400,
    });
    assert.ok(label.includes('scanned 50 of 1,247 files'), label);
    assert.ok(label.includes('no clone'), label);
    assert.ok(label.includes('1.4s fetch'), label);
    assert.ok(label.includes('0.1s engine time'), label);
  });

  it('never lets a read read as a clone, for any source', () => {
    for (const source of ['archive', 'archive-anonymous', 'api', 'gitlab-archive', 'something-new']) {
      const label = describeScanScope({ filesAnalysed: 1, filesInRepo: 2, source, engineMs: 1, fetchMs: 1 });
      assert.ok(label.includes('(no clone)'), `${source}: ${label}`);
      // "(no clone)" is the only place the word may appear.
      assert.strictEqual(
        label.split('clone').length - 1,
        1,
        `${source} mentions a clone more than once: ${label}`
      );
    }
  });

  it('says when the file cap truncated the read', () => {
    const label = describeScanScope({ filesAnalysed: 50, filesInRepo: 4000, source: 'api', truncated: true });
    assert.ok(label.includes('file cap reached'), label);
  });
});

describe('one definition, imported (Doctrine #4)', () => {
  const ROUTES = [
    'website/app/api/playground/scan/route.ts',
    'website/app/api/playground/scan/stream/route.ts',
  ];

  it('neither free-scan route carries its own grade maths', () => {
    for (const rel of ROUTES) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(
        /scan-grade/.test(src),
        `${rel} must import the shared grade`
      );
      assert.ok(
        !/function computeHealthScore/.test(src),
        `${rel} still defines its own score function`
      );
      assert.ok(
        !/grade = "B"|grade = 'B'/.test(src),
        `${rel} still carries an inline letter scale`
      );
    }
  });

  it('neither free-scan route carries its own severity map', () => {
    for (const rel of ROUTES) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(
        !/const MODULE_SEVERITY\b/.test(src),
        `${rel} still defines a second severity map`
      );
    }
  });

  it('the free-scan result carries the reproducibility fields', () => {
    const src = fs.readFileSync(path.join(ROOT, 'website/app/api/playground/scan/stream/route.ts'), 'utf8');
    for (const field of ['scanId', 'scannedAt', 'commitSha', 'branch', 'resultHeader', 'scopeLabel', 'blockingCount', 'warningCount']) {
      assert.ok(new RegExp(`\\b${field}\\b`).test(src), `stream route does not emit ${field}`);
    }
  });

  it('both free-scan routes pass the sha resolver\'s reason through to the result header', () => {
    for (const rel of ROUTES) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(/shaReason/.test(src), `${rel} does not pass shaReason to formatResultHeader`);
    }
  });
});

// =============================================================================
// N1/F2 — a sha that did not resolve says WHY, not just "not resolved"
// =============================================================================
// Tallrig re-walk 2026-09-22: three consecutive scans of a public repo all
// showed a bare "commit not resolved" — resolveBaseBranchSha (gluecron-client)
// swallowed every failure (rate-limited, 404, no token, timeout) into the same
// null with no reason attached, so there was nothing honest left to print.
// =============================================================================
describe('free-scan result header — the sha resolver\'s reason is never dropped (N1/F2)', () => {
  it('control pair: a resolved sha shows it; a resolver reason shows instead of a bare null', () => {
    const resolved = formatResultHeader({
      repoSlug: 'expressjs/express',
      commitSha: '4f1e2ab9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3',
      branch: 'main',
      scannedAt: '2026-09-22T09:00:00.000Z',
      scanId: 'scn_a',
    });
    assert.ok(resolved.includes('@ 4f1e2ab'), resolved);
    assert.ok(!resolved.includes('not resolved'), resolved);

    const rateLimited = formatResultHeader({
      repoSlug: 'expressjs/express',
      commitSha: null,
      shaReason: 'GitHub rate-limited or forbade the request (403)',
      branch: null,
      scannedAt: '2026-09-22T09:00:00.000Z',
      scanId: 'scn_b',
    });
    assert.ok(rateLimited.includes('commit not resolved'), rateLimited);
    assert.ok(
      rateLimited.includes('GitHub rate-limited or forbade the request (403)'),
      `expected the 403 reason in the header, got: ${rateLimited}`
    );
  });

  it('still says "commit not resolved" with no reason (back-compat with links minted before this fix)', () => {
    const header = formatResultHeader({ repoSlug: 'owner/repo', commitSha: null, scannedAt: null, scanId: null });
    assert.ok(header.includes('commit not resolved'), header);
    assert.ok(!header.includes('undefined') && !header.includes('null'), header);
  });
});

// =============================================================================
// N2 — the coverage fraction is ONE definition, and a partial read says so
// everywhere the result is read (Doctrine #1/#4/#6)
// =============================================================================
describe('coverage fraction — one definition, and the qualifier only appears when partial (N2)', () => {
  it('control pair: full coverage carries no qualifier; partial coverage always does', () => {
    const full = computeCoverage(214, 214);
    assert.strictEqual(full.partial, false);
    assert.strictEqual(coverageQualifier(full), '');

    const partial = computeCoverage(50, 214);
    assert.strictEqual(partial.partial, true);
    assert.strictEqual(coverageQualifier(partial), ' on 50 of 214 files');

    const summaryWithQualifier = 'Grade B — no blocking findings.' + coverageQualifier(partial);
    assert.ok(summaryWithQualifier.includes('on 50 of 214 files'), summaryWithQualifier);
    const summaryWithoutQualifier = 'Grade A — no findings from the modules that ran.' + coverageQualifier(full);
    assert.ok(!summaryWithoutQualifier.includes(' on '), summaryWithoutQualifier);
  });

  it('an unknown total is never called partial — that would be a guess', () => {
    const unknown = computeCoverage(50, 0);
    assert.strictEqual(unknown.partial, false, 'a zero/unknown total must not be read as 100% coverage');
    assert.strictEqual(coverageQualifier(unknown), '');
  });

  it('both free-scan routes call the shared computeCoverage/coverageQualifier and surface {scanned, total, partial}', () => {
    for (const rel of FREE_SCAN_ROUTES) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(/computeCoverage/.test(src), `${rel} does not call the shared computeCoverage`);
      assert.ok(/coverageQualifier/.test(src), `${rel} does not call the shared coverageQualifier`);
      assert.ok(/scanned:\s*coverage\.scanned/.test(src), `${rel} does not emit coverage.scanned`);
      assert.ok(/total:\s*coverage\.total/.test(src), `${rel} does not emit coverage.total`);
      assert.ok(/partial:\s*coverage\.partial/.test(src), `${rel} does not emit coverage.partial`);
    }
  });

  it('the free-scan page marks the badge markdown and alt text "partial" when coverage is partial', () => {
    const src = fs.readFileSync(path.join(ROOT, 'website/app/playground/page.tsx'), 'utf8');
    const idx = src.indexOf('Add a live badge to your README');
    assert.ok(idx > 0, 'badge embed section is gone');
    const body = src.slice(idx, idx + 900);
    assert.ok(/coverage\?\.partial/.test(body), 'the badge markdown does not check coverage.partial');
    assert.ok(/partial coverage/i.test(body), 'the badge gives no partial-coverage wording');
  });
});
