// =============================================================================
// RECIPE AUTO-PROMOTER TRAINER TEST
// =============================================================================

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAP = require('../website/app/lib/trainers/recipe-auto-promoter.js');

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-rap-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('recipe-auto-promoter — shape', () => {
  it('exports autoPromote + renderMarkdown', () => {
    assert.strictEqual(typeof RAP.autoPromote, 'function');
    assert.strictEqual(typeof RAP.renderMarkdown, 'function');
  });
  it('exports MIN_SAMPLES_AGREEING (≥2)', () => {
    assert.ok(RAP.MIN_SAMPLES_AGREEING >= 2);
  });
  it('FORBIDDEN_REMOVED_TOKENS rejects common keywords', () => {
    assert.ok(RAP.FORBIDDEN_REMOVED_TOKENS.has('true'));
    assert.ok(RAP.FORBIDDEN_REMOVED_TOKENS.has('false'));
    assert.ok(RAP.FORBIDDEN_REMOVED_TOKENS.has('const'));
  });
});

// ---------------------------------------------------------------------------
// pairedLines — diff parsing
// ---------------------------------------------------------------------------

describe('recipe-auto-promoter — pairedLines', () => {
  it('extracts a single -/+ pair', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,3 +1,3 @@',
      ' unchanged',
      '-old line',
      '+new line',
      ' unchanged',
    ].join('\n');
    const pairs = RAP._pairedLines(diff);
    assert.deepStrictEqual(pairs, [{ removed: 'old line', added: 'new line' }]);
  });

  it('skips multi-line - blocks (not a single swap)', () => {
    const diff = [
      ' context',
      '-line1',
      '-line2',
      '+new1',
      '+new2',
      ' context',
    ].join('\n');
    const pairs = RAP._pairedLines(diff);
    assert.strictEqual(pairs.length, 0);
  });

  it('skips file headers --- and +++', () => {
    const diff = '--- a/file\n+++ b/file\n';
    const pairs = RAP._pairedLines(diff);
    assert.strictEqual(pairs.length, 0);
  });

  it('handles multiple distinct 1:1 pairs in same diff', () => {
    const diff = [
      ' ctx',
      '-a-old',
      '+a-new',
      ' ctx',
      '-b-old',
      '+b-new',
      ' ctx',
    ].join('\n');
    const pairs = RAP._pairedLines(diff);
    assert.strictEqual(pairs.length, 2);
    assert.deepStrictEqual(pairs[0], { removed: 'a-old', added: 'a-new' });
  });
});

// ---------------------------------------------------------------------------
// extractTokenSwap
// ---------------------------------------------------------------------------

describe('recipe-auto-promoter — extractTokenSwap', () => {
  it('finds the middle token between shared prefix + suffix', () => {
    const r = RAP._extractTokenSwap(
      '  rejectUnauthorized: false,',
      '  rejectUnauthorized: true,',
    );
    assert.ok(r);
    assert.strictEqual(r.beforeToken, 'false');
    assert.strictEqual(r.afterToken, 'true');
  });

  it('returns null when lines are identical', () => {
    assert.strictEqual(RAP._extractTokenSwap('abc', 'abc'), null);
  });

  it('handles no shared prefix (full rewrite)', () => {
    const r = RAP._extractTokenSwap('aaa', 'bbb');
    assert.ok(r);
    assert.strictEqual(r.beforeToken, 'aaa');
    assert.strictEqual(r.afterToken, 'bbb');
    assert.strictEqual(r.sharedPrefix, '');
    assert.strictEqual(r.sharedSuffix, '');
  });

  it('respects word boundaries — does not cut a word', () => {
    // Word-boundary aware: 'foo-bar' vs 'foo-baz' should treat the
    // dash as the natural split, yielding 'bar' → 'baz' rather than
    // a partial 'r' → 'z'.
    const r = RAP._extractTokenSwap('foo-bar', 'foo-baz');
    assert.ok(r);
    assert.strictEqual(r.beforeToken, 'bar');
    assert.strictEqual(r.afterToken, 'baz');
    assert.strictEqual(r.sharedPrefix, 'foo-');
  });
});

// ---------------------------------------------------------------------------
// findConsensusSwap — end-to-end with ephemeral git repo
// ---------------------------------------------------------------------------

describe('recipe-auto-promoter — findConsensusSwap (real git)', () => {
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

  it('detects a consensus swap across 3 commits doing the same change', () => {
    // Setup: 3 files each starting with the same "bad" pattern, then
    // 3 commits each swapping the bad token for a good one. Token is
    // longer than MIN_SWAP_LENGTH and not on FORBIDDEN_REMOVED_TOKENS.
    const startA = `const a = "strategy: unsafe-permissive";\n`;
    const startB = `const b = "strategy: unsafe-permissive";\n`;
    const startC = `const c = "strategy: unsafe-permissive";\n`;
    commit('seed', { 'a.js': startA, 'b.js': startB, 'c.js': startC });
    const goodA = startA.replace('unsafe-permissive', 'strict-validation');
    const goodB = startB.replace('unsafe-permissive', 'strict-validation');
    const goodC = startC.replace('unsafe-permissive', 'strict-validation');
    const sha1 = commit('fix(policy): a', { 'a.js': goodA });
    const sha2 = commit('fix(policy): b', { 'b.js': goodB });
    const sha3 = commit('fix(policy): c', { 'c.js': goodC });

    const swap = RAP._findConsensusSwap(repoRoot, [sha1, sha2, sha3]);
    assert.ok(swap, 'should find a consensus swap');
    assert.strictEqual(swap.count, 3);
    assert.strictEqual(swap.beforeToken, 'unsafe-permissive');
    assert.strictEqual(swap.afterToken, 'strict-validation');
  });

  it('skips swaps where beforeToken is in FORBIDDEN list', () => {
    commit('seed', { 'x.js': 'const x = false;\n' });
    const sha = commit('fix: x', { 'x.js': 'const x = true;\n' });
    const swap = RAP._findConsensusSwap(repoRoot, [sha]);
    // Only 1 sample, and 'false' is forbidden — null expected.
    assert.strictEqual(swap, null);
  });

  it('skips when only ONE sample agrees', () => {
    commit('seed', { 'a.js': 'rejectUnauthorized: false,\n' });
    const sha1 = commit('fix(tls): a', { 'a.js': 'rejectUnauthorized: true,\n' });
    const swap = RAP._findConsensusSwap(repoRoot, [sha1]);
    assert.strictEqual(swap, null);
  });

  it('accepts a longer beforeToken not on the forbidden list', () => {
    // Word-boundary aware algorithm captures the differing run between
    // the shared prefix and suffix, then word-boundary-trims. So put
    // a long, distinct token in the middle and surround it with shared
    // context that ENDS at a non-word boundary on both sides.
    const before = `connectionMode: "unsafe-legacy"`;
    const after  = `connectionMode: "strict-modern"`;
    commit('seed', { 'a.js': `const x = ${before};\n`, 'b.js': `const y = ${before};\n` });
    const sha1 = commit('fix: a', { 'a.js': `const x = ${after};\n`, 'b.js': `const y = ${before};\n` });
    const sha2 = commit('fix: b', { 'a.js': `const x = ${after};\n`, 'b.js': `const y = ${after};\n` });
    const swap = RAP._findConsensusSwap(repoRoot, [sha1, sha2]);
    assert.ok(swap, 'should find a consensus swap');
    // The algorithm captures the differing inner region between quotes,
    // not the full "connectionMode: ..." statement. That's correct.
    assert.strictEqual(swap.beforeToken, 'unsafe-legacy');
    assert.strictEqual(swap.afterToken, 'strict-modern');
    assert.ok(swap.count >= 2);
  });
});

// ---------------------------------------------------------------------------
// sanitiseRuleName
// ---------------------------------------------------------------------------

describe('recipe-auto-promoter — sanitiseRuleName', () => {
  it('lowercases and dasherises non-alphanum chars', () => {
    assert.strictEqual(RAP._sanitiseRuleName('rejectUnauthorized: false'), 'rejectunauthorized-false');
  });
  it('truncates long names to 60 chars', () => {
    const long = 'x'.repeat(200);
    assert.ok(RAP._sanitiseRuleName(long).length <= 60);
  });
  it('falls back to "auto-rule" if input is all junk', () => {
    assert.strictEqual(RAP._sanitiseRuleName('!!!'), 'auto-rule');
  });
});

// ---------------------------------------------------------------------------
// buildRuleFile — the generated module source
// ---------------------------------------------------------------------------

describe('recipe-auto-promoter — buildRuleFile', () => {
  it('includes source SHAs + plausibility + reviewer checklist', () => {
    const body = RAP._buildRuleFile({
      ruleName: 'test-swap',
      swap: {
        beforeToken: 'badThing',
        afterToken: 'goodThing',
        samples: [{ sha: 'abc12345', prefix: '', suffix: '' }, { sha: 'def67890', prefix: '', suffix: '' }],
      },
      proposal: { pattern: 'fix(x): demo', hits: 2, plausibilityScore: 0.85, verdict: 'high-confidence' },
    });
    assert.match(body, /AUTO-GENERATED PENDING RULE/);
    assert.match(body, /abc12345/);
    assert.match(body, /def67890/);
    assert.match(body, /REVIEWER CHECKLIST/);
    assert.match(body, /name:\s*'auto-test-swap'/);
    assert.match(body, /badThing/);
    assert.match(body, /goodThing/);
  });

  it('escapes special chars in token strings', () => {
    const body = RAP._buildRuleFile({
      ruleName: 'q',
      swap: {
        beforeToken: '`tagged${x}`',
        afterToken:  '`safe${x}`',
        samples: [{ sha: 'a', prefix: '', suffix: '' }, { sha: 'b', prefix: '', suffix: '' }],
      },
      proposal: { pattern: 'p', hits: 2, plausibilityScore: 0.9, verdict: 'high-confidence' },
    });
    // Should still be valid JS — back-ticks and ${ escaped via the
    // jsStringLiteral helper. Sanity: the file should not contain
    // unescaped `${x}` outside of a literal.
    assert.match(body, /\\\$\{x\}/);
  });
});

// ---------------------------------------------------------------------------
// autoPromote — end-to-end with injected recipe report
// ---------------------------------------------------------------------------

describe('recipe-auto-promoter — autoPromote', () => {
  it('returns zero generations when no high-confidence proposals', async () => {
    const result = await RAP.autoPromote({
      recipeReport: { proposalsTotal: 0, proposals: [] },
      pendingDir: fs.mkdtempSync(path.join(tmpRoot, 'pending-')),
      dryRun: true,
    });
    assert.strictEqual(result.rulesGenerated, 0);
  });

  it('skips proposals whose SHAs do not yield a consensus', async () => {
    // Real repo with no commits matching the SHA references in the
    // recipe report — findConsensusSwap returns null.
    const repoRoot = fs.mkdtempSync(path.join(tmpRoot, 'norepo-'));
    execFileSync('git', ['-C', repoRoot, 'init', '-q', '-b', 'main']);
    const result = await RAP.autoPromote({
      repoRoot,
      pendingDir: fs.mkdtempSync(path.join(tmpRoot, 'pending2-')),
      recipeReport: {
        proposalsTotal: 1,
        proposals: [{
          pattern: 'fix(x): demo',
          hits: 3,
          sampleShas: ['ffffffff'.repeat(5), 'eeeeeeee'.repeat(5)],
          plausibilityScore: 0.9,
          verdict: 'high-confidence',
          proposedRule: { suggestedLocation: 'token-swap' },
        }],
      },
    });
    assert.strictEqual(result.rulesGenerated, 0);
    assert.ok(result.rules.some((r) => r.status === 'no-consensus'));
  });

  it('writes a pending rule file for a real consensus swap', async () => {
    // Build a repo with 2 commits that swap the same long, non-forbidden
    // token between word boundaries. Token: "unsafe-legacy" → "strict-modern".
    const repoRoot = fs.mkdtempSync(path.join(tmpRoot, 'realrepo-'));
    execFileSync('git', ['-C', repoRoot, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 't@e.com']);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'T']);
    execFileSync('git', ['-C', repoRoot, 'config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repoRoot, 'a.js'), `const x = "mode: unsafe-legacy";\n`);
    fs.writeFileSync(path.join(repoRoot, 'b.js'), `const y = "mode: unsafe-legacy";\n`);
    execFileSync('git', ['-C', repoRoot, 'add', '-A']);
    execFileSync('git', ['-C', repoRoot, '-c', 'commit.gpgsign=false', 'commit', '-m', 'seed', '--quiet']);
    fs.writeFileSync(path.join(repoRoot, 'a.js'), `const x = "mode: strict-modern";\n`);
    execFileSync('git', ['-C', repoRoot, 'add', '-A']);
    execFileSync('git', ['-C', repoRoot, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fix(a)', '--quiet']);
    const sha1 = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(repoRoot, 'b.js'), `const y = "mode: strict-modern";\n`);
    execFileSync('git', ['-C', repoRoot, 'add', '-A']);
    execFileSync('git', ['-C', repoRoot, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fix(b)', '--quiet']);
    const sha2 = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const pendingDir = fs.mkdtempSync(path.join(tmpRoot, 'pending3-'));
    const result = await RAP.autoPromote({
      repoRoot,
      pendingDir,
      recipeReport: {
        proposalsTotal: 1,
        proposals: [{
          pattern: 'fix(x): demo',
          hits: 2,
          sampleShas: [sha1, sha2],
          plausibilityScore: 0.9,
          verdict: 'high-confidence',
          proposedRule: { suggestedLocation: 'token-swap' },
        }],
      },
    });
    assert.strictEqual(result.rulesGenerated, 1, `expected 1 generation, got ${result.rulesGenerated}: ${JSON.stringify(result.rules)}`);
    const written = fs.readdirSync(pendingDir);
    assert.strictEqual(written.length, 1);
    const body = fs.readFileSync(path.join(pendingDir, written[0]), 'utf8');
    assert.match(body, /unsafe-legacy/);
    assert.match(body, /strict-modern/);
  });

  it('is idempotent — second run with the same swap skips already-drafted', async () => {
    const repoRoot = fs.mkdtempSync(path.join(tmpRoot, 'idem-'));
    execFileSync('git', ['-C', repoRoot, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 't@e.com']);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'T']);
    execFileSync('git', ['-C', repoRoot, 'config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repoRoot, 'a.js'), `"mode: unsafe-legacy"\n`);
    fs.writeFileSync(path.join(repoRoot, 'b.js'), `"mode: unsafe-legacy"\n`);
    execFileSync('git', ['-C', repoRoot, 'add', '-A']);
    execFileSync('git', ['-C', repoRoot, '-c', 'commit.gpgsign=false', 'commit', '-m', 'seed', '--quiet']);
    fs.writeFileSync(path.join(repoRoot, 'a.js'), `"mode: strict-modern"\n`);
    execFileSync('git', ['-C', repoRoot, 'add', '-A']);
    execFileSync('git', ['-C', repoRoot, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fix-a', '--quiet']);
    const sha1 = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(repoRoot, 'b.js'), `"mode: strict-modern"\n`);
    execFileSync('git', ['-C', repoRoot, 'add', '-A']);
    execFileSync('git', ['-C', repoRoot, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fix-b', '--quiet']);
    const sha2 = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const pendingDir = fs.mkdtempSync(path.join(tmpRoot, 'pending-idem-'));
    const proposal = {
      pattern: 'fix(x): demo', hits: 2, sampleShas: [sha1, sha2],
      plausibilityScore: 0.9, verdict: 'high-confidence',
      proposedRule: { suggestedLocation: 'token-swap' },
    };
    const r1 = await RAP.autoPromote({ repoRoot, pendingDir,
      recipeReport: { proposalsTotal: 1, proposals: [proposal] } });
    const r2 = await RAP.autoPromote({ repoRoot, pendingDir,
      recipeReport: { proposalsTotal: 1, proposals: [proposal] } });
    assert.strictEqual(r1.rulesGenerated, 1);
    assert.strictEqual(r2.rulesGenerated, 0);
    assert.ok(r2.rules.some((r) => r.status === 'already-drafted'));
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe('recipe-auto-promoter — renderMarkdown', () => {
  it('renders empty report', () => {
    const md = RAP.renderMarkdown({
      generatedAt: new Date().toISOString(),
      proposalsConsidered: 0,
      candidatesEvaluated: 0,
      rulesGenerated: 0,
      rulesSkipped: 0,
      rules: [],
    });
    assert.ok(md.includes('# Recipe Auto-Promoter'));
    assert.ok(md.includes('No high-confidence token-swap'));
  });

  it('renders a generated row', () => {
    const md = RAP.renderMarkdown({
      generatedAt: new Date().toISOString(),
      proposalsConsidered: 1,
      candidatesEvaluated: 1,
      rulesGenerated: 1,
      rulesSkipped: 0,
      rules: [{
        status: 'generated',
        ruleName: 'maxconnections-9999',
        path: 'website/app/lib/rule-based-fixer-pending/maxconnections-9999.js',
        beforeToken: 'maxConnections: 9999',
        afterToken: 'maxConnections: 100',
        sourceShas: ['abc12345', 'def67890'],
        pattern: 'fix(x): demo',
      }],
    });
    assert.ok(md.includes('maxconnections-9999'));
    assert.ok(md.includes('generated'));
    assert.ok(md.includes('abc12345'));
  });
});
