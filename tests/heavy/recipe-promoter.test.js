// =============================================================================
// RECIPE PROMOTER TRAINER TEST
// =============================================================================

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RP = require('../../website/app/lib/trainers/recipe-promoter.js');

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-rp-'));
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
// Shape
// ---------------------------------------------------------------------------

describe('recipe-promoter — shape', () => {
  it('exports propose and renderMarkdown', () => {
    assert.strictEqual(typeof RP.propose, 'function');
    assert.strictEqual(typeof RP.renderMarkdown, 'function');
  });
});

// ---------------------------------------------------------------------------
// plausibilityScore
// ---------------------------------------------------------------------------

describe('recipe-promoter — plausibilityScore', () => {
  it('returns 0 for empty diff set', () => {
    assert.strictEqual(RP._plausibilityScore([]), 0);
  });

  it('scores uniform small diffs highly', () => {
    const diffs = [
      { added: 1, removed: 1, fileCount: 1 },
      { added: 1, removed: 1, fileCount: 1 },
      { added: 1, removed: 1, fileCount: 1 },
    ];
    const score = RP._plausibilityScore(diffs);
    assert.ok(score >= 0.9, `expected ≥ 0.9, got ${score}`);
  });

  it('penalises large diffs vs uniform-small ones', () => {
    const small = [
      { added: 1, removed: 1, fileCount: 1 },
      { added: 1, removed: 1, fileCount: 1 },
    ];
    const big = [
      { added: 500, removed: 200, fileCount: 1 },
      { added: 500, removed: 200, fileCount: 1 },
    ];
    const sSmall = RP._plausibilityScore(small);
    const sBig = RP._plausibilityScore(big);
    assert.ok(sBig < sSmall, `big (${sBig}) should score below small (${sSmall})`);
  });

  it('penalises wide variance in size', () => {
    const diffs = [
      { added: 1, removed: 1, fileCount: 1 },
      { added: 100, removed: 100, fileCount: 1 },
      { added: 500, removed: 500, fileCount: 1 },
    ];
    const score = RP._plausibilityScore(diffs);
    assert.ok(score < 0.7);
  });

  it('penalises multi-file commits', () => {
    const diffs = [
      { added: 5, removed: 5, fileCount: 12 },
      { added: 5, removed: 5, fileCount: 12 },
    ];
    const score = RP._plausibilityScore(diffs);
    assert.ok(score < 0.95);
  });
});

// ---------------------------------------------------------------------------
// characteriseCommit — end-to-end against a real ephemeral repo
// ---------------------------------------------------------------------------

describe('recipe-promoter — characteriseCommit (real git)', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(tmpRoot, 'repo-'));
    execFileSync('git', ['-C', repoRoot, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 't@e.com']);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'T']);
    execFileSync('git', ['-C', repoRoot, 'config', 'commit.gpgsign', 'false']);
  });

  function commit(message, files) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(repoRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    execFileSync('git', ['-C', repoRoot, 'add', '-A']);
    execFileSync('git', [
      '-C', repoRoot, '-c', 'commit.gpgsign=false',
      'commit', '-m', message, '--quiet',
    ]);
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }

  it('returns file list + add/remove counts', () => {
    commit('initial', { 'a.js': 'const x = 1;\nconst y = 2;\n' });
    const sha = commit('change a', { 'a.js': 'const x = 100;\nconst y = 200;\n' });
    const stat = RP._characteriseCommit(repoRoot, sha);
    assert.ok(stat.files.includes('a.js'));
    assert.ok(stat.added >= 2);
    assert.ok(stat.removed >= 2);
  });

  it('returns zero on unknown SHA', () => {
    const stat = RP._characteriseCommit(repoRoot, '0000000000000000000000000000000000000000');
    assert.strictEqual(stat.added, 0);
    assert.strictEqual(stat.removed, 0);
    assert.strictEqual(stat.fileCount, 0);
  });
});

// ---------------------------------------------------------------------------
// propose — end-to-end
// ---------------------------------------------------------------------------

describe('recipe-promoter — propose', () => {
  it('produces empty proposals when no recurring patterns', async () => {
    const sessionPath = writeJsonl([
      { commitSha: '1', subject: 'fix(a): only one of me' },
    ]);
    const fixAttemptPath = writeJsonl([]);
    const report = await RP.propose({ sessionFixPath: sessionPath, fixAttemptPath, repoRoot: tmpRoot });
    assert.strictEqual(report.proposalsTotal, 0);
  });

  it('drops proposals whose sample SHAs do not exist in the repo', async () => {
    const sessionPath = writeJsonl([
      { commitSha: 'aaaa1111', subject: 'fix(x): same body' },
      { commitSha: 'aaaa2222', subject: 'fix(x): same body' },
      { commitSha: 'aaaa3333', subject: 'fix(x): same body' },
    ]);
    const fixAttemptPath = writeJsonl([]);
    const report = await RP.propose({ sessionFixPath: sessionPath, fixAttemptPath, repoRoot: tmpRoot });
    assert.strictEqual(report.proposalsTotal, 0);
  });

  it('produces a proposal when a recurring pattern matches real commits', async () => {
    // Build a real repo with 3 commits sharing the same fix(<x>): subject
    const repoRoot = fs.mkdtempSync(path.join(tmpRoot, 'realrepo-'));
    execFileSync('git', ['-C', repoRoot, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 't@e.com']);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'T']);
    execFileSync('git', ['-C', repoRoot, 'config', 'commit.gpgsign', 'false']);

    const shas = [];
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(repoRoot, `f${i}.js`), `const x${i} = ${i};\n`);
      execFileSync('git', ['-C', repoRoot, 'add', '-A']);
      execFileSync('git', [
        '-C', repoRoot, '-c', 'commit.gpgsign=false',
        'commit', '-m', 'fix(x): drizzle FP', '--quiet',
      ]);
      shas.push(execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    }

    const sessionPath = writeJsonl(shas.map((sha) => ({
      commitSha: sha,
      subject: 'fix(x): drizzle FP',
    })));
    const fixAttemptPath = writeJsonl([]);

    const report = await RP.propose({ sessionFixPath: sessionPath, fixAttemptPath, repoRoot });
    assert.strictEqual(report.proposalsTotal, 1);
    const p = report.proposals[0];
    assert.ok(['high-confidence', 'review', 'low-confidence-skip'].includes(p.verdict));
    assert.ok(p.proposedRule.name.includes('drizzle') || p.proposedRule.name.includes('x'));
    assert.ok(Array.isArray(p.sampleShas) && p.sampleShas.length >= 3);
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe('recipe-promoter — renderMarkdown', () => {
  it('renders empty report', () => {
    const md = RP.renderMarkdown({
      generatedAt: new Date().toISOString(),
      minerInputs: { sessionFixCount: 0, fixAttemptCount: 0 },
      proposalsTotal: 0,
      highConfidence: 0,
      review: 0,
      skipped: 0,
      proposals: [],
    });
    assert.ok(md.includes('# Recipe Promoter'));
    assert.ok(md.includes('No recurring patterns'));
  });

  it('renders one proposal with diffs table', () => {
    const md = RP.renderMarkdown({
      generatedAt: new Date().toISOString(),
      minerInputs: { sessionFixCount: 3, fixAttemptCount: 0 },
      proposalsTotal: 1,
      highConfidence: 1,
      review: 0,
      skipped: 0,
      proposals: [{
        pattern: 'fix(x): something',
        hits: 3,
        sampleShas: ['abc123', 'def456', '789ghi'],
        sampleDiffs: [
          { sha: 'abc123', files: ['a.js'], added: 2, removed: 2 },
          { sha: 'def456', files: ['b.js'], added: 2, removed: 2 },
          { sha: '789ghi', files: ['c.js'], added: 2, removed: 2 },
        ],
        plausibilityScore: 0.9,
        verdict: 'high-confidence',
        proposedRule: {
          name: 'rule-fix-x-something',
          sourceCommits: ['abc123', 'def456', '789ghi'],
          suggestedLocation: 'website/app/lib/rule-based-fixer.js (TRANSFORMS list)',
          action: 'transcribe ...',
        },
      }],
    });
    assert.ok(md.includes('rule-fix-x-something'));
    assert.ok(md.includes('high-confidence'));
    assert.ok(md.includes('| SHA |'));
  });
});
