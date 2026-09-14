/**
 * Flaky Tests Module — tests that pass on your laptop and fail in CI.
 *
 * Every team that ships has a test suite that flakes. The usual
 * suspects: someone committed `it.only` to debug a single test and
 * forgot it, a test reads `Date.now()` and asserts against a fixed
 * string, a spec calls real `fetch('https://api.stripe.com')` in CI,
 * `setTimeout` races against assertions, `process.env.X` gets mutated
 * in one test and read in another. Every one of those is a CI failure
 * waiting to happen. This module reads test source directly — no
 * runtime required — and flags the shapes before they flake.
 *
 * Discovery: `*.test.{js,jsx,ts,tsx,mjs,cjs,mts,cts}`,
 *            `*.spec.*`, and any file under `tests/`, `test/`,
 *            `__tests__/`, `spec/`.
 *
 * Rules (grouped by class of flake):
 *
 *   1. Left-in focus/skip modifiers (committed accidents)
 *      error:   `it.only(` / `test.only(` / `describe.only(` / `fit(` / `fdescribe(`
 *               (rule: `flaky-tests:only-committed:<rel>:<line>`)
 *      warning: `it.skip(` / `test.skip(` / `xit(` / `xdescribe(` / `xtest(`
 *               (rule: `flaky-tests:skip-committed:<rel>:<line>`)
 *      info:    `it.todo(` / `test.todo(` without a linked issue/PR
 *               in the title
 *               (rule: `flaky-tests:todo-no-issue:<rel>:<line>`)
 *
 *   2. Nondeterminism
 *      warning: `Math.random()` in a test file whose value reaches an
 *               assertion — non-seeded, flakes randomly (a random suffix
 *               on a temp filename reaches none and stays quiet)
 *               (rule: `flaky-tests:math-random:<rel>:<line>`)
 *      warning: `Date.now()` / `new Date()` with NO fake-timer setup
 *               anywhere in the file, asserted by VALUE — clock-dependent
 *               flake (a bound such as `elapsed < 5000` is a budget)
 *               (rule: `flaky-tests:real-clock:<rel>:<line>`)
 *
 *   3. Network hitting real endpoints from tests
 *      warning: `fetch(`, `axios.(get|post|put|delete)(`, `http.request(`
 *               with a URL argument when no mock harness (`nock`,
 *               `msw`, `vi.mock(`, `jest.mock(`, `fetchMock`) appears
 *               in the file
 *               (rule: `flaky-tests:real-network:<rel>:<line>`)
 *
 *   4. Real-time setTimeout/setInterval
 *      warning: `setTimeout(` / `setInterval(` in a test file with NO
 *               fake-timer setup — timing-dependent assertion. A BOUND
 *               (a timeout that rejects / kills / fails, or is cleared on
 *               success) and a SLEEP that no assertion follows are not
 *               races and stay quiet; a sleep-then-assert fires.
 *               (rule: `flaky-tests:real-timer:<rel>:<line>`)
 *
 *   5. Process-wide state mutation
 *      warning: `process.env.XXX = ...` without a matching restore in
 *               an `afterEach` / `afterAll` / `after` / `finally` later
 *               in the file — by name, by computed key, or wholesale
 *               (rule: `flaky-tests:env-leak:<rel>:<line>`)
 *
 *   6. Self-admission
 *      warning: test title contains `flaky`, `intermittent`,
 *               `sometimes`, `randomly`, `eventually` (unless wrapped
 *               in a retry helper — we can't tell either way, so we
 *               warn and let humans adjudicate)
 *               (rule: `flaky-tests:self-admitted:<rel>:<line>`)
 *
 * Non-goals: we don't try to run the tests or parse their ASTs. This
 * is a line-heuristic scanner. False positives are tolerable because
 * every flag is reviewed — false negatives (a missed flaky pattern)
 * are what actually cost teams money in CI minutes and "retry and
 * merge" culture.
 *
 * TODO(gluecron): once Gluecron ships first-party CI, add a rule
 * detecting tests that rely on GitHub-specific env vars
 * (`GITHUB_TOKEN`, `GITHUB_WORKSPACE`, etc.) without guarding for
 * Gluecron equivalents.
 */

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');
const { stripStringsAndComments } = require('../core/source-strip');

// Directory excludes beyond what `BaseModule._collectFiles` already skips
// (node_modules, .git, dist, build, coverage, .next, out, …). The old
// private walk (removed under KI #104) also skipped these.
const EXTRA_EXCLUDES = ['.terraform'];

const TEST_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
// Which files are test suites is "is this a test path" (one definition,
// `BaseModule._isTestPath`) narrowed to the JS/TS extensions. This module
// kept its own two regexes until 2026-09-05 and they had drifted: django's
// `js_tests/` and hono's `runtime-tests/` (a segment ENDING in a test word)
// were never scanned, so a `.only(` left in either was invisible.

// Fake-timer / mock hints — if ANY of these appear in the file, we
// soften the real-clock / real-timer / real-network rules.
const FAKE_TIMER_HINTS = [
  /\bjest\.useFakeTimers\b/,
  /\bvi\.useFakeTimers\b/,
  /\bsinon\.useFakeTimers\b/,
  /\buseFakeTimers\s*\(/,
  /\bMockDate\b/,
  /\btimekeeper\b/i,
  // node:test's built-in clock — `mock.timers.enable({ apis: ['Date'] })` /
  // `t.mock.timers.enable(…)`. It is the fake-timer setup this rule's own
  // suggestion should name for a node:test suite, and until 2026-09-13 it
  // was not on the list, so a test that had done exactly the right thing
  // was still reported.
  /\bmock\.timers\.enable\s*\(/,
];

const MOCK_NETWORK_HINTS = [
  /\bnock\s*\(/,
  /\bmsw\b/i,
  /\bjest\.mock\s*\(/,
  /\bvi\.mock\s*\(/,
  /\bfetchMock\b/i,
  /\bmockFetch\b/i,
  /\bsinon\.(?:stub|spy|fake)\b/,
  /\bfrom ['"]msw['"]/, // import from 'msw'

  // A test that supplies its OWN fetch is mocked without using a mocking
  // library. This list previously recognised libraries only, so the modern
  // pattern — define a fetch stub, inject it — read as an unmocked real call.
  //
  // Measured on axios @81df7a5 (org axios): flaky-tests produced 264 of the
  // repo's 487 warnings, 210 of them `real-network`. The sampled case,
  // tests/smoke/bun/tests/cancel.smoke.test.ts:67, is
  //
  //     const fetch = async () => new Response(JSON.stringify({ ok: true }), …)
  //     …
  //     const request = axios.get('https://example.com/in-flight', { fetch })
  //
  // The URL is never requested. example.com is not even resolved. That is a
  // fully hermetic test being told it will flake on a DNS hiccup.
  //
  // Deliberately narrow: a BINDING named `fetch`, or an assignment to the
  // global. Not `adapter:` (appears in real-network config too) and not a
  // bare `new Response(` (a file can construct one and still call out).
  /\b(?:const|let|var|function)\s+fetch\b/,
  /\b(?:globalThis|global|window|self)\s*\.\s*fetch\s*=/,
  /\bnew\s+MockAdapter\s*\(|\baxios-mock-adapter\b/,

  // A file that DECLARES a test double is a file that mocks, whether or not
  // it reaches for a mocking library. axios's smoke tests build
  // `createTransportMock()` and pass the result as `transport`, so the
  // request never touches the network stack:
  //
  //     const createTransportMock = (…) => ({ request(options, onResponse) {…} })
  //     …
  //     await axios.post('http://example.com/form', form,
  //                      { adapter: 'http', proxy: false, transport })
  //
  // This is file-level, like every other hint here — `jest.mock(` anywhere in
  // a file already suppresses the whole file, so the granularity is the
  // list's existing design rather than a new concession.
  //
  // The false-negative it admits: a file declaring a data fixture named
  // `mockUser` that ALSO makes a genuine external call would go unreported.
  // Accepted knowingly at warning severity, where 80 false warnings cost more
  // trust than one missed advisory — and recorded here so the trade is
  // visible rather than discovered later.
  /\b(?:const|let|var|function)\s+\w*(?:Mock|Stub|Fake)\w*\b/,
];

const SELF_ADMIT_TITLE_RE = /\b(?:flak(?:y|iness)|intermittent|sometimes\s+fails?|randomly\s+fails?|eventually\s+works?)\b/i;
// A title in which flakiness is the SUBJECT, not a confession: a test of a
// classifier ("classifies: flaky timer / timeout test", tests/ci-doctor-
// failure-classifier.test.js:148) or of a verdict ("CI failed but local
// passed → flaky", tests/replay-plan.test.js:192). A classifying verb before
// the word, or an arrow leading to it, is the tell; "is sometimes flaky in
// CI" has neither and still fires.
// The verb must open the title (at most one word before it — "should
// classify …"): "uploads the report (flaky on Windows)" reports nothing.
const FLAKE_IS_SUBJECT_RE = /^\s*(?:[\w-]+\s+)?(?:classif|detect|identif|recogni[sz]|categori[sz]|label|flag|mark|report|treat|diagnos)\w*\b.*\b(?:flak|intermittent|sometimes|randomly|eventually)|(?:→|->|=>)\s*(?:flak|intermittent)/i;

// Every pattern below is matched on the MASKED source — comments gone,
// string contents blanked, offsets preserved (src/core/source-strip.js, the
// one definition of where a string or comment begins and ends). A
// `setTimeout(` inside a fixture string, a `Date.now()` in a template a
// test writes to disk, or a `.only` in a quoted diff is data, not a test
// smell. Before 2026-09-05 only the `.only` / `.skip` / network rules had a
// guard, and it was a per-line quote counter of this module's own; the
// timer and clock rules had none and reported our own tests/run-tests.test.js
// for the fixture text it writes (found by our scanner on PR #456).
/** `re` ends at an opening quote on the masked line; does the raw line hold an http(s) URL there? */
function callsUrl(code, line, re) {
  const m = re.exec(code);
  return !!m && /^https?:\/\//.test(line.slice(m.index + m[0].length));
}

// ---------------------------------------------------------------------------
// A timer is only a flake when the test's VERDICT depends on it. Our own
// scanner reported 13 `real-timer` findings on this repository (2026-09-13),
// and opening every one of them found two shapes that are not races at all:
//
//   BOUND   `const timer = setTimeout(() => { proc.kill(); reject(new Error(
//           'timed out')) }, 5000)` … `clearTimeout(timer)` on success
//           (tests/heavy/mcp-server.test.js:67). The callback runs only when
//           the test has ALREADY hung; it changes how a failure is reported,
//           never whether the test passes.
//   SLEEP   `await new Promise((r) => setTimeout(r, 60))` inside a stub
//           handed to the code under test to make it slow
//           (tests/empire-smoke.test.js:212), or a `sleep()` helper used to
//           poll. A timer never fires EARLY, so "sleep 60ms, assert elapsed
//           > 30ms" is deterministic. The racy sleep is the one immediately
//           followed by an assertion about something ELSE — "wait 100ms and
//           hope it happened" — and that is the shape that still fires.
//
// Every rule below runs on the masked source.
// ---------------------------------------------------------------------------

/** The arguments of a call — from the open paren at `idx` on masked line `i` to its close, at most `maxLines` lines. */
function callText(masked, i, idx, maxLines = 8) {
  let depth = 0;
  let out = '';
  for (let k = i; k < masked.length && k < i + maxLines; k += 1) {
    const l = masked[k] || '';
    for (let c = k === i ? idx : 0; c < l.length; c += 1) {
      const ch = l[c];
      if (ch === '(') { depth += 1; if (depth > 1) out += ch; }
      else if (ch === ')') { depth -= 1; if (depth === 0) return out; out += ch; }
      else if (depth > 0) out += ch;
    }
    out += '\n';
  }
  return out;
}

// The callback of a bound aborts: it rejects, throws, kills the process,
// fails the test, or records that the wait timed out.
const TIMER_ABORT_RE = /\b(?:reject|throw|fail|abort|destroy|timedOut|timeout)\b|\.kill\s*\(|\bdone\s*\(\s*(?:new\b|err)/;

// `new Promise((r) => setTimeout(r, ms))` — a sleep, resolver passed straight
// to the timer (or `() => r()`), nothing else in the callback.
const SLEEP_WRAPPER_RE = /\bnew\s+Promise\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\{?\s*setTimeout\s*\(\s*(?:\1|\(\s*\)\s*=>\s*\1\s*\(\s*\))\s*,/;

// A line that asserts. `t.assert.strictEqual` / `assert(` / `expect(` /
// chai `should`.
const ASSERTION_RE = /\b(?:expect|assert(?:\.\w+)*|should)\s*\(/;

// An assertion that BOUNDS a value rather than naming it: `elapsed < 5000`,
// `daysLeft > 60`, `.toBeLessThan(`. The `[<>]` must not be an arrow's `>`
// or half of `<=` already consumed.
const BOUND_ASSERT_RE = /(?<![=<>!])[<>]=?(?![=>])|\bto(?:Be)?(?:Less|Greater)Than(?:OrEqual)?\b|\bis(?:Below|Above|AtLeast|AtMost)\b|\b(?:lessThan|greaterThan|below|above|within)\b/;

/**
 * Is the timer opened at `idx` on masked line `i` a guard — a bound the test
 * only reaches by hanging?
 */
function timerIsGuard(masked, maskedAll, i, code, idx) {
  // (i) the handle is cleared on the success path.
  const handle = code.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:setTimeout|setInterval)\s*\(/);
  if (handle && new RegExp(`\\bclear(?:Timeout|Interval)\\s*\\(\\s*${handle[1]}\\b`).test(maskedAll)) return true;
  // (ii) the timer never holds the loop open.
  if (/\)\s*\.unref\s*\(/.test(code)) return true;
  // (iii) the callback aborts.
  return TIMER_ABORT_RE.test(callText(masked, i, idx));
}

/** Does an assertion follow within `n` lines of masked line `i` (a sleep-then-assert)? */
function assertionFollows(masked, i, n = 4) {
  for (let k = i + 1; k <= i + n && k < masked.length; k += 1) {
    if (ASSERTION_RE.test(masked[k] || '')) return true;
  }
  return false;
}

/**
 * The helper name a sleep wrapper is bound to — `const sleep = (ms) =>
 * new Promise(…)` on the same line, or `function settle(ms) {` / `const
 * wait = async (ms) => {` on the line above a bare `return new Promise`.
 */
function sleepHelperName(masked, i) {
  const same = (masked[i] || '').match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (same) return same[1] || same[2];
  const prev = (masked[i - 1] || '').match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/);
  return prev ? (prev[1] || prev[2]) : null;
}

/**
 * Is the value produced by `callRe` on masked line `i` asserted on — inline,
 * or through the variable it is assigned to? Returns the assertion line's
 * masked text when it is (so the caller can ask what KIND of assertion), or
 * null. Shared by the clock and RNG rules: a timestamp in a temp filename
 * and a random suffix on it are deterministic in every way a test cares
 * about — only a value the test ASSERTS against can flake.
 */
function assertedValue(code, masked, i, callRe) {
  const inline = new RegExp(`\\b(?:expect|assert(?:\\.\\w+)*|should)\\s*\\(?[^;\\n]*${callRe.source}`);
  if (inline.test(code)) return code;
  const assign = code.match(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^;]*${callRe.source}`));
  if (!assign) return null;
  const varRe = new RegExp(`\\b(?:expect|assert(?:\\.\\w+)*|should)\\s*\\(?[^;\\n]*\\b${assign[1]}\\b`);
  for (let k = i + 1; k < masked.length; k += 1) {
    if (varRe.test(masked[k] || '')) return masked[k];
  }
  return null;
}

class FlakyTestsModule extends BaseModule {
  constructor() {
    super(
      'flakyTests',
      'Flaky Tests — committed .only/.skip, real clock/network/timers, env leaks, self-admitted flakes',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    // Shared walk from BaseModule — honours --diff/--pr scoping (KI #104);
    // the test-file predicate is applied on top of it.
    const files = this._collectFiles(projectRoot, [...TEST_EXTS], EXTRA_EXCLUDES)
      .filter((f) => this._isTestFile(f, projectRoot));

    if (files.length === 0) {
      result.addCheck('flaky-tests:no-files', true, {
        severity: 'info',
        message: 'No test files found — skipping',
      });
      return;
    }

    result.addCheck('flaky-tests:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} test file(s)`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('flaky-tests:summary', true, {
      severity: 'info',
      message: `Flaky tests scan: ${files.length} file(s), ${issues} issue(s)`,
    });
  }

  _isTestFile(full, projectRoot) {
    if (!TEST_EXTS.has(path.extname(full).toLowerCase())) return false;
    return this._isTestPath(repoRelative(projectRoot, full));
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch { return 0; }

    const rel = repoRelative(projectRoot, file);
    const lines = content.split(/\r?\n/);
    const masked = stripStringsAndComments(content).split(/\r?\n/);
    let issues = 0;

    const hasFakeTimers = FAKE_TIMER_HINTS.some((re) => re.test(content));
    const hasNetworkMock = MOCK_NETWORK_HINTS.some((re) => re.test(content));

    // Track env mutations + their potential restores (file-level).
    const envMutations = []; // { line, varName }
    const envRestores = new Set(); // varNames with a restore call afterwards
    // Sleep helpers declared in this file (`const sleep = (ms) => new
    // Promise(…)`) — their call sites are judged in the post-pass.
    const sleepHelpers = new Set();
    const maskedAll = masked.join('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];      // raw: messages, titles, URL literals
      const code = masked[i] || ''; // masked: every pattern match
      if (!code.trim()) continue;

      // 1. Focus / skip modifiers (a `.only` inside a string fixture is data)
      if (/\b(?:it|test|describe)\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(/.test(code)) {
        issues += this._flag(result, `flaky-tests:only-committed:${rel}:${i + 1}`, {
          severity: 'error',
          file: rel,
          line: i + 1,
          message: `${rel}:${i + 1} contains \`.only\` / \`fit\` / \`fdescribe\` — this silently disables every OTHER test in the file`,
          suggestion: 'Remove `.only` before committing. If you need to focus one test locally, use the test runner\'s CLI filter instead.',
        });
      }

      if (/\b(?:it|test|describe)\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\bxtest\s*\(/.test(code)) {
        issues += this._flag(result, `flaky-tests:skip-committed:${rel}:${i + 1}`, {
          severity: 'warning',
          file: rel,
          line: i + 1,
          message: `${rel}:${i + 1} contains \`.skip\` / \`xit\` — skipped tests rot; if you can't fix it, delete it or convert to \`.todo\` with an issue link`,
          suggestion: 'Fix the test, delete it, or change to `it.todo(\'... — see ISSUE-123\')`.',
        });
      }

      // 2. `.todo` with no issue link in the title
      const todoMatch = /\b(?:it|test)\.todo\s*\(/.test(code) ? line.match(/\b(?:it|test)\.todo\s*\(\s*(['"`])([^'"`]*?)\1/) : null;
      if (todoMatch) {
        const title = todoMatch[2];
        const hasLink = /(?:issue|#\d+|https?:\/\/|gh\/|pr[-/]?\d+|bug[-\s]?\d+)/i.test(title);
        if (!hasLink) {
          issues += this._flag(result, `flaky-tests:todo-no-issue:${rel}:${i + 1}`, {
            severity: 'info',
            file: rel,
            line: i + 1,
            message: `${rel}:${i + 1} has a \`.todo\` with no linked issue — TODOs without issues never get picked up`,
            suggestion: 'Include an issue link or reference: `it.todo(\'handles negative zero — see #456\')`.',
          });
        }
      }

      // 3. Nondeterminism: Math.random
      if (/\bMath\.random\s*\(/.test(code)) {
        // Skip jitter/backoff context: `Math.random() * DELAY` or `* Math.random()`
        // These are legitimate uses in retry/timing tests, not nondeterministic data.
        const isJitterContext = /Math\.random\s*\(\s*\)\s*[*+]/.test(code)
          || /[*+]\s*Math\.random\s*\(\s*\)/.test(code);
        // Same test as the clock rule below: a random value is only a flake
        // when it is ASSERTED against. Nine of this repo's own findings were
        // `Math.random().toString(36)` making a temp filename unique
        // (tests/fix-telemetry.test.js:17 and eight siblings) — a value no
        // assertion ever reads (2026-09-13).
        if (!isJitterContext && assertedValue(code, masked, i, /\bMath\.random\s*\(/)) {
          issues += this._flag(result, `flaky-tests:math-random:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            message: `${rel}:${i + 1} calls \`Math.random()\` — an unseeded RNG in a test produces different values every run`,
            suggestion: 'Use a fixed seed (e.g., `seedrandom`), inject the random source as a parameter, or assert on a property that doesn\'t depend on the random value.',
          });
        }
      }

      // 4. Real clock: Date.now() or new Date() without fake timers.
      // Reading the clock is not flaky by itself — a timestamp in a fixture
      // id or a temp filename is deterministic in every way a test cares
      // about. It becomes flaky only when the value is ASSERTED against, so
      // flag a clock read only when it feeds an expect/assert: directly on
      // the same line, or via a variable that later appears inside one.
      // (2026-08-18 audit residue: the unconditional form was a tautology —
      // "test reads clock, therefore flaky" — and mostly noise.)
      //
      // And asserting a BOUND on the clock is not a race either. `const
      // elapsed = Date.now() - start; assert.ok(elapsed < 5000)` is a
      // performance budget — it fails when the code regresses, not when
      // the clock moves — and `daysLeft > 60` on a certificate expiry is
      // the same shape. What still fires is an assertion that names a
      // clock value: `assert.equal(path, \`report-${today}.md\`)` crosses
      // midnight (tests/scan-fix-nuclear-ciso-wire.test.js:217, 2026-09-13).
      if ((/\bDate\.now\s*\(/.test(code) || /\bnew\s+Date\s*\(\s*\)/.test(code)) && !hasFakeTimers) {
        const assertion = assertedValue(code, masked, i, /(?:\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\))/);
        if (assertion && !BOUND_ASSERT_RE.test(assertion)) {
          issues += this._flag(result, `flaky-tests:real-clock:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            message: `${rel}:${i + 1} asserts on a real clock reading (\`Date.now()\` / \`new Date()\`) with no fake-timer setup in this file`,
            suggestion: 'Call `jest.useFakeTimers()` / `vi.useFakeTimers()` / `sinon.useFakeTimers()` at the top of the describe, or inject a clock.',
          });
        }
      }

      // 5. Real network
      // The call is matched on the masked line (a test that writes source
      // fixtures — `write(tmp, 'src/gateway.ts', 'fetch("https://api…')` —
      // contains the call as DATA; three such lines in our own
      // tests/prompt-safety.test.js were reported, 2026-09-05, PR #431); the
      // URL is by definition inside the string, so it is read from the raw
      // line at the offset where the masked line kept the opening quote.
      const fetchCall = callsUrl(code, line, /\bfetch\s*\(\s*['"`]/);
      const axiosCall = callsUrl(code, line, /\baxios\.(?:get|post|put|delete|patch|head)\s*\(\s*['"`]/);
      const httpCall = /\b(?:https?)\.request\s*\(/.test(code);
      // A LOOPBACK request is not a real-network call. There is no DNS to
      // hiccup and no third party to return a 5xx — the two failures this
      // rule's own message names. It is a test talking to a server the test
      // started, which is the standard way to test an HTTP client.
      //
      // Measured on axios @81df7a5 (org axios): 113 of 203 remaining
      // real-network findings were in tests/unit/adapters/http.test.js alone,
      // a file that calls http.createServer 14 times and points 96 of its 126
      // requests at localhost / 127.0.0.1 / [::1].
      //
      // Per-line rather than per-file on purpose: the same file also requests
      // `http://connect-timeout.test/`, and a file-level suppression would
      // have silenced that too.
      const loopback = /['"`]https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(?::|\/|['"`])/.test(line);
      if ((fetchCall || axiosCall || httpCall) && !hasNetworkMock && !loopback) {
        issues += this._flag(result, `flaky-tests:real-network:${rel}:${i + 1}`, {
          severity: 'warning',
          file: rel,
          line: i + 1,
          message: `${rel}:${i + 1} makes a real HTTP call with no network mock detected in this file — every 5xx or DNS hiccup flakes this test`,
          suggestion: 'Use `nock`, `msw`, `jest.mock(\'node:http\')`, or `vi.mock(\'node:fetch\')`. If this is an integration test against a staging env, mark the describe with a CI flag and document it.',
        });
      }

      // 6. Real timers — see the BOUND / SLEEP note above `callText`.
      const timerAt = code.search(/\b(?:setTimeout|setInterval)\s*\(/);
      if (timerAt !== -1 && !hasFakeTimers) {
        const openIdx = code.indexOf('(', timerAt);
        const sleep = SLEEP_WRAPPER_RE.test(code);
        let racy;
        if (sleep) {
          // A sleep is racy where it is awaited and an assertion follows.
          // A helper definition is judged at its call sites (post-pass);
          // an inline `await new Promise(…)` is judged here.
          const helper = sleepHelperName(masked, i);
          if (helper) { sleepHelpers.add(helper); racy = false; } else racy = /\bawait\b/.test(code) && assertionFollows(masked, i);
        } else {
          racy = !timerIsGuard(masked, maskedAll, i, code, openIdx);
        }
        if (racy) {
          issues += this._flag(result, `flaky-tests:real-timer:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            message: sleep
              ? `${rel}:${i + 1} sleeps on a real timer and then asserts — the assertion is a bet that something else finished first, and CI loses that bet`
              : `${rel}:${i + 1} uses \`setTimeout\` / \`setInterval\` in a test with no fake-timer setup — every race condition in CI surfaces as a flake`,
            suggestion: sleep
              ? 'Await the event itself (a promise, an `once(emitter, …)`, a bounded poll in a `for`/`while`) instead of a fixed delay, or use fake timers and advance them explicitly.'
              : 'Use `jest.useFakeTimers()` / `vi.useFakeTimers()` / node:test `mock.timers.enable()` and advance time explicitly. A timeout that only REJECTS or KILLS on a hang is a bound, not a race — clear it on the success path and this rule recognises it.',
          });
        }
      }

      // 7. process.env mutations (record for later restore check)
      const envMatch = code.match(/\bprocess\.env\.([A-Z_][A-Z0-9_]*)\s*=/);
      if (envMatch) {
        envMutations.push({ line: i + 1, varName: envMatch[1] });
      }
      // Track restores: `delete process.env.X`, or later assignment to a
      // saved `originalX` inside afterEach/afterAll.
      const restoreMatch = code.match(/\bdelete\s+process\.env\.([A-Z_][A-Z0-9_]*)/);
      if (restoreMatch) envRestores.add(restoreMatch[1]);

      // 8. Self-admission — test titles with flaky keywords
      const titleMatch = /\b(?:it|test)\s*\(\s*['"`]/.test(code) ? line.match(/\b(?:it|test)\s*\(\s*(['"`])([^'"`]+?)\1/) : null;
      if (titleMatch && SELF_ADMIT_TITLE_RE.test(titleMatch[2]) && !FLAKE_IS_SUBJECT_RE.test(titleMatch[2])) {
        issues += this._flag(result, `flaky-tests:self-admitted:${rel}:${i + 1}`, {
          severity: 'warning',
          file: rel,
          line: i + 1,
          title: titleMatch[2],
          message: `${rel}:${i + 1} test title admits flakiness: "${titleMatch[2]}" — tests that are documented as flaky ARE the bug`,
          suggestion: 'Root-cause the nondeterminism. If you genuinely need retry-on-failure, use your runner\'s `retry` option explicitly and track the root-cause as a bug.',
        });
      }
    }

    // Post-pass: a sleep helper's call sites. `await sleep(250)` followed
    // by an assertion is the race; `await sleep(500)` at the top of a poll
    // loop, or on a `for` / `while` line, is a bounded wait.
    for (const helper of sleepHelpers) {
      const callRe = new RegExp(`\\bawait\\s+${helper}\\s*\\(`);
      for (let i = 0; i < masked.length; i += 1) {
        const code = masked[i] || '';
        if (!callRe.test(code) || !assertionFollows(masked, i)) continue;
        // A poll: the sleep sits on a loop line or in the body a loop
        // opened within the three lines above.
        if (masked.slice(Math.max(0, i - 3), i + 1).some((l) => /\b(?:for|while)\s*\(/.test(l || ''))) continue;
        issues += this._flag(result, `flaky-tests:real-timer:${rel}:${i + 1}`, {
          severity: 'warning',
          file: rel,
          line: i + 1,
          message: `${rel}:${i + 1} sleeps on a real timer (\`${helper}()\`) and then asserts — the assertion is a bet that something else finished first, and CI loses that bet`,
          suggestion: 'Await the event itself (a promise, an `once(emitter, …)`, a bounded poll in a `for`/`while`) instead of a fixed delay, or use fake timers and advance them explicitly.',
        });
      }
    }

    // Post-pass: flag env mutations whose variable was never restored.
    // `restored` covers two cases: explicit `delete process.env.X` or a
    // later restore inside a teardown — `afterEach` / `afterAll`, node:test's
    // `after` / `t.after`, or a `finally` block. The restore may name the
    // variable (`process.env.X = orig`), restore by computed key
    // (`process.env[k] = saved[k]` over a saved map, tests/pr-size.test.js:45)
    // or replace the whole object (`process.env = { ...ORIGINAL }`); until
    // 2026-09-13 only the named form after `afterEach|afterAll` counted, so
    // a `finally` restore and a saved-map restore were both reported as
    // leaks. Approximated with a windowed match over the MASKED file, so a
    // comment saying "after the require" is not a teardown.
    for (const mutation of envMutations) {
      if (envRestores.has(mutation.varName)) continue;
      const restoreRe = new RegExp(
        `\\b(?:afterEach|afterAll|after|finally)\\b[\\s\\S]{0,500}(?:process\\.env\\.${mutation.varName}\\s*=|process\\.env\\s*=[^=]|process\\.env\\[[^\\]]+\\]\\s*=[^=]|delete\\s+process\\.env\\[)`,
      );
      if (restoreRe.test(maskedAll)) continue;
      issues += this._flag(result, `flaky-tests:env-leak:${rel}:${mutation.line}:${mutation.varName}`, {
        severity: 'warning',
        file: rel,
        line: mutation.line,
        envVar: mutation.varName,
        message: `${rel}:${mutation.line} sets \`process.env.${mutation.varName}\` with no matching restore in afterEach/afterAll — later tests in the run see the mutation`,
        suggestion: `Wrap in an afterEach: \`const orig = process.env.${mutation.varName}; /* ... */; afterEach(() => { process.env.${mutation.varName} = orig; });\` (or just \`delete process.env.${mutation.varName}\`).`,
      });
    }

    return issues;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = FlakyTestsModule;
