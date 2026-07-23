/**
 * Lint Module - Runs linters across the project.
 * Integrates with ESLint, Stylelint, and Markdownlint.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

class LintModule extends BaseModule {
  constructor() {
    super('lint', 'Linting Checks');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // ESLint flat config (v8+) uses eslint.config.{mjs,js,cjs,ts}.
    // Also search immediate subdirectories (monorepo pattern like website/).
    // Run ESLint from the directory that actually owns the config so v9+ can find it.
    const eslintFlatConfigs = ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.cjs', 'eslint.config.ts'];
    const eslintLegacyConfigs = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc.cjs'];
    const allEslintConfigs = [...eslintFlatConfigs, ...eslintLegacyConfigs];
    const eslintDir =
      (this._hasConfig(projectRoot, allEslintConfigs) || this._hasPackageJsonField(projectRoot, 'eslintConfig'))
        ? projectRoot
        : this._findConfigSubdir(projectRoot, allEslintConfigs);

    if (eslintDir) {
      this._runEslint(eslintDir, result);
    } else {
      // Only complain about missing ESLint config when the project
      // actually has JS/TS source. A Python or Go repo shouldn't be
      // flagged for not having an ESLint config — that would be a
      // gibberish error on every non-JS codebase we scan.
      const jsFiles = this._collectFiles(projectRoot, ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
      if (jsFiles.length > 0) {
        result.addCheck('lint:eslint-config', false, {
          // Warning, not error: a missing linter config is setup hygiene,
          // not a defect in the customer's code. Blocking a fresh repo's
          // very first scan over "you don't have ESLint yet" teaches
          // people to distrust the gate (first-run audit 2026-07-23).
          severity: 'warning',
          message: 'No ESLint configuration found',
          suggestion: 'Initialize ESLint: npx eslint --init',
        });
      } else {
        result.addCheck('lint:eslint-not-applicable', true, {
          severity: 'info',
          message: 'No JS/TS source files — ESLint not applicable',
        });
      }
    }

    // Check if Stylelint is available
    const cssFiles = this._collectFiles(projectRoot, ['.css', '.scss', '.less']);
    if (cssFiles.length > 0) {
      const stylelintConfigExists =
        this._hasConfig(projectRoot, ['.stylelintrc', '.stylelintrc.js', '.stylelintrc.json', '.stylelintrc.yml', 'stylelint.config.js', 'stylelint.config.mjs']) ||
        this._hasConfigInSubdirs(projectRoot, ['.stylelintrc', '.stylelintrc.js', '.stylelintrc.json', 'stylelint.config.js', 'stylelint.config.mjs']);
      if (stylelintConfigExists) {
        this._runStylelint(projectRoot, result);
      } else {
        // Downgrade to warning — Tailwind/utility-CSS projects may intentionally skip Stylelint
        result.addCheck('lint:stylelint-config', false, {
          severity: 'warning',
          message: 'CSS files found but no Stylelint configuration',
          suggestion: 'Install and configure Stylelint for CSS quality',
        });
      }
    }

    // Check Markdown files
    const mdFiles = this._collectFiles(projectRoot, ['.md']);
    if (mdFiles.length > 0) {
      for (const file of mdFiles) {
        this._lintMarkdown(file, projectRoot, result);
      }
    }
  }

  _hasConfig(projectRoot, filenames) {
    return filenames.some(f => fs.existsSync(path.join(projectRoot, f)));
  }

  _hasConfigInSubdirs(projectRoot, filenames) {
    return !!this._findConfigSubdir(projectRoot, filenames);
  }

  _findConfigSubdir(projectRoot, filenames) {
    try {
      const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const subdir = path.join(projectRoot, entry.name);
        if (filenames.some(f => fs.existsSync(path.join(subdir, f)))) return subdir;
      }
    } catch { // error-ok — readdir failure is non-fatal
    }
    return null;
  }

  _hasPackageJsonField(projectRoot, field) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return !!pkg[field];
    } catch {
      return false;
    }
  }

  // Resolve the locally-installed eslint binary directly, skipping npx's
  // package-resolution overhead (measurable on every single invocation,
  // worse on Windows). Falls back to `npx eslint` for repos where eslint
  // isn't hoisted to this project's own node_modules/.bin.
  _resolveEslintBin(projectRoot) {
    const candidates = [
      path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint'),
      path.join(projectRoot, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint'),
    ];
    for (const bin of candidates) {
      if (fs.existsSync(bin)) return `"${bin}"`;
    }
    return 'npx eslint';
  }

  _runEslint(projectRoot, result) {
    // Run without --max-warnings so the gate only blocks on actual errors.
    // Warnings still surface in the report (with their own severity)
    // but don't fail the gate — that's what the severity system is for.
    //
    // --cache makes repeat scans (the common case: local dev loop, CI on
    // an unchanged tree) dramatically faster — ESLint skips unchanged
    // files entirely. First run on a cold cache pays full price; every
    // scan after that doesn't. Cache lives under .gatetest/ so it's
    // gitignored alongside the rest of our state, not the project's.
    const eslintBin = this._resolveEslintBin(projectRoot);
    const cacheLocation = path.join(projectRoot, '.gatetest', '.eslintcache');
    try { fs.mkdirSync(path.dirname(cacheLocation), { recursive: true }); } catch { /* best-effort — eslint still runs without a cache dir */ }
    const { exitCode, stdout, stderr, timedOut } = this._exec(
      `${eslintBin} . --format json --cache --cache-location "${cacheLocation}"`,
      { cwd: projectRoot, timeout: 180000 }
    );

    if (timedOut) {
      // Do NOT call this a crash — it isn't one. A timeout on a large
      // project is an actionable, honest signal; "ESLint crashed" with
      // blank stderr is not. (Self-scan 2026-07-15: this exact path
      // blocked our own gate with zero diagnostic value.)
      result.addCheck('lint:eslint', false, {
        message: 'ESLint timed out after 180s — the project is larger than the default budget covers',
        suggestion: 'Re-run after the cache warms (subsequent scans reuse .gatetest/.eslintcache), or scope CI runs with --diff to lint only changed files',
        severity: 'warning',
      });
      return;
    }

    let errorCount = 0;
    let warningCount = 0;
    try {
      const results = JSON.parse(stdout);
      for (const fileResult of results) {
        errorCount += fileResult.errorCount;
        warningCount += fileResult.warningCount;
      }
    } catch {
      // ESLint exited non-zero AND we couldn't parse JSON, and it wasn't
      // our timeout — a real config error or crash. stdout is included
      // too: many fatal ESLint errors (bad config, plugin resolution
      // failures) print to stdout, not stderr, and the old message only
      // ever showed stderr — which is exactly why this was silently blank.
      if (exitCode !== 0) {
        const diagnostic = (stderr || stdout || '').slice(0, 300).trim() || '(no output captured)';
        result.addCheck('lint:eslint', false, {
          message: `ESLint crashed (exit ${exitCode}): ${diagnostic}`,
          suggestion: 'Run "npx eslint ." manually to diagnose',
        });
        return;
      }
    }

    if (errorCount === 0) {
      result.addCheck('lint:eslint', true, {
        message: warningCount > 0
          ? `ESLint passed (0 errors, ${warningCount} warning(s) — non-blocking)`
          : 'ESLint passed with zero issues',
      });
    } else {
      result.addCheck('lint:eslint', false, {
        message: `ESLint: ${errorCount} error(s), ${warningCount} warning(s)`,
        suggestion: 'Run "npx eslint . --fix" to auto-fix, then manually resolve remaining issues',
        autoFix: () => {
          const fix = this._exec('npx eslint . --fix 2>/dev/null', { cwd: projectRoot, timeout: 120000 });
          return {
            fixed: fix.exitCode === 0,
            description: fix.exitCode === 0
              ? 'ESLint auto-fixed all issues'
              : 'ESLint --fix applied partial fixes (some issues remain)',
            filesChanged: [],
          };
        },
      });
    }
  }

  _runStylelint(projectRoot, result) {
    const { exitCode } = this._exec(
      'npx stylelint "**/*.{css,scss,less}" --formatter json 2>/dev/null',
      { cwd: projectRoot, timeout: 60000 }
    );

    if (exitCode === 0) {
      result.addCheck('lint:stylelint', true);
    } else {
      result.addCheck('lint:stylelint', false, {
        message: 'Stylelint found issues',
        suggestion: 'Run "npx stylelint --fix" to auto-fix',
        autoFix: () => {
          const fix = this._exec('npx stylelint "**/*.{css,scss,less}" --fix 2>/dev/null', { cwd: projectRoot, timeout: 60000 });
          return {
            fixed: fix.exitCode === 0,
            description: 'Stylelint auto-fixed CSS issues',
            filesChanged: [],
          };
        },
      });
    }
  }

  _lintMarkdown(file, projectRoot, result) {
    const relPath = path.relative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf-8');
    const issues = [];

    // Split on \r?\n, not bare \n — a CRLF-encoded file would otherwise leave
    // a trailing \r on every line, which trimEnd() below strips too, making
    // every single line look like it has trailing whitespace (same root
    // cause fixed in env-integrity.js — see KI #48).
    const lines = content.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      // Check for trailing whitespace
      if (lines[i] !== lines[i].trimEnd() && !lines[i].endsWith('  ')) {
        issues.push({ line: i + 1, message: 'Trailing whitespace' });
      }
      // Check for multiple consecutive blank lines
      if (i > 0 && lines[i].trim() === '' && lines[i - 1].trim() === '' &&
          i > 1 && lines[i - 2].trim() === '') {
        issues.push({ line: i + 1, message: 'Multiple consecutive blank lines' });
      }
    }

    if (issues.length > 0) {
      result.addCheck(`lint:markdown:${relPath}`, false, {
        // Markdown whitespace nits (trailing spaces, extra blank lines) are
        // cosmetic and auto-fixable — INFO, never error/warning. A code gate
        // must not bury real findings under hundreds of prose-style notes
        // (375 on our own repo). The autoFix still cleans them on request.
        severity: 'info',
        file: relPath,
        message: `${issues.length} markdown issue(s)`,
        details: issues.slice(0, 5),
        autoFix: () => {
          try {
            const raw = fs.readFileSync(file, 'utf-8');
            let fixed = raw.split('\n').map(l => l.trimEnd()).join('\n');
            // Remove triple+ blank lines
            fixed = fixed.replace(/\n{3,}/g, '\n\n');
            fs.writeFileSync(file, fixed, 'utf-8');
            return { fixed: true, description: `Fixed markdown whitespace in ${relPath}`, filesChanged: [relPath] };
          } catch { return { fixed: false }; }
        },
      });
    } else {
      result.addCheck(`lint:markdown:${relPath}`, true);
    }
  }
}

module.exports = LintModule;
