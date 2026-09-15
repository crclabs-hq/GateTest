// ============================================================================
// PR-COMPOSER TEST — Phase 1.4 of THE FIX-FIRST BUILD PLAN
// ============================================================================
// Covers website/app/lib/pr-composer.js — the helper that builds the
// markdown PR body from the artifacts the orchestrator collects (fixes,
// errors, attempt history, gate results, before/after findings,
// regression tests).
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  composePrBody,
  renderAttemptHistoryTable,
  renderGateResults,
  renderBeforeAfterScan,
  renderFixedFiles,
  renderRegressionTests,
  renderErrors,
} = require('../website/app/lib/pr-composer.js');

// ---------- renderAttemptHistoryTable ----------

test('renderAttemptHistoryTable — empty input returns empty string', () => {
  assert.equal(renderAttemptHistoryTable(undefined), '');
  assert.equal(renderAttemptHistoryTable(null), '');
  assert.equal(renderAttemptHistoryTable({}), '');
});

test('renderAttemptHistoryTable — single file with one attempt', () => {
  const out = renderAttemptHistoryTable({
    'src/foo.js': {
      success: true,
      attempts: [
        { attemptNumber: 1, durationMs: 250, outcome: 'success' },
      ],
    },
  });
  assert.match(out, /Per-file fix history/);
  assert.match(out, /\| File \| Attempts \| Outcomes \| AI time \| Final \|/);
  assert.match(out, /✅ `src\/foo\.js`/);
  assert.match(out, /250ms/);
  assert.match(out, /1× success/);
});

test('renderAttemptHistoryTable — failure recorded with breakdown', () => {
  const out = renderAttemptHistoryTable({
    'src/foo.js': {
      success: false,
      attempts: [
        { attemptNumber: 1, durationMs: 100, outcome: 'quality-fail' },
        { attemptNumber: 2, durationMs: 150, outcome: 'quality-fail' },
        { attemptNumber: 3, durationMs: 200, outcome: 'quality-fail' },
      ],
    },
  });
  assert.match(out, /❌ `src\/foo\.js`/);
  assert.match(out, /3× quality-fail/);
  assert.match(out, /450ms/);
});

test('renderAttemptHistoryTable — multiple files', () => {
  const out = renderAttemptHistoryTable({
    'src/a.js': { success: true, attempts: [{ attemptNumber: 1, durationMs: 100, outcome: 'success' }] },
    'src/b.js': { success: true, attempts: [{ attemptNumber: 1, durationMs: 100, outcome: 'success' }] },
  });
  assert.match(out, /src\/a\.js/);
  assert.match(out, /src\/b\.js/);
});

// ---------- renderGateResults ----------

test('renderGateResults — empty when nothing supplied', () => {
  assert.equal(renderGateResults({}), '');
});

test('renderGateResults — syntax + scanner + test summaries', () => {
  const out = renderGateResults({
    syntaxGate: { summary: 'syntax gate: 5 fixes validated, all clean' },
    scannerGate: { summary: 'scanner gate: 5 fixes validated, no regressions' },
    testGen: { summary: 'test generation: 4 regression tests written, 1 skipped' },
  });
  assert.match(out, /Gate results/);
  assert.match(out, /Syntax gate.*5 fixes validated/);
  assert.match(out, /Cross-file scanner gate.*no regressions/);
  assert.match(out, /Test generation.*4 regression tests/);
});

test('renderGateResults — scanner skipped reason rendered', () => {
  const out = renderGateResults({
    syntaxGate: { summary: 'syntax gate: 1 fix validated, all clean' },
    scannerGate: { skipped: true, reason: 'caller did not pass scan baseline' },
  });
  assert.match(out, /scanner gate.*skipped.*caller did not pass/);
});

// ---------- renderBeforeAfterScan ----------

test('renderBeforeAfterScan — empty when no findings', () => {
  assert.equal(renderBeforeAfterScan({}), '');
  assert.equal(renderBeforeAfterScan({
    originalFindingsByModule: {},
    postFixFindingsByModule: {},
  }), '');
});

test('renderBeforeAfterScan — shows reduction in findings', () => {
  const out = renderBeforeAfterScan({
    originalFindingsByModule: {
      syntax: ['e1', 'e2', 'e3'],
      lint: ['l1'],
    },
    postFixFindingsByModule: {
      syntax: [],
      lint: [],
    },
  });
  assert.match(out, /Before vs after/);
  assert.match(out, /\| `syntax` \| 3 \| 0 \| -3 ✅ \|/);
  assert.match(out, /\| `lint` \| 1 \| 0 \| -1 ✅ \|/);
  assert.match(out, /\*\*TOTAL\*\* \| \*\*4\*\* \| \*\*0\*\* \| \*\*-4 ✅\*\*/);
});

test('renderBeforeAfterScan — flags regression with warning marker', () => {
  const out = renderBeforeAfterScan({
    originalFindingsByModule: { lint: [] },
    postFixFindingsByModule: { lint: ['l1', 'l2'] },
  });
  assert.match(out, /\| `lint` \| 0 \| 2 \| \+2 ⚠️/);
});

test('renderBeforeAfterScan — clean-throughout modules omitted', () => {
  const out = renderBeforeAfterScan({
    originalFindingsByModule: { syntax: [], lint: ['l1'] },
    postFixFindingsByModule: { syntax: [], lint: [] },
  });
  assert.doesNotMatch(out, /`syntax`/);
  assert.match(out, /`lint`/);
});

// ---------- renderFixedFiles ----------

test('renderFixedFiles — empty list', () => {
  assert.equal(renderFixedFiles([]), '');
  assert.equal(renderFixedFiles(undefined), '');
});

test('renderFixedFiles — single file with one issue', () => {
  const out = renderFixedFiles([
    { file: 'src/foo.js', issues: ['removed unused import'] },
  ]);
  assert.match(out, /Fixed files/);
  assert.match(out, /<details>/);
  assert.match(out, /<strong>src\/foo\.js<\/strong>/);
  assert.match(out, /1 fix\b/);
  assert.match(out, /✅ removed unused import/);
});

test('renderFixedFiles — auto-generated tests are excluded (rendered separately)', () => {
  const out = renderFixedFiles([
    { file: 'src/foo.js', issues: ['fix one'] },
    { file: 'tests/auto-generated/src_foo.test.js', issues: ['Regression test for src/foo.js'] },
  ]);
  assert.match(out, /src\/foo\.js/);
  assert.doesNotMatch(out, /tests\/auto-generated/);
});

// ---------- renderRegressionTests ----------

test('renderRegressionTests — empty when no auto-generated tests', () => {
  assert.equal(renderRegressionTests([]), '');
  assert.equal(renderRegressionTests([{ file: 'src/foo.js', issues: ['x'] }]), '');
});

test('renderRegressionTests — lists tests with source-file traceability', () => {
  const out = renderRegressionTests([
    { file: 'src/foo.js', issues: ['fix'] },
    { file: 'tests/auto-generated/src_foo.test.js', issues: ['Regression test for src/foo.js'] },
    { file: 'tests/auto-generated/src_bar.test.js', issues: ['Regression test for src/bar.js'] },
  ]);
  assert.match(out, /Regression tests added/);
  assert.match(out, /2 new regression tests/);
  assert.match(out, /tests\/auto-generated\/src_foo\.test\.js.*src\/foo\.js/);
  assert.match(out, /tests\/auto-generated\/src_bar\.test\.js.*src\/bar\.js/);
});

// ---------- renderErrors ----------

test('renderErrors — empty list', () => {
  assert.equal(renderErrors([]), '');
  assert.equal(renderErrors(undefined), '');
});

test('renderErrors — formats as bulleted advisory section', () => {
  const out = renderErrors(['Skipped src/big.js: file too large', 'Rolled back src/x.js: introduced 2 new findings']);
  assert.match(out, /Advisory — items that did not fix cleanly/);
  assert.match(out, /- Skipped src\/big\.js/);
  assert.match(out, /- Rolled back src\/x\.js/);
});

// ---------- composePrBody (full integration) ----------

test('composePrBody — full report with all artifacts', () => {
  const body = composePrBody({
    fixes: [
      { file: 'src/foo.js', original: 'old', fixed: 'new', issues: ['removed unused import', 'fixed null check'] },
      { file: 'tests/auto-generated/src_foo.test.js', original: '', fixed: 'test code', issues: ['Regression test for src/foo.js'] },
    ],
    errors: ['Skipped src/big.js: file too large'],
    attemptHistoryByFile: {
      'src/foo.js': {
        success: true,
        attempts: [
          { attemptNumber: 1, durationMs: 200, outcome: 'quality-fail' },
          { attemptNumber: 2, durationMs: 300, outcome: 'success' },
        ],
      },
    },
    syntaxGate: { summary: 'syntax gate: 1 fix validated, all clean' },
    scannerGate: { summary: 'scanner gate: 1 fix validated, no regressions' },
    testGen: { summary: 'test generation: 1 regression test written, 0 skipped' },
    originalFindingsByModule: {
      lint: ['src/foo.js: unused import', 'src/foo.js: null check'],
    },
    postFixFindingsByModule: {
      lint: [],
    },
  });

  // Header
  assert.match(body, /## GateTest Auto-Fix Report/);
  assert.match(body, /\*\*2 issues fixed\*\* across \*\*1 file\*\*/);
  assert.match(body, /\*\*1 regression test added\*\*/);

  // Before/after
  assert.match(body, /Before vs after/);
  assert.match(body, /-2 ✅/);

  // Gates
  assert.match(body, /Gate results/);
  assert.match(body, /Syntax gate/);
  assert.match(body, /scanner gate/);
  assert.match(body, /Test generation/);

  // Attempt history
  assert.match(body, /Per-file fix history/);
  assert.match(body, /1× quality-fail/);
  assert.match(body, /1× success/);

  // Fixed files (real fix only, not the test file)
  assert.match(body, /Fixed files/);
  assert.match(body, /src\/foo\.js/);

  // Regression tests
  assert.match(body, /Regression tests added/);
  assert.match(body, /1 new regression test/);

  // Advisory
  assert.match(body, /Advisory/);
  assert.match(body, /Skipped src\/big\.js/);

  // How it works + footer
  assert.match(body, /How GateTest works/);
  assert.match(body, /Next steps/);
  assert.match(body, /Scanned and fixed by/);
});

test('composePrBody — minimal input (just fixes) produces valid markdown', () => {
  const body = composePrBody({
    fixes: [{ file: 'src/foo.js', original: 'old', fixed: 'new', issues: ['fix'] }],
  });
  assert.match(body, /## GateTest Auto-Fix Report/);
  assert.match(body, /1 issue fixed/);
  assert.doesNotMatch(body, /Before vs after/); // no findings supplied
  assert.doesNotMatch(body, /Per-file fix history/);
  assert.doesNotMatch(body, /Regression tests added/);
});

test('composePrBody — handles 0 fixes gracefully (still valid markdown)', () => {
  const body = composePrBody({ fixes: [], errors: ['Everything was rolled back'] });
  assert.match(body, /## GateTest Auto-Fix Report/);
  assert.match(body, /Everything was rolled back/);
});

test('composePrBody — handles plural / singular correctly', () => {
  const single = composePrBody({
    fixes: [{ file: 'a.js', original: 'a', fixed: 'b', issues: ['i'] }],
  });
  assert.match(single, /1 issue fixed/);
  assert.match(single, /1 file/);

  const multi = composePrBody({
    fixes: [
      { file: 'a.js', original: 'a', fixed: 'b', issues: ['i1', 'i2'] },
      { file: 'b.js', original: 'a', fixed: 'b', issues: ['i3'] },
    ],
  });
  assert.match(multi, /3 issues fixed/);
  assert.match(multi, /2 files/);
});

test('composePrBody — order: header, before/after, gates, history, fixes, tests, advisory, how-it-works, next, footer', () => {
  const body = composePrBody({
    fixes: [
      { file: 'src/foo.js', original: 'a', fixed: 'b', issues: ['i'] },
      { file: 'tests/auto-generated/src_foo.test.js', original: '', fixed: 'test', issues: ['Regression test for src/foo.js'] },
    ],
    errors: ['advisory'],
    attemptHistoryByFile: {
      'src/foo.js': { success: true, attempts: [{ attemptNumber: 1, durationMs: 100, outcome: 'success' }] },
    },
    syntaxGate: { summary: 's' },
    scannerGate: { summary: 'sc' },
    testGen: { summary: 't' },
    originalFindingsByModule: { lint: ['x'] },
    postFixFindingsByModule: { lint: [] },
  });

  const positions = {
    header: body.indexOf('## GateTest Auto-Fix Report'),
    beforeAfter: body.indexOf('Before vs after'),
    gates: body.indexOf('Gate results'),
    history: body.indexOf('Per-file fix history'),
    fixed: body.indexOf('Fixed files'),
    tests: body.indexOf('Regression tests added'),
    advisory: body.indexOf('Advisory'),
    howItWorks: body.indexOf('How GateTest works'),
    nextSteps: body.indexOf('Next steps'),
    footer: body.indexOf('Scanned and fixed by'),
  };
  // Every position should be present and in the expected order
  Object.entries(positions).forEach(([name, pos]) => {
    assert.notEqual(pos, -1, `section '${name}' should be present`);
  });
  const ordered = [
    positions.header,
    positions.beforeAfter,
    positions.gates,
    positions.history,
    positions.fixed,
    positions.tests,
    positions.advisory,
    positions.howItWorks,
    positions.nextSteps,
    positions.footer,
  ];
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(ordered[i] > ordered[i - 1], `section ${i} should come after section ${i - 1}`);
  }
});

test('composePrBody — does NOT include scanner-gate result BULLET when no scannerGate provided', () => {
  const body = composePrBody({
    fixes: [{ file: 'a.js', original: 'a', fixed: 'b', issues: ['i'] }],
    syntaxGate: { summary: 'syntax gate: 1 fix' },
  });
  // No scanner gate object → no `- **Cross-file scanner gate**` bullet
  // in the Gate results section. The "How GateTest works" section
  // uses `4. **Cross-file scanner gate**` (numbered, not bulleted) and
  // is general explanation — that's allowed to mention every gate.
  assert.doesNotMatch(body, /^- \*\*Cross-file scanner gate\*\*/m);
});

test('composePrBody — issues count counts ALL issues across fixes, not just fixes count', () => {
  const body = composePrBody({
    fixes: [
      { file: 'a.js', original: 'a', fixed: 'b', issues: ['i1', 'i2', 'i3'] },
      { file: 'b.js', original: 'a', fixed: 'b', issues: ['i4', 'i5'] },
    ],
  });
  assert.match(body, /5 issues fixed/);
});
