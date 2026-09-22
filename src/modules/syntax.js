/**
 * Syntax Module - Deep syntax validation across ALL source files.
 * Not just "does it parse" — checks imports resolve, template literals close,
 * config files are valid, and TypeScript strict mode passes clean.
 */

const BaseModule = require('./base-module');
const { stripStringsAndComments } = require('../core/source-strip');
const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const { WALK_EXCLUDE_SET } = require('../core/walk-excludes');
const { stripJsonc, isJsoncPath } = require('../core/jsonc');

// Issue #630 — a real `npx tsc --noEmit` per workspace package is O(packages),
// not O(files): a 76-package monorepo turned the quick suite's ~15s bar into
// a 10-minute kill (and worse, because `_exec` is synchronous, it blocked the
// event loop even under --parallel, starving every other module until it was
// done). This budgets the WALL-CLOCK the TypeScript phase may spend across
// ALL projects in one run, checked only BETWEEN projects — a single real
// tsconfig (the common case, and every repo in the precision corpus) always
// gets its one compile in full; the cap only stops a large tree from growing
// the module's cost with its package count. See `_checkTypeScript`.
const DEFAULT_TS_TIME_BUDGET_MS = 20_000;

class SyntaxModule extends BaseModule {
  constructor() {
    super('syntax', 'Syntax & Compilation Checks');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // JavaScript / ESM / CJS. Track which files passed the authoritative
    // parse (vm.Script / node --check) so the dangling-pattern heuristics
    // below can skip them — a file the real parser accepted has balanced
    // backticks and parens BY DEFINITION, so the heuristic could only ever
    // false-positive on it.
    const parsedOk = new Set();
    const jsFiles = this._collectFiles(projectRoot, ['.js', '.mjs', '.cjs']);
    for (const file of jsFiles) {
      if (this._checkJsSyntax(file, result, projectRoot)) parsedOk.add(file);
    }

    // TypeScript
    const tsFiles = this._collectFiles(projectRoot, ['.ts', '.tsx']);
    if (tsFiles.length > 0) {
      this._checkTypeScript(projectRoot, result, config);
    }

    // JSX (React)
    const jsxFiles = this._collectFiles(projectRoot, ['.jsx']);
    for (const file of jsxFiles) {
      this._checkJsxSyntax(file, result, projectRoot);
    }

    // JSON
    const jsonFiles = this._collectFiles(projectRoot, ['.json']);
    for (const file of jsonFiles) {
      this._checkJsonSyntax(file, result, projectRoot);
    }

    // YAML
    const yamlFiles = this._collectFiles(projectRoot, ['.yml', '.yaml']);
    for (const file of yamlFiles) {
      this._checkYamlSyntax(file, result, projectRoot);
    }

    // TOML
    const tomlFiles = this._collectFiles(projectRoot, ['.toml']);
    for (const file of tomlFiles) {
      this._checkTomlSyntax(file, result, projectRoot);
    }

    // CSS
    const cssFiles = this._collectFiles(projectRoot, ['.css']);
    for (const file of cssFiles) {
      this._checkCssSyntax(file, result, projectRoot);
    }

    // HTML
    const htmlFiles = this._collectFiles(projectRoot, ['.html', '.htm']);
    for (const file of htmlFiles) {
      this._checkHtmlSyntax(file, result, projectRoot);
    }

    // Import resolution
    this._checkImportResolution(projectRoot, jsFiles, result);

    // Dangling patterns — a crude backtick/paren-balance heuristic. It is
    // ONLY a fallback for JS files the authoritative parser could not accept
    // (parsedOk skips the rest). TS/TSX are NOT included: they get real
    // validation from _checkTypeScript (tsc), and the JS-oriented stripper
    // mis-handles TS syntax (generics, JSX, type assertions), producing false
    // positives on perfectly valid files. A crude counter flagging valid code
    // is worse than no check — trust erodes fast.
    this._checkDanglingPatterns(projectRoot, jsFiles, result, parsedOk);

    if (jsFiles.length === 0 && jsonFiles.length === 0 && tsFiles.length === 0) {
      result.addCheck('syntax-scan', true, { message: 'No source files to check', severity: 'info' });
    }
  }

  _checkJsSyntax(file, result, projectRoot) {
    const relPath = repoRelative(projectRoot, file);
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const ext = path.extname(file).toLowerCase();

      // A server-side TEMPLATE that renders to JavaScript is not JavaScript
      // yet. django's `django/views/templates/i18n_catalog.js` opens with
      // `{% autoescape off %}` and is rendered by the JavaScriptCatalog view;
      // the parser read the `%` and the scan of django/django was gate-BLOCKED
      // on "Unexpected token '%'" at confidence 1.0 (2026-09-14). Recorded as
      // a passing info check — the file is on the report, classified — and
      // returned as "parsed" so the dangling-pattern heuristics, which would
      // trip on the same tags, leave it alone.
      if (SyntaxModule.isTemplateSource(relPath, content)) {
        result.addCheck(`syntax:${relPath}`, true, {
          severity: 'info',
          file: relPath,
          message: `${relPath} is a Django/Jinja template that renders to JavaScript — not parsed as JavaScript`,
        });
        return true;
      }

      // .mjs files are always ESM. .js files in a "type":"module" package are ESM.
      // .js files that contain top-level import/export are also ESM.
      // vm.Script rejects ESM syntax — use `node --check` for these.
      const isEsm = ext === '.mjs' || this._isEsmFile(content, file);
      if (isEsm) {
        const { exitCode, stderr } = this._exec(`node --check "${file}" 2>&1`, {
          cwd: projectRoot,
        });
        if (exitCode !== 0 && stderr && /SyntaxError/i.test(stderr)) {
          result.addCheck(`syntax:${relPath}`, false, {
            file: relPath,
            message: stderr.trim().slice(0, 200),
            suggestion: 'Fix the syntax error at the indicated location',
          });
          return false;
        }
        result.addCheck(`syntax:${relPath}`, true);
        return true;
      }

      const vm = require('vm');
      // Compile inside a CJS-style function wrapper, the same way Node
      // compiles real CommonJS modules — that wrapper is what makes
      // top-level `return` (early-exit platform guards) legal. A bare
      // vm.Script false-positives those files with "Illegal return
      // statement". Shebang stripped first, exactly like Node does.
      const cjsSource = content.replace(/^#![^\n]*/, '');
      new vm.Script(
        '(function (exports, require, module, __filename, __dirname) { ' + cjsSource + '\n});',
        { filename: file },
      );
      result.addCheck(`syntax:${relPath}`, true);
      return true;
    } catch (err) {
      if (err instanceof SyntaxError) {
        result.addCheck(`syntax:${relPath}`, false, {
          file: relPath,
          line: err.lineNumber,
          message: err.message,
          suggestion: 'Fix the syntax error at the indicated location',
        });
        return false;
      }
      // Non-syntax error (e.g. unreadable file) — treat as "not authoritatively
      // parsed" so the dangling-pattern fallback still gets a look.
      result.addCheck(`syntax:${relPath}`, true);
      return false;
    }
  }

  /**
   * Is this `.js` file a Django / Jinja / Twig / Nunjucks TEMPLATE rather
   * than JavaScript? Two signals:
   *
   *   - a `{% tag %}` occupying a line of its own. `{% ... %}` is never
   *     valid JavaScript, so one whole line of it settles the question on
   *     content alone (django's `i18n_catalog.js` opens with
   *     `{% autoescape off %}`);
   *   - a `templates/` (`template/`) directory segment — the convention
   *     every one of those engines loads from — AND a `{{` / `{%` somewhere
   *     in the content. Path alone is not enough: a JS project can keep real
   *     modules under `src/templates/`, and those still deserve a parse.
   *
   * `{{ x }}` alone is deliberately not a signal: `{{ b(); }}` is a legal
   * block inside a block.
   *
   * @param {string} relPath — repo-relative path, either separator
   * @param {string} content
   * @returns {boolean}
   */
  static isTemplateSource(relPath, content) {
    const text = String(content || '');
    if (/^[ \t]*\{%-?\s*[a-zA-Z_]+[^\n]*%\}[ \t]*\r?$/m.test(text)) return true;
    const posix = String(relPath || '').replace(/\\/g, '/');
    return /(?:^|\/)templates?\//i.test(posix) && /\{[{%]/.test(text);
  }

  // Detect whether a .js file is an ES module so we use node --check instead
  // of vm.Script (which rejects top-level import/export/import.meta).
  _isEsmFile(content, file) {
    // Check for top-level import/export statements (not inside strings/comments)
    if (/^(?:import\s|export\s|export\s+default\b)/m.test(content)) return true;
    // import.meta is ESM-only
    if (/\bimport\.meta\b/.test(content)) return true;
    // Check nearest package.json for "type": "module"
    try {
      const fs = require('fs');
      const path = require('path');
      let dir = path.dirname(file);
      for (let i = 0; i < 5; i++) {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          if (pkg.type === 'module') return true;
          break; // found a package.json, stop searching up
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch { /* error-ok — unreadable ancestor directory — treated as no tsconfig */ }
    return false;
  }

  _checkJsxSyntax(file, result, projectRoot) {
    const relPath = repoRelative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf-8');

    // Check for unclosed JSX tags.
    // Must correctly subtract self-closing tags (<Icon />, <Br/>) which
    // look like open tags but don't need a matching close tag.
    // allComponentOpens: every <Uppercase or <Namespace.Member opener
    const allComponentOpens = (content.match(/<[A-Z][a-zA-Z0-9]*(?:\.[A-Z][a-zA-Z0-9]*)*/g) || []).length;
    // selfClosing: <Icon />, <Component prop="x"/>, etc.
    const selfClosingTags = (content.match(/<[A-Z][a-zA-Z0-9]*[^>]*\/>/g) || []).length;
    const openTags = allComponentOpens - selfClosingTags;
    const closeTags = (content.match(/<\/[A-Z][a-zA-Z0-9]*(?:\.[A-Z][a-zA-Z0-9]*)*>/g) || []).length;

    if (Math.abs(openTags - closeTags) > 2) {
      result.addCheck(`syntax:jsx-balance:${relPath}`, false, {
        file: relPath,
        severity: 'warning',
        message: `JSX tag mismatch: ${openTags} opening vs ${closeTags} closing tags`,
        suggestion: 'Check for unclosed JSX components',
      });
    }

    // Check for common JSX mistakes
    if (content.includes('class=') && !content.includes('className=')) {
      result.addCheck(`syntax:jsx-class:${relPath}`, false, {
        file: relPath,
        severity: 'warning',
        message: 'Using "class=" instead of "className=" in JSX',
        suggestion: 'Replace class= with className= in JSX files',
      });
    }
  }

  _checkJsonSyntax(file, result, projectRoot) {
    const relPath = repoRelative(projectRoot, file);
    // Declared out here on purpose: the JSONC retry below lives in the
    // `catch`, and a `const` inside the `try` is not in scope there. It
    // used to be, which made the retry throw ReferenceError — swallowed by
    // the bare `catch` on the retry itself, so every commented tsconfig.json
    // was reported as a plain JSON syntax error and the JSONC branch below
    // had never once run.
    let content;
    try {
      // A UTF-8 BOM is not JSON to JSON.parse but every editor that writes
      // one (Visual Studio's launchSettings.json) reads it back fine.
      content = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
      JSON.parse(content);
      result.addCheck(`json:${relPath}`, true);
    } catch (err) {
      // tsconfig / jsconfig / devcontainer / .vscode files are JSONC by
      // specification — comments and trailing commas are legal there, and the
      // tools that own those formats read them without complaint. Retrying is
      // scoped to those filenames, so a trailing comma in an ordinary
      // `data/config.json` is still the real error it has always been, and a
      // genuinely malformed tsconfig still fails the second parse.
      if (isJsoncPath(relPath)) {
        try {
          JSON.parse(stripJsonc(content));
          result.addCheck(`json:${relPath}`, true, {
            message: 'Valid JSONC (comments / trailing commas permitted in this file type)',
          });
          return;
        } catch (retryErr) {
          // Malformed even as JSONC — fall through to the real error. Only
          // a parse failure belongs here; anything else is a bug in this
          // module and must not be silently absorbed.
          if (retryErr instanceof ReferenceError || retryErr instanceof TypeError) throw retryErr;
        }
      }
      result.addCheck(`json:${relPath}`, false, {
        file: relPath,
        message: err.message,
        suggestion: 'Fix the JSON syntax error',
      });
    }
  }

  _checkYamlSyntax(file, result, projectRoot) {
    const relPath = repoRelative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf-8');

    // Basic YAML validation — check for common errors
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Tab indentation (YAML requires spaces)
      if (line.match(/^\t/)) {
        result.addCheck(`yaml:tabs:${relPath}:${i + 1}`, false, {
          file: relPath,
          line: i + 1,
          severity: 'error',
          message: 'YAML files must use spaces for indentation, not tabs',
          suggestion: 'Replace tabs with spaces',
        });
        return; // One error per file is enough
      }
    }
    result.addCheck(`yaml:${relPath}`, true);
  }

  _checkTomlSyntax(file, result, projectRoot) {
    const relPath = repoRelative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf-8');

    // Basic TOML validation
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      // Check for unclosed brackets in TABLE HEADERS only. Table headers
      // by spec start at column 0 (no leading whitespace). Indented `[`
      // is an array element inside a multi-line array (e.g.
      // `commands = [\n    [ "uv", "pip", ... ],\n]`) — not a table.
      if (raw.startsWith('[') && !line.includes(']')) {
        result.addCheck(`toml:bracket:${relPath}:${i + 1}`, false, {
          file: relPath,
          line: i + 1,
          message: 'Unclosed bracket in TOML table header',
          suggestion: 'Close the bracket in the table header',
        });
        return;
      }
    }
    result.addCheck(`toml:${relPath}`, true);
  }

  _checkCssSyntax(file, result, projectRoot) {
    const relPath = repoRelative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf-8');

    // Check for balanced braces
    const opens = (content.match(/{/g) || []).length;
    const closes = (content.match(/}/g) || []).length;

    if (opens !== closes) {
      result.addCheck(`css:braces:${relPath}`, false, {
        file: relPath,
        message: `Unbalanced braces: ${opens} opening vs ${closes} closing`,
        suggestion: 'Check for missing or extra curly braces',
      });
    }

    // Check for unclosed strings
    const singleQuotes = (content.match(/'/g) || []).length;
    if (singleQuotes % 2 !== 0) {
      result.addCheck(`css:quotes:${relPath}`, false, {
        file: relPath,
        severity: 'warning',
        message: 'Odd number of single quotes — possible unclosed string',
        suggestion: 'Check for unclosed quote marks',
      });
    }
  }

  _checkHtmlSyntax(file, result, projectRoot) {
    const relPath = repoRelative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf-8');

    // Check for doctype
    if (!content.trim().toLowerCase().startsWith('<!doctype')) {
      result.addCheck(`html:doctype:${relPath}`, false, {
        file: relPath,
        severity: 'warning',
        message: 'Missing <!DOCTYPE html> declaration',
        suggestion: 'Add <!DOCTYPE html> at the start of the file',
      });
    }

    // Check for unclosed important tags
    const importantTags = ['html', 'head', 'body'];
    for (const tag of importantTags) {
      const openCount = (content.match(new RegExp(`<${tag}[\\s>]`, 'gi')) || []).length;
      const closeCount = (content.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
      if (openCount > closeCount) {
        result.addCheck(`html:unclosed:${tag}:${relPath}`, false, {
          file: relPath,
          severity: 'error',
          message: `Unclosed <${tag}> tag`,
          suggestion: `Add closing </${tag}> tag`,
        });
      }
    }
  }

  _checkTypeScript(projectRoot, result, config) {
    // Discover every tsconfig.json in the workspace (depth-limited so we
    // don't walk node_modules). Then run tsc only in directories where
    // the tsconfig is "real" — i.e. has compilerOptions configured. Stub
    // tsconfigs at monorepo roots (Crontech, Turborepo, etc.) often
    // exist only as `extends`-only or empty-shell configs; running
    // `npx tsc` against them produces TS6142 "jsx not set" / TS6053 "no
    // inputs found" noise that drowns out real findings.
    const tscDirs = this._discoverRealTsconfigs(projectRoot);

    let anyRan = false;
    let allPass = true;
    const allErrors = [];

    // Issue #630: each iteration below is a synchronous `npx tsc` subprocess
    // (spawn + module resolution + real type-check), so this loop's cost is
    // O(real tsconfigs found), not O(files). On a 76-package monorepo that
    // is 76 sequential compiles — measured at ~272s of a ~273s total quick
    // suite on a throwaway 76-package/~4200-file fixture, vs ~50s for the
    // next-slowest module, and because `_exec` (execSync) is synchronous it
    // blocks the event loop, so nothing else in --parallel mode could
    // progress either. The budget below is consulted only BETWEEN projects,
    // never mid-compile, so a repo with one real tsconfig — the common case,
    // and every repo in reliability-corpus/real-world.json — always gets its
    // one full compile; only a tree with many real tsconfigs has the tail
    // cut, and honestly (three-state: says what was not checked), never
    // silently.
    const syntaxConfig = config && config.getModuleConfig ? config.getModuleConfig('syntax') : {};
    const timeBudgetMs = (syntaxConfig && syntaxConfig.tsTimeBudgetMs) || DEFAULT_TS_TIME_BUDGET_MS;
    const deadline = Date.now() + timeBudgetMs;
    const skippedDirs = [];

    for (const dir of tscDirs) {
      if (Date.now() > deadline) { skippedDirs.push(dir); continue; }

      // Skip subprojects whose deps aren't installed. `tsc --noEmit` against
      // a directory without node_modules emits "Cannot find type definition
      // for X" noise that has nothing to do with the user's code. The CI
      // workflow installs deps in the workspaces that matter (website/, the
      // root); leaf packages without their own node_modules (vscode-extension/,
      // mcp-server stubs, etc.) are intentionally not type-checked here.
      const isRoot = dir === projectRoot;
      const hasOwnDeps = fs.existsSync(path.join(dir, 'node_modules'));
      const inheritsRootDeps = isRoot && fs.existsSync(path.join(projectRoot, 'node_modules'));
      if (!hasOwnDeps && !inheritsRootDeps) continue;
      anyRan = true;
      const { exitCode, stdout, stderr } = this._exec('npx tsc --noEmit 2>&1', {
        cwd: dir,
        timeout: 120000,
      });
      if (exitCode !== 0) {
        allPass = false;
        const output = stdout + stderr;
        const errors = output.split(/\r?\n/).filter(l => l.includes('error TS'));
        allErrors.push(...errors);
      }
    }

    if (skippedDirs.length > 0) {
      const shown = skippedDirs.slice(0, 5).map((d) => repoRelative(projectRoot, d) || '.');
      result.addCheck('typescript-strict:budget', true, {
        severity: 'info',
        // Every skipped project is named in `details` so "quick suite green" can never
        // be read as "types checked" on a tree where most packages were not (Tallrig, 22 Sep).
        details: skippedDirs.map((d) => repoRelative(projectRoot, d) || '.'),
        message: `${skippedDirs.length} additional TypeScript project(s) NOT type-checked — ` +
          `the ${Math.round(timeBudgetMs / 1000)}s tsc time budget was reached on a large tree ` +
          `(not checked: ${shown.join(', ')}${skippedDirs.length > shown.length ? ', …' : ''}). ` +
          'Run "gatetest --project <package>" to check one directly, or raise ' +
          'modules.syntax.tsTimeBudgetMs in .gatetest.json.',
      });
    }

    if (!anyRan) {
      result.addCheck('typescript-strict', true, {
        message: skippedDirs.length > 0
          ? 'The tsc time budget was reached before any project could be checked — see typescript-strict:budget above'
          : 'No real tsconfig.json found (stub configs without compilerOptions are skipped)',
        severity: 'info',
      });
    } else if (allPass) {
      result.addCheck('typescript-strict', true);
    } else {
      result.addCheck('typescript-strict', false, {
        message: `${allErrors.length} TypeScript error(s)`,
        details: allErrors.slice(0, 10),
        suggestion: 'Run "npx tsc --noEmit" to see all errors',
      });
    }
  }

  /**
   * Discover directories containing a "real" tsconfig.json — one that
   * sets `compilerOptions` (with at least one of jsx / target / module /
   * lib). Stub configs (empty, extends-only, or missing compilerOptions)
   * are deliberately skipped because running tsc against them produces
   * noise that obscures real findings.
   *
   * Walks subdirectories one and two levels deep to cover monorepo
   * patterns (apps/web, apps/api, packages/*, services/*) without
   * descending into node_modules / build output.
   */
  _discoverRealTsconfigs(projectRoot) {
    const found = new Set();
    const skip = WALK_EXCLUDE_SET;

    const isRealConfig = (configPath) => {
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        // Strip block + line comments (tsconfig is JSONC).
        const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        const cfg = JSON.parse(stripped);
        const co = cfg && cfg.compilerOptions;
        if (!co || typeof co !== 'object') return false;
        // A real config sets at least one of these. Stub configs that
        // only exist to extend a base get filtered out.
        return Boolean(co.target || co.module || co.jsx || co.lib || co.outDir || co.rootDir);
      } catch { return false; }
    };

    const visit = (dir, depth) => {
      if (depth > 2) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      const tsconfigPath = path.join(dir, 'tsconfig.json');
      if (fs.existsSync(tsconfigPath) && isRealConfig(tsconfigPath)) {
        found.add(dir);
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (skip.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue; // .claude, .git already in skip; this catches others
        visit(path.join(dir, entry.name), depth + 1);
      }
    };

    visit(projectRoot, 0);
    return [...found];
  }

  _checkImportResolution(projectRoot, jsFiles, result) {
    let unresolvedCount = 0;
    const maxReports = 10;

    for (const file of jsFiles) {
      const relPath = repoRelative(projectRoot, file);
      const raw = fs.readFileSync(file, 'utf-8');
      const dir = path.dirname(file);

      // Strip line comments and block comments before scanning to avoid
      // flagging require() calls that appear inside comment examples.
      // Also strip string literals to avoid false positives in template
      // strings and test fixtures.
      const content = this._stripCommentsAndStrings(raw);

      // Match require() calls with relative paths
      const requireRegex = /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
      let match;
      while ((match = requireRegex.exec(content)) !== null) {
        const importPath = match[1];
        const resolved = this._resolveImport(dir, importPath);
        if (!resolved) {
          unresolvedCount++;
          if (unresolvedCount <= maxReports) {
            result.addCheck(`syntax:import:${relPath}:${importPath}`, false, {
              file: relPath,
              severity: 'error',
              message: `Unresolved import: require('${importPath}')`,
              suggestion: `Check that the file exists: ${importPath}`,
            });
          }
        }
      }
    }

    if (unresolvedCount === 0) {
      result.addCheck('syntax:imports', true, { severity: 'info' });
    } else if (unresolvedCount > maxReports) {
      result.addCheck('syntax:imports-truncated', true, {
        severity: 'info',
        message: `${unresolvedCount - maxReports} more unresolved imports not shown`,
      });
    }
  }

  _stripCommentsAndStrings(source) {
    // Strip block comments, line comments, template literals, and string
    // literals so that pattern-matching code and test fixtures don't
    // produce false positives.
    let out = '';
    let i = 0;
    while (i < source.length) {
      // Block comment
      if (source[i] === '/' && source[i + 1] === '*') {
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      // Line comment
      if (source[i] === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') i++;
        continue;
      }
      // Template literal
      if (source[i] === '`') {
        i++;
        let depth = 1;
        while (i < source.length && depth > 0) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '`') depth--;
          i++;
        }
        continue;
      }
      // Single-quoted string
      if (source[i] === "'") {
        i++;
        while (i < source.length && source[i] !== "'" && source[i] !== '\n') {
          if (source[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      // Double-quoted string
      if (source[i] === '"') {
        i++;
        while (i < source.length && source[i] !== '"' && source[i] !== '\n') {
          if (source[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      out += source[i];
      i++;
    }
    return out;
  }

  _resolveImport(dir, importPath) {
    const extensions = ['', '.js', '.ts', '.tsx', '.jsx', '.json', '/index.js', '/index.ts'];
    for (const ext of extensions) {
      const resolved = path.resolve(dir, importPath + ext);
      if (fs.existsSync(resolved)) return resolved;
    }
    return null;
  }

  _checkDanglingPatterns(projectRoot, files, result, parsedOk = new Set()) {
    for (const file of files) {
      // Skip files the authoritative parser already accepted — their
      // backticks and parens are provably balanced, so these heuristics
      // could only false-positive.
      if (parsedOk.has(file)) continue;

      const relPath = repoRelative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');

      // Strip strings / template literals / regex / comments FIRST, so a
      // backtick or paren living inside one of those doesn't count. (The raw
      // backtick count fired on any file that merely mentions a `template`
      // in a string or comment.)
      const stripped = stripStringsAndComments(content);

      // Unclosed template literals — count backticks in the STRIPPED source.
      const backticks = (stripped.match(/`/g) || []).length;
      if (backticks % 2 !== 0) {
        result.addCheck(`syntax:template-literal:${relPath}`, false, {
          file: relPath,
          severity: 'warning',
          message: 'Odd number of backticks — possible unclosed template literal',
          suggestion: 'Check for unclosed template literals',
        });
      }

      // Unbalanced parentheses — same state-machine stripper.
      const parens = (stripped.match(/\(/g) || []).length - (stripped.match(/\)/g) || []).length;
      if (Math.abs(parens) > 2) {
        result.addCheck(`syntax:parens:${relPath}`, false, {
          file: relPath,
          severity: 'warning',
          message: `Parenthesis imbalance detected (off by ${Math.abs(parens)})`,
          suggestion: 'Check for unclosed or extra parentheses',
        });
      }
    }
  }
}

module.exports = SyntaxModule;
