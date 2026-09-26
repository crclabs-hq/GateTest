'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CONFIDENCE,
  BLOCK_THRESHOLD,
  DEFAULT_RULE_OVERRIDES,
  scoreFinding,
  isBlockingFinding,
  wouldBlockFinding,
  _signals,
} = require('../src/core/confidence');

// ─── constants ──────────────────────────────────────────────────────────────

test('DEFAULT_CONFIDENCE is 1.0', () => {
  assert.equal(DEFAULT_CONFIDENCE, 1.0);
});

test('BLOCK_THRESHOLD is 0.7', () => {
  assert.equal(BLOCK_THRESHOLD, 0.7);
});

test('DEFAULT_RULE_OVERRIDES is frozen', () => {
  assert.ok(Object.isFrozen(DEFAULT_RULE_OVERRIDES));
});

// ─── individual signals ─────────────────────────────────────────────────────

test('isDocFile fires on .md / .mdx / .rst', () => {
  assert.ok(_signals.isDocFile('README.md'));
  assert.ok(_signals.isDocFile('docs/guide.mdx'));
  assert.ok(_signals.isDocFile('manual.rst'));
  assert.equal(_signals.isDocFile('src/index.js'), null);
});

test('isTestFile fires on tests/, *.test.*, *.spec.*, __tests__/', () => {
  assert.ok(_signals.isTestFile('tests/foo.test.js'));
  assert.ok(_signals.isTestFile('src/foo.test.ts'));
  assert.ok(_signals.isTestFile('src/foo.spec.js'));
  assert.ok(_signals.isTestFile('src/__tests__/foo.js'));
  assert.equal(_signals.isTestFile('src/index.js'), null);
});

test('isFixtureFile fires on fixtures/, __fixtures__/, test-data/, mocks/, stubs/', () => {
  assert.ok(_signals.isFixtureFile('tests/fixtures/data.json'));
  assert.ok(_signals.isFixtureFile('src/__fixtures__/a.js'));
  assert.ok(_signals.isFixtureFile('test-data/sample.json'));
  assert.ok(_signals.isFixtureFile('src/mocks/server.js'));
  assert.ok(_signals.isFixtureFile('test/stubs/x.js'));
  assert.equal(_signals.isFixtureFile('src/index.js'), null);
});

test('isExampleDataFile fires on example*, sample*, demo*, docs/', () => {
  assert.ok(_signals.isExampleDataFile('docs/api.md'));
  assert.ok(_signals.isExampleDataFile('examples/basic.js'));
  assert.ok(_signals.isExampleDataFile('sample-config.json'));
  assert.ok(_signals.isExampleDataFile('demo-app.js'));
  assert.equal(_signals.isExampleDataFile('src/index.js'), null);
});

test('isHomeworkDir fires on node_modules, dist, build, .next, coverage, vendor', () => {
  assert.ok(_signals.isHomeworkDir('node_modules/foo/index.js'));
  assert.ok(_signals.isHomeworkDir('dist/main.js'));
  assert.ok(_signals.isHomeworkDir('build/out.js'));
  assert.ok(_signals.isHomeworkDir('website/.next/static/x.js'));
  assert.ok(_signals.isHomeworkDir('coverage/lcov.info'));
  assert.ok(_signals.isHomeworkDir('vendor/lib.js'));
  assert.equal(_signals.isHomeworkDir('src/index.js'), null);
});

test('isInsideBlockComment detects target line inside block comment', () => {
  const src = 'const a = 1;\n/* this is a\n  multi-line comment\n*/\nconst b = 2;';
  // Line 3 is inside the block comment
  assert.ok(_signals.isInsideBlockComment(src, 3));
  // Line 1 is not
  assert.equal(_signals.isInsideBlockComment(src, 1), null);
  // Line 5 is after the comment closes
  assert.equal(_signals.isInsideBlockComment(src, 5), null);
});

test('isInsideBlockComment detects line-comment-only lines', () => {
  const src = 'const a = 1;\n// just a comment\nconst b = 2;';
  assert.ok(_signals.isInsideBlockComment(src, 2));
});

test('isInsideStringLiteral with column detects string position', () => {
  const src = 'const url = "http://localhost:3000";';
  // Column 20 is inside the string
  assert.ok(_signals.isInsideStringLiteral(src, 1, 20));
  // Column 0 is not
  assert.equal(_signals.isInsideStringLiteral(src, 1, 0), null);
});

test('isInsideStringLiteral conservatively flags doc-string-shape lines', () => {
  // Line is dominated by a string literal (no executable receiver)
  const src = '  "NEXT_PUBLIC_ANTHROPIC_API_KEY in browser bundle",';
  assert.ok(_signals.isInsideStringLiteral(src, 1));
});

test('looksLikeUserFacingDocString fires on doc-shaped messages', () => {
  assert.ok(_signals.looksLikeUserFacingDocString(
    'NEXT_PUBLIC_API_KEY in browser bundle',
  ));
  assert.ok(_signals.looksLikeUserFacingDocString('Example of bad code'));
  assert.equal(
    _signals.looksLikeUserFacingDocString('Found hardcoded URL'),
    null,
  );
});

test('looksLikeUserFacingDocString does NOT fire on ordinary security prose', () => {
  // This signal alone drops a finding to 0.5, under the 0.7 block threshold,
  // so any phrase in its list silently stops that rule blocking the gate.
  // The list must hold documentation MARKERS, not security VOCABULARY.
  //
  // Removed 2026-07-28 after auditing what our own modules actually emit:
  // `cookie-security` reports a known-weak session secret at ERROR severity
  // with the word "placeholder" in the message, and was being downgraded to
  // a non-blocking soft error because of it.
  assert.equal(_signals.looksLikeUserFacingDocString(
    'Session secret is a known-weak placeholder ("changeme") — replace before deploy.',
  ), null);
  assert.equal(_signals.looksLikeUserFacingDocString('Should not be committed'), null);
  assert.equal(_signals.looksLikeUserFacingDocString('eval() should not be used'), null);
  assert.equal(_signals.looksLikeUserFacingDocString(
    '3 dead/placeholder link(s) found',
  ), null);
});

test('a weak session secret in production code still BLOCKS the gate', () => {
  // End-to-end of the above: the real cookie-security message shape, scored
  // in a normal source file, must stay above the block threshold.
  const { confidence } = scoreFinding({
    filePath: 'src/server/session.js',
    ruleKey: 'cookie-sec:js-weak-secret:src/server/session.js:12',
    module: 'cookieSecurity',
    message: 'Session secret is a known-weak placeholder ("changeme") — replace before deploy.',
  });
  assert.equal(confidence, 1);
  assert.ok(isBlockingFinding(
    { passed: false, severity: 'error', confidence }, BLOCK_THRESHOLD,
  ), 'a hardcoded weak session secret must block');
});

// ─── scoreFinding ───────────────────────────────────────────────────────────

test('scoreFinding on a normal source file returns 1.0', () => {
  const { confidence, signals } = scoreFinding({
    filePath: 'src/index.js',
    ruleKey: 'something',
    message: 'Found a real bug',
  });
  assert.equal(confidence, 1.0);
  assert.deepEqual(signals, []);
});

test('scoreFinding on a .md file returns ≤ 0.5', () => {
  const { confidence } = scoreFinding({
    filePath: 'README.md',
    ruleKey: 'something',
  });
  assert.ok(confidence <= 0.5, `expected <= 0.5, got ${confidence}`);
});

test('scoreFinding on a test file returns ≤ 0.7', () => {
  const { confidence } = scoreFinding({
    filePath: 'tests/foo.test.js',
    ruleKey: 'something',
  });
  assert.ok(confidence <= 0.7, `expected <= 0.7, got ${confidence}`);
});

test('scoreFinding on a fixture returns ≤ 0.5', () => {
  const { confidence } = scoreFinding({
    filePath: 'tests/fixtures/sample.json',
    ruleKey: 'something',
  });
  assert.ok(confidence <= 0.5, `expected <= 0.5, got ${confidence}`);
});

test('scoreFinding inside block comment returns ≤ 0.3', () => {
  const src = 'const a = 1;\n/*\n  http://localhost:3000\n*/\nconst b = 2;';
  const { confidence } = scoreFinding({
    filePath: 'src/index.js',
    ruleKey: 'hardcoded-url',
    line: 3,
    sourceText: src,
  });
  assert.ok(confidence <= 0.3, `expected <= 0.3, got ${confidence}`);
});

test('scoreFinding inside string literal returns ≤ 0.5', () => {
  // Conservative no-column detection: pattern-like doc string
  const src = '  "NEXT_PUBLIC_ANTHROPIC_API_KEY",';
  const { confidence } = scoreFinding({
    filePath: 'src/modules/prompt-safety.js',
    ruleKey: 'prompt-safety:public-api-key',
    line: 1,
    sourceText: src,
  });
  assert.ok(confidence <= 0.5, `expected <= 0.5, got ${confidence}`);
});

test('scoreFinding multiple signals stack multiplicatively', () => {
  // .md (0.3) AND doc string message (0.5) => 1.0 * 0.3 * 0.5 = 0.15
  const { confidence, signals } = scoreFinding({
    filePath: 'README.md',
    ruleKey: 'hardcoded-url',
    message: 'in browser bundle',
  });
  assert.ok(confidence < 0.2, `expected < 0.2, got ${confidence}`);
  assert.ok(signals.length >= 2);
});

test('scoreFinding clamps to [0, 1]', () => {
  const { confidence } = scoreFinding({
    filePath: 'node_modules/foo/dist/index.js',
    ruleKey: 'something',
  });
  assert.ok(confidence >= 0);
  assert.ok(confidence <= 1);
});

test('scoreFinding ruleOverrides.ignoreTestPath bypasses the test signal', () => {
  // Without override: confidence drops on test file
  const without = scoreFinding({
    filePath: 'tests/foo.test.js',
    ruleKey: 'unknown-rule',
  });
  assert.ok(without.confidence < 1.0);

  // With override: confidence stays high
  const withOverride = scoreFinding(
    { filePath: 'tests/foo.test.js', ruleKey: 'unknown-rule' },
    { 'unknown-rule': { ignoreTestPath: true } },
  );
  assert.equal(withOverride.confidence, 1.0);
});

test('scoreFinding flakyTests default override ignores test path', () => {
  // flakyTests is supposed to fire on test files
  const { confidence } = scoreFinding({
    filePath: 'tests/foo.test.js',
    ruleKey: 'flakyTests:committed-only:tests/foo.test.js:42',
    module: 'flakyTests',
  });
  assert.equal(confidence, 1.0);
});

test('scoreFinding documentation default override ignores doc files', () => {
  const { confidence } = scoreFinding({
    filePath: 'README.md',
    ruleKey: 'documentation:missing-section',
    module: 'documentation',
  });
  assert.equal(confidence, 1.0);
});

test('scoreFinding with no filePath defaults to 1.0', () => {
  const { confidence } = scoreFinding({
    ruleKey: 'something',
    message: 'config-level finding',
  });
  assert.equal(confidence, 1.0);
});

test('scoreFinding ignores sourceText when no line given', () => {
  const src = '/*\ncommented out\n*/';
  const { confidence } = scoreFinding({
    filePath: 'src/index.js',
    sourceText: src,
  });
  assert.equal(confidence, 1.0);
});

// ─── isBlockingFinding ─────────────────────────────────────────────────────

test('isBlockingFinding: error with confidence 1.0 → blocking', () => {
  assert.equal(
    isBlockingFinding({ passed: false, severity: 'error', confidence: 1.0 }),
    true,
  );
});

test('isBlockingFinding: error with confidence 0.4 → not blocking', () => {
  assert.equal(
    isBlockingFinding({ passed: false, severity: 'error', confidence: 0.4 }),
    false,
  );
});

test('isBlockingFinding: error with no confidence defaults to blocking', () => {
  assert.equal(
    isBlockingFinding({ passed: false, severity: 'error' }),
    true,
  );
});

test('isBlockingFinding: warning is never blocking regardless of confidence', () => {
  assert.equal(
    isBlockingFinding({ passed: false, severity: 'warning', confidence: 1.0 }),
    false,
  );
});

test('isBlockingFinding: passed check is never blocking', () => {
  assert.equal(
    isBlockingFinding({ passed: true, severity: 'error', confidence: 1.0 }),
    false,
  );
});

test('isBlockingFinding: custom threshold raises the bar', () => {
  // 0.8 is above default 0.7 but below 0.9
  assert.equal(
    isBlockingFinding(
      { passed: false, severity: 'error', confidence: 0.8 },
      0.9,
    ),
    false,
  );
  // 0.95 is above 0.9
  assert.equal(
    isBlockingFinding(
      { passed: false, severity: 'error', confidence: 0.95 },
      0.9,
    ),
    true,
  );
});

// ─── verdictSource gate policy (the Fifty, move 14) ───────────────────────
// Control pair: a deterministic finding blocks exactly as before; a
// model-judged finding with the SAME severity/confidence does not, unless
// the caller opts in via modelVerdictsBlock.

test('isBlockingFinding: deterministic error still blocks with no policy flag (control)', () => {
  assert.equal(
    isBlockingFinding({ passed: false, severity: 'error', confidence: 1.0, verdictSource: 'deterministic' }),
    true,
  );
});

test('isBlockingFinding: model-judged error does NOT block by default', () => {
  assert.equal(
    isBlockingFinding({ passed: false, severity: 'error', confidence: 1.0, verdictSource: 'model' }),
    false,
  );
});

test('isBlockingFinding: model-judged error blocks when modelVerdictsBlock=true', () => {
  assert.equal(
    isBlockingFinding({ passed: false, severity: 'error', confidence: 1.0, verdictSource: 'model' }, BLOCK_THRESHOLD, true),
    true,
  );
});

test('isBlockingFinding: a low-confidence model finding never blocks even with the flag on', () => {
  assert.equal(
    isBlockingFinding({ passed: false, severity: 'error', confidence: 0.1, verdictSource: 'model' }, BLOCK_THRESHOLD, true),
    false,
  );
});

test('wouldBlockFinding ignores verdictSource — confidence-only, for the "what a stricter policy would do" disclosure', () => {
  assert.equal(
    wouldBlockFinding({ passed: false, severity: 'error', confidence: 1.0, verdictSource: 'model' }),
    true,
  );
  assert.equal(
    wouldBlockFinding({ passed: false, severity: 'error', confidence: 0.1, verdictSource: 'model' }),
    false,
  );
});

// ─── PR #85 regression coverage ────────────────────────────────────────────

test('PR #85 regression: NEXT_PUBLIC_* example inside doc string downgrades', () => {
  // The literal pattern string in a module's detection table:
  // `'NEXT_PUBLIC_ANTHROPIC_API_KEY in browser bundle'` matched
  // the public-API-key scanner against itself.
  const src = '  message: "NEXT_PUBLIC_ANTHROPIC_API_KEY in browser bundle",';
  const { confidence } = scoreFinding({
    filePath: 'src/modules/prompt-safety.js',
    ruleKey: 'prompt-safety:public-api-key:src/modules/prompt-safety.js:42',
    module: 'promptSafety',
    message: 'NEXT_PUBLIC_ANTHROPIC_API_KEY in browser bundle',
    line: 1,
    sourceText: src,
  });
  // This should be soft (< 0.7) and not block the gate.
  assert.ok(confidence < 0.7, `expected < 0.7, got ${confidence}`);
});

test('PR #85 regression: localhost example inside comment downgrades', () => {
  const src = '// example: http://localhost:3000';
  const { confidence } = scoreFinding({
    filePath: 'src/index.js',
    ruleKey: 'hardcoded-url:localhost',
    message: 'hardcoded localhost URL',
    line: 1,
    sourceText: src,
  });
  assert.ok(confidence < 0.7, `expected < 0.7, got ${confidence}`);
});

test('PR #85 regression: ephemeral .claude/worktrees path downgrades', () => {
  // The path itself signals "not real code" — vendor/build-output signal
  const { confidence } = scoreFinding({
    filePath: 'node_modules/some-tool/dist/index.js',
    ruleKey: 'hardcoded-url:localhost',
    message: 'hardcoded localhost URL',
  });
  assert.ok(confidence < 0.2, `expected < 0.2, got ${confidence}`);
});

// ---------------------------------------------------------------------------
// Block-comment walker must skip line comments and string literals.
//
// It used to count any `/*` on any preceding line, so a line comment like
// `// The /api/v1/* endpoints ...` or a glob string latched the walker on
// permanently — every finding below it in that file then scored 0.20
// "inside block comment".
//
// That is the FALSE-NEGATIVE direction and it defeats the gate: an
// error-severity finding below the block threshold is downgraded to a
// non-blocking soft error. Measured on GateTest's own repo before the fix —
// 13 findings carried the signal, all 13 were not inside a comment, and one
// was error-severity, i.e. the gate passed something it should have caught.
// Found 2026-07-28 by grouping low-confidence findings by signal.
// ---------------------------------------------------------------------------

function _score(sourceText, line) {
  return scoreFinding({
    filePath: 'src/x.js',
    ruleKey: 'error-swallow:empty-catch',
    module: 'errorSwallow',
    line,
    sourceText,
  });
}
function _insideFlagged(sourceText, line) {
  return (_score(sourceText, line).signals || []).includes('inside block comment');
}

test('block-comment walker: a line comment containing /* does not latch it', () => {
  const src = ['// The /api/v1/* endpoints are public', 'try { g(); } catch {}'].join('\n');
  assert.equal(_insideFlagged(src, 2), false);
  assert.equal(_score(src, 2).confidence, 1);
});

test('block-comment walker: a string containing /* does not latch it', () => {
  const src = ["const glob = 'src/**" + "/*.test.js';", 'try { g(); } catch {}'].join('\n');
  assert.equal(_insideFlagged(src, 2), false);
});

test('block-comment walker: a double-quoted string containing /* does not latch it', () => {
  const src = ['const s = "a /* b";', 'try { g(); } catch {}'].join('\n');
  assert.equal(_insideFlagged(src, 2), false);
});

test('block-comment walker: an escaped quote does not desynchronise tracking', () => {
  // String.raw so the scanned source really contains a backslash-escape;
  // written with a normal escape it collapses and the fixture stops
  // testing what it claims to.
  const src = [String.raw`const s = 'it\'s /* fine';`, 'try { g(); } catch {}'].join('\n');
  assert.ok(src.includes("\\'"), 'fixture must contain a real escaped quote');
  assert.equal(_insideFlagged(src, 2), false);
});

test('block-comment walker: an inline /* */ ON the finding line is not "inside"', () => {
  // `} catch { /* not fatal */ }` is real, executing code.
  const src = ['function f() {', '  try { g(); } catch { /* not fatal */ }', '}'].join('\n');
  assert.equal(_insideFlagged(src, 2), false);
});

test('block-comment walker: code after a CLOSED block comment is not inside it', () => {
  const src = ['/**', ' * docs', ' */', 'try { g(); } catch {}'].join('\n');
  assert.equal(_insideFlagged(src, 4), false);
});

// The detection must still WORK — the fix must not have turned it off.
test('block-comment walker: a finding genuinely inside a block comment is still flagged', () => {
  const src = ['/*', '  try { g(); } catch {}', '*/', 'const a = 1;'].join('\n');
  assert.equal(_insideFlagged(src, 2), true);
  assert.equal(_score(src, 2).confidence, 0.2);
});

test('block-comment walker: a finding inside a JSDoc block is still flagged', () => {
  const src = ['/**', ' * try { g(); } catch {}', ' */', 'const a = 1;'].join('\n');
  assert.equal(_insideFlagged(src, 2), true);
});

test('block-comment walker: the real-world shape that exposed this scores full confidence', () => {
  // Reduced from src/core/doctor.js, where line 247's `/api/v1/*` line
  // comment silently down-weighted every finding below it.
  const src = [
    '// The /api/v1/* endpoints expose GateTest as a platform',
    'function f() {',
    '  try {',
    '    g();',
    '  } catch { /* not fatal */ }',
    '}',
  ].join('\n');
  assert.equal(_score(src, 5).confidence, 1);
});

// ---------------------------------------------------------------------------
// String-literal detection must treat `${...}` interpolation as CODE.
//
// The old walker flipped a boolean on every backtick, so everything between
// them counted as "string literal" — including interpolations. That made the
// most common injection shape in modern JavaScript score 0.4:
//
//     const q = `SELECT * FROM users WHERE id = ${req.query.id}`;
//
// Below the 0.7 block threshold an error-severity finding is downgraded to a
// non-blocking soft error, so the gate waved SQL injection through. Same
// false-negative class as the block-comment walker (KI #85), found the same
// way — by looking at what the signal was actually firing on.
// ---------------------------------------------------------------------------

function _scoreAt(sourceText, line, column, ruleKey = 'sql-injection:template-literal') {
  return scoreFinding({
    filePath: 'src/db.js', ruleKey, module: 'security', line, column, sourceText,
  });
}

test('string literal: a finding inside ${...} is CODE and keeps full confidence', () => {
  const src = [
    'function getUser(req, db) {',
    '  const q = `SELECT * FROM users WHERE id = ${req.query.id}`;',
    '  return db.query(q);',
    '}',
  ].join('\n');
  const lineText = src.split('\n')[1];
  const col = lineText.indexOf('req.query.id');
  const s = _scoreAt(src, 2, col);
  assert.equal(s.confidence, 1);
  assert.ok(!(s.signals || []).includes('string literal'));
  assert.ok(s.confidence >= BLOCK_THRESHOLD, 'must still block the gate');
});

test('string literal: literal TEXT inside the same template is still down-weighted', () => {
  const src = ['const q = `SELECT * FROM users WHERE id = ${id}`;'].join('\n');
  const col = src.indexOf('SELECT');
  const s = _scoreAt(src, 1, col);
  assert.equal(s.confidence, 0.4);
  assert.ok((s.signals || []).includes('string literal'));
});

test('string literal: a nested string inside ${...} IS string text', () => {
  // `${obj['key']}` — the inner quoted part is genuinely literal text.
  const src = ["const q = `x ${obj['key']} y`;"].join('\n');
  const col = src.indexOf('key');
  assert.equal(_scoreAt(src, 1, col).confidence, 0.4);
});

test('string literal: code AFTER a closed interpolation is still template text', () => {
  const src = ['const q = `a ${x} bbbb`;'].join('\n');
  const col = src.indexOf('bbbb');
  assert.equal(_scoreAt(src, 1, col).confidence, 0.4, 'past the } we are back in text');
});

test('string literal: nested braces inside interpolation do not end it early', () => {
  const src = ['const q = `a ${fn({ k: v })} TAIL`;'].join('\n');
  const inner = src.indexOf('k: v');
  assert.equal(_scoreAt(src, 1, inner).confidence, 1, 'still inside ${...}');
  const tail = src.indexOf('TAIL');
  assert.equal(_scoreAt(src, 1, tail).confidence, 0.4, 'back to template text after the close');
});

test('string literal: ordinary quoted strings are unaffected', () => {
  const src = ["const s = 'hello world';"].join('\n');
  assert.equal(_scoreAt(src, 1, src.indexOf('hello')).confidence, 0.4);
  assert.equal(_scoreAt(src, 1, src.indexOf('const')).confidence, 1);
});

test('string literal: an escape inside a string does not desynchronise the walker', () => {
  const src = [String.raw`const s = 'a\'b'; danger(x);`].join('\n');
  const col = src.indexOf('danger');
  assert.equal(_scoreAt(src, 1, col).confidence, 1, 'code after the string is code');
});

test('string literal: the no-column heuristic does not claim an interpolated line', () => {
  // Without a column we fall back to "does the line look like just a string?".
  // A template with ${...} in it is part code, so the shortcut must decline.
  const src = ['`gatetest-${process.pid}-${Date.now()}.json`,'].join('\n');
  const s = scoreFinding({
    filePath: 'tests/x.test.js', ruleKey: 'flaky-tests:math-random',
    module: 'flakyTests', line: 1, sourceText: src,
  });
  assert.ok(!(s.signals || []).includes('string literal'));
});

// ---------------------------------------------------------------------------
// A `docs/` PATH must not down-weight real shipping code.
//
// Plenty of products serve a documentation SITE from production code —
// website/app/docs/api/page.tsx, pages/docs/[slug].tsx, app/docs/route.ts.
// Scoring those 0.4 as "example data" puts them under the 0.7 block
// threshold, so an error-severity finding in genuinely deployed code stops
// blocking the gate. Actual documentation is already handled by isDocFile()
// (.md/.mdx/.rst -> 0.3), so the path clause only needs the non-source
// leftovers. Found 2026-07-28 auditing the path signals after KI #85-#87.
// ---------------------------------------------------------------------------

test('docs/ path does NOT down-weight production source files', () => {
  for (const p of [
    'website/app/docs/api/page.tsx',
    'app/docs/route.ts',
    'pages/docs/[slug].tsx',
    'src/doc/handler.js',
  ]) {
    const { confidence, signals } = scoreFinding({
      filePath: p, ruleKey: 'security:sqli', module: 'security',
    });
    assert.equal(confidence, 1, `${p} is shipping code, got ${confidence} ${JSON.stringify(signals)}`);
  }
});

test('docs/ path still down-weights non-source documentation assets', () => {
  for (const p of ['docs/sample-config.json', 'docs/ops/runbook.txt', 'docs/api/schema.yml']) {
    const { confidence } = scoreFinding({ filePath: p, ruleKey: 'x', module: 'm' });
    assert.ok(confidence <= 0.4, `${p} should stay low, got ${confidence}`);
  }
});

test('docs/ change does not disturb real doc files or examples/', () => {
  assert.ok(scoreFinding({ filePath: 'docs/GUIDE.md', ruleKey: 'x' }).confidence <= 0.3);
  assert.ok(scoreFinding({ filePath: 'examples/basic.js', ruleKey: 'x' }).confidence <= 0.4);
});

// Doctrine §4: isTestFile was a private copy of TEST_PATH_RE that knew only
// tests/, __tests__/ and .test./.spec. — e2e/, smoke-test/, js_tests/ and
// __mocks__/ kept full confidence while every module treated them as harness
// (2026-09-05). Fixture-only paths are still priced once, by isFixtureFile.
{
  const { _signals: { isTestFile, isFixtureFile } } = require('../src/core/confidence');
  test('isTestFile: compound test dirs and e2e are test paths', () => {
    for (const p of ['smoke-test/x.ts', 'e2e/login.ts', 'js_tests/q.js', 'src/__mocks__/m.js', 'runtime-tests/a.ts']) assert.ok(isTestFile(p), p);
  });
  test('isTestFile: a fixture dir outside tests/ is a fixture, not additionally a test; under tests/ it is both', () => {
    assert.equal(isTestFile('src/fixtures/k.pem'), null);
    assert.ok(isFixtureFile('src/fixtures/k.pem'));
    assert.ok(isTestFile('tests/fixtures/k.pem') && isFixtureFile('tests/fixtures/k.pem'));
  });
  test('isTestFile POSITIVE CONTROL: application code keeps full confidence', () => {
    for (const p of ['src/latest/x.js', 'contest/x.js', 'src/attestation.js', 'src/app.js']) assert.equal(isTestFile(p), null, p);
  });
}

// ─── a skipped test is not "just a test file" (the Fifty, move 30) ─────────

test('test.skip added in a fix commit scores 1.0 and BLOCKS — the test path is the point of the rule', () => {
  for (const rule of ['test-skip-added', 'test-xit-added', 'test-only-added']) {
    const { confidence, signals } = scoreFinding({
      filePath: 'tests/add.test.js',
      ruleKey: `fake-fix:pattern:${rule}:tests/add.test.js:5`,
      module: 'fakeFixDetector',
      message: 'Test was skipped instead of fixed',
    });
    assert.equal(confidence, 1, `${rule}: ${signals.join('; ')}`);
    assert.ok(isBlockingFinding({ passed: false, severity: 'error', confidence }, BLOCK_THRESHOLD), rule);
  }
});

test('control: another fake-fix rule in a test file is still priced as test code', () => {
  const { confidence } = scoreFinding({
    filePath: 'tests/add.test.js',
    ruleKey: 'fake-fix:pattern:empty-catch-added:tests/add.test.js:9',
    module: 'fakeFixDetector',
  });
  assert.ok(confidence <= 0.7, `expected <= 0.7, got ${confidence}`);
});

test('control: a rule-id override never matches a longer rule id that merely starts with it', () => {
  const { confidence } = scoreFinding(
    { filePath: 'tests/add.test.js', ruleKey: 'fake-fix:pattern:test-skip-added-elsewhere:tests/add.test.js:5', module: 'fakeFixDetector' },
  );
  assert.ok(confidence <= 0.7, `expected <= 0.7, got ${confidence}`);
});

// A shell script masked as JavaScript: ktor's gradlew has `/*)` in a case
// pattern on line 80 and a real `eval "set -- $(…)"` on line 241; the
// scorer read everything below line 80 as a block comment and gave the
// eval 0.2 — the gate passed it (2026-09-05, found by the corpus ceiling
// the day the modules' own masking was corrected).
const GRADLEW_SHAPE = [
  '#!/bin/sh',
  'case $link in',
  '  /*)   app_path=$link ;; #(',
  '  *)    app_path=$APP_HOME$link ;;',
  'esac',
  'eval "set -- $(printf \'%s\\n\' "$OPTS" | xargs -n1)"',
].join('\n');

test('language dispatch: a `/*)` case pattern in a shell script does not open a comment — the eval below it keeps full confidence', () => {
  const r = scoreFinding({ filePath: 'gradlew', ruleKey: 'shell:eval-var', module: 'shell', line: 6, sourceText: GRADLEW_SHAPE });
  assert.equal((r.signals || []).includes('inside block comment'), false, JSON.stringify(r));
  assert.equal(r.confidence, 1);
});

test('language dispatch: the same bytes in a JavaScript file ARE inside the comment `/*` opened', () => {
  const r = scoreFinding({ filePath: 'src/x.js', ruleKey: 'shell:eval-var', module: 'shell', line: 6, sourceText: GRADLEW_SHAPE });
  assert.equal((r.signals || []).includes('inside block comment'), true, JSON.stringify(r));
});
