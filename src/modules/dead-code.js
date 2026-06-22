// Dead Code Module — unused exports, unreachable files, orphaned symbols across JS/TS/Python.
// Indexing and extraction logic lives in dead-code-index.js + dead-code-extractor.js to stay
// within the 300-line file-length gate.

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');
const { buildDeadCodeIndex } = require('./dead-code-index');
const { parseExportsWithAcorn } = require('./dead-code-extractor');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
];

const ALL_EXTS_MAIN = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);

const ENTRYPOINT_DIRS = [
  'bin/', 'tests/', 'test/', '__tests__/', 'scripts/',
  'migrations/', 'pages/', 'app/', 'api/', 'public/',
  'integrations/',
];

const ENTRYPOINT_BASENAMES = new Set([
  'index.js', 'index.ts', 'index.mjs', 'index.cjs', 'index.jsx', 'index.tsx',
  'main.js', 'main.ts', 'main.py', '__init__.py', '__main__.py',
  'app.js', 'app.ts', 'server.js', 'server.ts',
  'conftest.py', 'setup.py', 'manage.py',
]);

const FRAMEWORK_RESERVED = new Set([
  'default', 'metadata', 'generateMetadata', 'generateStaticParams',
  'generateViewport', 'viewport',
  'loader', 'action', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS',
  'HEAD', 'middleware', 'config',
  'dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime',
  'preferredRegion', 'maxDuration',
  'alt', 'size', 'contentType',
  'ErrorBoundary', 'NotFound',
  'setUp', 'tearDown', 'setup', 'teardown', 'setup_module', 'teardown_module',
]);

class DeadCodeModule extends BaseModule {
  constructor() {
    super(
      'deadCode',
      'Dead Code — unused exports across JS/TS/Python, orphaned files, rotting commented-out blocks',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('dead-code:no-files', true, {
        severity: 'info',
        message: 'No JS/TS/Python source files found — skipping',
      });
      return;
    }

    result.addCheck('dead-code:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} source file(s) for unused exports and orphaned files`,
    });

    // User-configurable ignore patterns — globs relative to projectRoot.
    // Accepted in .gatetest.json as: { "deadCode": { "ignore": ["**/*.stories.*"] } }
    const ignorePatterns = (config.deadCode?.ignore || config.ignore || []);

    const index = buildDeadCodeIndex(files, projectRoot);

    let totalIssues = 0;
    totalIssues += this._flagUnusedExports(index, result, ignorePatterns);
    totalIssues += this._flagOrphanedFiles(index, result, ignorePatterns);
    totalIssues += this._flagCommentedOutBlocks(files, projectRoot, result, ignorePatterns);

    result.addCheck('dead-code:summary', true, {
      severity: 'info',
      message: `Dead-code scan: ${files.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  _findFiles(projectRoot) {
    const out = [];
    const walk = (dir, depth = 0) => {
      if (depth > 12) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ALL_EXTS_MAIN.has(ext)) out.push(full);
        }
      }
    };
    walk(projectRoot);
    return out;
  }

  _isEntryPoint(file, projectRoot) {
    const rel = path.relative(projectRoot, file).replace(/\\/g, '/');
    const base = path.basename(file);
    if (ENTRYPOINT_BASENAMES.has(base)) return true;
    for (const dir of ENTRYPOINT_DIRS) {
      if (rel === dir.slice(0, -1) || rel.startsWith(dir)) return true;
    }
    if (/\b(page|layout|route|loading|error|not-found|template|default|global-error)\.(tsx?|jsx?)$/.test(base)) {
      return true;
    }
    if (/^(opengraph-image|twitter-image|icon|apple-icon|favicon|robots|sitemap|manifest)(\.[^.]+)?\.(tsx?|jsx?|ts|js)$/.test(base)) {
      return true;
    }
    return false;
  }

  _matchesIgnorePattern(rel, patterns) {
    if (!patterns || patterns.length === 0) return false;
    const normRel = rel.replace(/\\/g, '/');
    const SPECIAL = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);
    for (const pattern of patterns) {
      const normPat = pattern.replace(/\\/g, '/');
      let regex = '';
      let i = 0;
      while (i < normPat.length) {
        const ch = normPat[i];
        if (ch === '*' && normPat[i + 1] === '*') {
          regex += '.*';
          i += 2;
          if (normPat[i] === '/') i++;
        } else if (ch === '*') {
          regex += '[^/]*';
          i++;
        } else if (SPECIAL.has(ch)) {
          regex += '\\' + ch;
          i++;
        } else {
          regex += ch;
          i++;
        }
      }
      try {
        if (new RegExp(`^${regex}$`).test(normRel)) return true;
      } catch { /* malformed pattern — skip */ }
    }
    return false;
  }

  _flagUnusedExports(index, result, ignorePatterns = []) {
    let issues = 0;
    for (const [file, info] of index.perFile.entries()) {
      const wsPkg = index.fileWorkspacePackage && index.fileWorkspacePackage.get(file);
      if (wsPkg && index.importedWorkspacePackages && index.importedWorkspacePackages.has(wsPkg)) {
        if (!index.workspacePackagesWithSurface || !index.workspacePackagesWithSurface.has(wsPkg)) continue;
      }
      if (this._matchesIgnorePattern(info.rel, ignorePatterns)) continue;

      for (const exp of info.exports) {
        if (FRAMEWORK_RESERVED.has(exp.name)) continue;
        if (exp.isDefault) continue;
        if (index.importedNames.has(exp.name)) continue;

        issues += this._flag(result, `dead-code:unused-export:${info.rel}:${exp.line}:${exp.name}`, {
          severity: 'warning',
          file: info.rel,
          line: exp.line,
          export: exp.name,
          message: `\`${exp.name}\` is exported from ${info.rel} but no file in the project imports it — candidate dead code`,
          suggestion: 'Delete the export (and its body if it\'s only used here), or wire it up from a live caller.',
        });
      }
    }
    return issues;
  }

  _flagOrphanedFiles(index, result, ignorePatterns = []) {
    let issues = 0;
    for (const [file, info] of index.perFile.entries()) {
      if (info.exports.length === 0) continue;
      if (this._isEntryPoint(file, index.projectRoot)) continue;
      if (index.referencedFiles.has(path.normalize(file))) continue;

      const wsPkg = index.fileWorkspacePackage && index.fileWorkspacePackage.get(file);
      if (wsPkg && index.importedWorkspacePackages && index.importedWorkspacePackages.has(wsPkg)) {
        if (!index.workspacePackagesWithSurface || !index.workspacePackagesWithSurface.has(wsPkg)) continue;
      }
      if (this._matchesIgnorePattern(info.rel, ignorePatterns)) continue;

      issues += this._flag(result, `dead-code:orphan-file:${info.rel}`, {
        severity: 'info',
        file: info.rel,
        message: `${info.rel} exports ${info.exports.length} symbol(s) but no file in the project imports it — candidate orphaned module`,
        suggestion: 'If this module is legitimately reachable via a path alias, dynamic require, or non-JS entry point, mark it as such. Otherwise delete.',
      });
    }
    return issues;
  }

  _flagCommentedOutBlocks(files, projectRoot, result, ignorePatterns = []) {
    let issues = 0;
    for (const file of files) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch { continue; }

      const ext = path.extname(file).toLowerCase();
      const lang = ext === '.py' ? 'py' : 'js';
      const rel = path.relative(projectRoot, file);
      if (this._matchesIgnorePattern(rel, ignorePatterns)) continue;
      const lines = content.split('\n');

      let run = 0;
      let runStart = 0;
      const emit = (from, count) => {
        if (count < 10) return;
        issues += this._flag(result, `dead-code:commented-block:${rel}:${from}`, {
          severity: 'info',
          file: rel,
          line: from,
          message: `${count}-line commented-out block at ${rel}:${from} — rotting code`,
          suggestion: 'Delete the block. If you need it later, `git log` has it.',
        });
      };

      for (let i = 0; i < lines.length; i += 1) {
        const t = lines[i].trim();
        const marker = lang === 'js' ? '//' : '#';
        const body = t.startsWith(marker) ? t.slice(marker.length).trim() : '';
        const looksLikeCode = (lang === 'js' ? (t.startsWith('//') && !t.startsWith('///')) : t.startsWith('#') && !t.startsWith('#!'))
          && /[=(){};]/.test(body);

        if (looksLikeCode) {
          if (run === 0) runStart = i + 1;
          run += 1;
        } else {
          emit(runStart, run);
          run = 0;
        }
      }
      emit(runStart, run);
    }
    return issues;
  }

  // Backward-compat delegation for tests that call mod._parseExportsWithAcorn(...)
  _parseExportsWithAcorn(filePath) { return parseExportsWithAcorn(filePath); }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = DeadCodeModule;
