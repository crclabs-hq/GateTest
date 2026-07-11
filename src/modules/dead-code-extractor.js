// Dead-code extractor helpers: export/import extraction and Phase 1B entry-surface analysis.

const fs = require('fs');
const path = require('path');

const JS_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const PY_EXTS = new Set(['.py']);
const ALL_EXTS = new Set([...JS_EXTS, ...PY_EXTS]);

function resolvePackageEntry(pkgDir) {
  let mainBase = 'index';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
    const mainField = (typeof pkg.module === 'string' && pkg.module)
      || (typeof pkg.main === 'string' && pkg.main)
      || null;
    if (mainField) mainBase = mainField.replace(/\.(js|mjs|cjs|ts|tsx)$/, '');
  } catch { /* use default */ }

  const base = path.isAbsolute(mainBase) ? mainBase : path.join(pkgDir, mainBase);
  const candidates = [
    base,
    ...Array.from(ALL_EXTS).map((e) => base + e),
    ...Array.from(ALL_EXTS).map((e) => path.join(pkgDir, 'index' + e)),
    ...Array.from(ALL_EXTS).map((e) => path.join(pkgDir, 'src', 'index' + e)),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return path.normalize(c); }
    catch { /* keep trying */ }
  }
  return null;
}

function resolveImportPath(fromFile, importPath, projectRoot, workspacePackages = null) {
  if (!importPath) return null;
  if (workspacePackages && !importPath.startsWith('.') && !importPath.startsWith('/')) {
    const pkgDir = workspacePackages.get(importPath)
      || (importPath.startsWith('@')
        ? workspacePackages.get(importPath.split('/').slice(0, 2).join('/'))
        : workspacePackages.get(importPath.split('/')[0]));
    if (pkgDir) return resolvePackageEntry(pkgDir);
  }
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;
  const base = importPath.startsWith('/')
    ? path.join(projectRoot, importPath)
    : path.resolve(path.dirname(fromFile), importPath);
  const candidates = [
    base,
    ...Array.from(ALL_EXTS).map((e) => base + e),
    ...Array.from(ALL_EXTS).map((e) => path.join(base, 'index' + e)),
    ...Array.from(ALL_EXTS).map((e) => path.join(base, '__init__' + e)),
  ];
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return path.normalize(c);
    } catch { /* keep going */ }
  }
  return null;
}

function extractJsExports(content) {
  const out = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    let m = line.match(/^\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
    if (m) { out.push({ name: m[1], line: i + 1 }); continue; }

    m = line.match(/^\s*export\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/);
    if (m) { out.push({ name: m[1], line: i + 1, isDefault: true }); continue; }

    m = line.match(/^\s*export\s*\{\s*([^}]+)\s*\}/);
    if (m) {
      const names = m[1].split(',').map((s) => {
        const parts = s.trim().split(/\s+as\s+/);
        return (parts[1] || parts[0]).trim();
      }).filter(Boolean);
      for (const n of names) out.push({ name: n, line: i + 1 });
      continue;
    }

    m = line.match(/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/);
    if (m) { out.push({ name: m[1], line: i + 1 }); continue; }
  }
  return out;
}

// Regex-based fallback for when acorn is absent.
// Handles multi-line export { ... } blocks and export * from "path" re-exports.
function _parseExportsWithRegex(content) {
  const reExportPaths = [];

  // Strip block comments and line comments to avoid false positives.
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*/g, '');

  let m;
  const starRe = /export\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s+['"]([^'"]+)['"]/g;
  while ((m = starRe.exec(stripped)) !== null) {
    reExportPaths.push(m[1]);
  }

  // Handles both single-line and multi-line export { ... } [from "path"].
  const braceExports = [];
  const braceRe = /export\s*\{([^}]*)\}(?:\s*from\s+['"]([^'"]+)['"])?/gs;
  while ((m = braceRe.exec(stripped)) !== null) {
    const lineNum = (stripped.slice(0, m.index).match(/\n/g) || []).length + 1;
    for (const part of m[1].split(',')) {
      const alias = part.trim().replace(/\n/g, ' ').split(/\s+as\s+/);
      const exported = (alias[1] || alias[0]).trim();
      if (exported && /^[A-Za-z_$][\w$]*$/.test(exported)) {
        braceExports.push({ name: exported, line: lineNum });
      }
    }
    if (m[2] && !reExportPaths.includes(m[2])) reExportPaths.push(m[2]);
  }

  // Line-by-line pass covers function/class/const/module.exports declarations.
  const lineExports = extractJsExports(content);
  const seenNames = new Set(lineExports.map((e) => e.name));
  const exports = [...lineExports];
  for (const e of braceExports) {
    if (!seenNames.has(e.name)) { exports.push(e); seenNames.add(e.name); }
  }

  return { exports, reExportPaths };
}

// AST-level export extraction — handles multi-line export blocks; falls back to regex on acorn-absent / parse errors.
function parseExportsWithAcorn(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf-8'); }
  catch { return { exports: [], reExportPaths: [] }; }

  let acorn;
  try { acorn = require('acorn'); }
  catch { return _parseExportsWithRegex(content); }

  let ast;
  try {
    ast = acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
  } catch {
    return { exports: extractJsExports(content), reExportPaths: [] };
  }

  const exports = [];
  const reExportPaths = [];

  for (const node of ast.body) {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.source?.value) reExportPaths.push(node.source.value);
      if (node.declaration) {
        const d = node.declaration;
        if (d.id) {
          exports.push({ name: d.id.name, line: d.id.loc.start.line });
        } else if (d.declarations) {
          for (const v of d.declarations) {
            if (v.id?.type === 'Identifier') exports.push({ name: v.id.name, line: v.id.loc.start.line });
          }
        }
      }
      for (const spec of node.specifiers || []) {
        const name = spec.exported?.name;
        if (name) exports.push({ name, line: node.loc.start.line });
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      const id = node.declaration?.id;
      if (id) exports.push({ name: id.name, line: id.loc.start.line, isDefault: true });
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.source?.value) reExportPaths.push(node.source.value);
    }
  }

  return { exports, reExportPaths };
}

// Recursively follow re-export chains to discover all files + names reachable from a package entry (Phase 1B).
function buildPackageExportSurface(entryFile, pkgDir, seen = new Set()) {
  const normEntry = path.normalize(entryFile);
  if (seen.has(normEntry)) return { reachableFiles: new Set(), exportedNames: new Set() };
  seen.add(normEntry);

  const reachableFiles = new Set([normEntry]);
  const exportedNames = new Set();

  const ext = path.extname(entryFile).toLowerCase();
  const needsLineHeuristic = ['.ts', '.tsx', '.mts', '.cts', '.jsx'].includes(ext);

  let exports;
  let reExportPaths;

  if (needsLineHeuristic) {
    let content;
    try { content = fs.readFileSync(entryFile, 'utf-8'); }
    catch { return { reachableFiles, exportedNames }; }
    exports = extractJsExports(content);
    reExportPaths = [];
    for (const m of content.matchAll(/^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm)) {
      reExportPaths.push(m[1]);
    }
  } else {
    ({ exports, reExportPaths } = parseExportsWithAcorn(entryFile));
  }

  for (const exp of exports) exportedNames.add(exp.name);

  for (const rePath of reExportPaths) {
    const resolved = resolveImportPath(entryFile, rePath, pkgDir);
    if (!resolved) continue;
    try {
      const sub = buildPackageExportSurface(resolved, pkgDir, seen);
      for (const f of sub.reachableFiles) reachableFiles.add(f);
      for (const n of sub.exportedNames) exportedNames.add(n);
    } catch { /* non-blocking */ }
  }

  return { reachableFiles, exportedNames };
}

// Merge a workspace package's entry surface into the global index sets (Phase 1B precision suppression).
function populatePackageSurface(pkgDir, pkgName, referencedFiles, importedNames, workspacePackagesWithSurface) {
  const entryFile = resolvePackageEntry(pkgDir);
  if (!entryFile) return;
  try {
    const { reachableFiles, exportedNames } = buildPackageExportSurface(entryFile, pkgDir);
    for (const f of reachableFiles) referencedFiles.add(f);
    for (const n of exportedNames) importedNames.add(n);
    workspacePackagesWithSurface.add(pkgName);
  } catch { /* non-blocking — blanket suppression fallback stays in effect */ }
}

function extractJsImports(content) {
  const names = new Set();
  const paths = new Set();
  // Paths imported as a WHOLE module (namespace / default / bare require, or a
  // dynamic import) — the importer can reach any export via member access
  // (`M.foo`) or a later destructure (`const { foo } = M`), which we can't
  // track statically. A file imported this way must NOT have its exports
  // flagged as unused. Only files imported EXCLUSIVELY by name are analysable.
  const namespacePaths = new Set();
  // Paths reached by at least one NAMED import (import { x } / { x } = require).
  const namedPaths = new Set();

  // The optional `type` after `import` handles TS type-only imports:
  //   import type { Foo } from './x'   /   import type Foo from './x'
  const importRe = /import\s+(?:type\s+)?(?:(\*\s+as\s+[A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)|(\{[^}]*\})|(\{[^}]*\}\s*,\s*[A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*\s*,\s*\{[^}]*\}))?\s*(?:from\s+)?["']([^"']+)["']/g;
  let m;
  while ((m = importRe.exec(content)) !== null) {
    const p = m[6];
    paths.add(p);
    const spec = m[1] || m[2] || m[3] || m[4] || m[5] || '';
    // `import * as M`, `import M from`, and side-effect `import 'x'` bring the
    // whole module into reach; a spec containing `{...}` is a named import.
    if (m[1] || m[2] || m[5] || !spec) namespacePaths.add(p);
    if (spec) {
      const braces = spec.match(/\{([^}]*)\}/);
      if (braces) {
        namedPaths.add(p);
        for (const part of braces[1].split(',')) {
          let trimmed = part.trim();
          if (!trimmed) continue;
          // Strip a leading inline `type ` modifier (import { type Foo }).
          trimmed = trimmed.replace(/^type\s+/, '');
          const alias = trimmed.split(/\s+as\s+/);
          names.add(alias[0].trim());
        }
      }
      const bare = spec.match(/^([A-Za-z_$][\w$]*)/);
      if (bare) names.add(bare[1]);
    }
  }

  // Named CJS destructure: `const { a, b } = require('path')`.
  const destructRe = /\{\s*([^}]+)\s*\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = destructRe.exec(content)) !== null) {
    namedPaths.add(m[2]);
    for (const part of m[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const alias = trimmed.split(/\s*:\s*/);
      names.add(alias[0].trim());
    }
  }

  // Every remaining require('path') that wasn't the named-destructure form is a
  // whole-module require (`const M = require('path')`, `foo(require('path'))`,
  // or a bare side-effect require).
  const requireRe = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = requireRe.exec(content)) !== null) {
    paths.add(m[1]);
    if (!namedPaths.has(m[1])) namespacePaths.add(m[1]);
  }

  const dynamicImportRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynamicImportRe.exec(content)) !== null) {
    paths.add(m[1]);
    namespacePaths.add(m[1]); // dynamic import — whole module in reach
  }

  // Re-exports (barrel files). `export * from './x'` re-exports the whole
  // module — every export of './x' is now part of THIS module's surface, so
  // treat it as a namespace reference. `export { a, b } from './x'` re-exports
  // specific names. Without this, an index.ts barrel makes the underlying
  // files' exports look unused.
  const starReExportRe = /export\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s*["']([^"']+)["']/g;
  while ((m = starReExportRe.exec(content)) !== null) {
    paths.add(m[1]);
    namespacePaths.add(m[1]);
  }
  const namedReExportRe = /export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  while ((m = namedReExportRe.exec(content)) !== null) {
    paths.add(m[2]);
    for (let part of m[1].split(',')) {
      part = part.trim();
      if (!part) continue;
      part = part.replace(/^type\s+/, '');
      names.add(part.split(/\s+as\s+/)[0].trim());
    }
  }

  return { names, paths, namespacePaths };
}

function extractPyExports(content) {
  const out = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let m = line.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
    if (m) {
      if (!m[1].startsWith('_')) out.push({ name: m[1], line: i + 1 });
      continue;
    }
    m = line.match(/^class\s+([A-Za-z_][\w]*)/);
    if (m) {
      if (!m[1].startsWith('_')) out.push({ name: m[1], line: i + 1 });
      continue;
    }
    // NOTE: module-level UPPER_CASE assignments (REPO = ..., TASK_ID = ...) are
    // deliberately NOT treated as exports. In Python these are in-module config
    // constants used within the same file (or the script's own runtime state);
    // no other file "imports" them, so flagging them flooded the report with
    // false positives (300+ on one runner script). Only def/class — reusable
    // code units — are meaningful "unused export" signals.
  }
  // Drop any def/class that is REFERENCED elsewhere in its own file — a
  // dispatch table, registry, or internal call means it's used (and not safe
  // to delete), so it isn't dead even if no other file imports it. Common in
  // Python runner scripts: `def tool_x(): ...` then `if name == "x": tool_x()`.
  return out.filter((exp) => {
    const re = new RegExp(`\\b${exp.name}\\b`, 'g');
    const hits = (content.match(re) || []).length;
    return hits <= 1; // only the definition itself → genuinely unreferenced
  });
}

function extractPyImports(content) {
  const names = new Set();
  const paths = new Set();
  const lines = content.split('\n');
  for (const line of lines) {
    let m = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+?)(?:\s*#.*)?$/);
    if (m) {
      paths.add(m[1]);
      for (const part of m[2].split(',')) {
        const trimmed = part.trim();
        if (!trimmed || trimmed === '*') continue;
        const alias = trimmed.split(/\s+as\s+/);
        names.add(alias[0].trim());
      }
      continue;
    }
    m = line.match(/^\s*import\s+(.+?)(?:\s*#.*)?$/);
    if (m) {
      for (const part of m[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const alias = trimmed.split(/\s+as\s+/);
        const first = alias[0].trim().split('.')[0];
        names.add(alias[1] ? alias[1].trim() : first);
        paths.add(alias[0].trim());
      }
    }
  }
  return { names, paths };
}

module.exports = {
  ALL_EXTS, JS_EXTS, PY_EXTS,
  resolvePackageEntry, resolveImportPath,
  extractJsExports, parseExportsWithAcorn,
  buildPackageExportSurface, populatePackageSurface,
  extractJsImports, extractPyExports, extractPyImports,
};
