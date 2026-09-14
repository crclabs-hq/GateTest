'use strict';
/**
 * Module resolution — the one definition of how a specifier becomes a file.
 *
 * tsconfig / jsconfig `paths` aliases (with `extends`, JSONC tolerated, read
 * once per directory) and a package's entry file. Shared by the dead-code
 * extractor and src/core/import-graph.js (KI #96): until 2026-09-05 the
 * import graph resolved only `./` specifiers, so every `@/app/...` import in
 * the website was invisible to reachability, while the dead-code extractor
 * carried its own alias loader. Two answers to "what does this import
 * resolve to" is the Doctrine §4 bug; this file is the one answer.
 */

const fs = require('fs');
const path = require('path');

/** Extensions a package entry may carry, in the order Node and tsc try them. */
const ENTRY_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py'];

function resolvePackageEntry(pkgDir, exts = ENTRY_EXTS) {
  let mainBase = 'index';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
    const mainField = (typeof pkg.module === 'string' && pkg.module)
      || (typeof pkg.main === 'string' && pkg.main)
      || null;
    if (mainField) mainBase = mainField.replace(/\.(js|mjs|cjs|ts|tsx)$/, '');
  } catch { /* error-ok — no readable package.json: `index` is the resolution default */ }

  const base = path.isAbsolute(mainBase) ? mainBase : path.join(pkgDir, mainBase);
  const candidates = [
    base,
    ...Array.from(exts).map((e) => base + e),
    ...Array.from(exts).map((e) => path.join(pkgDir, 'index' + e)),
    ...Array.from(exts).map((e) => path.join(pkgDir, 'src', 'index' + e)),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return path.normalize(c); }
    catch { /* error-ok — this candidate is absent; the next extension may exist */ }
  }
  return null;
}

// tsconfig / jsconfig `paths` aliases.
//
// `import X from "@/app/components/X"` is how every Next.js app in the world
// imports its own files, and until 2026-09-05 this resolver returned null for
// any specifier that did not start with `.` or `/` — so a component imported
// only through the alias was reported as an orphaned module (it happened to
// website/app/components/ComparisonReviewed.tsx, imported by seven pages).
// The nearest tsconfig.json / jsconfig.json walking up from the importing file
// is consulted, `extends` is followed, and the config is read once per
// directory. JSONC is tolerated: tsconfig files carry comments.
// ---------------------------------------------------------------------------
const aliasCache = new Map(); // dir → [{ prefix, wildcard, targets: [abs base] }] | null

function stripJsoncLite(src) {
  let out = '';
  let i = 0;
  let inStr = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += next || ''; i += 2; continue; }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
    out += ch;
    i += 1;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

// The compilerOptions that change what the emitted JavaScript imports. A child
// tsconfig's explicit value wins over the one it `extends`.
const ELISION_FLAGS = ['verbatimModuleSyntax', 'preserveValueImports', 'importsNotUsedAsValues', 'emitDecoratorMetadata'];

function readTsconfig(file, depth = 0) {
  let cfg;
  try { cfg = JSON.parse(stripJsoncLite(fs.readFileSync(file, 'utf8'))); } catch { return null; }
  if (!cfg || typeof cfg !== 'object') return null;
  const co = cfg.compilerOptions || {};
  const flags = {};
  for (const k of ELISION_FLAGS) if (co[k] !== undefined) flags[k] = co[k];
  let base = { baseUrl: co.baseUrl, paths: co.paths, dir: path.dirname(file), flags };
  if (cfg.extends && typeof cfg.extends === 'string' && cfg.extends.startsWith('.') && depth < 3) {
    const parent = readTsconfig(path.resolve(path.dirname(file), cfg.extends.endsWith('.json') ? cfg.extends : `${cfg.extends}.json`), depth + 1);
    if (parent) base = { baseUrl: base.baseUrl || parent.baseUrl, paths: base.paths || parent.paths, dir: base.paths ? base.dir : parent.dir, flags: { ...parent.flags, ...flags } };
  }
  return base;
}

const nearestCache = new Map(); // dir → tsconfig | null
/**
 * The tsconfig.json governing a directory: the closest one walking up, stopping
 * at `stopDir`. Null when there is none (a plain JS project).
 */
function nearestTsconfig(dir, stopDir) {
  if (nearestCache.has(dir)) return nearestCache.get(dir);
  let found = null;
  let cur = dir;
  for (;;) {
    found = readTsconfig(path.join(cur, 'tsconfig.json'));
    if (found) break;
    if (cur === stopDir || path.dirname(cur) === cur) break;
    cur = path.dirname(cur);
  }
  nearestCache.set(dir, found);
  return found;
}

/**
 * Does tsc drop an import whose bindings are only used as types? Yes unless
 * the project says otherwise: `verbatimModuleSyntax` / `preserveValueImports`
 * keep every import as written; `importsNotUsedAsValues: preserve` keeps the
 * module load (a side-effect import), `error` forces `import type` for
 * anything type-only, so what is left as a plain import is a value import.
 * `isolatedModules` alone does NOT change elision.
 */
function elisionMode(dir, stopDir) {
  const cfg = nearestTsconfig(dir, stopDir);
  const f = (cfg && cfg.flags) || {};
  const elide = !(f.verbatimModuleSyntax === true || f.preserveValueImports === true
    || f.importsNotUsedAsValues === 'preserve' || f.importsNotUsedAsValues === 'error');
  return { elide, decoratorMetadata: f.emitDecoratorMetadata === true, configured: !!cfg };
}

function loadPathAliases(dir) {
  if (aliasCache.has(dir)) return aliasCache.get(dir);
  let entries = null;
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const cfg = readTsconfig(path.join(dir, name));
    if (!cfg) continue;
    const hasPaths = cfg.paths && typeof cfg.paths === 'object';
    if (!hasPaths && !cfg.baseUrl) continue;
    const baseDir = path.resolve(cfg.dir, cfg.baseUrl || '.');
    entries = [];
    // A bare specifier resolves against `baseUrl` on its own — Angular's
    // `import { X } from 'src/app/x'` with baseUrl "./" and no `paths`
    // (CleanArchitecture's ClientApp, 7 files "unreachable" for this).
    // Listed last so an explicit `paths` entry wins.
    const baseUrlEntry = cfg.baseUrl ? { prefix: '', wildcard: true, targets: [baseDir] } : null;
    for (const [pattern, targets] of Object.entries(hasPaths ? cfg.paths : {})) {
      if (!Array.isArray(targets)) continue;
      const wildcard = pattern.endsWith('*');
      entries.push({
        prefix: wildcard ? pattern.slice(0, -1) : pattern,
        wildcard,
        targets: targets.map((t) => path.resolve(baseDir, wildcard && t.endsWith('*') ? t.slice(0, -1) : t)),
      });
    }
    if (baseUrlEntry) entries.push(baseUrlEntry);
    break;
  }
  // Docusaurus resolves `@site/*` to the site root by convention; the tsconfig
  // that declares it lives in node_modules (`@docusaurus/tsconfig`), so no
  // project file says so. trpc's www/: five components imported only from
  // .mdx docs through `@site/src/components/…` were "unreachable" for this.
  // `@theme/*` and `@docusaurus/*` are package internals and stay external.
  if (DOCUSAURUS_CONFIG.some((n) => fs.existsSync(path.join(dir, n)))) {
    entries = entries || [];
    entries.push({ prefix: '@site/', wildcard: true, targets: [dir] });
  }
  aliasCache.set(dir, entries);
  return entries;
}
const DOCUSAURUS_CONFIG = ['docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs', 'docusaurus.config.cjs'];

const BUILD_DIRS = new Set(['out', 'dist', 'build', 'lib', 'es', 'esm', 'cjs', '.next']);
const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const stemIndexCache = new Map(); // pkgDir → Map<stem, abs[]>

/** Every source file under `<pkgDir>/src`, keyed by basename-without-extension. Read once per package. */
function sourceStemIndex(pkgDir) {
  if (stemIndexCache.has(pkgDir)) return stemIndexCache.get(pkgDir);
  const index = new Map();
  const srcDir = path.join(pkgDir, 'src');
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } // error-ok — no src tree
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      const ext = path.extname(e.name);
      if (!SOURCE_EXTS.includes(ext)) continue;
      const stem = e.name.slice(0, -ext.length).replace(/\.d$/, '');
      if (!index.has(stem)) index.set(stem, []);
      index.get(stem).push(full);
    }
  };
  walk(srcDir, 0);
  stemIndexCache.set(pkgDir, index);
  return index;
}

/**
 * The source file a manifest's compiled target denotes. `./dist/x.mjs` that
 * is not on disk (a fresh clone is unbuilt) names the one `src/**\/x.*` with
 * that stem; an ambiguous stem names nothing rather than guessing.
 */
function compiledToSources(pkgDir, target) {
  const parts = target.replace(/^\.\//, '').split('/');
  const at = parts.findIndex((seg) => BUILD_DIRS.has(seg));
  if (at === -1) return [];
  const out = [];
  // The same path under src/ first: dist/jsx/jsx-runtime.js → src/jsx/jsx-runtime.ts.
  // A bare stem lookup would find two jsx-runtime files in hono and give up.
  const rest = parts.slice(at + 1).join('/').replace(/\.[^.]+$/, '').replace(/\.d$/, '');
  for (const ext of SOURCE_EXTS) {
    const cand = path.join(pkgDir, 'src', `${rest}${ext}`);
    try { if (fs.statSync(cand).isFile()) { out.push(cand); break; } } catch { /* error-ok — next extension */ }
  }
  const stem = path.basename(parts[parts.length - 1]).replace(/\.[^.]+$/, '').replace(/\.d$/, '');
  // prisma writes `contract__authored-check-naming.mjs` for src/exports/authored-check-naming.ts
  for (const c of new Set([stem, stem.split('__').pop()])) {
    for (const hit of sourceStemIndex(pkgDir).get(c) || []) if (!out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * The one source a compiled target denotes, for an EDGE: the path-shaped
 * match, else a unique stem. Ambiguity resolves to nothing — an edge to the
 * wrong file invents a dependency. For ENTRYPOINT exemption use the plural:
 * every candidate is kept out of the orphan report, which errs the safe way.
 */
function compiledToSource(pkgDir, target) {
  const all = compiledToSources(pkgDir, target);
  if (all.length === 0) return null;
  const parts = target.replace(/^\.\//, '').split('/');
  const at = parts.findIndex((seg) => BUILD_DIRS.has(seg));
  const rest = parts.slice(at + 1).join('/').replace(/\.[^.]+$/, '').replace(/\.d$/, '');
  const shaped = all.find((f) => f.startsWith(path.join(pkgDir, 'src', rest) + '.'));
  if (shaped) return shaped;
  return all.length === 1 ? all[0] : null;
}

function exportsTarget(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(exportsTarget).find(Boolean) || null;
  if (value && typeof value === 'object') {
    for (const key of ['source', 'import', 'require', 'default', 'node', 'types']) {
      if (value[key] !== undefined) { const t = exportsTarget(value[key]); if (t) return t; }
    }
    for (const v of Object.values(value)) { const t = exportsTarget(v); if (t) return t; }
  }
  return null;
}

/**
 * `@scope/pkg/sub/path` through the package's `exports` map — exact keys and
 * `./sub/*` patterns — to a file on disk, or to the source a compiled
 * target names. Null when the map does not export that subpath.
 */
function resolvePackageSubpath(pkgDir, sub) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')); } catch { return null; } // error-ok
  const map = pkg && pkg.exports;
  if (!map || typeof map !== 'object') return null;
  const key = `./${sub}`;
  let target = null;
  if (map[key] !== undefined) target = exportsTarget(map[key]);
  else {
    for (const [pattern, value] of Object.entries(map)) {
      const star = pattern.indexOf('*');
      if (star === -1) continue;
      const pre = pattern.slice(0, star); const post = pattern.slice(star + 1);
      if (key.startsWith(pre) && key.endsWith(post)) {
        const t = exportsTarget(value);
        if (t) { target = t.replace('*', key.slice(pre.length, key.length - post.length)); break; }
      }
    }
  }
  if (!target) return null;
  const abs = path.resolve(pkgDir, target);
  for (const cand of [abs, ...tsEquivalents(abs)]) {
    try { if (fs.statSync(cand).isFile()) return path.normalize(cand); } catch { /* error-ok — next spelling */ }
  }
  return compiledToSource(pkgDir, target);
}

/** Absolute base paths an aliased specifier maps to, or null when no alias applies. */
function resolveAlias(fromFile, importPath, projectRoot) {
  const root = path.resolve(projectRoot);
  let dir = path.dirname(path.resolve(fromFile));
  for (;;) {
    const aliases = loadPathAliases(dir);
    if (aliases) {
      for (const a of aliases) {
        if (a.wildcard ? importPath.startsWith(a.prefix) : importPath === a.prefix) {
          const rest = a.wildcard ? importPath.slice(a.prefix.length) : '';
          return a.targets.map((t) => (a.wildcard ? path.join(t, rest) : t));
        }
      }
    }
    if (dir === root || !dir.startsWith(root)) return null;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * TypeScript's NodeNext/ESM convention writes the OUTPUT extension in the
 * specifier: `import … from "./external.js"` resolves to `external.ts` on
 * disk. The spellings a `.js` / `.jsx` / `.mjs` / `.cjs` specifier may really
 * denote, in the order to try them. One table — the dead-code extractor and
 * the import graph both resolve through it (a 2026-09-05 measurement on the
 * nest monorepo: 1,128 files "unreachable" because the graph lacked it).
 */
const JS_TO_TS = { '.js': ['.ts', '.tsx', '.d.ts'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
function tsEquivalents(base) {
  const ext = path.extname(base);
  if (!JS_TO_TS[ext]) return [];
  const stem = base.slice(0, -ext.length);
  return JS_TO_TS[ext].map((e) => stem + e);
}

/**
 * A require or dynamic import whose specifier is BUILT rather than written:
 *
 *   require(path.join(__dirname, '..', 'lib', 'x.js'))
 *   require(path.resolve(ROOT, 'src', 'core', 'y'))   // const ROOT = path.resolve(__dirname, '..')
 *   import(path.join(process.cwd(), 'scripts', 'z.js'))
 *
 * Every segment is a string literal and the base is something the file can
 * name on its own — `__dirname`, `process.cwd()` (the project root under a
 * scan), or a const the same file derives from `__dirname` — so the target
 * is knowable without running the code. Each such call is rewritten to the
 * literal `require('./relative')` every reader already understands, padded
 * with the newlines the original spanned so line numbers survive. Anything
 * else (a variable segment, a base the file does not define) is left exactly
 * as written: a path we cannot resolve is not an edge, and guessing one
 * would invent a dependency.
 *
 * Both readers of "what does this file import" run their text through here
 * first — src/core/import-graph.js (edges, orphan files) and the dead-code
 * extractor (names). Measured 2026-09-13 on this repo: the ops script that
 * consumes mail-transport's `mailProvider` / `fromAddress`, the precision
 * script that consumes confidence-calibration, and two test files all
 * require through `path.join(__dirname, …)`; deadCode reported the exports
 * unused and the module shipped-but-unreachable.
 */
const COMPUTED_SPEC_RE = /\b(require|import)\s*\(\s*path\.(?:join|resolve)\s*\(\s*(__dirname|process\.cwd\(\)|[A-Za-z_$][\w$]*)((?:\s*,\s*(?:'[^'\\\n]*'|"[^"\\\n]*"))+)\s*\)\s*\)/g;
const DIRNAME_CONST_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.(?:join|resolve)\s*\(\s*__dirname((?:\s*,\s*(?:'[^'\\\n]*'|"[^"\\\n]*"))*)\s*\)/g;
const SEGMENT_RE = /'([^'\\\n]*)'|"([^"\\\n]*)"/g;

function literalSegments(list) {
  const out = [];
  SEGMENT_RE.lastIndex = 0;
  let m = SEGMENT_RE.exec(list);
  while (m !== null) { out.push(m[1] !== undefined ? m[1] : m[2]); m = SEGMENT_RE.exec(list); }
  return out;
}

/**
 * @param {string} text source of `fromFile`
 * @param {string} fromFile absolute path
 * @param {string} [projectRoot] what `process.cwd()` denotes under a scan
 * @returns {string} the same text, computed specifiers replaced by literals
 */
function inlineComputedRequires(text, fromFile, projectRoot) {
  if (!text.includes('path.')) return text;
  const dir = path.dirname(path.resolve(fromFile));
  const bases = new Map([['__dirname', dir]]);
  if (projectRoot) bases.set('process.cwd()', path.resolve(projectRoot));
  DIRNAME_CONST_RE.lastIndex = 0;
  let b = DIRNAME_CONST_RE.exec(text);
  while (b !== null) { bases.set(b[1], path.resolve(dir, ...literalSegments(b[2]))); b = DIRNAME_CONST_RE.exec(text); }
  return text.replace(COMPUTED_SPEC_RE, (whole, kw, base, segs) => {
    const root = bases.get(base);
    if (!root) return whole;
    let rel = path.relative(dir, path.resolve(root, ...literalSegments(segs))).split(path.sep).join('/');
    if (!/^\.\.?(?:\/|$)/.test(rel)) rel = `./${rel}`;
    const newlines = whole.match(/\n/g);
    return `${kw}('${rel}')${newlines ? newlines.join('') : ''}`;
  });
}

module.exports = { tsEquivalents, resolvePackageEntry, resolvePackageSubpath, compiledToSources, resolveAlias, stripJsoncLite, elisionMode, inlineComputedRequires };
