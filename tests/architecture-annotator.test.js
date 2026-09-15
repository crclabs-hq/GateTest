// ============================================================================
// ARCHITECTURE-ANNOTATOR TEST — Phase 2.2 of THE FIX-FIRST BUILD PLAN
// ============================================================================
// Covers website/app/lib/architecture-annotator.js — the second
// $199-tier depth deliverable. Reads the codebase SHAPE (not per-file)
// and produces a "design observations" report. INFORMATIONAL only —
// no auto-refactor.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  annotateArchitecture,
  renderArchitectureComment,
  isArchitecturallyInteresting,
  summariseCodebase,
  pickSampleFiles,
  buildArchitecturePrompt,
  parseArchitectureOutput,
} = require('../website/app/lib/architecture-annotator.js');

const validReport = `# Architecture observations

## Summary
This is a small Next.js app with a clear src/ + website/ split. The route layer mixes business logic with HTTP concerns, which will become harder to test as it grows.

## Observations
1. **Route layer is doing business logic** — \`website/app/api/scan/fix/route.ts\` is 800+ lines and handles GitHub I/O, Claude calls, gate orchestration, and HTTP shaping all in one file. Pull the orchestration into a service.
2. **Helpers vs lib boundary unclear** — both \`website/app/lib/\` and \`src/core/\` hold reusable helpers. New code lands in either by accident.

## Recommendations
- Extract the fix orchestrator into a service module
- Pick one home for cross-cutting helpers and stick to it
`;

// ---------- isArchitecturallyInteresting ----------

test('isArchitecturallyInteresting — JS/TS source accepted', () => {
  assert.equal(isArchitecturallyInteresting('src/app.js'), true);
  assert.equal(isArchitecturallyInteresting('website/app/page.tsx'), true);
  assert.equal(isArchitecturallyInteresting('lib/foo.mjs'), true);
});

test('isArchitecturallyInteresting — multi-language source accepted', () => {
  assert.equal(isArchitecturallyInteresting('src/main.py'), true);
  assert.equal(isArchitecturallyInteresting('cmd/serve.go'), true);
  assert.equal(isArchitecturallyInteresting('src/lib.rs'), true);
  assert.equal(isArchitecturallyInteresting('Service.java'), true);
  assert.equal(isArchitecturallyInteresting('App.kt'), true);
  assert.equal(isArchitecturallyInteresting('main.rb'), true);
});

test('isArchitecturallyInteresting — node_modules / build / dist excluded', () => {
  assert.equal(isArchitecturallyInteresting('node_modules/foo/index.js'), false);
  assert.equal(isArchitecturallyInteresting('website/.next/page.js'), false);
  assert.equal(isArchitecturallyInteresting('dist/bundle.js'), false);
  assert.equal(isArchitecturallyInteresting('build/main.js'), false);
  assert.equal(isArchitecturallyInteresting('coverage/index.js'), false);
  assert.equal(isArchitecturallyInteresting('vendor/foo/main.js'), false);
});

test('isArchitecturallyInteresting — tests / specs / minified excluded', () => {
  assert.equal(isArchitecturallyInteresting('tests/foo.test.js'), false);
  assert.equal(isArchitecturallyInteresting('src/foo.spec.ts'), false);
  assert.equal(isArchitecturallyInteresting('src/foo.test.tsx'), false);
  assert.equal(isArchitecturallyInteresting('public/jquery.min.js'), false);
});

test('isArchitecturallyInteresting — docs / config / assets excluded', () => {
  assert.equal(isArchitecturallyInteresting('README.md'), false);
  assert.equal(isArchitecturallyInteresting('package.json'), false);
  assert.equal(isArchitecturallyInteresting('Dockerfile'), false);
  assert.equal(isArchitecturallyInteresting('logo.svg'), false);
});

test('isArchitecturallyInteresting — handles malformed input', () => {
  assert.equal(isArchitecturallyInteresting(''), false);
  assert.equal(isArchitecturallyInteresting(null), false);
  assert.equal(isArchitecturallyInteresting('no-extension'), false);
});

// ---------- summariseCodebase ----------

test('summariseCodebase — empty input', () => {
  const s = summariseCodebase([]);
  assert.equal(s.totalFiles, 0);
  assert.equal(s.sourceFiles, 0);
  assert.deepEqual(s.topDirectories, []);
  assert.deepEqual(s.largestFiles, []);
});

test('summariseCodebase — counts source files, ignores excluded', () => {
  const s = summariseCodebase([
    { path: 'src/foo.js', content: 'a'.repeat(100) },
    { path: 'src/bar.ts', content: 'b'.repeat(200) },
    { path: 'tests/foo.test.js', content: 'c'.repeat(50) }, // excluded
    { path: 'package.json', content: '{}' },                // excluded (extension)
    { path: 'node_modules/x/index.js', content: 'x' },      // excluded
  ]);
  assert.equal(s.totalFiles, 5);
  assert.equal(s.sourceFiles, 2);
  assert.equal(s.totalBytes, 300);
});

test('summariseCodebase — top directories ranked by file count', () => {
  const s = summariseCodebase([
    { path: 'src/a.js', content: 'a' },
    { path: 'src/b.js', content: 'a' },
    { path: 'src/c.js', content: 'a' },
    { path: 'website/d.ts', content: 'a' },
    { path: 'website/e.ts', content: 'a' },
    { path: 'lib/f.js', content: 'a' },
  ]);
  assert.equal(s.topDirectories[0].dir, 'src');
  assert.equal(s.topDirectories[0].count, 3);
  assert.equal(s.topDirectories[1].dir, 'website');
  assert.equal(s.topDirectories[1].count, 2);
});

test('summariseCodebase — extension counts ranked', () => {
  const s = summariseCodebase([
    { path: 'a.js', content: 'a' },
    { path: 'b.js', content: 'a' },
    { path: 'c.ts', content: 'a' },
  ]);
  assert.equal(s.extensionCounts['.js'], 2);
  assert.equal(s.extensionCounts['.ts'], 1);
});

test('summariseCodebase — largest files sorted descending', () => {
  const s = summariseCodebase([
    { path: 'small.js', content: 'a'.repeat(100) },
    { path: 'big.js', content: 'a'.repeat(1000) },
    { path: 'medium.js', content: 'a'.repeat(500) },
  ]);
  assert.equal(s.largestFiles[0].path, 'big.js');
  assert.equal(s.largestFiles[0].bytes, 1000);
  assert.equal(s.largestFiles[1].path, 'medium.js');
  assert.equal(s.largestFiles[2].path, 'small.js');
});

// ---------- pickSampleFiles ----------

test('pickSampleFiles — picks N largest, ordered by size desc', () => {
  const sample = pickSampleFiles([
    { path: 'a.js', content: 'a'.repeat(100) },
    { path: 'b.js', content: 'a'.repeat(500) },
    { path: 'c.js', content: 'a'.repeat(300) },
  ], 2);
  assert.equal(sample.length, 2);
  assert.equal(sample[0].path, 'b.js');
  assert.equal(sample[1].path, 'c.js');
});

test('pickSampleFiles — truncates content above maxFileBytes', () => {
  const sample = pickSampleFiles([
    { path: 'big.js', content: 'a'.repeat(20_000) },
  ], 1, 5_000);
  assert.equal(sample[0].content.length, 5_000);
  assert.equal(sample[0].truncated, true);
  assert.equal(sample[0].originalBytes, 20_000);
});

test('pickSampleFiles — non-source files excluded', () => {
  const sample = pickSampleFiles([
    { path: 'README.md', content: 'a'.repeat(1_000_000) },
    { path: 'src/x.js', content: 'a'.repeat(100) },
  ]);
  assert.equal(sample.length, 1);
  assert.equal(sample[0].path, 'src/x.js');
});

test('pickSampleFiles — empty input', () => {
  assert.deepEqual(pickSampleFiles([]), []);
  assert.deepEqual(pickSampleFiles(null), []);
});

// ---------- buildArchitecturePrompt ----------

test('buildArchitecturePrompt — includes summary metrics + sample blocks', () => {
  const summary = summariseCodebase([
    { path: 'src/big.js', content: 'a'.repeat(500) },
  ]);
  const sampleFiles = [{ path: 'src/big.js', content: 'function big() {}', truncated: false, originalBytes: 500 }];
  const prompt = buildArchitecturePrompt({ summary, sampleFiles });
  assert.match(prompt, /CODEBASE SUMMARY/);
  assert.match(prompt, /Total files: 1/);
  assert.match(prompt, /Source files: 1/);
  assert.match(prompt, /src\/big\.js/);
  assert.match(prompt, /function big/);
  assert.match(prompt, /design observations/);
  assert.match(prompt, /SKIP/);
});

test('buildArchitecturePrompt — flags truncation when present', () => {
  const sampleFiles = [{ path: 'a.js', content: 'short', truncated: true, originalBytes: 99999 }];
  const prompt = buildArchitecturePrompt({
    summary: summariseCodebase([{ path: 'a.js', content: 'short' }]),
    sampleFiles,
  });
  assert.match(prompt, /TRUNCATED/);
  assert.match(prompt, /99999 bytes/);
});

test('buildArchitecturePrompt — explicit instruction not to repeat per-file findings', () => {
  const prompt = buildArchitecturePrompt({
    summary: summariseCodebase([{ path: 'a.js', content: 'a' }]),
    sampleFiles: [{ path: 'a.js', content: 'a', truncated: false, originalBytes: 1 }],
  });
  assert.match(prompt, /Do NOT/);
  assert.match(prompt, /per-file scanner would have already caught/);
});

// ---------- parseArchitectureOutput ----------

test('parseArchitectureOutput — happy path', () => {
  const result = parseArchitectureOutput(validReport);
  assert.equal(result.ok, true);
  assert.match(result.body, /Architecture observations/);
});

test('parseArchitectureOutput — SKIP marker', () => {
  const result = parseArchitectureOutput('SKIP: codebase too small');
  assert.equal(result.ok, false);
  assert.match(result.reason, /declined/);
});

test('parseArchitectureOutput — refusal recognised', () => {
  const result = parseArchitectureOutput("I cannot generate this report.");
  assert.equal(result.ok, false);
  assert.match(result.reason, /refused/);
});

test('parseArchitectureOutput — missing required section', () => {
  const noSummary = `# Architecture observations
## Observations
1. **A** — long enough text here to satisfy the length floor lorem ipsum dolor sit amet consectetur adipisicing elit
## Recommendations
- one`;
  const result = parseArchitectureOutput(noSummary);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing required section.*Summary/);
});

test('parseArchitectureOutput — too short', () => {
  const tiny = `# Architecture observations
## Summary
ok
## Observations
- a
## Recommendations
- b`;
  const result = parseArchitectureOutput(tiny);
  assert.equal(result.ok, false);
  assert.match(result.reason, /too short/);
});

test('parseArchitectureOutput — empty / non-string', () => {
  assert.equal(parseArchitectureOutput('').ok, false);
  assert.equal(parseArchitectureOutput(null).ok, false);
  assert.equal(parseArchitectureOutput(42).ok, false);
});

// ---------- annotateArchitecture (orchestrator) ----------

const sufficientWorkspace = [
  { path: 'src/a.js', content: 'function a() { return 1; }' },
  { path: 'src/b.js', content: 'function b() { return 2; }' },
  { path: 'src/c.js', content: 'function c() { return 3; }' },
  { path: 'src/d.js', content: 'function d() { return 4; }' },
];

test('annotateArchitecture — happy path', async () => {
  const result = await annotateArchitecture({
    fileContents: sufficientWorkspace,
    askClaudeForArchitecture: async () => validReport,
  });
  assert.equal(result.ok, true);
  assert.match(result.body, /Architecture observations/);
  assert.equal(result.summary.sourceFiles, 4);
  assert.ok(result.sampleFiles.length > 0);
});

test('annotateArchitecture — too few source files → returns ok=false with reason', async () => {
  const result = await annotateArchitecture({
    fileContents: [
      { path: 'src/a.js', content: 'a' },
      { path: 'src/b.js', content: 'b' },
    ],
    askClaudeForArchitecture: async () => validReport,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /codebase too small/);
});

test('annotateArchitecture — AI provider error captured', async () => {
  const result = await annotateArchitecture({
    fileContents: sufficientWorkspace,
    askClaudeForArchitecture: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /AI provider error: ECONNRESET/);
  assert.ok(result.summary);
  assert.ok(result.sampleFiles); // sample built before Claude call
});

test('annotateArchitecture — invalid Claude response captured', async () => {
  const result = await annotateArchitecture({
    fileContents: sufficientWorkspace,
    askClaudeForArchitecture: async () => 'plain text with no sections',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing required section/);
});

test('annotateArchitecture — passes repoUrl into prompt', async () => {
  let promptSeen = '';
  await annotateArchitecture({
    fileContents: sufficientWorkspace,
    repoUrl: 'https://github.com/test/repo',
    askClaudeForArchitecture: async (p) => { promptSeen = p; return validReport; },
  });
  assert.match(promptSeen, /github\.com\/test\/repo/);
});

test('annotateArchitecture — input validation', async () => {
  await assert.rejects(
    () => annotateArchitecture({ fileContents: 'no', askClaudeForArchitecture: async () => '' }),
    /fileContents must be an array/
  );
  await assert.rejects(
    () => annotateArchitecture({ fileContents: [] }),
    /askClaudeForArchitecture must be a function/
  );
});

// ---------- renderArchitectureComment ----------

test('renderArchitectureComment — successful report includes body + footer + sample note', () => {
  const result = {
    ok: true,
    body: validReport,
    summary: { sourceFiles: 50 },
    sampleFiles: [{ path: 'a.js', bytes: 100 }, { path: 'b.js', bytes: 200 }],
  };
  const comment = renderArchitectureComment(result);
  assert.match(comment, /Architecture observations/);
  assert.match(comment, /\$199 Scan \+ Fix/);
  assert.match(comment, /INFORMATIONAL/);
  assert.match(comment, /Sampled 2 of 50/);
});

test('renderArchitectureComment — failure renders friendly placeholder', () => {
  const result = {
    ok: false,
    body: null,
    reason: 'AI provider error',
    summary: { sourceFiles: 5 },
    sampleFiles: null,
  };
  const comment = renderArchitectureComment(result);
  assert.match(comment, /Architecture Observations/);
  assert.match(comment, /not generated/);
  assert.match(comment, /AI provider error/);
});

test('renderArchitectureComment — null result handled', () => {
  const comment = renderArchitectureComment(null);
  assert.match(comment, /Architecture Observations/);
  assert.match(comment, /not generated/);
});
