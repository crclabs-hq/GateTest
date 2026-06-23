// Dead-code index builder — walks the project and builds the import/export graph.
// Kept separate from the main module to stay within the 300-line file-length gate.

const fs = require('fs');
const path = require('path');
const {
  PY_EXTS,
  extractJsExports, extractJsImports,
  extractPyExports, extractPyImports,
  resolveImportPath, populatePackageSurface,
} = require('./dead-code-extractor');

function buildDeadCodeIndex(files, projectRoot) {
  const perFile = new Map();
  const importedNames = new Set();
  const referencedFiles = new Set();

  const workspacePackages = buildWorkspaceMap(projectRoot);
  const importedWorkspacePackages = new Set();
  const fileWorkspacePackage = new Map();
  const workspacePackagesWithSurface = new Set();
  const seenPackageSurfaces = new Set();

  for (const file of files) {
    const normFile = path.normalize(file);
    for (const [pkgName, pkgDir] of workspacePackages.entries()) {
      if (normFile.startsWith(path.normalize(pkgDir) + path.sep)) {
        fileWorkspacePackage.set(file, pkgName);
        break;
      }
    }
  }

  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); }
    catch { continue; }

    const ext = path.extname(file).toLowerCase();
    const lang = PY_EXTS.has(ext) ? 'py' : 'js';
    const exports = lang === 'py'
      ? extractPyExports(content)
      : extractJsExports(content);

    perFile.set(file, { exports, lang, rel: path.relative(projectRoot, file) });

    const { names, paths } = lang === 'py'
      ? extractPyImports(content)
      : extractJsImports(content);

    for (const n of names) importedNames.add(n);
    for (const p of paths) {
      let wsKey = null;
      if (workspacePackages.has(p)) {
        wsKey = p;
      } else {
        const pkgKey = p.startsWith('@')
          ? p.split('/').slice(0, 2).join('/')
          : p.split('/')[0];
        if (workspacePackages.has(pkgKey)) wsKey = pkgKey;
      }
      if (wsKey) {
        importedWorkspacePackages.add(wsKey);
        if (!seenPackageSurfaces.has(wsKey)) {
          seenPackageSurfaces.add(wsKey);
          populatePackageSurface(
            workspacePackages.get(wsKey), wsKey,
            referencedFiles, importedNames, workspacePackagesWithSurface,
          );
        }
      }
      const resolved = resolveImportPath(file, p, projectRoot, workspacePackages);
      if (resolved) referencedFiles.add(resolved);
    }
  }

  return { perFile, importedNames, referencedFiles, projectRoot, importedWorkspacePackages, fileWorkspacePackage, workspacePackagesWithSurface };
}

function buildWorkspaceMap(projectRoot) {
  const pkgMap = new Map();
  const patterns = new Set();

  try {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    const ws = rootPkg.workspaces;
    if (Array.isArray(ws)) ws.forEach((p) => patterns.add(p));
    else if (ws && Array.isArray(ws.packages)) ws.packages.forEach((p) => patterns.add(p));
  } catch { /* not present or invalid */ }

  try {
    const yaml = fs.readFileSync(path.join(projectRoot, 'pnpm-workspace.yaml'), 'utf-8');
    for (const line of yaml.split('\n')) {
      const m = line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?/);
      if (m) patterns.add(m[1]);
    }
  } catch { /* not present */ }

  try {
    const lerna = JSON.parse(fs.readFileSync(path.join(projectRoot, 'lerna.json'), 'utf-8'));
    if (Array.isArray(lerna.packages)) lerna.packages.forEach((p) => patterns.add(p));
  } catch { /* not present */ }

  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      const base = pattern.replace(/\/\*+.*$/, '');
      const depth = pattern.includes('/**') ? 2 : 1;
      expandWorkspaceGlob(path.join(projectRoot, base), depth, pkgMap);
    } else {
      readWorkspacePackage(path.join(projectRoot, pattern), pkgMap);
    }
  }

  return pkgMap;
}

function expandWorkspaceGlob(baseDir, depth, pkgMap) {
  let entries;
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(baseDir, entry.name);
    readWorkspacePackage(full, pkgMap);
    if (depth > 1) expandWorkspaceGlob(full, depth - 1, pkgMap);
  }
}

function readWorkspacePackage(pkgDir, pkgMap) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
    if (pkg.name) pkgMap.set(pkg.name, pkgDir);
  } catch { /* not a package directory */ }
}

module.exports = { buildDeadCodeIndex };
