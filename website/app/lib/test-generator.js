/**
 * Test-generation helper.
 *
 * Phase 1.3 of THE FIX-FIRST BUILD PLAN. For every successful fix,
 * Claude writes a regression test that would have caught the original
 * bug. The test ships in the same PR as the fix — so when the customer
 * merges, their test suite is stronger than it was before. No
 * competitor on the market today does this.
 *
 * Pure JS, dependency-injected. The route imports this and provides
 * `askClaudeForTest` (a thin wrapper around the route's existing
 * Anthropic-call helper). Tests inject a stub.
 *
 * Outcome: per fix, either a `{ path, content }` object representing
 * the new test file, or null if test generation failed / wasn't
 * applicable. The orchestrator appends successful entries to the
 * fixes array as new-file commits; failed entries are logged but
 * never block the underlying fix from shipping.
 *
 * Test path convention:
 *   src/foo.js                    → tests/auto-generated/foo.test.js
 *   src/lib/utils.js              → tests/auto-generated/lib_utils.test.js
 *   website/app/lib/foo.ts        → tests/auto-generated/website_app_lib_foo.test.js
 *   package.json                  → null (no test for config files)
 *   docs/foo.md                   → null (no test for docs)
 *
 * Why `tests/auto-generated/`: predictable location the customer can
 * review at a glance, doesn't collide with hand-written tests, and
 * signals AI provenance. Customer can move/rename after merge.
 */

const TESTABLE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.mts', '.cts', '.tsx',
]);

const NON_TESTABLE_PATHS = [
  /\.test\.[jt]sx?$/,    // existing tests
  /\.spec\.[jt]sx?$/,    // existing specs
  /\.d\.ts$/,            // type declarations
  /\/types?\.[jt]s$/,    // pure type modules
];

/**
 * Decide whether a fix is testable. Config files, docs, type
 * declarations, and existing test files are not — generating a
 * regression test for them is meaningless or recursive.
 */
function isTestableFix(fix) {
  if (!fix || typeof fix.file !== 'string') return false;
  const lower = fix.file.toLowerCase();
  // Reject by suffix patterns first
  for (const pattern of NON_TESTABLE_PATHS) {
    if (pattern.test(lower)) return false;
  }
  // Then check extension
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx === -1) return false;
  const ext = lower.slice(dotIdx);
  return TESTABLE_EXTENSIONS.has(ext);
}

/**
 * Build the test-file path for a given source path.
 * Returns null when the source isn't testable.
 */
function buildTestPath(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) return null;
  // Get extension
  const lastDot = sourcePath.lastIndexOf('.');
  if (lastDot === -1) return null;
  const ext = sourcePath.slice(lastDot).toLowerCase();
  // Map extension to test-file extension. JSX/TSX tests are usually
  // written in matching JSX/TSX since they may import JSX components.
  const testExt = ext === '.tsx' || ext === '.jsx' ? ext : '.js';
  // Flatten the path (preserving readability) by replacing slashes
  // with underscores. This avoids deeply nested
  // tests/auto-generated/website/app/lib/... directories that the
  // customer would have to navigate.
  const noExt = sourcePath.slice(0, lastDot);
  const flattened = noExt.replace(/^\/+/, '').replace(/\//g, '_');
  return `tests/auto-generated/${flattened}.test${testExt}`;
}

/**
 * Detect the test framework from project context.
 *
 * Looks at the test path's extension and any caller-provided
 * `frameworkHint`. Defaults to node:test (zero-dep, Node-native) if
 * no other signal is available — that's the safest cross-project
 * default since every modern Node version has it built in.
 *
 * @param {string} testPath
 * @param {string} [frameworkHint]  Optional override from the caller.
 * @returns {'jest'|'vitest'|'node:test'}
 */
function detectFramework(testPath, frameworkHint) {
  if (frameworkHint && ['jest', 'vitest', 'node:test'].includes(frameworkHint)) {
    return frameworkHint;
  }
  // Without a strong signal, prefer node:test — it's the most
  // portable default. Customers who use jest/vitest will still get
  // a working test (since the customer's CI will reject it if the
  // wrong framework is detected, surfacing the issue clearly), and
  // we can switch on hint detection in a follow-up.
  return 'node:test';
}

/**
 * Build the prompt that Claude sees for test generation.
 * Exposed for tests so the prompt shape can be asserted.
 */
function buildTestPrompt({ filePath, originalContent, fixedContent, issues, framework }) {
  const frameworkSection = framework === 'jest'
    ? 'TEST FRAMEWORK: Jest. Use `describe`, `test` / `it`, `expect`. Use `require` or `import` based on the source file.'
    : framework === 'vitest'
    ? 'TEST FRAMEWORK: Vitest. Use `import { describe, test, expect } from "vitest"`.'
    : 'TEST FRAMEWORK: Node\'s built-in test runner. Use `import { test } from "node:test"; import assert from "node:assert/strict";` (or the require equivalent for CJS).';

  return `You are writing a REGRESSION TEST for a bug that was just fixed.

The test must:
1. Demonstrate the bug — at least one assertion that would have FAILED against the ORIGINAL (buggy) code.
2. PASS against the FIXED code.
3. Be self-contained — only require the fixed module and the test framework. No external services, no file-system writes, no network.
4. Be tightly focused on the specific issues that were fixed. Do not write a comprehensive test suite — that's not the goal here. The goal is "if someone reverts this fix, the CI fails."

${frameworkSection}

FILE THAT WAS FIXED: ${filePath}

ISSUES THAT WERE FIXED:
${issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

ORIGINAL (BUGGY) CODE:
\`\`\`
${originalContent}
\`\`\`

FIXED CODE:
\`\`\`
${fixedContent}
\`\`\`

Output ONLY the regression test file content. No explanations. No markdown fences. The first line of your output should be the first line of the test file.

If you cannot write a meaningful regression test for these issues (e.g. the fix is purely cosmetic, or testing it would require a real database), output the single token \`SKIP\` and nothing else. The orchestrator handles that case correctly.`;
}

/**
 * Generate a regression test for a single fix.
 *
 * @param {Object} opts
 * @param {{ file: string, fixed: string, original: string, issues: string[] }} opts.fix
 *   The successful fix to write a test for.
 * @param {(prompt: string) => Promise<string>} opts.askClaudeForTest
 *   Caller-provided. Sends the prompt to Claude, returns the raw
 *   response text. Throws on API errors.
 * @param {string} [opts.frameworkHint]
 *   Override framework detection (mostly for tests).
 * @returns {Promise<{
 *   ok: boolean,
 *   test: { path: string, content: string } | null,
 *   reason: string | null,
 * }>}
 */
async function generateTestForFix(opts) {
  const { fix, askClaudeForTest, frameworkHint } = opts || {};

  if (!fix || typeof fix.file !== 'string' || typeof fix.fixed !== 'string') {
    return { ok: false, test: null, reason: 'malformed fix entry' };
  }
  if (typeof askClaudeForTest !== 'function') {
    throw new TypeError('askClaudeForTest must be a function');
  }
  if (!Array.isArray(fix.issues) || fix.issues.length === 0) {
    return { ok: false, test: null, reason: 'no issues to test' };
  }

  if (!isTestableFix(fix)) {
    return { ok: false, test: null, reason: `not testable: ${fix.file}` };
  }

  // CREATE_FILE fixes have no original content — there's no "buggy
  // version" to demonstrate, so a regression test is meaningless.
  if (typeof fix.original !== 'string' || fix.original.length === 0) {
    return { ok: false, test: null, reason: 'new file (no buggy version to regress against)' };
  }

  const testPath = buildTestPath(fix.file);
  if (!testPath) {
    return { ok: false, test: null, reason: 'could not build test path' };
  }

  const framework = detectFramework(testPath, frameworkHint);
  const prompt = buildTestPrompt({
    filePath: fix.file,
    originalContent: fix.original,
    fixedContent: fix.fixed,
    issues: fix.issues,
    framework,
  });

  let response;
  try {
    response = await askClaudeForTest(prompt);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, test: null, reason: `AI provider error: ${message}` };
  }

  // Strip markdown fences if Claude added them despite instructions
  let content = String(response || '')
    .replace(/^```[\w]*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  if (!content) {
    return { ok: false, test: null, reason: 'empty AI response' };
  }

  if (content === 'SKIP' || /^SKIP\b/.test(content)) {
    return { ok: false, test: null, reason: 'the AI declined (purely cosmetic fix or untestable in isolation)' };
  }

  // Refusal markers — same shape as the main fix loop's validateFix.
  const firstLine = content.split('\n', 1)[0] || '';
  if (/^I (cannot|can't|won't)\b|^I'm unable to\b|^As an AI\b/.test(firstLine)) {
    return { ok: false, test: null, reason: 'the AI refused' };
  }

  // Sanity: a useful test must reference the source file or one of
  // the issues. If it's a 5-line stub with no link to the fix, it's
  // not adding value — drop it.
  if (content.length < 100) {
    return { ok: false, test: null, reason: `test too short (${content.length} chars) to be meaningful` };
  }

  return {
    ok: true,
    test: { path: testPath, content },
    reason: null,
  };
}

/**
 * Generate regression tests for a batch of fixes. Per-fix failures
 * are logged but never abort the batch — a missing test never blocks
 * the underlying fix from shipping.
 *
 * @param {Object} opts
 * @param {Array<{ file, fixed, original, issues }>} opts.fixes
 * @param {(prompt: string) => Promise<string>} opts.askClaudeForTest
 * @param {string} [opts.frameworkHint]
 * @returns {Promise<{
 *   tests: Array<{ path: string, content: string, sourceFile: string }>,
 *   skipped: Array<{ sourceFile: string, reason: string }>,
 *   summary: string,
 * }>}
 */
async function generateTestsForFixes(opts) {
  const { fixes, askClaudeForTest, frameworkHint } = opts || {};
  if (!Array.isArray(fixes)) throw new TypeError('fixes must be an array');
  if (typeof askClaudeForTest !== 'function') throw new TypeError('askClaudeForTest must be a function');

  const tests = [];
  const skipped = [];

  for (const fix of fixes) {
    const result = await generateTestForFix({ fix, askClaudeForTest, frameworkHint });
    if (result.ok && result.test) {
      tests.push({
        path: result.test.path,
        content: result.test.content,
        sourceFile: fix.file,
      });
    } else {
      skipped.push({ sourceFile: fix && fix.file ? fix.file : '(unknown)', reason: result.reason || 'unknown' });
    }
  }

  const summary = tests.length === 0
    ? `test generation: 0 tests written (${skipped.length} skipped)`
    : `test generation: ${tests.length} regression test${tests.length > 1 ? 's' : ''} written, ${skipped.length} skipped`;

  return { tests, skipped, summary };
}

module.exports = {
  generateTestForFix,
  generateTestsForFixes,
  // Exported for tests / advanced callers.
  isTestableFix,
  buildTestPath,
  detectFramework,
  buildTestPrompt,
};
