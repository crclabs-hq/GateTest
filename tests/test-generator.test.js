// ============================================================================
// TEST-GENERATOR TEST — Phase 1.3 of THE FIX-FIRST BUILD PLAN
// ============================================================================
// Covers website/app/lib/test-generator.js — the helper that asks Claude
// to write a regression test for every successful fix. The test ships
// in the same PR, so when the customer merges, their suite is stronger
// than before. No competitor on the market does this today.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  generateTestForFix,
  generateTestsForFixes,
  isTestableFix,
  buildTestPath,
  detectFramework,
  buildTestPrompt,
} = require('../website/app/lib/test-generator.js');

// ---------- isTestableFix ----------

test('isTestableFix — JS/TS/JSX/TSX source files are testable', () => {
  assert.equal(isTestableFix({ file: 'src/foo.js', fixed: 'x' }), true);
  assert.equal(isTestableFix({ file: 'src/foo.mjs', fixed: 'x' }), true);
  assert.equal(isTestableFix({ file: 'src/foo.cjs', fixed: 'x' }), true);
  assert.equal(isTestableFix({ file: 'src/foo.ts', fixed: 'x' }), true);
  assert.equal(isTestableFix({ file: 'src/foo.mts', fixed: 'x' }), true);
  assert.equal(isTestableFix({ file: 'src/foo.cts', fixed: 'x' }), true);
  assert.equal(isTestableFix({ file: 'src/foo.tsx', fixed: 'x' }), true);
  assert.equal(isTestableFix({ file: 'src/foo.jsx', fixed: 'x' }), true);
});

test('isTestableFix — config / docs / non-code files are NOT testable', () => {
  assert.equal(isTestableFix({ file: 'package.json', fixed: 'x' }), false);
  assert.equal(isTestableFix({ file: 'README.md', fixed: 'x' }), false);
  assert.equal(isTestableFix({ file: 'Dockerfile', fixed: 'x' }), false);
  assert.equal(isTestableFix({ file: '.env.example', fixed: 'x' }), false);
  assert.equal(isTestableFix({ file: 'config/app.yaml', fixed: 'x' }), false);
});

test('isTestableFix — existing test/spec files are NOT testable (no recursion)', () => {
  assert.equal(isTestableFix({ file: 'tests/foo.test.js', fixed: 'x' }), false);
  assert.equal(isTestableFix({ file: 'src/foo.spec.ts', fixed: 'x' }), false);
  assert.equal(isTestableFix({ file: 'src/foo.test.tsx', fixed: 'x' }), false);
});

test('isTestableFix — type declarations and pure type modules are NOT testable', () => {
  assert.equal(isTestableFix({ file: 'src/types.d.ts', fixed: 'x' }), false);
  assert.equal(isTestableFix({ file: 'src/types.ts', fixed: 'x' }), false);
  assert.equal(isTestableFix({ file: 'src/type.js', fixed: 'x' }), false);
});

test('isTestableFix — handles malformed input', () => {
  assert.equal(isTestableFix(null), false);
  assert.equal(isTestableFix({}), false);
  assert.equal(isTestableFix({ file: '', fixed: 'x' }), false);
  assert.equal(isTestableFix({ file: 'no-extension', fixed: 'x' }), false);
});

// ---------- buildTestPath ----------

test('buildTestPath — flat src file', () => {
  assert.equal(buildTestPath('src/foo.js'), 'tests/auto-generated/src_foo.test.js');
});

test('buildTestPath — deeply nested', () => {
  assert.equal(
    buildTestPath('website/app/lib/foo.ts'),
    'tests/auto-generated/website_app_lib_foo.test.js'
  );
});

test('buildTestPath — TSX preserves TSX extension', () => {
  assert.equal(
    buildTestPath('website/app/components/Hero.tsx'),
    'tests/auto-generated/website_app_components_Hero.test.tsx'
  );
});

test('buildTestPath — JSX preserves JSX extension', () => {
  assert.equal(buildTestPath('src/Comp.jsx'), 'tests/auto-generated/src_Comp.test.jsx');
});

test('buildTestPath — null on empty / no-extension input', () => {
  assert.equal(buildTestPath(''), null);
  assert.equal(buildTestPath('no-extension'), null);
  assert.equal(buildTestPath(null), null);
});

// ---------- detectFramework ----------

test('detectFramework — honors caller hint when valid', () => {
  assert.equal(detectFramework('tests/foo.test.js', 'jest'), 'jest');
  assert.equal(detectFramework('tests/foo.test.js', 'vitest'), 'vitest');
  assert.equal(detectFramework('tests/foo.test.js', 'node:test'), 'node:test');
});

test('detectFramework — defaults to node:test when no hint', () => {
  assert.equal(detectFramework('tests/foo.test.js'), 'node:test');
});

test('detectFramework — ignores invalid hint', () => {
  assert.equal(detectFramework('tests/foo.test.js', 'mocha'), 'node:test');
  assert.equal(detectFramework('tests/foo.test.js', ''), 'node:test');
});

// ---------- buildTestPrompt ----------

test('buildTestPrompt — includes file path, both code blocks, and issues', () => {
  const prompt = buildTestPrompt({
    filePath: 'src/foo.js',
    originalContent: 'function buggy() { return null; }',
    fixedContent: 'function fixed() { return 42; }',
    issues: ['returns null instead of 42', 'missing default value'],
    framework: 'node:test',
  });
  assert.match(prompt, /src\/foo\.js/);
  assert.match(prompt, /buggy/);
  assert.match(prompt, /fixed\(\) \{ return 42/);
  assert.match(prompt, /returns null instead of 42/);
  assert.match(prompt, /missing default value/);
  assert.match(prompt, /Node's built-in test runner/);
});

test('buildTestPrompt — framework section changes per framework', () => {
  const jest = buildTestPrompt({
    filePath: 'a.js', originalContent: 'a', fixedContent: 'b',
    issues: ['x'], framework: 'jest',
  });
  assert.match(jest, /Jest/);

  const vitest = buildTestPrompt({
    filePath: 'a.js', originalContent: 'a', fixedContent: 'b',
    issues: ['x'], framework: 'vitest',
  });
  assert.match(vitest, /Vitest/);
});

test('buildTestPrompt — instructs SKIP for untestable cases', () => {
  const prompt = buildTestPrompt({
    filePath: 'a.js', originalContent: 'a', fixedContent: 'b',
    issues: ['x'], framework: 'node:test',
  });
  assert.match(prompt, /SKIP/);
});

// ---------- generateTestForFix ----------

const okFix = {
  file: 'src/foo.js',
  original: 'function buggy() { return null; }',
  fixed: 'function fixed() { return 42; }',
  issues: ['returns null'],
};

const longTestContent = `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixed } from '../../src/foo.js';

test('regression: fixed() returns 42 not null', () => {
  assert.equal(fixed(), 42, 'fixed must return 42 — original returned null');
});
`.trim();

test('generateTestForFix — happy path returns test path + content', async () => {
  const result = await generateTestForFix({
    fix: okFix,
    askClaudeForTest: async () => longTestContent,
  });
  assert.equal(result.ok, true);
  assert.equal(result.test.path, 'tests/auto-generated/src_foo.test.js');
  assert.match(result.test.content, /regression: fixed/);
  assert.equal(result.reason, null);
});

test('generateTestForFix — strips markdown fences from response', async () => {
  const wrapped = '```javascript\n' + longTestContent + '\n```';
  const result = await generateTestForFix({
    fix: okFix,
    askClaudeForTest: async () => wrapped,
  });
  assert.equal(result.ok, true);
  assert.match(result.test.content, /^import \{ test \}/);
  assert.doesNotMatch(result.test.content, /```/);
});

test('generateTestForFix — Claude SKIP marker → reason recorded', async () => {
  const result = await generateTestForFix({
    fix: okFix,
    askClaudeForTest: async () => 'SKIP',
  });
  assert.equal(result.ok, false);
  assert.equal(result.test, null);
  assert.match(result.reason, /declined/);
});

test('generateTestForFix — Claude refusal recorded', async () => {
  const result = await generateTestForFix({
    fix: okFix,
    askClaudeForTest: async () => "I cannot help with that request.",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /refused/);
});

test('generateTestForFix — short response rejected', async () => {
  const result = await generateTestForFix({
    fix: okFix,
    askClaudeForTest: async () => 'test()',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /too short/);
});

test('generateTestForFix — empty response rejected', async () => {
  const result = await generateTestForFix({
    fix: okFix,
    askClaudeForTest: async () => '',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/);
});

test('generateTestForFix — AI provider error captured, not thrown', async () => {
  const result = await generateTestForFix({
    fix: okFix,
    askClaudeForTest: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /AI provider error: ECONNRESET/);
});

test('generateTestForFix — non-testable file (config) skipped', async () => {
  let calls = 0;
  const result = await generateTestForFix({
    fix: { file: 'package.json', original: '{}', fixed: '{"a":1}', issues: ['add a'] },
    askClaudeForTest: async () => { calls++; return longTestContent; },
  });
  assert.equal(calls, 0, 'should not call Claude for untestable files');
  assert.equal(result.ok, false);
  assert.match(result.reason, /not testable/);
});

test('generateTestForFix — CREATE_FILE (new file, no original) skipped', async () => {
  const result = await generateTestForFix({
    fix: { file: 'src/new.js', original: '', fixed: 'new code', issues: ['create file'] },
    askClaudeForTest: async () => longTestContent,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /new file/);
});

test('generateTestForFix — malformed fix entry handled gracefully', async () => {
  const result = await generateTestForFix({
    fix: null,
    askClaudeForTest: async () => longTestContent,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /malformed/);
});

test('generateTestForFix — no issues skipped', async () => {
  const result = await generateTestForFix({
    fix: { file: 'src/foo.js', original: 'a', fixed: 'b', issues: [] },
    askClaudeForTest: async () => longTestContent,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no issues/);
});

test('generateTestForFix — input validation throws on missing askClaudeForTest', async () => {
  await assert.rejects(
    () => generateTestForFix({ fix: okFix }),
    /askClaudeForTest must be a function/
  );
});

// ---------- generateTestsForFixes (batch) ----------

test('generateTestsForFixes — batch returns tests + skipped + summary', async () => {
  const fixes = [
    okFix,
    { file: 'package.json', original: '{}', fixed: '{"a":1}', issues: ['add a'] },
    { file: 'src/bar.js', original: 'old', fixed: 'new', issues: ['fix bar'] },
  ];
  const result = await generateTestsForFixes({
    fixes,
    askClaudeForTest: async () => longTestContent,
  });
  assert.equal(result.tests.length, 2);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].sourceFile, 'package.json');
  assert.match(result.summary, /2 regression tests written, 1 skipped/);
});

test('generateTestsForFixes — empty fix set', async () => {
  const result = await generateTestsForFixes({
    fixes: [],
    askClaudeForTest: async () => longTestContent,
  });
  assert.equal(result.tests.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.match(result.summary, /0 tests written/);
});

test('generateTestsForFixes — Claude failure on one fix does not abort batch', async () => {
  let calls = 0;
  const fixes = [
    okFix,
    { file: 'src/bar.js', original: 'old', fixed: 'new', issues: ['fix bar'] },
    { file: 'src/baz.js', original: 'old', fixed: 'new', issues: ['fix baz'] },
  ];
  const result = await generateTestsForFixes({
    fixes,
    askClaudeForTest: async () => {
      calls++;
      if (calls === 2) throw new Error('transient API error');
      return longTestContent;
    },
  });
  assert.equal(result.tests.length, 2);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /AI provider error/);
});

test('generateTestsForFixes — input validation', async () => {
  await assert.rejects(
    () => generateTestsForFixes({ fixes: 'no', askClaudeForTest: async () => '' }),
    /fixes must be an array/
  );
  await assert.rejects(
    () => generateTestsForFixes({ fixes: [] }),
    /askClaudeForTest must be a function/
  );
});

test('generateTestsForFixes — every test entry includes sourceFile for traceability', async () => {
  const result = await generateTestsForFixes({
    fixes: [okFix, { file: 'src/bar.js', original: 'old', fixed: 'new', issues: ['fix bar'] }],
    askClaudeForTest: async () => longTestContent,
  });
  assert.equal(result.tests[0].sourceFile, 'src/foo.js');
  assert.equal(result.tests[1].sourceFile, 'src/bar.js');
});
