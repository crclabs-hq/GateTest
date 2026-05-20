// =============================================================================
// REGRESSION-TEST GENERATOR TRAINER TEST
// =============================================================================

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RTG = require('../website/app/lib/trainers/regression-test-generator.js');

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-rtg-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function fakeRepo({ withSource = [], withTests = [], withPending = [] } = {}) {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'repo-'));
  for (const rel of withSource) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '// stub\nmodule.exports = {};');
  }
  for (const rel of withTests) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "describe('x', () => {});");
  }
  for (const rel of withPending) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '// pending draft');
  }
  return root;
}

function writeJsonl(records) {
  const p = path.join(fs.mkdtempSync(path.join(tmpRoot, 'log-')), 'log.jsonl');
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('regression-test-generator — shape', () => {
  it('exports generate, renderMarkdown', () => {
    assert.strictEqual(typeof RTG.generate, 'function');
    assert.strictEqual(typeof RTG.renderMarkdown, 'function');
  });
});

// ---------------------------------------------------------------------------
// resolveModuleImportPath
// ---------------------------------------------------------------------------

describe('regression-test-generator — resolveModuleImportPath', () => {
  it('finds src/modules/<name>.js', () => {
    const repo = fakeRepo({ withSource: ['src/modules/foo.js'] });
    const r = RTG._resolveModuleImportPath(repo, 'foo');
    assert.ok(r);
    assert.strictEqual(r.rel, 'src/modules/foo.js');
  });

  it('finds website/app/lib/<name>.js', () => {
    const repo = fakeRepo({ withSource: ['website/app/lib/health-score.js'] });
    const r = RTG._resolveModuleImportPath(repo, 'health-score');
    assert.ok(r);
    assert.strictEqual(r.rel, 'website/app/lib/health-score.js');
  });

  it('returns null when source file missing', () => {
    const repo = fakeRepo({});
    assert.strictEqual(RTG._resolveModuleImportPath(repo, 'doesNotExist'), null);
  });

  it('returns null for (unattributed) module name', () => {
    const repo = fakeRepo({ withSource: ['src/modules/(unattributed).js'] });
    assert.strictEqual(RTG._resolveModuleImportPath(repo, '(unattributed)'), null);
  });
});

// ---------------------------------------------------------------------------
// buildDraft
// ---------------------------------------------------------------------------

describe('regression-test-generator — buildDraft', () => {
  it('includes module name, import path, and pending-test marker', () => {
    const content = RTG._buildDraft({
      moduleName: 'foo',
      importPath: '../src/modules/foo.js',
      fixes: { count: 5, subjects: ['fix(foo): a'], shas: ['abc12345'] },
      tests: 1,
      testPerFix: 0.2,
    });
    assert.ok(content.includes('AUTO-GENERATED PENDING'));
    assert.ok(content.includes('foo'));
    assert.ok(content.includes('../src/modules/foo.js'));
    assert.ok(content.includes('abc12345'));
    assert.ok(content.includes('TODO'));
    assert.ok(content.includes('pending.test.js'));
  });

  it('handles empty subjects/shas gracefully', () => {
    const content = RTG._buildDraft({
      moduleName: 'bar',
      importPath: '../src/modules/bar.js',
      fixes: { count: 3, subjects: [], shas: [] },
      tests: 0,
      testPerFix: 0,
    });
    assert.ok(content.includes('(no SHAs supplied)'));
  });
});

// ---------------------------------------------------------------------------
// generate — end-to-end
// ---------------------------------------------------------------------------

describe('regression-test-generator — generate', () => {
  it('writes a pending test file under tests/auto-generated/', async () => {
    const repo = fakeRepo({ withSource: ['src/modules/foo.js'] });
    const sessionPath = writeJsonl([
      { commitSha: '1', module: 'foo', subject: 'fix(foo): a', testsAdded: 0 },
      { commitSha: '2', module: 'foo', subject: 'fix(foo): b', testsAdded: 0 },
      { commitSha: '3', module: 'foo', subject: 'fix(foo): c', testsAdded: 0 },
    ]);
    const fixAttemptPath = writeJsonl([]);
    const report = await RTG.generate({
      repoRoot: repo,
      sessionFixPath: sessionPath,
      fixAttemptPath,
    });
    assert.strictEqual(report.drafted, 1);
    const expectedPath = path.join(repo, 'tests', 'auto-generated', 'foo.pending.test.js');
    assert.ok(fs.existsSync(expectedPath), 'pending test file should exist');
    const body = fs.readFileSync(expectedPath, 'utf8');
    assert.ok(body.includes('AUTO-GENERATED PENDING'));
  });

  it('skips when source file is missing', async () => {
    const repo = fakeRepo({}); // no source
    const sessionPath = writeJsonl([
      { commitSha: '1', module: 'phantom', subject: 'fix(phantom): a', testsAdded: 0 },
      { commitSha: '2', module: 'phantom', subject: 'fix(phantom): b', testsAdded: 0 },
      { commitSha: '3', module: 'phantom', subject: 'fix(phantom): c', testsAdded: 0 },
    ]);
    const fixAttemptPath = writeJsonl([]);
    const report = await RTG.generate({
      repoRoot: repo,
      sessionFixPath: sessionPath,
      fixAttemptPath,
    });
    assert.strictEqual(report.drafted, 0);
    assert.ok(report.drafts.some((d) => d.status === 'skipped-no-source-file'));
  });

  it('skips when a real test already exists', async () => {
    const repo = fakeRepo({
      withSource: ['src/modules/foo.js'],
      withTests: ['tests/foo.test.js'],
    });
    const sessionPath = writeJsonl([
      { commitSha: '1', module: 'foo', subject: 'fix(foo): a', testsAdded: 0 },
      { commitSha: '2', module: 'foo', subject: 'fix(foo): b', testsAdded: 0 },
      { commitSha: '3', module: 'foo', subject: 'fix(foo): c', testsAdded: 0 },
    ]);
    const fixAttemptPath = writeJsonl([]);
    const report = await RTG.generate({
      repoRoot: repo,
      sessionFixPath: sessionPath,
      fixAttemptPath,
    });
    assert.strictEqual(report.drafted, 0);
    assert.ok(report.drafts.some((d) => d.status === 'skipped-real-test-exists'));
  });

  it('skips when pending draft already exists (idempotent)', async () => {
    const repo = fakeRepo({
      withSource: ['src/modules/foo.js'],
      withPending: ['tests/auto-generated/foo.pending.test.js'],
    });
    const sessionPath = writeJsonl([
      { commitSha: '1', module: 'foo', subject: 'fix(foo): a', testsAdded: 0 },
      { commitSha: '2', module: 'foo', subject: 'fix(foo): b', testsAdded: 0 },
      { commitSha: '3', module: 'foo', subject: 'fix(foo): c', testsAdded: 0 },
    ]);
    const fixAttemptPath = writeJsonl([]);
    const report = await RTG.generate({
      repoRoot: repo,
      sessionFixPath: sessionPath,
      fixAttemptPath,
    });
    assert.strictEqual(report.drafted, 0);
    assert.ok(report.drafts.some((d) => d.status === 'skipped-already-drafted'));
  });

  it('dryRun does not write files', async () => {
    const repo = fakeRepo({ withSource: ['src/modules/foo.js'] });
    const sessionPath = writeJsonl([
      { commitSha: '1', module: 'foo', subject: 'fix(foo): a', testsAdded: 0 },
      { commitSha: '2', module: 'foo', subject: 'fix(foo): b', testsAdded: 0 },
      { commitSha: '3', module: 'foo', subject: 'fix(foo): c', testsAdded: 0 },
    ]);
    const fixAttemptPath = writeJsonl([]);
    const report = await RTG.generate({
      repoRoot: repo,
      sessionFixPath: sessionPath,
      fixAttemptPath,
      dryRun: true,
    });
    assert.ok(report.drafts.some((d) => d.status === 'dry-run-would-draft'));
    const expectedPath = path.join(repo, 'tests', 'auto-generated', 'foo.pending.test.js');
    assert.ok(!fs.existsSync(expectedPath), 'dry-run must not write');
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe('regression-test-generator — renderMarkdown', () => {
  it('renders empty', () => {
    const md = RTG.renderMarkdown({
      generatedAt: new Date().toISOString(),
      underTestedTargets: 0,
      draftsTotal: 0,
      drafted: 0,
      skipped: 0,
      failed: 0,
      drafts: [],
    });
    assert.ok(md.includes('# Regression-Test Generator'));
    assert.ok(md.includes('No under-tested modules'));
  });

  it('renders drafted rows', () => {
    const md = RTG.renderMarkdown({
      generatedAt: new Date().toISOString(),
      underTestedTargets: 1,
      draftsTotal: 1,
      drafted: 1,
      skipped: 0,
      failed: 0,
      drafts: [{ module: 'foo', status: 'drafted', path: 'tests/auto-generated/foo.pending.test.js' }],
    });
    assert.ok(md.includes('foo'));
    assert.ok(md.includes('drafted'));
  });
});
