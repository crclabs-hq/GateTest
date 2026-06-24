'use strict';
/**
 * Tests for src/core/bidirectional-test-gate.js
 *
 * Real Node.js source + test files are written to tmpdir so we can
 * test the negative / positive control paths end-to-end without Claude.
 * The correction loop path is tested via shape assertions only (no
 * live API key available in CI).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { verifyGeneratedTest } = require('../src/core/bidirectional-test-gate');

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gt-bidir-test-'));
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

// Minimal CJS module — buggy returns -1, fixed returns 1.
// Both source and test go to the SAME tmpdir so the test can use a
// relative require('./src') — avoids backslash-escaping issues on Windows.
const BUGGY_SOURCE  = `'use strict';\nmodule.exports = { compute: () => -1 };\n`;
const FIXED_SOURCE  = `'use strict';\nmodule.exports = { compute: () => 1 };\n`;

// Test that correctly detects the bug: asserts compute() === 1.
// Uses relative require — works because _runTestFile sets cwd=dirname(testPath).
const GOOD_TEST = `\
'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { compute } = require('./src');
test('compute returns 1', () => { assert.equal(compute(), 1); });
`;

// Test that is toothless: always passes regardless of the source
const TOOTHLESS_TEST = `\
'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
test('always passes', () => { assert.ok(true); });
`;

// ── module shape ──────────────────────────────────────────────────────────────

describe('bidirectional-test-gate shape', () => {
  test('exports verifyGeneratedTest as a function', () => {
    assert.equal(typeof verifyGeneratedTest, 'function');
  });

  test('returns certified:false when testPath is missing', async () => {
    const result = await verifyGeneratedTest({
      testPath: null,
      sourceFilePath: '/any/path.js',
      originalContent: 'x',
      fixedContent: 'y',
    });
    assert.equal(result.certified, false);
    assert.ok(typeof result.reason === 'string');
  });

  test('returns certified:false when sourceFilePath is missing', async () => {
    const result = await verifyGeneratedTest({
      testPath: '/some/test.js',
      sourceFilePath: null,
      originalContent: 'x',
      fixedContent: 'y',
    });
    assert.equal(result.certified, false);
  });

  test('returns certified:false when originalContent or fixedContent are not strings', async () => {
    const tmp = makeTmpDir();
    const src = write(tmp, 'src.js', BUGGY_SOURCE);
    const tst = write(tmp, 'test.js', TOOTHLESS_TEST);
    try {
      const r = await verifyGeneratedTest({
        testPath: tst, sourceFilePath: src,
        originalContent: null, fixedContent: null,
      });
      assert.equal(r.certified, false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('returns certified:false when test file absent and no testContent provided', async () => {
    const tmp = makeTmpDir();
    const src = write(tmp, 'src.js', BUGGY_SOURCE);
    try {
      const r = await verifyGeneratedTest({
        testPath: path.join(tmp, 'nonexistent.test.js'),
        sourceFilePath: src,
        originalContent: BUGGY_SOURCE,
        fixedContent: FIXED_SOURCE,
      });
      assert.equal(r.certified, false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ── negative control ──────────────────────────────────────────────────────────

describe('negative control', () => {
  test('negativePass:false when test passes against buggy code (toothless)', async () => {
    const tmp = makeTmpDir();
    const src = write(tmp, 'src.js', BUGGY_SOURCE);
    const tst = write(tmp, 'test.js', TOOTHLESS_TEST);
    try {
      const r = await verifyGeneratedTest({
        testPath: tst, sourceFilePath: src,
        originalContent: BUGGY_SOURCE, fixedContent: FIXED_SOURCE,
        maxCorrections: 0,
      });
      assert.equal(r.negativePass, false, 'toothless test should not detect the bug');
      assert.equal(r.certified, false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ── positive control ──────────────────────────────────────────────────────────

describe('positive control', () => {
  test('positivePass:false when fix does not match what test asserts', async () => {
    const tmp = makeTmpDir();
    const src = write(tmp, 'src.js', BUGGY_SOURCE);
    // Test asserts compute() === 1 — which the "fixed" source also gets wrong
    const WRONG_FIX = `'use strict';\nmodule.exports = { compute: () => -1 };\n`; // still wrong
    const tst = write(tmp, 'test.js', GOOD_TEST);
    try {
      const r = await verifyGeneratedTest({
        testPath: tst, sourceFilePath: src,
        originalContent: BUGGY_SOURCE, fixedContent: WRONG_FIX,
        maxCorrections: 0,
      });
      // Negative pass: test detects bug in original → true
      assert.equal(r.negativePass, true);
      // Positive pass: "fixed" source still returns -1 → test fails
      assert.equal(r.positivePass, false);
      assert.equal(r.certified, false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ── full certification (happy path) ──────────────────────────────────────────

describe('full certification', () => {
  test('certified:true when test fails on buggy and passes on fixed', async () => {
    const tmp = makeTmpDir();
    const src = write(tmp, 'src.js', BUGGY_SOURCE);
    const tst = write(tmp, 'test.js', GOOD_TEST);
    try {
      const r = await verifyGeneratedTest({
        testPath: tst, sourceFilePath: src,
        originalContent: BUGGY_SOURCE, fixedContent: FIXED_SOURCE,
        maxCorrections: 0,
      });
      assert.equal(r.negativePass, true,  'test catches the bug in original code');
      assert.equal(r.positivePass, true,  'test passes with the fixed code');
      assert.equal(r.certified,    true);
      assert.equal(typeof r.finalTestContent, 'string');
      assert.equal(r.correctionsMade, 0);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ── source file restoration ───────────────────────────────────────────────────

describe('source file restoration', () => {
  test('source file is restored to its pre-call state after gate runs', async () => {
    const tmp = makeTmpDir();
    const src = write(tmp, 'src.js', FIXED_SOURCE); // starts at fixed
    const tst = write(tmp, 'test.js', GOOD_TEST);
    try {
      await verifyGeneratedTest({
        testPath: tst, sourceFilePath: src,
        originalContent: BUGGY_SOURCE, fixedContent: FIXED_SOURCE,
        maxCorrections: 0,
      });
      // Source should be restored to what it was before the call (FIXED_SOURCE)
      const afterContent = fs.readFileSync(src, 'utf-8');
      assert.equal(afterContent, FIXED_SOURCE, 'source restored to pre-call state');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('source file is restored even when certification fails', async () => {
    const tmp = makeTmpDir();
    const src = write(tmp, 'src.js', FIXED_SOURCE);
    const tst = write(tmp, 'test.js', TOOTHLESS_TEST);
    try {
      await verifyGeneratedTest({
        testPath: tst, sourceFilePath: src,
        originalContent: BUGGY_SOURCE, fixedContent: FIXED_SOURCE,
        maxCorrections: 0,
      });
      assert.equal(fs.readFileSync(src, 'utf-8'), FIXED_SOURCE);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ── test file lifecycle ───────────────────────────────────────────────────────

describe('test file lifecycle', () => {
  test('test file written by gate is removed on failed certification', async () => {
    const tmp = makeTmpDir();
    const src = write(tmp, 'src.js', BUGGY_SOURCE);
    const testPath = path.join(tmp, 'auto.test.js');
    // testPath does NOT exist yet — gate writes it, then cleans up on failure
    try {
      const r = await verifyGeneratedTest({
        testPath,
        testContent: TOOTHLESS_TEST, // toothless → won't certify
        sourceFilePath: src,
        originalContent: BUGGY_SOURCE,
        fixedContent: FIXED_SOURCE,
        maxCorrections: 0,
      });
      assert.equal(r.certified, false);
      assert.equal(fs.existsSync(testPath), false, 'gate should remove uncertified generated test');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('pre-existing test file is not removed after failed gate', async () => {
    const tmp = makeTmpDir();
    const src = write(tmp, 'src.js', BUGGY_SOURCE);
    const tst = write(tmp, 'test.js', TOOTHLESS_TEST); // EXISTS before gate
    try {
      await verifyGeneratedTest({
        testPath: tst, sourceFilePath: src,
        originalContent: BUGGY_SOURCE, fixedContent: FIXED_SOURCE,
        maxCorrections: 0,
      });
      assert.equal(fs.existsSync(tst), true, 'pre-existing test must not be deleted');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ── correction loop shape ─────────────────────────────────────────────────────

describe('correction loop shape', () => {
  test('correctionsMade is 0 when maxCorrections is 0', async () => {
    const tmp = makeTmpDir();
    const src = write(tmp, 'src.js', BUGGY_SOURCE);
    const tst = write(tmp, 'test.js', TOOTHLESS_TEST);
    try {
      const r = await verifyGeneratedTest({
        testPath: tst, sourceFilePath: src,
        originalContent: BUGGY_SOURCE, fixedContent: FIXED_SOURCE,
        apiKey: 'fake-key-should-not-be-called',
        maxCorrections: 0,
      });
      assert.equal(r.correctionsMade, 0);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
