'use strict';
/**
 * Canonical "is this test/fixture code?" pattern — the union of the 6
 * drifted copies it replaces. Forward slashes only; `_isTestPath()` owns
 * normalising the input, so callers must go through it rather than testing
 * this directly (that omission is the Windows bug it was built to fix).
 *
 * Three branches: a directory segment anywhere in the path, a conventional
 * `.test.<ext>` / `.spec.<ext>` suffix, or a Python runner basename.
 * Language list covers the runtimes GateTest scans.
 */
// The definition lives in src/core so both layers read it: modules through
// `BaseModule._isTestPath` / `BaseModule.TEST_PATH_RE`, core (the dependency
// reachability walker) directly. tests/test-path-canonical.test.js is the
// guard: no other file may declare its own.
const TEST_PATH_RE =
  // `[a-z0-9]+[-_](?:tests?|specs?)` — django keeps its QUnit suite in
  // `js_tests/`, hono its runtime tests in `runtime-tests/`. A segment that
  // ENDS in a test word with a separator before it is a test dir; `contest`,
  // `latest`, `tester.js` have no separator and stay application code.
  //
  // `(?:test_[^/]*|[^/]*_test|tests|conftest)\.py` — the Python runners
  // find tests by BASENAME, not by suffix: pytest collects `test_*.py` and
  // `*_test.py` and loads `conftest.py` by name; Django's runner discovers
  // `test*.py`, so an app ships a single `tests.py` beside `views.py`. The
  // whole basename is matched at end-of-path (`[^/]*` cannot cross a
  // segment), and the loading rule is the same as the directory branch: a
  // test WORD with a separator (`_`) or nothing on the far side. `contest`,
  // `latest`, `attestation`, `testing`, `testcases`, `testutils` carry the
  // word inside an identifier and stay application code — django's
  // `django/test/testcases.py` is test-support code classified by its
  // `test/` directory, never by its name. Bare `test.py` is deliberately
  // NOT here: pytest does not collect it, and the two in the corpus are both
  // shipped code — `django/core/management/commands/test.py` IS the
  // `manage.py test` command, and `django/contrib/messages/test.py` is a
  // public assertion mixin. Matching it would silence checks on files that
  // exist precisely because they run tests, not because they are tests.
  //
  // `benchmarks?|bench` — a benchmark is the same KIND of code as a test: a
  // harness that measures the library and never ships (the engine already
  // said so twice — `HARNESS_DIR_RE` in scan-scope.js and `NOT_SHIPPED_RE`
  // in dependency-reachability.js — but this predicate, the one the
  // severity ladders read, did not). sindresorhus/got's `benchmark/index.ts`
  // sets `rejectUnauthorized: false` against its own local server four
  // times and was gate-BLOCKED on all four at confidence 1.0 (2026-09-14).
  //
  // `examples/` is deliberately NOT here, and neither is `docs/`. tRPC keeps
  // its real workspaces under `examples/*` — `tests/new-modules.test.js`
  // pins that trpcContract still reads a router there — and KI #77 recorded
  // why folding docs/ in would silence every module under it. Sample code
  // is a per-module judgement (claude-compliance makes it), not a harness.
  /(?:^|\/)(?:tests?|specs?|__tests__|__mocks__|e2e|fixtures?|stories|storybook|reliability-corpus|testdata|test[-_]?resources|benchmarks?|bench|[a-z0-9]+[-_](?:tests?|specs?))(?:\/|$)|\.(?:test|spec|stories|fixture|e2e)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts|py|rb|go|java|rs|php)$|(?:^|\/)(?:test_[^/]*|[^/]*_test|tests|conftest)\.py$/i;

/**
 * Is this project-relative path test / fixture code? Normalises Windows
 * separators here, once — the omission at call sites was the bug this
 * predicate was built to fix.
 * @param {string} relPath
 * @returns {boolean}
 */
function isTestPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return false;
  return TEST_PATH_RE.test(relPath.replace(/\\/g, '/'));
}

module.exports = { TEST_PATH_RE, isTestPath };
