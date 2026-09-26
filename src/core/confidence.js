/**
 * Confidence scoring for findings.
 *
 * Every finding gets a CONFIDENCE score from 0.0 to 1.0 in addition to
 * its severity (`error` / `warning` / `info`). The score is computed
 * from context signals (path, comment-state, surrounding text, etc).
 *
 * The gate's BLOCKING decision is now:
 *   severity === 'error' && confidence >= BLOCK_THRESHOLD
 *
 * Low-confidence error findings still appear in the report — they just
 * don't block the gate. They count toward `softErrorCount` so the
 * summary shows e.g. "3 errors / 1 soft-error (low confidence)".
 *
 * The score is a product of multiplier signals. A finding starts at
 * `DEFAULT_CONFIDENCE` (1.0). Each signal that fires multiplies the
 * score by its multiplier (0.0..1.0). The final confidence is bounded
 * to `[0, 1]`. If no signal fires, the score is 1.0.
 *
 * Per-rule overrides: some rules legitimately fire on test files
 * (flakyTests, prSize) and shouldn't be penalised by the test-path
 * signal. Callers pass `ruleOverrides` keyed by `ruleKey`.
 *
 * Pure functions, no I/O. Backwards-compatible: modules that don't
 * pass `sourceText` still get a path-only score.
 */

'use strict';
const { maskSource, literalKindAt } = require('./source-strip');

const DEFAULT_CONFIDENCE = 1.0;
const BLOCK_THRESHOLD = 0.7;

// Per-rule overrides shipped as defaults. The most obvious cases where
// firing on a test file is the WHOLE POINT of the rule.
const DEFAULT_RULE_OVERRIDES = Object.freeze({
  // flakyTests scans test files BY DEFINITION
  flakyTests: { ignoreTestPath: true, ignoreFixturePath: true },
  // prSize scans the whole diff; test files are part of the diff
  prSize: { ignoreTestPath: true, ignoreFixturePath: true },
  // A test that was SKIPPED, DISABLED or FOCUSED instead of fixed lives in a
  // test file by definition — the whole finding is "this test file changed
  // in the wrong direction". Discounting it for being in tests/ made every
  // `test.skip` added in a fix commit a soft, non-blocking error (measured
  // 2026-09-05: GATE PASSED, "1 soft (low confidence)"; the Fifty, move 30).
  // Keyed by rule, not module: an empty catch or a `return true` added to a
  // test is still priced as test code.
  'fake-fix:pattern:test-skip-added': { ignoreTestPath: true, ignoreFixturePath: true },
  'fake-fix:pattern:test-xit-added': { ignoreTestPath: true, ignoreFixturePath: true },
  'fake-fix:pattern:test-only-added': { ignoreTestPath: true, ignoreFixturePath: true },
  // Test-coverage gate cares about test files
  unitTests: { ignoreTestPath: true },
  integrationTests: { ignoreTestPath: true },
  // Documentation module is supposed to scan .md files
  documentation: { ignoreDocFile: true },
  // links module scans .md files for broken links
  links: { ignoreDocFile: true },
  // NOT `secrets: { ignoreDocFile: true }` — TRIED AND REVERTED 2026-09-01.
  //
  // The argument for it is good: a credential in a README is exactly as leaked
  // as one in source, and the doc-file multiplier asks "is this shipping
  // code?", which is the wrong question for a rule reporting that a file
  // CONTAINS a credential. Without the override, a real AWS key planted in
  // SECURITY.md scores 0.3 — soft, non-blocking. Found and operationally
  // ignored.
  //
  // It was reverted because the corpus measured the cost. axios @81df7a5 went
  // from 7 blocking to 8, gaining NINE doc findings: its HTTP Basic auth
  // documentation, in four languages, containing
  //     password: "myPassword"      docs/pages/advanced/authentication.md
  //     password: 's00pers3cret'    README.md
  // Those are what authentication documentation looks like. Blocking a clean,
  // widely-used library on its own docs is the failure this whole exercise
  // exists to prevent.
  //
  // The real fix is per-PATTERN specificity, not per-module: a vendor-shaped
  // credential (AKIA…, sk_live_…, ghp_…, a PEM header) is unambiguous in any
  // file type and should block anywhere, while the generic
  // `password|secret|token = "<8+ chars>"` patterns are exactly what docs
  // contain. The confidence layer keys overrides by module or ruleKey, and
  // the secrets module emits one check per FILE, so that distinction cannot
  // be expressed here yet — it needs the module to carry the matched pattern
  // type into the finding first.
  //
  // Until then documentation secrets are DETECTED and non-blocking, which is
  // strictly better than the pre-2026-09-01 state of not being read at all.
});

// ─── individual signal functions ─────────────────────────────────────────────

/**
 * Extensions that mean "this is executable source", used to stop
 * documentation-shaped PATH heuristics from claiming real shipping code.
 */
const SOURCE_EXT_RE =
  /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|rb|go|rs|java|php|cs|kt|kts|swift|scala|vue|svelte|sh|bash)$/i;

/**
 * Doc file: .md / .mdx / .rst → 0.3
 */
function isDocFile(filePath) {
  if (!filePath) return null;
  const p = String(filePath).toLowerCase().replace(/\\/g, '/');
  if (/\.(md|mdx|rst)$/.test(p)) {
    return { multiplier: 0.3, reason: 'doc file' };
  }
  return null;
}

/**
 * Test file: /tests?/, *.test.*, *.spec.*, __tests__/ → 0.6
 */
function isTestFile(filePath) {
  if (!filePath) return null;
  const p = String(filePath).replace(/\\/g, '/');
  // One definition of "is this a test path" (doctrine §4): the private copy
  // here knew tests/, __tests__/ and .test./.spec. only — fixtures/, e2e/,
  // __mocks__/, `smoke-test/`, `js_tests/` kept full confidence while every
  // module already treated them as harness (2026-09-05). Required lazily:
  // base-module is a module-layer file and confidence is core.
  const { TEST_PATH_RE } = require('../modules/base-module');
  if (!TEST_PATH_RE.test(p)) return null;
  // A path that is a test path ONLY because of a fixture/mock segment
  // (`src/fixtures/x`) is priced once, by isFixtureFile below; a fixture
  // under tests/ (`tests/fixtures/x`) is still both, as it always was.
  const TEST_PROPER_RE = /(?:^|\/)(?:tests?|specs?|__tests__|e2e|stories|storybook|reliability-corpus|testdata|test[-_]?resources|[a-z0-9]+[-_](?:tests?|specs?))(?:\/|$)|\.(?:test|spec|stories|e2e)\./i;
  if (!TEST_PROPER_RE.test(p) && isFixtureFile(p)) return null;
  return { multiplier: 0.6, reason: 'test file' };
}

/**
 * Fixture file: /fixtures?/, /__fixtures__/, /test-data/, /mocks?/,
 * /stubs?/ → 0.4
 */
function isFixtureFile(filePath) {
  if (!filePath) return null;
  const p = String(filePath).replace(/\\/g, '/');
  if (
    /(?:^|\/)fixtures?\//i.test(p) ||
    /(?:^|\/)__fixtures__\//i.test(p) ||
    /(?:^|\/)test-data\//i.test(p) ||
    /(?:^|\/)mocks?\//i.test(p) ||
    /(?:^|\/)stubs?\//i.test(p)
  ) {
    return { multiplier: 0.4, reason: 'fixture file' };
  }
  return null;
}

/**
 * Example data file: example*, sample*, demo*, /docs/ → 0.4
 */
function isExampleDataFile(filePath) {
  if (!filePath) return null;
  const p = String(filePath).replace(/\\/g, '/').toLowerCase();
  // A `docs/` PATH means "documentation" only for non-source files. Plenty
  // of products serve a documentation site from real, shipping code —
  // `website/app/docs/api/page.tsx`, `pages/docs/[slug].tsx`, `app/docs/
  // route.ts`. Down-weighting those to 0.4 puts them under the 0.7 block
  // threshold, so an error-severity finding in genuinely deployed code stops
  // blocking the gate. Actual documentation is already covered by
  // isDocFile() (.md/.mdx/.rst → 0.3), so this clause only needs to catch
  // the non-source leftovers (.json/.txt/.yml samples). Found 2026-07-28
  // auditing the path signals for false-negative risk after KI #85-#87.
  if (/(?:^|\/)docs?\//i.test(p) && !SOURCE_EXT_RE.test(p)) {
    return { multiplier: 0.4, reason: 'example data' };
  }
  // `docs_src/` (and `doc_src/`, `docs-src/`) is a SAMPLES directory — source
  // files whose entire purpose is to be pasted into documentation (fastapi
  // keeps 3,000+ tutorial snippets there, complete with fake secrets). Unlike
  // the `docs/` clause above this applies to source extensions too: nothing
  // under docs_src ships. 2026-08-18 audit residue — docs_src secrets were
  // blocking at confidence 1.
  if (/(?:^|\/)docs?[_-]src\//i.test(p)) {
    return { multiplier: 0.4, reason: 'example data' };
  }
  // Directory-style match: examples/, samples/, demos/
  if (/(?:^|\/)(?:example|sample|demo)s?\//i.test(p)) {
    return { multiplier: 0.4, reason: 'example data' };
  }
  // Basename-style match: example*, sample*, demo*
  const base = p.split('/').pop() || '';
  if (/^(example|sample|demo)/i.test(base)) {
    return { multiplier: 0.4, reason: 'example data' };
  }
  return null;
}

/**
 * Vendor / build output → 0.1 (essentially "don't block on this")
 */
function isHomeworkDir(filePath) {
  if (!filePath) return null;
  const p = String(filePath).replace(/\\/g, '/');
  if (
    /(?:^|\/)node_modules\//.test(p) ||
    /(?:^|\/)dist\//.test(p) ||
    /(?:^|\/)build\//.test(p) ||
    /(?:^|\/)\.next\//.test(p) ||
    /(?:^|\/)coverage\//.test(p) ||
    /(?:^|\/)vendor\//.test(p)
  ) {
    return { multiplier: 0.1, reason: 'vendor / build output' };
  }
  return null;
}

// The mask of the last source text asked about: findings for one file
// arrive together, and masking a large file per finding would be the cost.
let lastSource = null;
let lastFile = null;
let lastMasked = null;
function maskedOf(sourceText, filePath) {
  if (sourceText !== lastSource || (filePath || '') !== lastFile) {
    // maskSource picks the stripper by language — a shell script masked as
    // JavaScript read `/*)` in a case pattern as a comment opener (gradlew).
    lastSource = sourceText;
    lastFile = filePath || '';
    lastMasked = { raw: sourceText.split(/\r?\n/), masked: maskSource(sourceText, filePath).split(/\r?\n/) };
  }
  return lastMasked;
}

/**
 * Inside a comment: the line's first non-space character is masked and the
 * mask says it is a comment (src/core/source-strip.js literalKindAt — one
 * definition; the block-comment walker this replaced skipped line comments
 * and strings on its own and disagreed with the modules' stripper at the
 * edges, KI #85).
 */
function isInsideBlockComment(sourceText, line, filePath) {
  if (!sourceText || !line || line < 1) return null;
  const { raw, masked } = maskedOf(sourceText, filePath);
  if (line > raw.length) return null;
  const target = raw[line - 1] || '';
  const first = target.search(/\S/);
  if (first === -1) return null;
  if (literalKindAt(raw, masked, line - 1, first) !== 'comment') return null;
  return { multiplier: 0.2, reason: /^\s*\/\//.test(target) || /^\s*#/.test(target) ? 'inside line comment' : 'inside block comment' };
}

/**
 * Inside string literal: finding position is inside a `"`/`'`/backtick
 * string on `line`. If `column` is undefined, we conservatively answer
 * "is the line dominated by a string?" — used by modules that don't
 * track column.
 */
function isInsideStringLiteral(sourceText, line, column, filePath) {
  if (!sourceText || !line || line < 1) return null;
  const { raw, masked } = maskedOf(sourceText, filePath);
  if (line > raw.length) return null;
  const lineText = raw[line - 1];
  if (!lineText) return null;

  // With a column: the mask decides. A `${…}` hole is code, so the injection
  // shape `\`SELECT … ${req.query.id}\`` scores at the column of the hole as
  // code (the 0.4 that once waved SQL injection through, see git history).
  if (typeof column === 'number' && column >= 0) {
    if (literalKindAt(raw, masked, line - 1, column) === 'string') {
      return { multiplier: 0.4, reason: 'string literal' };
    }
    return null;
  }

  // No column: conservative heuristic. Doc-string-shape line.
  // A template literal with `${...}` in it is NOT "just a string" — part of
  // the line is executable — so the whole-line shortcut must not claim it.
  const trimmed = lineText.trim();
  if (trimmed.includes('${')) return null;
  if (/^['"`]/.test(trimmed) && /['"`][,)\s]*$/.test(trimmed)) {
    return { multiplier: 0.4, reason: 'string literal' };
  }
  // Deliberately NOT matching `key: "…"` here. That shape is ambiguous:
  // `message: "NEXT_PUBLIC_… in browser bundle"` (a scanner's own detection
  // table, PR #85) and `apiBase: "http://localhost:3000"` (a real hardcoded
  // URL that must block) are the same line shape. Line shape cannot separate
  // them; only the message content can, which is what
  // looksLikeUserFacingDocString is for.
  return null;
}

/**
 * Message itself looks like documentation / a rule description rather
 * than a concrete bug location.
 *
 * The list must contain DOCUMENTATION MARKERS, never ordinary security
 * vocabulary. This signal alone drops a finding to 0.5 — under the 0.7
 * block threshold — so every phrase added here silently disables blocking
 * for any rule whose wording contains it.
 *
 * Removed 2026-07-28 after auditing what our own modules actually say:
 *   'placeholder'          — `cookie-security` reports "Session secret is a
 *                            known-weak placeholder (\"changeme\")" at ERROR
 *                            severity in non-test code. A hardcoded weak
 *                            session secret is exactly what the gate exists
 *                            to stop, and this word was waving it through.
 *                            Also hit `links` ("dead/placeholder link(s)").
 *   'should not be'        — ordinary finding prose: "secrets should not be
 *   'should not contain'     committed", "eval() should not be used".
 *
 * The PR #85 case that justifies the signal is unaffected: its message is
 * "NEXT_PUBLIC_ANTHROPIC_API_KEY in browser bundle", which still matches
 * the retained 'in browser bundle' marker.
 *
 * Note this cannot be replaced by a line-shape rule. `message: "…"` (a
 * scanner's own detection table) and `apiBase: "http://localhost:3000"` (a
 * real hardcoded URL that must block) are the same shape — only the message
 * content separates them.
 */
function looksLikeUserFacingDocString(message) {
  if (!message || typeof message !== 'string') return null;
  const m = message.toLowerCase();
  // The classic PR #85 false-positive shapes
  const docPhrases = [
    'in browser bundle',
    'example of',
    'for example',
    'e.g.,',
    ' eg. ',
    'illustrative',
  ];
  for (const p of docPhrases) {
    if (m.includes(p)) {
      return { multiplier: 0.5, reason: 'documentation context' };
    }
  }
  return null;
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Score a finding's confidence.
 *
 * @param {object} input
 * @param {string} [input.filePath]    relative or absolute file path
 * @param {string} [input.ruleKey]     e.g. 'prompt-safety:public-api-key'
 * @param {string} [input.module]      module name (e.g. 'promptSafety')
 * @param {string} [input.message]     finding message
 * @param {number} [input.line]        1-indexed line number
 * @param {number} [input.column]      0-indexed column
 * @param {string} [input.sourceText]  full file content
 * @param {object} [input.context]     reserved for future signals
 * @param {object} [ruleOverrides]     per-rule override map.
 *
 * @returns {{ confidence: number, signals: string[] }}
 */
function scoreFinding(input = {}, ruleOverrides = null) {
  const overrides = mergeOverrides(input, ruleOverrides);
  const signals = [];
  let score = DEFAULT_CONFIDENCE;

  // Path-based signals
  const sDoc = isDocFile(input.filePath);
  if (sDoc && !overrides.ignoreDocFile) {
    score *= sDoc.multiplier;
    signals.push(sDoc.reason);
  }

  const sTest = isTestFile(input.filePath);
  if (sTest && !overrides.ignoreTestPath) {
    score *= sTest.multiplier;
    signals.push(sTest.reason);
  }

  const sFix = isFixtureFile(input.filePath);
  if (sFix && !overrides.ignoreFixturePath) {
    score *= sFix.multiplier;
    signals.push(sFix.reason);
  }

  const sEx = isExampleDataFile(input.filePath);
  if (sEx && !overrides.ignoreExamplePath) {
    score *= sEx.multiplier;
    signals.push(sEx.reason);
  }

  const sVendor = isHomeworkDir(input.filePath);
  if (sVendor) {
    score *= sVendor.multiplier;
    signals.push(sVendor.reason);
  }

  // Source-text signals (only fire when source is available)
  if (input.sourceText && input.line) {
    const sBlock = isInsideBlockComment(input.sourceText, input.line, input.filePath);
    if (sBlock) {
      score *= sBlock.multiplier;
      signals.push(sBlock.reason);
    }
    const sStr = isInsideStringLiteral(input.sourceText, input.line, input.column, input.filePath);
    if (sStr) {
      score *= sStr.multiplier;
      signals.push(sStr.reason);
    }
  }

  // Message-based signal
  const sDocStr = looksLikeUserFacingDocString(input.message);
  if (sDocStr) {
    score *= sDocStr.multiplier;
    signals.push(sDocStr.reason);
  }

  // Clamp
  if (score < 0) score = 0;
  if (score > 1) score = 1;

  return { confidence: score, signals };
}

/**
 * Merge default rule overrides with caller-supplied ones, matching by
 * module name or ruleKey prefix.
 */
function mergeOverrides(input, callerOverrides) {
  const merged = {
    ignoreTestPath: false,
    ignoreFixturePath: false,
    ignoreDocFile: false,
    ignoreExamplePath: false,
  };
  const all = {
    ...DEFAULT_RULE_OVERRIDES,
    ...(callerOverrides || {}),
  };

  // Try module-level match
  if (input.module && all[input.module]) {
    Object.assign(merged, all[input.module]);
  }
  // Try exact ruleKey match
  if (input.ruleKey && all[input.ruleKey]) {
    Object.assign(merged, all[input.ruleKey]);
  }
  // Try rulekey prefix match — the module prefix before the first colon,
  // and any longer override key that names a rule id: check names carry
  // `:<file>:<line>` after the rule, so `fake-fix:pattern:test-skip-added`
  // must match `fake-fix:pattern:test-skip-added:tests/a.test.js:5` and not
  // `fake-fix:pattern:test-skip-added-elsewhere:…`.
  if (input.ruleKey) {
    const colonIdx = input.ruleKey.indexOf(':');
    const prefix = colonIdx > 0 ? input.ruleKey.slice(0, colonIdx) : input.ruleKey;
    if (all[prefix]) Object.assign(merged, all[prefix]);
    for (const key of Object.keys(all)) {
      if (key !== prefix && key !== input.ruleKey && input.ruleKey.startsWith(key + ':')) {
        Object.assign(merged, all[key]);
      }
    }
  }

  return merged;
}

/**
 * Would this check block the gate on confidence alone — the question asked
 * before verdictSource policy is layered on. Exposed as `wouldBlockFinding`
 * so callers can show "what a stricter policy would do" (the Fifty, move
 * 14) without re-deriving the confidence arithmetic.
 */
function wouldBlockFinding(check, threshold) {
  if (!check) return false;
  if (check.passed === true) return false;
  if (check.severity !== 'error') return false;
  const c = typeof check.confidence === 'number' ? check.confidence : DEFAULT_CONFIDENCE;
  const t = typeof threshold === 'number' ? threshold : BLOCK_THRESHOLD;
  return c >= t;
}

/**
 * Convenience: should this check ACTUALLY block the gate?
 *
 * Confidence decides whether a finding qualifies as blocking at all
 * (`wouldBlockFinding`); verdictSource then decides whether the GATE acts on
 * that qualification. A `model`-judged finding — one whose verdict came from
 * asking an AI to judge the code rather than from a deterministic rule —
 * never blocks unless the caller opts in via `modelVerdictsBlock` (config
 * `gate.modelVerdictsBlock`, CLI `--model-verdicts-block`, env
 * `GATETEST_MODEL_VERDICTS_BLOCK=1`). This is the customer trust fix for
 * "40% of AI review alerts ignored" (the Fifty, move 14, complaints C1/C4):
 * a model opinion is reported — as a warning, with `wouldBlock: true`
 * preserved on the finding — never silently treated as equal to a
 * deterministic rule firing.
 *
 * @param {object} check
 * @param {number} [threshold]
 * @param {boolean} [modelVerdictsBlock=false]
 */
function isBlockingFinding(check, threshold, modelVerdictsBlock = false) {
  if (!wouldBlockFinding(check, threshold)) return false;
  if (check.verdictSource === 'model' && modelVerdictsBlock !== true) return false;
  return true;
}

module.exports = {
  DEFAULT_CONFIDENCE,
  BLOCK_THRESHOLD,
  DEFAULT_RULE_OVERRIDES,
  scoreFinding,
  isBlockingFinding,
  wouldBlockFinding,
  // exported for testing
  _signals: {
    isDocFile,
    isTestFile,
    isFixtureFile,
    isExampleDataFile,
    isHomeworkDir,
    isInsideBlockComment,
    isInsideStringLiteral,
    looksLikeUserFacingDocString,
  },
};
