/**
 * Monorepo Constraints — enforces package boundary rules.
 *
 * In a monorepo (apps/ + packages/ or libs/), applications should import
 * shared code through the packages layer, not directly cross-app. Direct
 * cross-app imports cause:
 *   - Circular dependency explosions at build time.
 *   - Impossible to deploy apps independently.
 *   - Hidden coupling that makes refactoring painful.
 *
 * Members come from the declared workspaces (src/core/workspaces.js), not
 * from directory names alone.
 *
 * Rules enforced:
 *   1. apps/web must not import from apps/api (or any sibling app) — error.
 *   2. packages/* must not import from apps/* (package depends on app) — error.
 *   3. No relative import may walk into a sibling member (../../other-pkg/src)
 *      — warning; it holds only inside this checkout.
 *   4. A member importing a sibling by name must declare it in its own
 *      package.json — warning; otherwise it resolves only through hoisting.
 *   (An "apps → services" rule was listed here for years and never implemented.)
 *
 * Suppression: `// monorepo-ok` on the import line skips that import.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const BaseModule    = require('./base-module');
const { makeAutoFix } = require('../core/ai-fix-engine');
const { listWorkspacePackages } = require('../core/workspaces');

// ─── helpers ───────────────────────────────────────────────────────────────

// "app" and "package" in rules 1–2 mean what the directory says (apps/,
// packages/). Members under any other first segment (examples/, www,
// test/, tools/) are still members and take part in rules 3–4.

function readDeclaredDeps(pkgDir) {
  const deps = new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg[key] || {})) deps.add(name);
    }
  } catch { /* error-ok — no manifest: nothing declared */ }
  return deps;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import\s+.*?from\s+|(?:const|let|var)\s+.*?=\s*require\s*\(\s*)['"]([^'"]+)['"]/g;

// ─── module ────────────────────────────────────────────────────────────────

class MonorepoConstraints extends BaseModule {
  constructor() {
    super('monorepoConstraints', 'Monorepo Constraints — package boundaries from the declared workspaces (apps/ packages/ libs/, pnpm, lerna)');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    // Members from package.json workspaces / pnpm-workspace.yaml / lerna.json,
    // falling back to apps/ packages/ libs/ services/ (src/core/workspaces.js).
    // Until 2026-09-05 only the four directory names were ever read: trpc's
    // members under examples/* and www, prisma's under packages/** and
    // test/** were invisible (KI #106).
    const members = listWorkspacePackages(projectRoot);

    if (members.length < 2) {
      result.addCheck('monorepo-constraints:not-monorepo', true, {
        severity: 'info',
        message: 'No monorepo structure detected (workspaces, apps/, packages/, libs/) — constraint check skipped',
      });
      return;
    }

    const byName = new Map();
    for (const m of members) if (m.name) byName.set(m.name, m);
    // Longest rel first, so a nested member (packages/a/b) wins over packages/a.
    const byRelDesc = [...members].sort((a, b) => b.rel.length - a.rel.length);
    const memberOf = (absPath) => {
      const rel = repoRelative(projectRoot, absPath);
      return byRelDesc.find((m) => rel === m.rel || rel.startsWith(m.rel + '/')) || null;
    };

    const extensions = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];
    let issueCount = 0;

    for (const source of members) {
      const declared = readDeclaredDeps(source.dir);
      const sourceFiles = this._collectFiles(source.dir, extensions);

      for (const file of sourceFiles) {
        if (memberOf(file) !== source) continue; // belongs to a nested member
        let content;
        try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; } // error-ok — unreadable file has no imports

        const rel = repoRelative(projectRoot, file);
        const isTest = this._isTestPath(rel);
        const lines = content.split(/\r?\n/);

        IMPORT_RE.lastIndex = 0;
        let m;
        while ((m = IMPORT_RE.exec(content)) !== null) {
          const specifier = m[1];
          // IMPORT_RE starts at the newline BEFORE the statement, so the
          // match index sits on the previous line — every import after the
          // first was reported one line early (and `// monorepo-ok` was read
          // from the wrong line) until 2026-09-05.
          const stmtIndex = content[m.index] === '\n' ? m.index + 1 : m.index;
          const lineNo    = content.slice(0, stmtIndex).split(/\r?\n/).length;
          const lineText  = lines[lineNo - 1] || '';
          if (lineText.includes('// monorepo-ok')) continue;

          let target = null;
          let viaRelative = false;

          if (specifier.startsWith('.')) {
            target = memberOf(path.resolve(path.dirname(file), specifier));
            viaRelative = true;
          } else {
            const barePkg = specifier.startsWith('@')
              ? specifier.split('/').slice(0, 2).join('/')
              : specifier.split('/')[0];
            target = byName.get(barePkg) || null;
          }

          if (!target || target === source) continue;
          const targetName = target.name || target.rel;

          // Rule 1: apps/* → apps/* is forbidden
          if (source.layer === 'apps' && target.layer === 'apps') {
            issueCount++;
            result.addCheck(`monorepo-constraints:cross-app:${rel}:${specifier}`, false, {
              severity: 'error',
              message: `${source.rel} imports directly from ${target.rel} — cross-app imports forbidden. Move shared code to packages/.`,
              file: rel,
              line: lineNo,
              fix: `Extract the shared code from ${target.rel} into a packages/ package and import from there.`,
              autoFix: makeAutoFix(file, 'monorepo-constraints:cross-app', `Cross-app import from ${targetName}`, lineNo, `Move shared code to packages/ and update this import`),
            });
            continue;
          }

          // Rule 2: packages/* → apps/* is forbidden
          if (source.layer === 'packages' && target.layer === 'apps') {
            issueCount++;
            result.addCheck(`monorepo-constraints:pkg-imports-app:${rel}:${specifier}`, false, {
              severity: 'error',
              message: `${source.rel} imports from ${target.rel} — packages must never depend on apps.`,
              file: rel,
              line: lineNo,
              fix: `Remove the dependency on ${target.rel}. Packages must be app-agnostic.`,
              autoFix: makeAutoFix(file, 'monorepo-constraints:pkg-imports-app', `Package importing from app`, lineNo, `Remove this app dependency from the package`),
            });
            continue;
          }

          if (isTest) continue; // the two objective rules below are about shipped code
          // `import type` is erased at runtime: the MODULE_NOT_FOUND rule 4
          // warns about cannot happen (apollo-server's plugin-response-cache
          // imports only a type from @apollo/cache-control-types, 2026-09-05).
          const typeOnly = /^\s*import\s+type\b/.test(lineText);

          // Rule 3 (objective, any layer): a relative path that walks into a
          // sibling workspace member bypasses that member's public surface —
          // it works only while both live in this checkout, and breaks the
          // moment either is published, vendored or deployed alone.
          if (viaRelative) {
            issueCount++;
            result.addCheck(`monorepo-constraints:relative-cross-package:${rel}:${specifier}`, false, {
              severity: 'warning',
              message: `${source.rel} reaches into ${target.rel} by relative path (${specifier}) — import the package by name (${targetName}) so the boundary holds outside this checkout`,
              file: rel,
              line: lineNo,
              fix: `Replace the relative path with an import of ${targetName} and declare it in ${source.rel}/package.json.`,
            });
            continue;
          }

          // Rule 4 (objective, any layer): importing a sibling by name without
          // declaring it. Hoisting makes it resolve in the monorepo; a consumer
          // of the published package, or a filtered install, gets MODULE_NOT_FOUND.
          if (target.name && !typeOnly && !declared.has(target.name)) {
            issueCount++;
            result.addCheck(`monorepo-constraints:undeclared-workspace-dep:${rel}:${target.name}`, false, {
              severity: 'warning',
              message: `${source.rel} imports ${target.name} but ${source.rel}/package.json does not declare it — resolves only through hoisting`,
              file: rel,
              line: lineNo,
              fix: `Add "${target.name}": "workspace:*" (pnpm) or the workspace version to ${source.rel}/package.json dependencies.`,
            });
          }
        }
      }
    }

    if (issueCount === 0) {
      result.addCheck('monorepo-constraints:clean', true, {
        severity: 'info',
        message: `Monorepo boundaries respected across ${members.length} packages`,
      });
    }
  }
}

module.exports = MonorepoConstraints;
