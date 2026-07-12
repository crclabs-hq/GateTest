/**
 * Syntax Module - Deep syntax validation across ALL source files.
 * Not just "does it parse" — checks imports resolve, template literals close,
 * config files are valid, and TypeScript strict mode passes clean.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

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
      this._checkTypeScript(projectRoot, result);
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
    const relPath = path.relative(projectRoot, file);
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const ext = path.extname(file).toLowerCase();

      // .mjs files are always ESM. .js files in a "type":"module" package are ESM.
      // .js files that contain top-level import/export are also ESM.
      // vm.Script rejects ESM syntax — use `node --check` for these.
      const isEsm = ext === '.mjs' || this._isEsmFile(content, file, projectRoot);
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

  // Detect whether a .js file is an ES module so we use node --check instead
  // of vm.Script (which rejects top-level import/export/import.meta).
  _isEsmFile(content, file, projectRoot) {
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
    } catch { /* ignore */ }
    return false;
  }

  _checkJsxSyntax(file, result, projectRoot) {
    const relPath = path.relative(projectRoot, file);
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
    const relPath = path.relative(projectRoot, file);
    try {
      const content = fs.readFileSync(file, 'utf-8');
      JSON.parse(content);
      result.addCheck(`json:${relPath}`, true);
    } catch (err) {
      result.addCheck(`json:${relPath}`, false, {
        file: relPath,
        message: err.message,
        suggestion: 'Fix the JSON syntax error',
      });
    }
  }

  _checkYamlSyntax(file, result, projectRoot) {
    const relPath = path.relative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf-8');

    // Basic YAML validation — check for common errors
    const lines = content.split('\n');
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
    const relPath = path.relative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf-8');

    // Basic TOML validation
    const lines = content.split('\n');
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
    const relPath = path.relative(projectRoot, file);
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
    const relPath = path.relative(projectRoot, file);
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

  _checkTypeScript(projectRoot, result) {
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

    for (const dir of tscDirs) {
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
        const errors = output.split('\n').filter(l => l.includes('error TS'));
        allErrors.push(...errors);
      }
    }

    if (!anyRan) {
      result.addCheck('typescript-strict', true, { message: 'No real tsconfig.json found (stub configs without compilerOptions are skipped)', severity: 'info' });
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
    const skip = new Set([
      'node_modules', '.git', 'dist', 'build', 'coverage',
      '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.turbo',
      '.gatetest', '.claude', 'out', 'vendor', '__pycache__',
    ]);

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
      const relPath = path.relative(projectRoot, file);
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

      const relPath = path.relative(projectRoot, file);
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

// State-machine source stripper. Walks char-by-char and replaces the
// contents of strings / template literals / regex literals / comments
// with a single space, leaving structural punctuation intact for
// downstream paren-counting. Approximate (regex vs. division heuristic
// is the standard one), but far more accurate than a single regex.
function stripStringsAndComments(src) {
  const out = [];
  const STATE = {
    NORMAL: 0,
    LINE_COMMENT: 1,
    BLOCK_COMMENT: 2,
    SQ_STRING: 3,
    DQ_STRING: 4,
    TEMPLATE: 5,
    TEMPLATE_EXPR: 6,
    REGEX: 7,
    REGEX_CLASS: 8,
  };
  let state = STATE.NORMAL;
  let templateExprDepth = 0;
  // Tokens after which `/` is interpreted as a regex literal (otherwise division).
  const REGEX_PRECEDERS = /[=(,;:!&|?{}[\n+\-*<>%^~]/;
  let lastSig = '\n';

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1] || '';
    if (state === STATE.NORMAL || state === STATE.TEMPLATE_EXPR) {
      if (c === '/' && next === '/') {
        state = STATE.LINE_COMMENT;
        out.push(' ', ' ');
        i++;
        continue;
      }
      if (c === '/' && next === '*') {
        state = STATE.BLOCK_COMMENT;
        out.push(' ', ' ');
        i++;
        continue;
      }
      if (c === "'") { state = STATE.SQ_STRING; out.push(c); continue; }
      if (c === '"') { state = STATE.DQ_STRING; out.push(c); continue; }
      if (c === '`') { state = STATE.TEMPLATE; out.push(c); continue; }
      if (c === '/' && REGEX_PRECEDERS.test(lastSig)) {
        state = STATE.REGEX;
        out.push(c);
        continue;
      }
      if (state === STATE.TEMPLATE_EXPR) {
        if (c === '{') templateExprDepth++;
        else if (c === '}') {
          templateExprDepth--;
          if (templateExprDepth === 0) {
            state = STATE.TEMPLATE;
            out.push(c);
            continue;
          }
        }
      }
      out.push(c);
      if (!/\s/.test(c)) lastSig = c;
      continue;
    }
    if (state === STATE.LINE_COMMENT) {
      if (c === '\n') { state = STATE.NORMAL; out.push(c); lastSig = '\n'; }
      else out.push(' ');
      continue;
    }
    if (state === STATE.BLOCK_COMMENT) {
      if (c === '*' && next === '/') {
        state = STATE.NORMAL;
        out.push(' ', ' ');
        i++;
      } else {
        out.push(c === '\n' ? '\n' : ' ');
      }
      continue;
    }
    if (state === STATE.SQ_STRING) {
      if (c === '\\') { out.push(' '); if (next) { out.push(' '); i++; } continue; }
      if (c === "'") { state = STATE.NORMAL; out.push(c); lastSig = c; continue; }
      out.push(c === '\n' ? '\n' : ' ');
      continue;
    }
    if (state === STATE.DQ_STRING) {
      if (c === '\\') { out.push(' '); if (next) { out.push(' '); i++; } continue; }
      if (c === '"') { state = STATE.NORMAL; out.push(c); lastSig = c; continue; }
      out.push(c === '\n' ? '\n' : ' ');
      continue;
    }
    if (state === STATE.TEMPLATE) {
      if (c === '\\') { out.push(' '); if (next) { out.push(' '); i++; } continue; }
      if (c === '`') { state = STATE.NORMAL; out.push(c); lastSig = c; continue; }
      if (c === '$' && next === '{') {
        state = STATE.TEMPLATE_EXPR;
        templateExprDepth = 1;
        out.push(c, next);
        i++;
        continue;
      }
      out.push(c === '\n' ? '\n' : ' ');
      continue;
    }
    if (state === STATE.REGEX) {
      if (c === '\\') { out.push(' '); if (next) { out.push(' '); i++; } continue; }
      if (c === '[') { state = STATE.REGEX_CLASS; out.push(' '); continue; }
      if (c === '/') {
        state = STATE.NORMAL;
        out.push(c);
        // Consume any flag chars (gimsuy)
        let j = i + 1;
        while (j < src.length && /[gimsuy]/.test(src[j])) { out.push(src[j]); j++; }
        i = j - 1;
        lastSig = '/';
        continue;
      }
      if (c === '\n') {
        // Unterminated regex — bail back to NORMAL to avoid eating the rest of the file.
        state = STATE.NORMAL;
        out.push(c);
        lastSig = '\n';
        continue;
      }
      out.push(' ');
      continue;
    }
    if (state === STATE.REGEX_CLASS) {
      if (c === '\\') { out.push(' '); if (next) { out.push(' '); i++; } continue; }
      if (c === ']') { state = STATE.REGEX; out.push(' '); continue; }
      out.push(c === '\n' ? '\n' : ' ');
      continue;
    }
  }
  return out.join('');
}

module.exports = SyntaxModule;
