/**
 * Base Module - Abstract base class for all GateTest test modules.
 */

// "Is this a test path" has ONE definition, src/core/test-paths.js; this
// class exposes it to every module as `_isTestPath` and `TEST_PATH_RE`.
const { TEST_PATH_RE, isTestPath } = require('../core/test-paths');
const { maskSource } = require('../core/source-strip');
const { repoRelative } = require('../core/repo-path');

class BaseModule {
  constructor(name, description) {
    this.name = name;
    this.description = description;
  }

  /**
   * Record `<module>:not-checked` — three-state reporting (Doctrine #1:
   * clean / found / NOT CHECKED, and the third must be printed). Use this
   * when the module has NO way to look at all on this scan — e.g. a
   * file-walking module (webHeaders, tlsSecurity, cookieSecurity,
   * accessibility, seo, links) invoked on a URL-only hosted scan with no
   * `config.projectRoot` and no usable `config.livePage` — as opposed to a
   * module that legitimately walked the project and found nothing
   * applicable (that stays a `passed: true` info check; see each module's
   * own `:no-files`/`:files` check for that path).
   *
   * `passed: false` (not `true`) is deliberate here: a silent `true` risks
   * being read as "checked, nothing found" by anything that just counts
   * passes. `notChecked: true` is the flag every caller (Health Score,
   * result cards, JSON/markdown exports) keys on to pull this out of the
   * pass/fail denominator and surface it as its own bucket instead.
   *
   * @param {TestResult} result
   * @param {string} reason — plain-English, e.g. "this module reads source
   *   files, not a live URL"
   */
  _notChecked(result, reason) {
    result.addCheck(`${this.name}:not-checked`, false, {
      severity: 'info',
      notChecked: true,
      message: reason,
    });
  }

  /**
   * One definition (Doctrine §4) of "is this a URL-only / hosted-web scan,
   * as opposed to a repo checkout with a real (if momentarily empty)
   * `projectRoot`?" `GateTestConfig` always defaults `projectRoot` to
   * something truthy (the given root, or `process.cwd()` — src/core/config.js),
   * so a file-walking module cannot tell "URL-only scan" from "empty repo"
   * by `projectRoot` alone. The web-scan route sets `targetUrl`/`webUrl` on
   * the config for exactly this reason (see stream/route.ts); a caller
   * that built a bare config object for a live scan without going through
   * `GateTestConfig` (unit tests, the non-streaming route) may also simply
   * leave `projectRoot` unset — both count.
   *
   * @param {GateTestConfig|object} config
   * @returns {boolean}
   */
  _isUrlOnlyScan(config) {
    if (!config) return false;
    if (!config.projectRoot) return true;
    // `targetUrl`/`webUrl` are written through `GateTestConfig#set()`,
    // which nests them under `config.config.targetUrl` — `config.get()` is
    // the only reader that sees them on a real config instance (KI: this
    // is why `website/app/api/web/scan/route.ts` guards `config.set` at
    // all — src/core/config.js's own comment on `set()`). A bare test
    // object with no `.get()` gets the direct property instead, matching
    // the fallback several wp-* modules already use for the same field.
    const read = (key) => (typeof config.get === 'function' ? config.get(key) : config[key]);
    return Boolean(read('targetUrl') || read('webUrl'));
  }

  /**
   * Run the module's checks.
   * @param {TestResult} result - The result object to record checks against.
   * @param {GateTestConfig} config - The GateTest configuration.
   */
  async run(_result, _config) {
    throw new Error(`Module "${this.name}" must implement run()`);
  }

  /**
   * Collect files matching patterns from project root.
   *
   * Incremental-scan mode: when the runner sets
   * `this._incrementalContext = { changedFilesAbs: Set<string> }` on
   * the module instance (only on PRs / `--diff`), the returned file list
   * is intersected with that set. Modules don't need to know — they get
   * a shorter list and run proportionally faster. Per-PR scans drop from
   * ~30s (full sweep, parallel) to ~3-10s (touched files only).
   *
   * Modules that need to run on EVERY scan regardless of diff (e.g. a
   * config-level checker that reads `package.json`) can opt out by
   * setting `this._respectsIncremental = false` in their constructor.
   */
  _collectFiles(projectRoot, patterns, excludes = []) {
    const fs = require('fs');
    const path = require('path');
    const files = [];

    const { WALK_EXCLUDES: defaultExcludes } = require('../core/walk-excludes');
    const allExcludes = [...defaultExcludes, ...excludes];

    // Issue #767: a repo's .gitignore (root + nested) plus a built-in
    // build-output name set are out of scope for a default scan — 300 of
    // 600 blocking findings on a real customer monorepo were inside
    // gitignored `apps/web/.next-build` and `.design`. `--include-ignored`
    // (src/core/gitignore.js `includeIgnoredFiles()`) opts back in; the
    // hard excludes above are never affected by it.
    const { getScanIgnoreMatcher, includeIgnoredFiles } = require('../core/gitignore');
    const ignoreMatcher = includeIgnoredFiles() ? null : getScanIgnoreMatcher(projectRoot);

    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (allExcludes.includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (ignoreMatcher && ignoreMatcher(repoRelative(projectRoot, fullPath), true)) continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          if (ignoreMatcher && ignoreMatcher(repoRelative(projectRoot, fullPath), false)) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (patterns.includes(ext) || patterns.includes('*')) {
            files.push(fullPath);
          }
        }
      }
    };

    walk(projectRoot);

    // Repository path filter (.gatetest.json `paths`, stamped by the runner
    // as this._scanPathFilter): the one place "in scope for this gate" is
    // decided for every module that walks (src/core/scan-paths.js).
    if (this._scanPathFilter) {
      const { pathInScope } = require('../core/scan-paths');
      const inScope = (f) => pathInScope(this._scanPathFilter, repoRelative(projectRoot, f));
      for (let i = files.length - 1; i >= 0; i--) if (!inScope(files[i])) files.splice(i, 1);
    }

    // Incremental filter — applied AFTER the walk so the exclude rules
    // and extension matching still hold. Cheap set intersection.
    if (
      this._respectsIncremental !== false &&
      this._incrementalContext &&
      this._incrementalContext.changedFilesAbs instanceof Set
    ) {
      const changed = this._incrementalContext.changedFilesAbs;
      return files.filter((f) => changed.has(f));
    }

    return files;
  }

  /**
   * Run a shell command and return { stdout, stderr, exitCode }.
   */
  _exec(command, options = {}) {
    const { execSync } = require('child_process');
    try {
      const stdout = execSync(command, {
        encoding: 'utf-8',
        timeout: options.timeout || 60000,
        cwd: options.cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
        ...(options.env ? { env: options.env } : {}),
      });
      return { stdout, stderr: '', exitCode: 0, signal: null, timedOut: false };
    } catch (err) {
      // execSync kills the child on timeout: status is null, signal is
      // SIGTERM, code is ETIMEDOUT. Without surfacing this, callers can't
      // tell "the tool crashed" from "we killed it after our own timeout" —
      // and the two need very different messages (see lint.js self-scan
      // 2026-07-15: a real ESLint timeout on a large Next.js app was
      // reported to the user as "ESLint crashed. stderr: " with zero
      // diagnostic value).
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        exitCode: err.status || 1,
        signal: err.signal || null,
        timedOut: err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM',
        // The tool itself could not run (ENOENT: binary missing; EACCES…) —
        // `exitCode` above is a synthetic 1 in that case, indistinguishable
        // from a real "answered no" exit 1 without this. A caller that
        // treats exit 1 as a verdict (git ls-files: "not tracked") must
        // check it, or a missing git turns into a silent false negative.
        spawnError: err.status == null && !err.signal && typeof err.code === 'string' ? err.code : null,
      };
    }
  }

  /**
   * True when `index` falls inside an unescaped '/"/` string literal that
   * OPENS before `index` on the same line (and hasn't closed yet).
   *
   * Rules whose regex needs a quoted value preserved (e.g. matching a literal
   * `"0"`) can't run against a fully string-stripped line, so they scan raw
   * text instead — which means a rule like `process.env.X = "0"` matches
   * identically whether it's real top-level code OR a JS string literal
   * containing that same text as sample/fixture data, e.g.
   * `write(tmp, 'a.js', 'process.env.X = "0"')`. A real assignment is never
   * itself nested inside another string literal — that would be inert text,
   * not executable code — so "nested in an outer string" is a safe, general
   * signal that a match is example/fixture data, not a live vulnerability.
   * (Found via self-scan 2026-07-15: tls-security/cookie-security flagging
   * their own test fixtures as real findings.)
   */
  /**
   * Is this repo-relative path test/fixture code?
   *
   * Modules use this to downgrade findings (usually error → info) in code
   * that is not shipped. It replaces 6 DIFFERENT hand-rolled `TEST_PATH_RE`
   * bodies that had been copy-pasted across 20 modules and then drifted, so
   * whether `src/foo.test.js` counted as a test depended on which module
   * found it (KI #77).
   *
   * SEPARATOR NORMALISATION IS THE POINT, not a detail. `path.relative()`
   * returns `tests\helper.js` on Windows, and every one of those regexes
   * required `/`. Eight modules — async-iteration, env-vars, hardcoded-url,
   * import-cycle, openapi-drift, race-condition, resource-leak, ssrf —
   * tested the raw value, so on any Windows checkout a file under `tests/`
   * was NOT recognised unless its name also carried `.test.`/`.spec.`.
   * Findings in `tests/helper.js`, `tests/setup.js`, `spec/support/*.js`
   * were reported at full severity; for `ssrf` that is a gate-BLOCKING
   * error rather than an info. Proven by direct predicate comparison
   * 2026-07-28. Normalising here fixes it everywhere at once.
   *
   * The pattern is the union of what those 6 variants were each reaching
   * for — none of them was deliberately narrow, they were just incomplete.
   *
   * @param {string} relPath — repo-relative path, either separator
   * @returns {boolean}
   */
  _isTestPath(relPath) {
    return isTestPath(relPath);
  }

  /**
   * Is this whole line a comment? (`//`, `#`, or a `*` continuation line.)
   *
   * Modules that scan line-by-line for a code pattern need this: prose
   * describing the thing you detect looks exactly like the thing you detect.
   * `retry-hygiene` flagged `no-backoff` and `no-jitter` at
   * `website/app/lib/pentest/probes.js:145` because the line above reads
   * `// Time-based: send sleep(5), expect response delay` — the module
   * matched `sleep(5)` in a sentence about sleep(5) (found 2026-07-28).
   *
   * Companion to `_isInsideStringLiteral`, which covers the other half of
   * "this text is not executable code".
   *
   * Deliberately only whole-line: a trailing `// note` after real code
   * leaves that code executable, and callers wanting position-accurate
   * handling should match on `_maskedLines` instead.
   *
   * @param {string} line
   * @returns {boolean}
   */
  /**
   * The file's lines with every string literal blanked and every comment
   * removed, offsets preserved — masked line i is raw line i, and a token
   * that survives on the masked line sits at the same index on the raw one.
   * Match a pattern on the masked line; read a captured name, title or URL
   * from the raw line at the match's own offsets. One definition
   * (src/core/source-strip.js) of where a string or comment begins and ends:
   * the per-line quote counters this is replacing (_isInsideStringLiteral,
   * _stripJsStrings, and nine private isInString copies, 2026-09-05) could
   * not see a template literal or a block comment spanning lines, and each
   * disagreed with the others at the edges.
   *
   * @param {string} content
   * @param {string} [rel] file path — a `.py` file is masked by the Python
   *   stripper (`#` comments, triple-quoted strings); everything else as JS/TS
   * @returns {string[]}
   */
  _maskedLines(content, rel = '') {
    return maskSource(content, rel).split(/\r?\n/);
  }

  /**
   * Match `shape` (the code around a string, e.g. `secret\s*:\s*['"]`) on the
   * masked line, then read `full` (a sticky regex, `/…/y`) from the raw line
   * at that offset — the way a rule reads a value that lives inside quotes
   * without ever matching prose or a fixture string.
   */
  _matchOnRaw(code, line, shape, full) {
    const m = shape.exec(code);
    if (!m) return null;
    full.lastIndex = m.index;
    return full.exec(line);
  }

  /**
   * Is index `idx` of raw line `i` inside a string, regex or comment? True
   * when the mask blanked that character. Use it where a rule must read the
   * raw line (the pattern lives inside quotes) but must not fire on prose.
   */
  _insideLiteral(masked, lines, i, idx) {
    const raw = lines[i] || '';
    return raw[idx] !== undefined && (masked[i] || '')[idx] !== raw[idx];
  }

  _isCommentLine(line) {
    if (typeof line !== 'string') return false;
    const t = line.trim();
    if (!t) return false;
    return t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');
  }

}

module.exports = BaseModule;
// The one test-path definition, for the standalone predicates that have no
// module instance to call `_isTestPath()` on (auth-bypass's exempt-path
// check, duplicate-code's skip list). Same regex, same drift guard.
module.exports.TEST_PATH_RE = TEST_PATH_RE;
