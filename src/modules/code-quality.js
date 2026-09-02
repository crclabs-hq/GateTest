/**
 * Code Quality Module - Enforces coding standards and quality metrics.
 * Catches console.log, debugger, TODO/FIXME, eval, and complexity issues.
 */

const BaseModule = require('./base-module');
const { JS_SOURCE_EXTS } = require('../core/source-extensions');
const fs = require('fs');
const path = require('path');

class CodeQualityModule extends BaseModule {
  constructor() {
    super('codeQuality', 'Code Quality Analysis');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const moduleConfig = config.getModuleConfig('codeQuality');
    const thresholds = config.config.thresholds;
    const excludePaths = moduleConfig.excludePaths || [];

    const sourceFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS);

    // Accumulators for grouped findings (file-length, func-length)
    const fileLengthViolations = [];
    const funcLengthViolations = [];

    for (const file of sourceFiles) {
      const relPath = path.relative(projectRoot, file);
      const relFwd = relPath.replace(/\\/g, '/');

      // Skip files matching excludePaths patterns
      if (excludePaths.some(pattern => relFwd.startsWith(pattern) || relFwd.includes(`/${pattern}`))) {
        continue;
      }

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      // Neutralised version for pattern checks — block comments, strings, and
      // regex literals replaced with spaces so the line numbers still line up,
      // but content inside those contexts can't trigger forbidden-pattern hits.
      const neutralisedLines = this._neutraliseContent(content).split('\n');

      // Check forbidden patterns
      this._checkForbiddenPatterns(file, relPath, content, lines, neutralisedLines, moduleConfig, result, projectRoot);

      // Check function length — collect violations for grouped summary
      this._collectFunctionLengthViolations(relPath, lines, thresholds.maxFunctionLength, funcLengthViolations);

      // Check file length — collect violations for grouped summary
      if (lines.length > thresholds.maxFileLength && !content.includes('quality:file-length-ok')) {
        fileLengthViolations.push({ file: relPath, lines: lines.length, max: thresholds.maxFileLength });
      }

      // Check for commented-out code blocks
      this._checkCommentedCode(file, relPath, lines, result);

      // Check for unused imports (basic heuristic)
      this._checkUnusedImports(relPath, content, lines, result);
    }

    // Emit grouped file-length finding (one observation, not N identical entries)
    if (fileLengthViolations.length > 0) {
      const worst = fileLengthViolations.sort((a, b) => b.lines - a.lines);
      const examples = worst.slice(0, 5).map(v => `\`${v.file}\` (${v.lines} lines)`).join(', ');
      const tail = worst.length > 5 ? ` and ${worst.length - 5} more` : '';
      result.addCheck('quality:file-length:summary', false, {
        severity: 'warning',
        message: `${worst.length} file(s) exceed ${worst[0].max}-line limit — architectural observation, not a bug. Top offenders: ${examples}${tail}`,
        suggestion: 'Consider splitting large files into smaller focused modules. Add `// quality:file-length-ok` to suppress for intentionally large files.',
        count: worst.length,
      });
    }

    // Emit grouped function-length finding
    if (funcLengthViolations.length > 0) {
      const worst = funcLengthViolations.sort((a, b) => b.length - a.length);
      const examples = worst.slice(0, 5).map(v => `\`${v.name}\` in ${v.file} (${v.length} lines)`).join(', ');
      const tail = worst.length > 5 ? ` and ${worst.length - 5} more` : '';
      result.addCheck('quality:func-length:summary', false, {
        severity: 'warning',
        message: `${worst.length} function(s) exceed ${funcLengthViolations[0].max}-line limit. Top offenders: ${examples}${tail}`,
        suggestion: 'Break long functions into smaller helpers. Add `// quality:func-length-ok` to suppress for intentionally large functions.',
        count: worst.length,
      });
    }

    if (sourceFiles.length === 0) {
      result.addCheck('code-quality-scan', true, { message: 'No source files to check' });
    }
  }

  /**
   * Neutralise entire file content — replace strings, template literals, regex
   * literals, line comments, and block comments with spaces. Line numbers and
   * character offsets are preserved, so pattern matches against the neutralised
   * version map 1:1 to original line numbers. Handles MULTI-LINE block comments.
   */
  _neutraliseContent(content) {
    let out = "";
    let i = 0;
    const n = content.length;
    let state = "code"; // code | str | tpl | regex | lineCmt | blockCmt
    let stringChar = "";
    let tplDepth = 0;

    while (i < n) {
      const c = content[i];
      const next = content[i + 1];

      if (state === "blockCmt") {
        if (c === "*" && next === "/") { state = "code"; out += "  "; i += 2; continue; }
        out += c === "\n" ? "\n" : " ";
        i++;
        continue;
      }
      if (state === "lineCmt") {
        if (c === "\n") { state = "code"; out += "\n"; i++; continue; }
        out += " ";
        i++;
        continue;
      }
      if (state === "str") {
        if (c === "\\" && i + 1 < n) { out += "  "; i += 2; continue; }
        if (c === stringChar) { state = "code"; out += c; i++; continue; }
        if (c === "\n") { state = "code"; out += "\n"; i++; continue; } // unterminated
        out += " ";
        i++;
        continue;
      }
      if (state === "tpl") {
        if (c === "\\" && i + 1 < n) { out += "  "; i += 2; continue; }
        if (c === "`") { state = "code"; out += c; i++; continue; }
        if (c === "$" && next === "{") { tplDepth++; out += "  "; i += 2; continue; }
        if (c === "}" && tplDepth > 0) { tplDepth--; out += " "; i++; continue; }
        if (tplDepth > 0) { out += c; i++; continue; }
        out += c === "\n" ? "\n" : " ";
        i++;
        continue;
      }
      if (state === "regex") {
        if (c === "\\" && i + 1 < n) { out += "  "; i += 2; continue; }
        if (c === "/") { state = "code"; out += c; i++; continue; }
        if (c === "\n") { state = "code"; out += "\n"; i++; continue; }
        out += " ";
        i++;
        continue;
      }

      // state === "code"
      if (c === "/" && next === "/") { state = "lineCmt"; out += "  "; i += 2; continue; }
      if (c === "/" && next === "*") { state = "blockCmt"; out += "  "; i += 2; continue; }
      if (c === '"' || c === "'") { state = "str"; stringChar = c; out += c; i++; continue; }
      if (c === "`") { state = "tpl"; tplDepth = 0; out += c; i++; continue; }
      if (c === "/" && next !== "/" && next !== "*") {
        // Bounded lookback (last ~24 chars), NOT `out.trim()`/`out.replace(...)`
        // on the full accumulated string. TSX/JSX files are dense with `/`
        // (every `<Foo />` and `</Foo>` is one) — re-scanning the whole
        // `out` string on every one of those turns this O(n) traversal into
        // O(n^2), which is exactly what hung the scan on a 257KB TSX file
        // for 9.5+ minutes on a single file (Known Issue #40 root cause,
        // found via the Gluecron.com repro 2026-07-16 — this was never an
        // async hang, so the runner's per-module timeout couldn't catch it;
        // it blocks the synchronous event loop).
        const tail = this._trimEnd(out.slice(-24));
        const prev = tail.slice(-1);
        const isRegexContext = !prev || /[=(,:;!?&|{[]/.test(prev) ||
          tail.endsWith("return") || tail.endsWith("typeof");
        if (isRegexContext) { state = "regex"; out += c; i++; continue; }
      }
      out += c;
      i++;
    }
    return out;
  }

  /** Strip trailing whitespace from a short bounded string — O(1) vs `.replace(/\s+$/, "")` on a large one. */
  _trimEnd(s) {
    let end = s.length;
    while (end > 0 && /\s/.test(s[end - 1])) end--;
    return s.slice(0, end);
  }

  /**
   * Legacy single-line neutraliser — kept for backward compat in tests.
   * Does NOT handle multi-line block comments; use _neutraliseContent for that.
   */
  _stripContextFromLine(line) {
    let out = "";
    let i = 0;
    const n = line.length;
    let inString = false;
    let stringChar = "";
    let inTemplate = false;
    let templateDepth = 0;
    let inRegex = false;
    let inBlockComment = false;

    while (i < n) {
      const c = line[i];
      const next = line[i + 1];

      if (inBlockComment) {
        if (c === "*" && next === "/") { inBlockComment = false; out += "  "; i += 2; continue; }
        out += " ";
        i++;
        continue;
      }
      if (inString) {
        if (c === "\\" && i + 1 < n) { out += "  "; i += 2; continue; }
        if (c === stringChar) { inString = false; stringChar = ""; out += c; i++; continue; }
        out += " ";
        i++;
        continue;
      }
      if (inTemplate) {
        if (c === "\\" && i + 1 < n) { out += "  "; i += 2; continue; }
        if (c === "`") { inTemplate = false; out += c; i++; continue; }
        if (c === "$" && next === "{") { templateDepth++; out += "  "; i += 2; continue; }
        if (c === "}" && templateDepth > 0) { templateDepth--; out += " "; i++; continue; }
        if (templateDepth > 0) { out += c; i++; continue; }
        out += " ";
        i++;
        continue;
      }
      if (inRegex) {
        if (c === "\\" && i + 1 < n) { out += "  "; i += 2; continue; }
        if (c === "/") { inRegex = false; out += c; i++; continue; }
        out += " ";
        i++;
        continue;
      }

      // Line comment — everything after // is stripped
      if (c === "/" && next === "/") {
        out += " ".repeat(n - i);
        break;
      }
      // Block comment open
      if (c === "/" && next === "*") { inBlockComment = true; out += "  "; i += 2; continue; }
      // String open
      if (c === '"' || c === "'") { inString = true; stringChar = c; out += c; i++; continue; }
      // Template open
      if (c === "`") { inTemplate = true; out += c; i++; continue; }
      // Regex literal: heuristic — preceded by = ( , : ; ! ? & | { [ return
      if (c === "/" && next !== "/" && next !== "*") {
        // Bounded lookback, not a full-string trim/replace — see the
        // identical fix + rationale in _neutraliseContent above.
        const tail = this._trimEnd(out.slice(-24));
        const prev = tail.slice(-1);
        const isRegexContext = !prev || /[=(,:;!?&|{[]/.test(prev) ||
          tail.endsWith("return") || tail.endsWith("typeof");
        if (isRegexContext) { inRegex = true; out += c; i++; continue; }
      }
      out += c;
      i++;
    }
    return out;
  }

  /**
   * Directory names that are, by near-universal convention, NOT library code.
   * A `console.log` here is the file doing its job: a demo printing its own
   * banner, a CLI talking to the user, a test emitting a diagnostic.
   */
  static NON_LIBRARY_DIRS = new Set([
    'example', 'examples', 'demo', 'demos', 'sample', 'samples',
    'bin', 'script', 'scripts', 'cli', 'tool', 'tools',
    'test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'fixture', 'fixtures',
    'doc', 'docs', 'benchmark', 'benchmarks', 'playground', 'sandbox',
  ]);

  /**
   * Is this path library code — the thing a consumer imports — as opposed to a
   * demo, CLI, test or script?
   *
   * @param {string} relFwd - repo-relative path, forward slashes
   * @returns {boolean}
   */
  _isLibraryPath(relFwd, projectRoot) {
    if (relFwd.split('/').some(seg => CodeQualityModule.NON_LIBRARY_DIRS.has(seg.toLowerCase()))) return false;
    if (!projectRoot) return true;
    const pkg = this._nearestPackage(projectRoot, relFwd);
    return pkg ? this._isPublishedPath(pkg, relFwd) : true;
  }

  /**
   * The package.json that OWNS a file — the nearest one walking up from the
   * file's directory to the project root. In a repo that publishes from its
   * root and also carries a private app in a subdirectory (this repo:
   * `website/`), a file in the app was being judged as library code of the
   * root package. Self-scan 2026-09-02: 30 blocking findings, all console.log
   * in `website/capture-baseline.mjs`, a Playwright capture script nobody
   * imports.
   *
   * Cached per directory. Returns `{ dir, json }` or null.
   */
  _nearestPackage(projectRoot, relFwd) {
    if (!this._pkgCache || this._pkgCache.root !== projectRoot) this._pkgCache = { root: projectRoot, byDir: new Map() };
    const segs = relFwd.split('/');
    segs.pop();
    for (let n = segs.length; n >= 0; n--) {
      const dir = segs.slice(0, n).join('/');
      if (this._pkgCache.byDir.has(dir)) {
        const hit = this._pkgCache.byDir.get(dir);
        if (hit) return hit;
        continue;
      }
      let entry = null;
      try {
        const json = JSON.parse(fs.readFileSync(path.join(projectRoot, dir, 'package.json'), 'utf-8'));
        entry = { dir, json };
      } catch (err) {
        // ENOENT: no package.json at this level, keep walking up. Anything
        // else (malformed JSON) still OWNS the file — with no `main` or
        // `files` it reads as an application, which is the safe direction.
        entry = err && err.code === 'ENOENT' ? null : { dir, json: {}, error: err.message };
      }
      this._pkgCache.byDir.set(dir, entry);
      if (entry) return entry;
    }
    return null;
  }

  /**
   * Is the file inside what its package actually ships? When package.json
   * declares `files`, npm publishes only those paths (plus README/LICENSE/
   * main), so anything outside them cannot be "code a consumer imports". No
   * `files` list means everything not .npmignored ships — treated as
   * published.
   */
  _isPublishedPath(pkg, relFwd) {
    const files = Array.isArray(pkg.json.files) ? pkg.json.files : null;
    if (!files || files.length === 0) return true;
    const inPkg = pkg.dir ? relFwd.slice(pkg.dir.length + 1) : relFwd;
    const entries = files.concat(pkg.json.main ? [String(pkg.json.main)] : []);
    return entries.some((raw) => {
      let e = String(raw).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      const glob = e.search(/[*?[{]/);
      if (glob === 0) {
        // `*.d.ts` publishes top-level files with that suffix; `**` publishes
        // everything; any other leading-glob shape fails toward "published".
        const suffix = e.match(/^\*(\.[A-Za-z0-9.]+)$/);
        if (suffix) return !inPkg.includes('/') && inPkg.endsWith(suffix[1]);
        return true;
      }
      if (glob !== -1) e = e.slice(0, glob).replace(/\/+$/, '');
      return inPkg === e || inPkg.startsWith(e + '/');
    });
  }

  /**
   * Does this repo publish a package others import? Only then is "no
   * console.log in library code" a rule about someone else's console.
   *
   * Cached per project — this is called once per forbidden-pattern hit.
   *
   * @param {string} projectRoot
   * @returns {boolean}
   */
  _publishesPackage(projectRoot, relFwd = '') {
    const owner = this._nearestPackage(projectRoot, relFwd);
    if (!owner) return false;
    const pkg = owner.json;
    return pkg.private !== true && Boolean(pkg.main || pkg.exports || pkg.module || pkg.bin);
  }

  /**
   * Logging that is obviously deliberate — guarded by a verbose/debug flag, so
   * it is off by default and the author clearly meant it.
   *
   * @param {string} rawLine
   * @returns {boolean}
   */
  _isDeliberateLogging(rawLine) {
    return /\bverbose\b/i.test(rawLine) || /process\.env\.DEBUG\b/.test(rawLine);
  }

  /**
   * Severity for one forbidden-pattern hit, or `undefined` to keep the
   * module default (error).
   *
   * Only the `console.*` rule is context-sensitive. `debugger`, `eval`, the
   * Function constructor and `innerHTML =` are defects wherever they appear
   * and stay unconditional errors.
   *
   * Why (neutral-repo audit 2026-08-12): scanning expressjs/express, this rule
   * alone produced 37 of 50 error-severity findings — every one of them a demo
   * in `examples/` printing its own startup banner ('Express started on port
   * 3000'), or a verbose-guarded log, or a test diagnostic. The Bible's rule is
   * "no console.log IN LIBRARY CODE"; the module was dropping that qualifier.
   *
   * The old `excludePaths` default could not have helped a customer: it lists
   * GateTest's own directory names (`src/reporters`, `src/hooks`), so it only
   * ever protected this repo from its own scan.
   *
   * @returns {string|undefined}
   */
  _severityForForbidden(patternSource, relFwd, rawLine, projectRoot) {
    if (!patternSource.includes('console')) return undefined;
    // Non-library path -> INFO, not warning.
    //
    // The rule is "no console.log in LIBRARY code" — code a consumer imports,
    // whose console it pollutes. In a test, an example or a build script,
    // nothing is being violated, and this function has already decided that
    // by the time it gets here. Emitting a *warning* asserts a defect the
    // module itself does not believe in.
    //
    // Measured on axios @81df7a5 (org axios): 79 of its 82 codeQuality
    // warnings were console.log, and ALL 79 were in tests/ (70), sandbox/ (5)
    // and examples/ (4). Zero in lib/. That is 24% of the repo's whole
    // warning volume spent asserting a rule that does not apply there.
    //
    // Info is still disclosed and still counted — it moves out of the warning
    // wall, not out of the report. Library paths are untouched: a published
    // package logging from lib/ is still an error.
    if (!this._isLibraryPath(relFwd, projectRoot)) return 'info';
    if (this._isDeliberateLogging(rawLine)) return 'warning';
    if (!this._publishesPackage(projectRoot, relFwd)) return 'warning';
    return undefined;
  }

  _checkForbiddenPatterns(absPath, relPath, content, lines, neutralisedLines, moduleConfig, result, projectRoot) {
    const patterns = moduleConfig.forbiddenPatterns || [];
    const relFwd = relPath.replace(/\\/g, '/');
    for (const { pattern, message, safeIf } of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      for (let i = 0; i < lines.length; i++) {
        // Suppressor: `// code-quality-ok` on the same line or the previous line
        // silences any forbidden-pattern hit on that line.
        const line = lines[i] || '';
        const prevLine = i > 0 ? (lines[i - 1] || '') : '';
        if (/\bcode-quality-ok\b/.test(line) || /\bcode-quality-ok\b/.test(prevLine)) continue;

        // Use the file-level neutralised view — strings, template literals,
        // regex literals, line comments, AND multi-line block comments have
        // been replaced with spaces while preserving line numbers. Prevents
        // false positives on forbidden patterns that appear inside JSDoc
        // blocks or pattern-list string literals in scanner modules.
        const neutralised = neutralisedLines[i] ?? this._stripContextFromLine(lines[i]);
        regex.lastIndex = 0;
        if (regex.test(neutralised)) {
          // Per-pattern proof that this particular occurrence cannot do the
          // thing the rule looks for. Deliberately fed the RAW line, not the
          // neutralised one: neutralising blanks string literals, so the
          // right-hand side a predicate needs to inspect would already be
          // gone and every assignment would look unparseable.
          if (safeIf && safeIf(line)) continue;
          const lineNum = i;
          const severity = this._severityForForbidden(pattern.source, relFwd, line, projectRoot);
          result.addCheck(`quality:${message}:${relPath}:${i + 1}`, false, {
            file: relPath,
            line: i + 1,
            ...(severity ? { severity } : {}),
            message: `${message} at line ${i + 1}`,
            suggestion: 'Remove or replace this pattern before committing',
            autoFix: () => this._removeLineFromFile(absPath, lineNum, relPath, message),
          });
        }
      }
    }
  }

  // Variant that pushes into a violations array instead of adding to result directly.
  // Used by run() to emit a single grouped summary instead of N identical findings.
  _collectFunctionLengthViolations(relPath, lines, maxLength, violations) {
    let braceDepth = 0;
    let functionStart = -1;
    let functionName = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        for (const char of line) {
          if (char === '{') braceDepth++;
          if (char === '}') { braceDepth--; if (braceDepth === 0) functionStart = -1; }
        }
        continue;
      }
      const funcMatch = line.match(/(?:function\s+(\w+)|(\w+)\s*(?:=|:)\s*(?:async\s+)?(?:function|\(.*?\)\s*=>))/);
      if (funcMatch && braceDepth === 0) {
        functionName = funcMatch[1] || funcMatch[2] || 'anonymous';
        functionStart = i;
      }
      for (const char of line) {
        if (char === '{') braceDepth++;
        if (char === '}') {
          braceDepth--;
          if (braceDepth === 0 && functionStart >= 0) {
            const length = i - functionStart + 1;
            if (length > maxLength) {
              violations.push({ file: relPath, name: functionName, line: functionStart + 1, length, max: maxLength });
            }
            functionStart = -1;
          }
        }
      }
    }
  }

  _checkFunctionLength(relPath, lines, maxLength, result) {
    let braceDepth = 0;
    let functionStart = -1;
    let functionName = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip comment lines — "function definition" in a comment is not a function
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        // Still count braces (in non-comment code) but don't set function starts from comments
        for (const char of line) {
          if (char === '{') braceDepth++;
          if (char === '}') {
            braceDepth--;
            if (braceDepth === 0) functionStart = -1;
          }
        }
        continue;
      }

      // Detect function declarations
      const funcMatch = line.match(/(?:function\s+(\w+)|(\w+)\s*(?:=|:)\s*(?:async\s+)?(?:function|\(.*?\)\s*=>))/);
      if (funcMatch && braceDepth === 0) {
        functionName = funcMatch[1] || funcMatch[2] || 'anonymous';
        functionStart = i;
      }

      // Count braces
      for (const char of line) {
        if (char === '{') braceDepth++;
        if (char === '}') {
          braceDepth--;
          if (braceDepth === 0 && functionStart >= 0) {
            const length = i - functionStart + 1;
            if (length > maxLength) {
              result.addCheck(`quality:function-length:${relPath}:${functionName}`, false, {
                file: relPath,
                line: functionStart + 1,
                expected: `<= ${maxLength} lines`,
                actual: `${length} lines`,
                message: `Function "${functionName}" is ${length} lines (max ${maxLength})`,
                suggestion: 'Extract helper functions to reduce complexity',
              });
            }
            functionStart = -1;
          }
        }
      }
    }
  }

  _checkCommentedCode(absPath, relPath, lines, result) {
    let commentBlock = 0;
    let commentStart = -1;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('//') && /\/\/\s*(const|let|var|function|if|for|while|return|import|export|class)\s/.test(trimmed)) {
        if (commentBlock === 0) commentStart = i;
        commentBlock++;
      } else {
        if (commentBlock >= 3) {
          const start = commentStart;
          const count = commentBlock;
          result.addCheck(`quality:commented-code:${relPath}:${commentStart + 1}`, false, {
            file: relPath,
            line: commentStart + 1,
            message: `${commentBlock} lines of commented-out code starting at line ${commentStart + 1}`,
            suggestion: 'Remove commented-out code — use version control instead',
            autoFix: () => this._removeLinesFromFile(absPath, start, count, relPath),
          });
        }
        commentBlock = 0;
      }
    }
  }

  _checkUnusedImports(relPath, content, lines, result) {
    // Strip block comments and line comments so documentation examples
    // with import statements don't false-positive as real declarations.
    const stripped = content
      .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))  // block comments
      .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));        // line comments

    const importRegex = /(?:import\s+(?:{([^}]+)}|(\w+))\s+from|const\s+(?:{([^}]+)}|(\w+))\s*=\s*require\()/g;
    let match;

    while ((match = importRegex.exec(stripped)) !== null) {
      const imported = match[1] || match[2] || match[3] || match[4];
      if (!imported) continue;

      const names = imported
        .split(',')
        .map((n) => {
          // Strip TypeScript `type ` keyword prefix inside named imports
          // e.g. `{ type RepoFile }` — the import name is `RepoFile`
          const clean = n.trim().replace(/^type\s+/, '');
          return clean.split(/\s+as\s+/).pop().trim();
        })
        .filter(Boolean);

      for (const name of names) {
        if (!name || name === '*' || !/^\w+$/.test(name)) continue;
        // Count occurrences in stripped content (subtract the import line itself)
        const occurrences = stripped.split(new RegExp(`\\b${name}\\b`)).length - 1;
        if (occurrences <= 1) {
          // Hygiene, not a defect: an unused import never breaks a build or
          // a user. Warning — `lint` owns the strict form via ESLint.
          result.addCheck(`quality:unused-import:${relPath}:${name}`, false, {
            file: relPath,
            severity: 'warning',
            message: `Import "${name}" appears unused`,
            suggestion: `Remove unused import "${name}"`,
          });
        }
      }
    }
  }
  /**
   * Auto-fix: remove a single line from a file (e.g. console.log, debugger).
   * Re-neutralises the file and re-verifies the line still contains real code
   * matching the forbidden pattern — refuses to delete if the hit has moved
   * into a string/comment since the scan (file-edited-between-scan-and-fix).
   */
  _removeLineFromFile(absPath, lineIndex, relPath, patternName) {
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const lines = content.split('\n');
      if (lineIndex < 0 || lineIndex >= lines.length) {
        return { fixed: false };
      }
      const neutralisedLines = this._neutraliseContent(content).split('\n');
      const neutralisedLine = neutralisedLines[lineIndex] || '';
      // Safety: if the neutralised view of the line is whitespace-only, the
      // original content is entirely string/comment and must not be deleted.
      if (!neutralisedLine.trim()) {
        return {
          fixed: false,
          description: `Skipped ${relPath}:${lineIndex + 1} — line is inside a string/comment`,
        };
      }
      lines.splice(lineIndex, 1);
      fs.writeFileSync(absPath, lines.join('\n'), 'utf-8');
      return {
        fixed: true,
        description: `Removed ${patternName} from ${relPath}:${lineIndex + 1}`,
        filesChanged: [relPath],
      };
    } catch {
      return { fixed: false };
    }
  }

  /**
   * Auto-fix: remove a block of consecutive lines (e.g. commented-out code).
   */
  _removeLinesFromFile(absPath, startIndex, count, relPath) {
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const lines = content.split('\n');
      if (startIndex < 0 || startIndex + count > lines.length) {
        return { fixed: false };
      }
      lines.splice(startIndex, count);
      fs.writeFileSync(absPath, lines.join('\n'), 'utf-8');
      return {
        fixed: true,
        description: `Removed ${count} lines of commented-out code from ${relPath}:${startIndex + 1}`,
        filesChanged: [relPath],
      };
    } catch {
      return { fixed: false };
    }
  }
}

module.exports = CodeQualityModule;
