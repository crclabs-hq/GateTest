// Dead Code Module — unused exports, unreachable files, orphaned symbols across JS/TS/Python.
// Indexing and extraction logic lives in dead-code-index.js + dead-code-extractor.js to stay
// within the 300-line file-length gate.

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');
const { buildDeadCodeIndex } = require('./dead-code-index');
const { isEntryPoint, manifestEntrypoints } = require('../core/entrypoints');
const { buildImportGraph, reverseGraph, JS_EXTS } = require('../core/import-graph');
const { pythonImporters } = require('../core/python-imports');
const { parseExportsWithAcorn } = require('./dead-code-extractor');

// Directory excludes beyond what `BaseModule._collectFiles` already skips
// (node_modules, .git, dist, build, coverage, .next, out, …). The old
// private walk (removed under KI #104) also skipped these.
const EXTRA_EXCLUDES = ['.terraform'];

const ALL_EXTS_MAIN = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);

// Test files are executed by the runner, never imported — their top-level
// exports are incidental (a local `run` helper, a mock), so "unused export"
// analysis on them is pure noise (and "delete this dead code" is dangerous
// advice for test code), and a test is never a production READER of the
// module it exercises. "Is this a test path" has one definition,
// `BaseModule._isTestPath` (`TEST_PATH_RE`, Doctrine §4) — this module
// carried its own copy under another name until 2026-09-05, which the
// canonical-definition guard could not see, and the copy had drifted
// (`test.py` counted as a test; pytest never collects it, and django's
// `manage.py test` command lives in one).

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
  // VS Code extension contract — the editor calls these; nothing imports them.
  'activate', 'deactivate',
]);

class DeadCodeModule extends BaseModule {
  constructor() {
    super(
      'deadCode',
      'Dead Code — unused exports across JS/TS/Python, orphaned files, rotting commented-out blocks',
    );
    // Opt out of incremental: unused-export and orphaned-file detection
    // is a whole-repo set comparison — indexing only the changed files
    // would report every export in them as unused because their
    // importers were never walked. Cross-file invariant — always full set.
    this._respectsIncremental = false;
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    // Shared walk from BaseModule (KI #104). Incremental scoping is opted
    // out in the constructor — see the note there.
    const files = this._collectFiles(projectRoot, [...ALL_EXTS_MAIN], EXTRA_EXCLUDES);

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

    const ignorePatterns = (config.deadCode?.ignore || config.ignore || []);

    const index = buildDeadCodeIndex(files, projectRoot);
    // Every directory a scanned file sits in, and every ancestor up to the
    // root: a package.json one level above `src/` names `src/extension.ts`
    // through its compiled main.
    const manifestDirs = new Set();
    for (const f of files) {
      let d = path.dirname(f);
      while (d.startsWith(projectRoot) && !manifestDirs.has(d)) { manifestDirs.add(d); d = path.dirname(d); }
    }
    this._manifestRefs = manifestEntrypoints(manifestDirs);
    const reach = this._buildReach(files, projectRoot);

    let totalIssues = 0;
    totalIssues += this._flagUnusedExports(index, result, ignorePatterns);
    totalIssues += this._flagOrphanedFiles(index, result, ignorePatterns, reach);
    totalIssues += this._flagCommentedOutBlocks(files, projectRoot, result, ignorePatterns);

    result.addCheck('dead-code:summary', true, {
      severity: 'info',
      message: `Dead-code scan: ${files.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  _isEntryPoint(file, projectRoot) {
    // One definition (src/core/entrypoints.js): segment-aware directories,
    // framework and tool files, and whatever a package.json names.
    return isEntryPoint(file, projectRoot, this._manifestRefs);
  }

  /**
   * Who imports each file — JS/TS per src/core/import-graph.js (path aliases,
   * workspace packages and registry path strings resolved), Python per
   * src/core/python-imports.js (relative imports, src layout, dotted string
   * literals) — KI #96. Test files are never production readers: a module
   * whose sole importer is its own test has no production reader.
   */
  _buildReach(files, projectRoot) {
    const jsFiles = files.filter((f) => JS_EXTS.includes(path.extname(f).toLowerCase()));
    const pyFiles = files.filter((f) => path.extname(f).toLowerCase() === '.py');
    // Docs sites import components from .mdx — a reader the JS-only walk
    // never sees (trpc's www/: five components "unreachable" for this).
    // They are importers only; nothing under them is ever a finding.
    const mdx = this._collectFiles(projectRoot, ['.mdx'], EXTRA_EXCLUDES);
    const graph = buildImportGraph({ projectRoot, files: jsFiles.concat(mdx) });
    const rev = reverseGraph(graph.fullGraph);
    const productionImporters = new Map();
    const production = (importers) => [...importers].filter((i) => !this._isTestPath(graph.rel(i)));
    for (const f of jsFiles) productionImporters.set(f, production(rev.get(f) || []));
    for (const [f, importers] of pythonImporters(pyFiles, projectRoot)) {
      productionImporters.set(f, production(importers));
    }
    return { productionImporters, rel: graph.rel };
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
      } catch { /* error-ok — malformed pattern — skip */ }
    }
    return false;
  }

  _flagUnusedExports(index, result, ignorePatterns = []) {
    let issues = 0;
    const nsFiles = index.namespaceReferencedFiles || new Set();
    for (const [file, info] of index.perFile.entries()) {
      const wsPkg = index.fileWorkspacePackage && index.fileWorkspacePackage.get(file);
      if (wsPkg && index.importedWorkspacePackages && index.importedWorkspacePackages.has(wsPkg)) {
        if (!index.workspacePackagesWithSurface || !index.workspacePackagesWithSurface.has(wsPkg)) continue;
      }
      // Whole-module import somewhere → a consumer can reach any export via
      // member access / late destructure. Can't prove any export unused. This
      // is the common "module exports helpers, its test does
      // `const M = require('./mod')` then uses M.helper" pattern.
      if (nsFiles.has(path.normalize(file)) || nsFiles.has(file)) continue;
      if (this._isTestPath(info.rel)) continue;
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

  _flagOrphanedFiles(index, result, ignorePatterns = [], reach = null) {
    let issues = 0;
    for (const [file, info] of index.perFile.entries()) {
      if (info.exports.length === 0) continue;
      if (this._isEntryPoint(file, index.projectRoot)) continue;
      if (this._isTestPath(info.rel)) continue;
      // The import graphs decide (JS/TS: aliases, workspaces, registry
      // strings; Python: relative imports, src layout, dotted literals). The
      // index's `referencedFiles` no longer backs this rule — it fed Python
      // specifiers through the JS resolver and called every package file an
      // orphan (flask 10/10 false, django 351).
      const importers = reach && reach.productionImporters.get(path.normalize(file));
      if (importers && importers.length > 0) continue;

      const wsPkg = index.fileWorkspacePackage && index.fileWorkspacePackage.get(file);
      if (wsPkg && index.importedWorkspacePackages && index.importedWorkspacePackages.has(wsPkg)) {
        if (!index.workspacePackagesWithSurface || !index.workspacePackagesWithSurface.has(wsPkg)) continue;
      }
      if (this._matchesIgnorePattern(info.rel, ignorePatterns)) continue;

      issues += this._flag(result, `dead-code:orphan-file:${info.rel}`, {
        severity: 'warning',
        file: info.rel,
        message: `${info.rel} exports ${info.exports.length} symbol(s) but no file outside tests imports it — shipped, but unreachable`,
        suggestion: 'If it is run rather than imported (a script, a hook, a package main), name it in package.json or move it under bin/ or scripts/; if a test is its only reader, it is test code; otherwise delete it.',
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
      const rel = repoRelative(projectRoot, file);
      if (this._matchesIgnorePattern(rel, ignorePatterns)) continue;
      const lines = content.split(/\r?\n/);

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
