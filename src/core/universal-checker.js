/**
 * Universal Checker — pattern-based cross-language issue detector.
 *
 * Powers GateTest's non-JS language modules (Python, Go, Rust, Java,
 * Ruby, PHP, C#, Kotlin, Swift). Zero-dependency, regex-based, fast.
 *
 * Philosophy: catch REAL issues (security holes, bugs, swallowed errors,
 * force unwraps, hardcoded secrets), not style preferences. GateTest is
 * not a linter — deep per-language lint is a separate (optional) native-
 * tool integration for later.
 *
 * Patterns are intentionally conservative. A false positive here damages
 * trust more than a missed issue. Memory-driven agentic exploration is
 * the layer that catches the subtle ones.
 *
 * TODO(gluecron): once Gluecron exposes language metadata, prefer that
 * signal over file extension sniffing.
 */

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('./repo-path');

/**
 * Skip these files & directories entirely.
 */
const { WALK_EXCLUDES: DEFAULT_EXCLUDES } = require('./walk-excludes');

/**
 * Patterns are applied per line. Comments that look like examples are
 * stripped before matching to minimise false positives.
 */
const LANGUAGE_SPECS = {
  python: {
    name: 'python',
    displayName: 'Python',
    extensions: ['.py'],
    testFilePattern: /(^|\/)(test_|.*_test)\.py$|(^|\/)tests?\//i,
    patterns: [
      // `(?<!def\s)` — django/template/smartif.py defines `def eval(self,
      // context)` on its expression nodes; a method DEFINITION named eval
      // is not a call to the builtin. Four of Django's eight real-source
      // hits were definitions.
      { name: 'eval', pattern: /(?<![.\w])(?<!def\s)eval\s*\(/, severity: 'error',
        message: 'eval() — arbitrary code execution risk',
        suggestion: 'Use ast.literal_eval for literals, or refactor to avoid eval entirely.' },
      // `(?<![.\w])` — a METHOD named exec (`session.exec(select(...))` in
      // SQLModel, `cursor.exec`, `re.compile(...).exec`) is not the builtin.
      { name: 'exec', pattern: /(?<![.\w])(?<!def\s)exec\s*\(/, severity: 'error',
        message: 'exec() — arbitrary code execution risk',
        suggestion: 'Refactor to call the target function directly. Exec is rarely needed.' },
      { name: 'bare-except', pattern: /^\s*except\s*:/, severity: 'warning',
        message: 'bare except swallows all exceptions including SystemExit and KeyboardInterrupt',
        suggestion: 'Catch a specific exception class, e.g. `except ValueError:`' },
      { name: 'mutable-default', pattern: /def\s+\w+\s*\([^)]*=\s*(\[\]|\{\})/, severity: 'warning',
        message: 'Mutable default argument — shared across calls, common bug source',
        suggestion: 'Use `None` as the default and construct the mutable inside the function.' },
      { name: 'sql-concat', pattern: /(execute|query|cursor\.execute)\s*\(\s*["'].*(\+|%|\.format|f["'])/, severity: 'error',
        message: 'Likely SQL string concatenation — SQL injection risk',
        suggestion: 'Use parameterised queries: cursor.execute(sql, params).' },
      { name: 'pickle-load', pattern: /\bpickle\.loads?\s*\(/, severity: 'warning',
        message: 'pickle.load on untrusted input = RCE',
        suggestion: 'Use json, or validate the pickle source cryptographically.' },
    ],
  },

  go: {
    name: 'go',
    displayName: 'Go',
    extensions: ['.go'],
    testFilePattern: /_test\.go$/,
    patterns: [
      // `_, _ =` is the RAREST way a Go programmer ignores an error. The
      // canonical form is `f, _ := os.Open(path)` — keep the value, discard
      // the error — and the old line-anchored `^\s*_\s*,\s*_` matched none
      // of it. Verified on a planted file: `f, _ := os.Open("/etc/passwd")`
      // and `data, _ := io.ReadAll(r)` were both silent.
      //
      // Now: `_` as the LAST assigned name, with a CALL on the right. The
      // negative lookahead excludes `for i, _ := range xs`, where the `_`
      // discards a value, not an error — Go puts the error last by
      // convention, and range has none.
      { name: 'ignored-error', pattern: /,\s*_\s*:?=\s*(?![^\n]*\brange\b)[^\n]*\(/, severity: 'warning',
        message: 'Error return discarded with `_` — the failure is invisible',
        suggestion: 'Check the error return, even if only to log it.' },
      { name: 'fmt-println-lib', pattern: /^\s*fmt\.Println\s*\(/, severity: 'info',
        message: 'fmt.Println in source — consider structured logging',
        suggestion: 'Use log package or a structured logger for anything beyond main().' },
      // Line-anchored, so `if err != nil { panic(err) }` — the shape panic
      // almost always takes in real Go — never matched. Whole-line comments
      // are already skipped before patterns run (isLikelyCommentOrFixture),
      // so dropping the anchor does not start matching prose.
      { name: 'panic-in-lib', pattern: /\bpanic\s*\(/, severity: 'warning',
        message: 'panic() call — library code should return errors, not panic',
        suggestion: 'Return an error value. Reserve panic for truly unrecoverable conditions.' },
      { name: 'goroutine-wait-missing', pattern: /^\s*go\s+func\s*\(/, severity: 'info',
        message: 'Goroutine launched — verify its lifetime is bounded (context, WaitGroup, or channel)',
        suggestion: 'Ensure the goroutine cannot outlive its caller uncontrollably.' },
    ],
  },

  rust: {
    name: 'rust',
    displayName: 'Rust',
    extensions: ['.rs'],
    testFilePattern: /(^|\/)tests\/|#\[test\]|#\[cfg\(test\)\]/,
    patterns: [
      { name: 'unwrap', pattern: /\.unwrap\s*\(\s*\)/, severity: 'warning',
        message: '.unwrap() panics on error — production code should handle Result explicitly',
        suggestion: 'Use ? for propagation, .expect("context") for clarity, or a proper match.' },
      { name: 'panic-macro', pattern: /\bpanic!\s*\(/, severity: 'warning',
        message: 'panic!() in source — crashes the process',
        suggestion: 'Return a Result<T, E> with a meaningful error.' },
      { name: 'todo-macro', pattern: /\btodo!\s*\(\s*\)/, severity: 'error',
        message: 'todo!() placeholder left in code — will panic at runtime',
        suggestion: 'Replace with real implementation before merging.' },
      { name: 'unimplemented', pattern: /\bunimplemented!\s*\(\s*\)/, severity: 'error',
        message: 'unimplemented!() left in code — runtime panic',
        suggestion: 'Implement, or return an explicit error.' },
      { name: 'unsafe-block', pattern: /\bunsafe\s*\{/, severity: 'info',
        message: 'unsafe block — verify invariants are documented',
        suggestion: 'Add // SAFETY: comment describing why this block is sound.' },
    ],
  },

  java: {
    name: 'java',
    displayName: 'Java',
    extensions: ['.java'],
    testFilePattern: /(^|\/)(test|Test)\/|Test\.java$|Tests\.java$/,
    patterns: [
      { name: 'sysout', pattern: /^\s*System\.out\.print(ln)?\s*\(/, severity: 'info',
        message: 'System.out in source — use a logger',
        suggestion: 'Replace with SLF4J / java.util.logging.' },
      { name: 'catch-exception', pattern: /catch\s*\(\s*Exception\s+\w+\s*\)/, severity: 'warning',
        message: 'catch (Exception e) swallows too broadly — catches RuntimeExceptions unintentionally',
        suggestion: 'Catch specific exception classes. If truly needed, comment why Exception is correct.' },
      { name: 'empty-catch', pattern: /catch\s*\([^)]+\)\s*\{\s*\}/, severity: 'error',
        message: 'Empty catch block silently swallows errors',
        suggestion: 'At minimum log the exception. Re-throw if the caller should know.' },
      { name: 'printstacktrace', pattern: /\.printStackTrace\s*\(\s*\)/, severity: 'warning',
        message: 'e.printStackTrace() writes to stderr without context',
        suggestion: 'Use a logger: log.error("context", e).' },
    ],
  },

  ruby: {
    name: 'ruby',
    displayName: 'Ruby',
    extensions: ['.rb'],
    testFilePattern: /(^|\/)(spec|test)\/|_(spec|test)\.rb$/,
    patterns: [
      // eval of a STRING LITERAL is the one safe form (nothing external
      // reaches it); the risk is eval of an expression/variable. The old
      // pattern flagged exactly the safe case (`binding.eval('@_out_buf')`
      // in sinatra) and missed the dangerous one.
      // A `*_eval` whose argument list carries a source location —
      // `__FILE__`, `__LINE__`, or a `.lineno` — is code GENERATION: Rails'
      // attribute accessors do `class_eval reader, __FILE__, reader_line` and
      // `module_eval(definition.join(";"), location.path, location.lineno)`.
      // User input never arrives with its own file and line number. Five of
      // eleven real-source hits on rails @1ec64ce were this shape; the other
      // six (`rails runner`, `rails query`, the routes loader) evaluate what
      // they are handed by design and stay reported.
      { name: 'eval', pattern: /(?<![.\w])(?:instance_|class_|module_)?eval(?:\s*\(\s*|\s+)(?!['"])[A-Za-z_([@$:](?![^\n]*(?:__FILE__|__LINE__|\.lineno\b))/, severity: 'error',
        message: 'eval() of a non-literal expression — arbitrary code execution risk',
        suggestion: 'Refactor to call the target method directly; never eval user-controlled strings.' },
      // `exec` only when bare or on Kernel — `pg_conn.exec("NOTIFY #{...}")`
      // is a database query on a PG connection, not a shell. Same defect as
      // RegExp.prototype.exec being read as child_process.exec in JS: a
      // method NAME is not a shell. Backticks keep their own alternative.
      //
      // The backtick form is a COMMAND LITERAL only when the backtick opens
      // an expression — line start, or after `=` `(` `,` — and closes on the
      // same line. A bare `` `[^`]*#\{ `` matched every error message with a
      // backtick-quoted word before an interpolation: rails @1ec64ce has
      // dozens of `raise ArgumentError, "expected Array (got #{x}) for `k`"`,
      // and that one alternative took the repo from 56 to 127 blocking. The
      // closing backtick and the leading context are what separate
      // `out = \`git diff #{sha}\`` from prose about `layout`.
      //
      // Not line-start: a continued multi-line message that begins
      // `\`t.column(.., #{opt}: true)\` from inside a change_table` looks
      // identical to a bare command statement, and Rails has four of those
      // for every real one. A command literal in Ruby is assigned or passed;
      // the bare-statement form is rare enough to be an accepted miss.
      // `(?<!\\)` keeps a regex literal's `\(\`?` out of it.
      { name: 'system-interp', pattern: /(?:(?<![.\w])(?:system|exec|Kernel\.exec)\s*\(?\s*["'][^"']*#\{|(?<!\\)[=(,]\s*`[^`\n]*#\{[^`\n]*`)/, severity: 'error',
        message: 'Shell command with string interpolation — command injection risk',
        suggestion: 'Use the array form: system("cmd", arg1, arg2) to avoid shell parsing.',
        // `system "kill -9 #{pid}"` where pid came from `fork` cannot inject
        // anything — an Integer has no shell metacharacters. When EVERY
        // interpolation on the line is provably numeric ($$, Process.pid,
        // .to_i/.size/.length/.count, Integer(...), a digit literal, or an
        // identifier the file assigns from fork/Process.*/an integer), keep
        // the finding visible but below the block threshold. 2026-08-18
        // audit residue (sinatra, "debatable").
        downgrade(line, content) {
          const interps = [...line.matchAll(/#\{([^}]*)\}/g)].map((m) => m[1].trim());
          if (interps.length === 0) return null;
          const NUMERIC_RE = /^(?:\$\$|\d+|Process\.pid|Integer\([^)]*\)|[\w.@$[\]]+\.(?:to_i|size|length|count))$/;
          const numericById = (id) => new RegExp(
            `^\\s*${id}\\s*=\\s*(?:fork\\b|Process\\.(?:fork|spawn|pid)\\b|\\d+\\s*$|[^\\n]*\\.to_i\\s*$)`, 'm'
          ).test(content);
          const allNumeric = interps.every((expr) =>
            NUMERIC_RE.test(expr) || (/^[a-z_][\w]*$/.test(expr) && numericById(expr)));
          return allNumeric ? 'every interpolated value is a provable integer (pid/count), which cannot carry shell metacharacters' : null;
        } },
      { name: 'rescue-all', pattern: /^\s*rescue\s*(=>|\n|$)/, severity: 'warning',
        message: 'rescue without a class catches StandardError silently',
        suggestion: 'Rescue a specific exception, e.g. `rescue ArgumentError => e`.' },
      { name: 'puts-in-lib', pattern: /^\s*puts\s+/, severity: 'info',
        message: 'puts in source — consider Rails.logger / a proper logger',
        suggestion: 'Replace with Rails.logger.info or equivalent.' },
    ],
  },

  php: {
    name: 'php',
    displayName: 'PHP',
    extensions: ['.php'],
    testFilePattern: /Test\.php$|(^|\/)tests?\//i,
    patterns: [
      // `(?<![\w$>:])` — `$redis->eval($lua)` and `Redis::eval(...)` are Lua
      // EVAL on a Redis connection, not PHP eval. 23 of laravel/framework's
      // 28 blocking findings (2026-09-05) were that method.
      // `(?<!function\s)` — laravel's PhpRedisConnection DEFINES
      // `public function eval($script, …)`; a method definition is not a call.
      { name: 'eval', pattern: /(?<![\w$>:])(?<!function\s)eval\s*\(/, severity: 'error',
        message: 'eval() in PHP — arbitrary code execution',
        suggestion: 'Refactor. eval is almost never the right answer.' },
      { name: 'mysql-legacy', pattern: /\bmysql_(query|connect|fetch_)/, severity: 'error',
        message: 'mysql_* functions removed in PHP 7',
        suggestion: 'Migrate to mysqli or PDO with prepared statements.' },
      { name: 'unescaped-super', pattern: /(echo|print)\s+\$(_GET|_POST|_REQUEST|_COOKIE)\[/, severity: 'error',
        message: 'Unescaped superglobal output — XSS risk',
        suggestion: 'htmlspecialchars($var, ENT_QUOTES, "UTF-8") before echoing.' },
      { name: 'var-dump', pattern: /^\s*(var_dump|print_r)\s*\(/, severity: 'warning',
        message: 'var_dump / print_r left in code',
        suggestion: 'Remove before shipping, or use a proper logger.' },
    ],
  },

  csharp: {
    name: 'csharp',
    displayName: 'C#',
    extensions: ['.cs'],
    testFilePattern: /Test(s)?\.cs$|(^|\/)(test|tests)\//i,
    patterns: [
      { name: 'console-writeline', pattern: /^\s*Console\.WriteLine\s*\(/, severity: 'info',
        message: 'Console.WriteLine in library code — use a logger',
        suggestion: 'Use ILogger / Serilog / NLog for structured logs.' },
      { name: 'catch-all', pattern: /catch\s*(\(\s*Exception[^)]*\))?\s*\{\s*\}/, severity: 'error',
        message: 'Empty catch — silently swallows errors',
        suggestion: 'Log, re-throw, or handle explicitly. Never swallow.' },
      { name: 'catch-exception', pattern: /catch\s*\(\s*Exception\s+\w+\s*\)/, severity: 'warning',
        message: 'catch (Exception) — too broad',
        suggestion: 'Catch specific exception types.' },
    ],
  },

  kotlin: {
    name: 'kotlin',
    displayName: 'Kotlin',
    extensions: ['.kt', '.kts'],
    testFilePattern: /Test\.kts?$|(^|\/)test\//i,
    patterns: [
      { name: 'not-null-assert', pattern: /!!(?![!=])/, severity: 'warning',
        message: '!! (not-null assertion) throws NullPointerException — defeats Kotlin null safety',
        suggestion: 'Use ?.let { }, ?: (Elvis), or handle null explicitly.' },
      { name: 'println-in-lib', pattern: /^\s*println\s*\(/, severity: 'info',
        message: 'println in source — use a logger',
        suggestion: 'Use SLF4J or a Kotlin logging library.' },
      { name: 'todo-call', pattern: /\bTODO\s*\([^)]*\)/, severity: 'error',
        message: 'TODO() placeholder left in code — throws NotImplementedError at runtime',
        suggestion: 'Replace with real implementation before merge.' },
    ],
  },

  swift: {
    name: 'swift',
    displayName: 'Swift',
    extensions: ['.swift'],
    testFilePattern: /Tests?\.swift$|(^|\/)Tests?\//,
    patterns: [
      { name: 'fatal-error', pattern: /\bfatalError\s*\(/, severity: 'warning',
        message: 'fatalError crashes the app — use only for truly unrecoverable states',
        suggestion: 'Return an optional, throw, or degrade gracefully.' },
      { name: 'force-try', pattern: /\btry!\s/, severity: 'warning',
        message: 'try! crashes on error — handle with do/catch or try?',
        suggestion: 'Use do { try ... } catch { ... } or try? for optional handling.' },
      { name: 'force-unwrap', pattern: /!\s*(\.|\)|$|,)/, severity: 'info',
        message: 'Force-unwrap — verify the value cannot be nil',
        suggestion: 'Use if-let, guard-let, or the nil-coalescing operator.' },
      { name: 'print-in-lib', pattern: /^\s*print\s*\(/, severity: 'info',
        message: 'print() in source — consider os_log or a logger',
        suggestion: 'Use Logger (Apple Unified Logging) for production code.' },
    ],
  },
};

/**
 * Run universal pattern checks for a given language against a project.
 * Adds checks to the `result` object; returns a small stat block.
 */
function runLanguageChecks(lang, projectRoot, result, options = {}) {
  const spec = LANGUAGE_SPECS[lang];
  if (!spec) {
    result.addCheck(`${lang}:unknown-language`, false, {
      severity: 'warning',
      message: `Unknown language key: ${lang}`,
    });
    return { filesScanned: 0, issuesFound: 0 };
  }

  let files = collectLanguageFiles(projectRoot, spec.extensions);

  // Incremental filter — when caller supplies a Set of absolute paths,
  // restrict the scan to those files only. An empty Set means "no filter"
  // (treat as a full scan to prevent a misconfigured pipeline skipping everything).
  if (options.incrementalFiles instanceof Set && options.incrementalFiles.size > 0) {
    files = files.filter((f) => options.incrementalFiles.has(f));
  }

  if (files.length === 0) {
    const isIncremental = options.incrementalFiles instanceof Set && options.incrementalFiles.size > 0;
    result.addCheck(`${lang}:no-files`, true, {
      severity: 'info',
      message: isIncremental
        ? `No ${spec.displayName} files changed since base ref`
        : `No ${spec.displayName} files found in project`,
    });
    return { filesScanned: 0, issuesFound: 0 };
  }

  let issuesFound = 0;
  let filesScanned = 0;

  for (const file of files) {
    const isTest = spec.testFilePattern && spec.testFilePattern.test(file.replace(/\\/g, '/'));
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    filesScanned += 1;

    const lines = content.split('\n');
    // Rust keeps its unit tests INSIDE the source file, under
    // `#[cfg(test)] mod tests { … }` at the bottom. The path pattern cannot
    // see that; the file's own text can. From that attribute to EOF the
    // rules run at test severity — axum's `todo!()` / `unimplemented!()`
    // inside `mod tests` were 13 of its 28 blocking findings (2026-09-05).
    let inTestScope = Boolean(isTest);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (spec.name === 'rust' && !inTestScope && /^\s*#\[cfg\(test\)\]/.test(line)) inTestScope = true;
      // Skip obvious comments and string-only lines where heuristics often
      // fire false positives. This is intentional: we prefer missing a
      // genuine issue to burning trust on a bad warning.
      if (isLikelyCommentOrFixture(line, spec)) continue;

      for (const p of spec.patterns) {
        // For test files, downgrade info/warning patterns to info to reduce noise.
        let severity = p.severity;
        // A test file is not an attack surface. `eval(method)` iterating a
        // table of helper names in actionview/test/, or `cursor.execute("..."
        // + sql)` in django/tests/backends/, exercises the thing under test;
        // it does not expose it. The old rule downgraded only NON-error
        // severities here, so every error-severity rule (eval, exec,
        // sql-concat, system-interp) kept blocking inside test trees.
        // Measured on rails @1ec64ce: 40+ of 54 `ruby:eval` blocking findings
        // were test files; on django @b3f4d83, 30 of 39 `sql-concat` were.
        // Errors drop to warning (still reported, no longer a build verdict);
        // warnings and below drop to info, as before.
        if (inTestScope) severity = severity === 'error' ? 'warning' : 'info';
        if (!p.pattern.test(line)) continue;

        // A pattern may prove a matched line is materially safer than the
        // rule's headline case (e.g. shell interpolation of a provable
        // integer). It returns a reason string; the finding stays visible
        // but drops below the block threshold instead of gating the build.
        let downgradeNote = '';
        if (severity === 'error' && typeof p.downgrade === 'function') {
          const reason = p.downgrade(line, content);
          if (reason) { severity = 'warning'; downgradeNote = ` — ${reason}`; }
        }

        const relPath = repoRelative(projectRoot, file);
        const passed = severity === 'info';
        result.addCheck(`${lang}:${p.name}:${relPath}:${i + 1}`, passed, {
          severity,
          file: relPath,
          line: i + 1,
          message: `[${spec.displayName}] ${p.message}${downgradeNote}`,
          suggestion: p.suggestion,
        });
        if (!passed) issuesFound += 1;
      }
    }
  }

  result.addCheck(`${lang}:summary`, true, {
    severity: 'info',
    message: `${spec.displayName}: scanned ${filesScanned} file(s), ${issuesFound} issue(s) found`,
  });

  return { filesScanned, issuesFound };
}

function collectLanguageFiles(projectRoot, extensions) {
  const files = [];
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));

  const walk = (dir, depth = 0) => {
    if (depth > 10) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && extSet.has(path.extname(entry.name).toLowerCase())) {
        files.push(full);
      }
    }
  };

  walk(projectRoot);
  return files;
}

function isLikelyCommentOrFixture(line, spec) {
  const t = line.trim();
  if (!t) return true;
  // Common comment leaders across the supported languages.
  if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*')) return true;
  // Python docstring lines (rough heuristic).
  if (spec.name === 'python' && (t.startsWith('"""') || t.startsWith("'''"))) return true;
  return false;
}

module.exports = {
  LANGUAGE_SPECS,
  runLanguageChecks,
  collectLanguageFiles,
};
