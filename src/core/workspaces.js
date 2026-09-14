'use strict';

/**
 * One answer to "which packages make up this monorepo?"
 *
 * KI #106 / the Fifty move 11. Three modules had their own answer:
 * `monorepoConstraints` and `aiHallucination` only ever looked in
 * `apps/`, `packages/`, `libs/` and `services/` — a pnpm workspace whose
 * members live under `examples/*`, `www`, `test/**` or `packages/**`
 * (prisma, trpc) was partly or wholly invisible — and `deadCodeIndex`
 * carried a private reader of the workspace globs. This file is that
 * reader, once: `package.json` workspaces (array or `{packages}`),
 * `pnpm-workspace.yaml` `packages:`, `lerna.json` packages, with the
 * conventional directories as the fallback when no config declares any.
 */

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('./repo-path');

const CONVENTIONAL_DIRS = ['apps', 'packages', 'libs', 'services'];
const { WALK_EXCLUDE_SET: SKIP_DIRS } = require('./walk-excludes');

/** Workspace glob patterns declared by the repo's tooling, in declaration order. */
function readWorkspacePatterns(projectRoot) {
  const patterns = [];
  const add = (p) => { if (typeof p === 'string' && p.trim() && !patterns.includes(p.trim())) patterns.push(p.trim()); };

  try {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    const ws = rootPkg.workspaces;
    if (Array.isArray(ws)) ws.forEach(add);
    else if (ws && Array.isArray(ws.packages)) ws.packages.forEach(add);
  } catch { /* error-ok — no root package.json or invalid JSON: nothing declared here */ }

  try {
    const yaml = fs.readFileSync(path.join(projectRoot, 'pnpm-workspace.yaml'), 'utf-8');
    let inPackages = false;
    for (const raw of yaml.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trimEnd();
      if (!line.trim()) continue;
      if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
      if (/^\S/.test(line)) { inPackages = false; continue; } // next top-level key
      const m = inPackages && line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/);
      if (m) add(m[1]);
    }
  } catch { /* error-ok — not a pnpm workspace */ }

  try {
    const lerna = JSON.parse(fs.readFileSync(path.join(projectRoot, 'lerna.json'), 'utf-8'));
    if (Array.isArray(lerna.packages)) lerna.packages.forEach(add);
  } catch { /* error-ok — not a lerna repo */ }

  return patterns;
}

/** Turn one workspace glob into a matcher over `/`-joined relative dir paths. */
function globToRegExp(glob) {
  const src = glob
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .map((seg) => {
      if (seg === '**') return '(?:[^/]+/)*[^/]+';
      return seg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*');
    })
    .join('/')
    // `a/**` also matches `a` itself's children at any depth; `(?:…/)*[^/]+` above
    // already needs at least one segment, which is the intent (members live below).
    ;
  return new RegExp(`^${src}$`);
}

/**
 * Expand a positive glob to the directories under `projectRoot` it names.
 * Segment by segment: a literal goes straight down, `*` lists one level,
 * `**` lists up to three levels. Dot-directories are only entered when the
 * pattern segment asks for them (`.*`), the way pnpm behaves.
 */
function expandGlob(projectRoot, glob) {
  const segs = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter(Boolean);
  const out = [];
  const walk = (dir, i) => {
    if (i === segs.length) { out.push(dir); return; }
    const seg = segs[i];
    if (!seg.includes('*')) { walk(path.join(dir, seg), i + 1); return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } // error-ok — a glob over a dir that is not there names nothing
    const wantDot = seg.startsWith('.');
    const segRe = globToRegExp(seg);
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.') && !wantDot) continue;
      const full = path.join(dir, e.name);
      if (seg === '**') {
        // zero or more levels: the dir itself is a candidate for the rest
        // of the pattern, and so is everything below it (depth-capped).
        walk(full, i + 1);
        const depth = full.slice(projectRoot.length).split(path.sep).filter(Boolean).length;
        if (depth < 4) walk(full, i);
      } else if (segRe.test(e.name)) {
        walk(full, i + 1);
      }
    }
  };
  walk(projectRoot, 0);
  return out;
}

/**
 * @typedef {{ name: string|null, dir: string, rel: string, layer: string }} WorkspacePackage
 *   name  — package.json `name` (null when the manifest has none)
 *   dir   — absolute directory
 *   rel   — `/`-joined path relative to the root
 *   layer — the first path segment (`apps`, `packages`, `examples`, `www`, …)
 */

/**
 * Every workspace member (a directory with a package.json), from the
 * declared globs, or from the conventional layer directories when nothing
 * is declared. Deterministic order: by `rel`.
 * @returns {WorkspacePackage[]}
 */
function listWorkspacePackages(projectRoot) {
  const patterns = readWorkspacePatterns(projectRoot);
  const positives = patterns.filter((p) => !p.startsWith('!'));
  const negatives = patterns.filter((p) => p.startsWith('!')).map((p) => globToRegExp(p.slice(1)));
  const dirs = new Set();

  if (positives.length > 0) {
    for (const g of positives) for (const d of expandGlob(projectRoot, g)) dirs.add(d);
  } else {
    for (const layer of CONVENTIONAL_DIRS) {
      for (const d of expandGlob(projectRoot, `${layer}/*`)) dirs.add(d);
    }
  }

  const members = [];
  for (const dir of dirs) {
    const rel = repoRelative(projectRoot, dir);
    if (!rel || rel.startsWith('..')) continue;
    if (negatives.some((re) => re.test(rel) || re.test(path.basename(rel)))) continue;
    const manifest = path.join(dir, 'package.json');
    let name = null;
    try { name = JSON.parse(fs.readFileSync(manifest, 'utf-8')).name || null; } catch { continue; } // error-ok — a dir without a manifest is not a member
    members.push({ name, dir, rel, layer: rel.split('/')[0] });
  }
  members.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return members;
}

/** Every field a package.json can declare a dependency in. */
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Does the package.json in `dir` declare a package matching `matcher` in any
 * dependency field? `matcher` is a Set of names, a RegExp over the name, or a
 * predicate. No manifest / invalid JSON declares nothing. zodSchema and
 * trpcContract each carried a private copy of this (KI #106, 2026-09-05).
 */
function manifestDeclares(dir, matcher) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')); } catch { return false; } // error-ok — no manifest / invalid JSON: declares nothing
  const test = matcher instanceof Set ? (k) => matcher.has(k)
    : matcher instanceof RegExp ? (k) => matcher.test(k)
      : matcher;
  return DEP_FIELDS.some((f) => Object.keys(pkg[f] || {}).some((k) => test(k)));
}

/**
 * The workspace member that contains `rel` (`/`-joined, relative to root),
 * deepest first so `examples/minimal/client` wins over `examples/minimal`.
 * Segment-anchored: `packages/a` must not claim `packages/ab/x.tsx`. Null
 * when no member contains it (the root manifest governs).
 */
function nearestWorkspacePackage(members, rel) {
  let best = null;
  for (const m of members) {
    if (rel === m.rel || rel.startsWith(m.rel + '/')) {
      if (!best || m.rel.length > best.rel.length) best = m;
    }
  }
  return best;
}

/** `name → absolute dir` for every named member (deadCodeIndex's shape). */
function workspacePackageMap(projectRoot) {
  const map = new Map();
  for (const m of listWorkspacePackages(projectRoot)) if (m.name) map.set(m.name, m.dir);
  return map;
}

/** The set of member package names (aiHallucination's shape). */
function workspacePackageNames(projectRoot) {
  return new Set(workspacePackageMap(projectRoot).keys());
}

module.exports = {
  CONVENTIONAL_DIRS,
  readWorkspacePatterns,
  globToRegExp,
  expandGlob,
  listWorkspacePackages,
  workspacePackageMap,
  workspacePackageNames,
  DEP_FIELDS,
  manifestDeclares,
  nearestWorkspacePackage,
};
