/**
 * KI #77 — one canonical "is this test code?" predicate.
 *
 * What the audit actually found (the KI said "TEST_PATH_RE copy-pasted into
 * 20 files", which undersold it): there were **6 materially different**
 * bodies, so whether a path counted as a test depended on which module asked.
 *
 * And the live defect underneath: `path.relative()` returns `tests\helper.js`
 * on Windows, but every one of those regexes required `/`. Eight modules
 * tested the raw value — async-iteration, env-vars, hardcoded-url,
 * import-cycle, openapi-drift, race-condition, resource-leak, ssrf — so on
 * any Windows checkout a file under `tests/` went unrecognised unless its
 * NAME also carried `.test.`/`.spec.`. Findings in `tests/helper.js`,
 * `tests/setup.js`, `spec/support/*.js` were reported at full severity; for
 * `ssrf` that is a gate-BLOCKING error instead of an info.
 *
 * Measured effect of consolidating, on GateTest's own repo (a Windows
 * checkout): warnings 820 -> 813. Seven real false positives removed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BaseModule = require('../src/modules/base-module');
const MODULES_DIR = path.join(__dirname, '..', 'src', 'modules');

const probe = new BaseModule('probe', 'probe');

describe('BaseModule._isTestPath — canonical predicate', () => {
  const MATCH = [
    'tests/helper.js',
    'test/helper.js',
    'src/__tests__/a.js',
    'spec/support/env.js',
    'specs/thing.js',
    'e2e/flow.js',
    'src/fixtures/data.js',
    'stories/Button.js',
    'src/foo.test.js',
    'src/foo.spec.ts',
    'src/foo.stories.tsx',
    'app/test_thing.spec.py',
    // Compound test dirs with a separator — django's QUnit suite lives in
    // js_tests/, hono's runtime tests in runtime-tests/. Both were
    // application code to every path predicate until 2026-09-05.
    'js_tests/admin/inlines.test.js',
    'pkg/testdata/fixture.go',
    'ktor-server/core/test-resources/testdir/test.html',
    'py_tests/a.py',
    'runtime-tests/lambda/mock.ts',
    // Python runners discover tests by BASENAME (2026-09-05): pytest collects
    // `test_*.py` / `*_test.py` and loads `conftest.py` by name; Django's
    // runner finds an app's single `tests.py`. django's own `scripts/tests.py`
    // (233 lines of unittest.TestCase) was application code to this
    // predicate — four "unused export" warnings on its test classes.
    'app/test_views.py',
    'pkg/views_test.py',
    'app/tests.py',
    'conftest.py',
    'src/pkg/conftest.py',
    'scripts/tests.py',
    'django/test/testcases.py', // by its `test/` DIRECTORY, unchanged — see below
    // A benchmark is a harness, the same kind of code as a test (2026-09-14):
    // got's `benchmark/index.ts` disables TLS verification against its own
    // local server and was gate-BLOCKED four times.
    'benchmark/index.ts',
    'bench/run.js',
    'packages/zod/src/v3/benchmarks/string.ts',
  ];
  const NO_MATCH = [
    'src/app.js',
    'lib/tester.js',        // "test" as a substring is not a test dir
    'src/contest/main.js',
    'src/latest/x.js',
    'src/attestation.js',
    'protest.js',
    'src/manifest/x.js',      // ends in "test" with no separator
    'src/greatest_hits.js',
    'src/testdatabase.go',
    // The Python basename branch is a whole word at end-of-path: the test
    // word inside an identifier is not a test file.
    'contest.py',
    'src/latest.py',
    'src/attestation.py',
    'src/testing.py',
    'src/testcases.py',         // django/test/testcases.py matches by DIRECTORY, never by name
    'src/testutils.py',
    'test_data.json',           // not .py — a fixture only by its directory
    'pytest.ini',
    'src/test_views.pyc',
    'a/test_x.py/b.js',         // the basename must END the path
    // Bare `test.py` is not a test: pytest never collects it, and both in
    // the corpus are shipped code — django/core/management/commands/test.py
    // IS the `manage.py test` command; django/contrib/messages/test.py is a
    // public assertion mixin. Matching the name would silence checks on
    // files that exist because they RUN tests.
    'django/core/management/commands/test.py',
    'django/contrib/messages/test.py',
    // The harness words are directory SEGMENTS too — a file or an identifier
    // carrying them stays application code, and `docs/` is not a harness.
    'lib/benchmark.js',
    'src/benchmarking/timer.js',
    'docs/api.js',
    // `examples/` is NOT a harness (2026-09-14, tried and reverted the same
    // day): tRPC keeps its real workspaces under `examples/*`, and
    // tests/new-modules.test.js pins that trpcContract still reads a router
    // there. Sample code is a per-module judgement, not a path class.
    'examples/session/index.js',
    'examples/big/src/server/router.ts',
  ];

  for (const p of MATCH) {
    it(`matches ${p}`, () => assert.strictEqual(probe._isTestPath(p), true));
  }
  for (const p of NO_MATCH) {
    it(`does not match ${p}`, () => assert.strictEqual(probe._isTestPath(p), false));
  }

  it('handles junk input without throwing', () => {
    for (const v of [null, undefined, '', 42, {}, []]) {
      assert.strictEqual(probe._isTestPath(v), false);
    }
  });
});

describe('KI #77 — Windows separators (the live defect)', () => {
  // These are the exact shapes path.relative() produces on Windows. Before
  // consolidation the 8 non-normalising modules returned false for all of
  // them and reported test-code findings at full severity.
  const WIN = [
    'tests\\helper.js',
    'tests\\setup.js',
    'spec\\support\\env.js',
    'src\\fixtures\\data.js',
    'e2e\\flow.js',
    'src\\__tests__\\a.js',
  ];
  for (const p of WIN) {
    it(`recognises ${JSON.stringify(p)}`, () => {
      assert.strictEqual(probe._isTestPath(p), true, 'backslash paths must normalise');
    });
  }

  it('a backslash path and its posix twin agree', () => {
    const pairs = [
      ['tests/helper.js', 'tests\\helper.js'],
      ['src/fixtures/data.js', 'src\\fixtures\\data.js'],
      ['src/app.js', 'src\\app.js'],
    ];
    for (const [posix, win] of pairs) {
      assert.strictEqual(
        probe._isTestPath(posix),
        probe._isTestPath(win),
        `${posix} and ${win} must classify identically`,
      );
    }
  });
});

describe('KI #77 — the drift cannot come back', () => {
  // src/core/test-paths.js owns the canonical body (moved there 2026-09-05 so
  // core files read it without importing from modules/). claude-compliance
  // keeps its own because it asks a BROADER question (mocks/examples/docs =
  // "not shipped code"), and folding that in would start suppressing findings
  // in docs/ for all 20 modules.
  const ALLOWED_OWN_PATTERN = new Set(['src/core/test-paths.js', 'src/modules/claude-compliance.js']);
  const SCANNED_DIRS = [MODULES_DIR, path.join(__dirname, '..', 'src', 'core')];

  it('no module or core file re-declares its own TEST_PATH_RE — under that name or another', () => {
    // dead-code.js kept a `TEST_FILE_RE` for months: the same question under
    // a different name, invisible to a guard that only knew one spelling,
    // and drifted (it counted `test.py` as a test). The guard now catches the
    // shape, not the label — and src/core too: dependency-reachability.js
    // carried a TEST_PATH_RE + TEST_FILE_RE pair the modules-only guard never
    // saw (found 2026-09-05).
    const offenders = [];
    for (const dir of SCANNED_DIRS) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js')) continue;
        const rel = path.relative(path.join(__dirname, '..'), path.join(dir, f)).replace(/\\/g, '/');
        if (ALLOWED_OWN_PATTERN.has(rel)) continue;
        if (/const\s+TEST_(?:PATH|FILE|DIR)_RE\s*=/.test(fs.readFileSync(path.join(dir, f), 'utf8'))) offenders.push(rel);
      }
    }
    assert.deepStrictEqual(offenders, [], 'use this._isTestPath() / isTestPath() instead of a local copy');
  });

  it('base-module imports the definition rather than declaring it', () => {
    const src = fs.readFileSync(path.join(MODULES_DIR, 'base-module.js'), 'utf8');
    assert.match(src, /require\('\.\.\/core\/test-paths'\)/);
    assert.doesNotMatch(src, /const\s+TEST_PATH_RE\s*=/);
  });

  it('the modules that were migrated now call the helper', () => {
    const migrated = [
      'ssrf.js', 'race-condition.js', 'resource-leak.js', 'hardcoded-url.js',
      'async-iteration.js', 'env-vars.js', 'openapi-drift.js', 'import-cycle.js',
      'cookie-security.js', 'log-pii.js', 'money-float.js', 'tls-security.js',
      'homoglyph.js', 'error-swallow.js', 'redos.js', 'datetime-bug.js',
      'feature-flag.js', 'cron-expression.js', 'cross-file-taint.js',
      'dead-code.js',
    ];
    for (const f of migrated) {
      const src = fs.readFileSync(path.join(MODULES_DIR, f), 'utf8');
      assert.match(src, /this\._isTestPath\(/, `${f} should call the shared helper`);
    }
  });

  it('the canonical pattern normalises inside the helper, not at call sites', () => {
    // The whole bug was call sites forgetting to normalise. Keep that
    // responsibility in one place.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'test-paths.js'), 'utf8');
    assert.match(src, /function isTestPath\(relPath\)\s*\{[\s\S]*?replace\(\/\\\\\/g, '\/'\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The hole the drift guard above left open (found 2026-09-04).
//
// "no module re-declares TEST_PATH_RE" only catches the *named* copy. It does
// not catch the much commoner shape — a bare substring test on the path:
//
//     if (relPath.includes('test')) continue;
//
// That is not a narrower predicate, it is a WRONG one, and it fails toward
// silence: it also matches `src/latest/`, `src/attestation.js`,
// `src/contest/` and `app/testimonials/` — shipped code the module then
// never scans. dataIntegrity._checkDataValidation (the module that flags
// unvalidated `req.body`) and integrationTests._detectApiEndpoints both
// carried it and were never migrated with the other twenty.
//
// The `.git` variant is the same mistake against a different word:
// `rel.includes('.git')` also matches `.github`, so bashSafety,
// deployContract and deployScriptValidator each skipped every GitHub
// Actions workflow — deployScriptValidator's isDeployFile() ends with a
// clause written specifically to match `.github/workflows/*.yml`, which
// made that clause unreachable.
//
// Substring containment is never the right test for a path segment. Use
// this._isTestPath(), or split on the separator and compare segments.
// ─────────────────────────────────────────────────────────────────────────────
describe('path filters are segment-anchored, not substring', () => {
  // A path variable — not file CONTENT, which may legitimately be searched
  // for the word "test". Only the identifiers that hold a path are checked.
  const PATH_VAR = String.raw`(?:rel|relPath|relFwd|filePath|fullPath|filename|fileName|dir|lower|p)`;
  const BAD_WORD = String.raw`(?:test|tests|spec|\.git|\.gatetest|node_modules|dist|build|vendor)`;
  const SUBSTRING_PATH_FILTER = new RegExp(
    String.raw`\b${PATH_VAR}\.includes\((['"])${BAD_WORD}\1\)`,
  );

  // Extended past src/modules on 2026-09-05 (the Fifty, move 10): the same
  // shape had survived in src/core, the website's own analysers and the
  // CLI watcher, and fake-fix-detector's `/==[^=]/` matching inside `===`
  // was the same bug in a different alphabet.
  const ROOT = path.join(__dirname, '..');
  const SCAN_DIRS = ['src/modules', 'src/core', 'src/reporters', 'src', 'bin', 'website/app/lib'];
  const files = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (/\.(?:js|ts|mjs|cjs)$/.test(f) && fs.statSync(path.join(abs, f)).isFile()) files.push(path.join(d, f));
    }
  }

  for (const f of files) {
    it(`${f} uses no substring path filter`, () => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const offending = src
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => !/^\s*(?:\/\/|\*)/.test(line)) // not a comment
        .filter(([, line]) => SUBSTRING_PATH_FILTER.test(line));

      assert.deepStrictEqual(
        offending.map(([n, line]) => `${f}:${n} ${line.trim()}`),
        [],
        'substring containment matches src/latest/, attestation.js and .github/ — ' +
          'use this._isTestPath() or compare path segments',
      );
    });
  }
});

describe('.github survives the .git exclusion', () => {
  // Behavioural, not textual: the regex guard above already forbids the bad
  // shape, so what is worth pinning here is that a workflow file actually
  // reaches a scanner. bashSafety returned 0 findings on this exact input
  // and 1 on the identical file at `ci/w.yml` — same content, different
  // directory — because `dir.includes('/.git')` matched `/.github`.
  const BashSafety = require('../src/modules/bash-safety');

  const WORKFLOW = [
    'jobs:',
    '  j:',
    '    steps:',
    '      - name: Notify',
    '        run: |',
    '          set +e',
    '          gh issue create --title x',
    '',
  ].join('\n');

  async function scanAt(rel) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dotgithub-'));
    try {
      const file = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, WORKFLOW);
      const checks = [];
      const result = {
        checks,
        addCheck: (id, passed, meta) => checks.push({ id, passed, ...(meta || {}) }),
        addInfo() {},
      };
      await new BashSafety().run(result, { projectRoot: tmp });
      return checks.filter((c) => !c.passed);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('an unrestored `set +e` is found inside .github/workflows', async () => {
    const found = await scanAt('.github/workflows/w.yml');
    assert.ok(
      found.some((c) => c.id.includes('set-e-disabled')),
      'a GitHub Actions workflow must be scanned, not skipped as if it were .git',
    );
  });

  it('the same file elsewhere reports identically', async () => {
    const inGithub = await scanAt('.github/workflows/w.yml');
    const elsewhere = await scanAt('ci/w.yml');
    assert.strictEqual(
      inGithub.length,
      elsewhere.length,
      'identical content must not depend on the directory it sits in',
    );
  });

  it('a real .git directory is still excluded', async () => {
    const found = await scanAt('.git/hooks/w.yml');
    assert.deepStrictEqual(found, [], '.git itself must stay excluded');
  });
});

// `_collectFiles` matches on path.extname. A compound suffix such as
// '.test.js' therefore matches nothing — integration-tests asked for
// ['.test.js', '.spec.js', '.test.ts', '.spec.ts'] and silently found zero
// test files on every repo, for as long as the module existed (2026-09-05).
// Extensions go to the walk; test-ness goes to `_isTestPath`.
describe('_collectFiles is never handed a compound suffix', () => {
  it('no module passes a two-dot pattern to the walk', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '..', 'src', 'modules');
    const offenders = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const re = /_collectFiles\([^)]*?\[([^\]]*)\]/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        if (/['"]\.[a-z0-9]+\.[a-z0-9]+['"]/i.test(m[1])) offenders.push(`${f}: [${m[1].trim()}]`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });
});
