/**
 * Base Module - Abstract base class for all GateTest test modules.
 */

class BaseModule {
  constructor(name, description) {
    this.name = name;
    this.description = description;
  }

  /**
   * Run the module's checks.
   * @param {TestResult} result - The result object to record checks against.
   * @param {GateTestConfig} config - The GateTest configuration.
   */
  async run(result, config) {
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

    const defaultExcludes = [
      'node_modules', '.git', 'dist', 'build', '.gatetest', 'coverage',
      '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.turbo',
      '__pycache__', '.pytest_cache', 'target', 'vendor', '.cargo',
      'out', 'public/build', '.cache', '.parcel-cache',
      // .claude is the agent-coordination dir (worktrees, scratch state).
      // Scanning .claude/worktrees/agent-* inflates findings with
      // duplicate scans of the same code — every gatetest run on a
      // repo with active agent worktrees would produce N× the noise.
      '.claude',
    ];
    const allExcludes = [...defaultExcludes, ...excludes];

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
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (patterns.includes(ext) || patterns.includes('*')) {
            files.push(fullPath);
          }
        }
      }
    };

    walk(projectRoot);

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
  _isInsideStringLiteral(line, index) {
    let state = null;
    for (let j = 0; j < index && j < line.length; j += 1) {
      const ch = line[j];
      if (state) {
        if (ch === '\\') { j += 1; continue; }
        if (ch === state) state = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') state = ch;
    }
    return state !== null;
  }

  // A `/` opens a regex literal (not a division operator) when the last
  // non-space character emitted so far is one of these — covers the
  // overwhelming majority of real code AND test-assertion style
  // (`assert.match(x, /foo/)`, `.test(/foo/)`, `const re = /foo/`), without
  // the false-positive risk of trying to fully disambiguate JS grammar.
  static _REGEX_PRECEDING_RE = /[([{,:=!&|;]$|^$/;

  /**
   * Blank out the contents of string ('/"/`) and regex (/.../ ) literals on
   * a line, keeping the delimiters so downstream regexes that only care
   * about structure (not content) still see them. Regex literals matter
   * because rules that match on stripped `line` still see straight through
   * one: `assert.doesNotMatch(result, /rejectUnauthorized: false/)` is a
   * test assertion, not a live config value, but textually contains the
   * exact vulnerable pattern the module is designed to flag. Found via
   * self-scan 2026-07-15 (tls-security + cookie-security self-flagging
   * their own test files' regex-literal assertions).
   */
  _stripJsStrings(line, inTemplate) {
    let out = '';
    let state = inTemplate ? '`' : null;
    let j = 0;
    while (j < line.length) {
      const ch = line[j];
      if (state) {
        if (state === '/') {
          if (ch === '\\') { out += '  '; j += 2; continue; }
          if (ch === '[') { out += ' '; state = '/['; j += 1; continue; }
          if (ch === '/') { out += ch; state = null; j += 1; continue; }
          out += ' ';
          j += 1;
          continue;
        }
        if (state === '/[') {
          // Inside a regex character class — `/` doesn't close the regex here.
          if (ch === '\\') { out += '  '; j += 2; continue; }
          if (ch === ']') { out += ' '; state = '/'; j += 1; continue; }
          out += ' ';
          j += 1;
          continue;
        }
        if (ch === '\\') {
          out += '  ';
          j += 2;
          continue;
        }
        if (ch === state) {
          out += ch;
          state = null;
          j += 1;
          continue;
        }
        out += ' ';
        j += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        out += ch;
        state = ch;
        j += 1;
        continue;
      }
      if (ch === '/' && BaseModule._REGEX_PRECEDING_RE.test(out.trimEnd())) {
        out += ch;
        state = '/';
        j += 1;
        continue;
      }
      out += ch;
      j += 1;
    }
    return { stripped: out, inTemplate: state === '`' };
  }
}

module.exports = BaseModule;
