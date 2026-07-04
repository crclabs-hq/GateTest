// =============================================================================
// PATTERN MINER TRAINER TEST
// =============================================================================
// Tests for website/app/lib/trainers/pattern-miner.js
// =============================================================================

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PM = require('../website/app/lib/trainers/pattern-miner.js');

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-pm-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeJsonl(records) {
  const p = path.join(fs.mkdtempSync(path.join(tmpRoot, 'case-')), 'log.jsonl');
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('pattern-miner — shape', () => {
  it('exports mine and renderMarkdown', () => {
    assert.strictEqual(typeof PM.mine, 'function');
    assert.strictEqual(typeof PM.renderMarkdown, 'function');
  });
});

// ---------------------------------------------------------------------------
// topModulesByFixCount
// ---------------------------------------------------------------------------

describe('pattern-miner — topModulesByFixCount', () => {
  it('ranks modules by fix-count descending', () => {
    const fixes = [
      { module: 'a' }, { module: 'a' }, { module: 'a' },
      { module: 'b' }, { module: 'b' },
      { module: 'c' },
    ];
    const top = PM._topModulesByFixCount(fixes);
    assert.deepStrictEqual(top[0], { module: 'a', count: 3 });
    assert.deepStrictEqual(top[1], { module: 'b', count: 2 });
    assert.deepStrictEqual(top[2], { module: 'c', count: 1 });
  });

  it('groups null/missing modules under (unattributed)', () => {
    const fixes = [{ module: null }, { module: undefined }, {}];
    const top = PM._topModulesByFixCount(fixes);
    assert.strictEqual(top[0].module, '(unattributed)');
    assert.strictEqual(top[0].count, 3);
  });

  it('caps at 10', () => {
    const fixes = Array.from({ length: 20 }, (_, i) => ({ module: 'm' + i }));
    assert.strictEqual(PM._topModulesByFixCount(fixes).length, 10);
  });
});

// ---------------------------------------------------------------------------
// recurringSubjects
// ---------------------------------------------------------------------------

describe('pattern-miner — recurringSubjects', () => {
  it('groups commits with same fix(<x>): prefix + body prefix', () => {
    // First 30 chars of body form the grouping key. Bodies under 30 chars
    // group whole-body when identical.
    const fixes = [
      { commitSha: '1', subject: 'fix(links): anchor FP' },
      { commitSha: '2', subject: 'fix(links): anchor FP' },
      { commitSha: '3', subject: 'fix(links): anchor FP' },
      { commitSha: '4', subject: 'fix(security): unrelated bug' },
    ];
    const recurring = PM._recurringSubjects(fixes);
    assert.ok(recurring.length >= 1, JSON.stringify(recurring));
    assert.ok(recurring[0].pattern.startsWith('fix(links):'));
    assert.ok(recurring[0].hits >= 3);
  });

  it('does NOT surface patterns with < 3 hits', () => {
    const fixes = [
      { commitSha: '1', subject: 'fix(x): bug a' },
      { commitSha: '2', subject: 'fix(x): bug a' },
    ];
    assert.strictEqual(PM._recurringSubjects(fixes).length, 0);
  });

  it('skips records with non-string subjects', () => {
    const fixes = [
      { commitSha: '1', subject: null },
      { commitSha: '2', subject: undefined },
      { commitSha: '3' },
    ];
    assert.strictEqual(PM._recurringSubjects(fixes).length, 0);
  });
});

// ---------------------------------------------------------------------------
// underTestedModules
// ---------------------------------------------------------------------------

describe('pattern-miner — underTestedModules', () => {
  it('flags modules with ≥3 fixes and <1 test per fix on average', () => {
    const fixes = [
      { module: 'risky', testsAdded: 0 },
      { module: 'risky', testsAdded: 0 },
      { module: 'risky', testsAdded: 1 }, // total 1 test / 3 fixes = 0.33
      { module: 'safe', testsAdded: 5 },
      { module: 'safe', testsAdded: 5 },
      { module: 'safe', testsAdded: 5 }, // 15 / 3 = 5
    ];
    const under = PM._underTestedModules(fixes);
    assert.strictEqual(under.length, 1);
    assert.strictEqual(under[0].module, 'risky');
    assert.strictEqual(under[0].testPerFix, 0.33);
  });

  it('does NOT flag modules with <3 fixes', () => {
    const fixes = [
      { module: 'small', testsAdded: 0 },
      { module: 'small', testsAdded: 0 },
    ];
    assert.strictEqual(PM._underTestedModules(fixes).length, 0);
  });
});

// ---------------------------------------------------------------------------
// claudeRatioByLayer
// ---------------------------------------------------------------------------

describe('pattern-miner — claudeRatioByLayer', () => {
  it('computes per-layer attempts + claude share', () => {
    const attempts = [
      { layer: 'claude', success: true },
      { layer: 'claude', success: false },
      { layer: 'claude', success: true },
      { layer: 'ast', success: true },
      { layer: 'rule', success: true },
    ];
    const stats = PM._claudeRatioByLayer(attempts);
    assert.strictEqual(stats.layers.claude.attempts, 3);
    assert.strictEqual(stats.layers.claude.successes, 2);
    assert.strictEqual(stats.layers.ast.attempts, 1);
    assert.strictEqual(stats.total, 5);
    assert.strictEqual(stats.claudeShare, 0.6);
    assert.strictEqual(stats.deterministicShare, 0.4);
  });

  it('treats null layer as its own bucket', () => {
    const attempts = [
      { layer: null, success: false },
      { layer: null, success: false },
    ];
    const stats = PM._claudeRatioByLayer(attempts);
    assert.strictEqual(stats.layers.null.attempts, 2);
    assert.strictEqual(stats.claudeShare, 0);
  });

  it('handles empty input', () => {
    const stats = PM._claudeRatioByLayer([]);
    assert.strictEqual(stats.total, 0);
    assert.strictEqual(stats.claudeShare, 0);
  });
});

// ---------------------------------------------------------------------------
// mine — end-to-end
// ---------------------------------------------------------------------------

describe('pattern-miner — mine (end-to-end)', () => {
  it('produces report from real JSONL files', async () => {
    const sessionPath = writeJsonl([
      { commitSha: '1', module: 'crossFileTaint', subject: 'fix(crossFileTaint): drizzle FP', testsAdded: 6 },
      { commitSha: '2', module: 'crossFileTaint', subject: 'fix(crossFileTaint): regex tweak', testsAdded: 2 },
      { commitSha: '3', module: 'links', subject: 'fix(links): anchor FP', testsAdded: 0 },
      { commitSha: '4', module: 'links', subject: 'fix(links): anchor FP', testsAdded: 0 },
      { commitSha: '5', module: 'links', subject: 'fix(links): anchor FP', testsAdded: 0 },
    ]);
    const fixAttemptPath = writeJsonl([
      { layer: 'claude', issueRuleKey: 'sql:taint', success: true },
      { layer: 'claude', issueRuleKey: 'sql:taint', success: true },
      { layer: 'ast', issueRuleKey: 'tls:reject-unauth', success: true },
    ]);

    const report = await PM.mine({ sessionFixPath: sessionPath, fixAttemptPath });
    assert.strictEqual(report.inputs.sessionFixCount, 5);
    assert.strictEqual(report.inputs.fixAttemptCount, 3);
    assert.ok(report.topModulesByFixCount.length >= 2);
    assert.strictEqual(report.topModulesByFixCount[0].module, 'links');
    assert.ok(report.recurringSubjects.length >= 1);
    assert.ok(report.underTestedModules.length >= 1);
    assert.strictEqual(report.underTestedModules[0].module, 'links');
    assert.ok(report.recommendations.length >= 1);
  });

  it('handles missing input files gracefully', async () => {
    const report = await PM.mine({
      sessionFixPath: '/tmp/__not_here_session.jsonl',
      fixAttemptPath: '/tmp/__not_here_fixattempts.jsonl',
      mcpTelemetryPath: '/tmp/__not_here_mcp_telemetry.jsonl', // ensure no real telemetry file is read
    });
    assert.strictEqual(report.inputs.sessionFixCount, 0);
    assert.strictEqual(report.inputs.fixAttemptCount, 0);
    assert.strictEqual(report.recommendations.length, 0);
  });

  it('renders markdown without throwing', async () => {
    const report = await PM.mine({
      sessionFixPath: '/tmp/__not_here_a.jsonl',
      fixAttemptPath: '/tmp/__not_here_b.jsonl',
    });
    const md = PM.renderMarkdown(report);
    assert.ok(md.includes('# Flywheel Pattern Miner'));
    assert.ok(md.includes('Recommendations'));
  });

  it('flywheel-not-maturing recommendation fires when claude > 60% of ≥50 attempts', async () => {
    const sessionPath = writeJsonl([]);
    const heavyClaude = Array.from({ length: 60 }, () => ({ layer: 'claude', success: true }));
    const someAst = Array.from({ length: 10 }, () => ({ layer: 'ast', success: true }));
    const fixAttemptPath = writeJsonl([...heavyClaude, ...someAst]);

    const report = await PM.mine({ sessionFixPath: sessionPath, fixAttemptPath });
    assert.ok(report.recommendations.some((r) => r.kind === 'flywheel-not-maturing'));
  });
});
