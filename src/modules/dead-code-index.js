// Dead-code index builder — walks the project and builds the import/export graph.
// Kept separate from the main module to stay within the 300-line file-length gate.

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const { workspacePackageMap } = require('../core/workspaces');
const {
  PY_EXTS,
  extractJsExports, extractJsImports,
  extractPyExports, extractPyImports,
  resolveImportPath, populatePackageSurface,
} = require('./dead-code-extractor');

function buildDeadCodeIndex(files, projectRoot) {
  const perFile = new Map();
  const importedNames = new Set();
  // Files imported as a WHOLE module somewhere (namespace/default/whole-require/
  // dynamic import). Their exports can't be proven unused — skip flagging them.
  const namespaceReferencedFiles = new Set();

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

    perFile.set(file, { exports, lang, rel: repoRelative(projectRoot, file) });

    const imp = lang === 'py'
      ? extractPyImports(content)
      : extractJsImports(content, file, projectRoot);
    const { names, paths } = imp;
    const namespacePaths = imp.namespacePaths || new Set();

    for (const n of names) importedNames.add(n);
    for (const nsPath of namespacePaths) {
      const resolvedNs = resolveImportPath(file, nsPath, projectRoot, workspacePackages);
      if (resolvedNs) {
        namespaceReferencedFiles.add(resolvedNs);
        namespaceReferencedFiles.add(path.normalize(resolvedNs));
      }
    }
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
            importedNames, workspacePackagesWithSurface,
          );
        }
      }
    }
  }

  return { perFile, importedNames, namespaceReferencedFiles, projectRoot, importedWorkspacePackages, fileWorkspacePackage, workspacePackagesWithSurface };
}

// The workspace reader lives in src/core/workspaces.js (one definition —
// monorepoConstraints and aiHallucination read the same globs).
function buildWorkspaceMap(projectRoot) {
  return workspacePackageMap(projectRoot);
}

module.exports = { buildDeadCodeIndex };
