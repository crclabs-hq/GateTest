/**
 * AI Hallucination Detector — catches packages and APIs that don't exist.
 *
 * When AI coding assistants generate code they occasionally:
 *   1. Import npm packages that were never published or have been deleted.
 *   2. Call methods that don't exist on well-known APIs (fs.readAllFiles,
 *      Array.prototype.flatten on Node <11, etc.).
 *   3. Use non-existent named exports from popular packages.
 *   4. Reference APIs from the wrong library (calling OpenAI SDK methods
 *      on the Anthropic client).
 *
 * Detection:
 *   - Cross-reference every package import against package.json
 *     dependencies + devDependencies. Unknown packages = error. The imports
 *     come from the one import graph (src/core/import-graph.js `externals`):
 *     the same statements, the same masked text and the same alias /
 *     workspace resolution that importCycle and deadCode read — this module
 *     no longer keeps its own harvester or its own tsconfig `paths` reader.
 *   - Scan for known-hallucinated method shapes on popular library objects.
 *   - AI engine (Claude) analyses the diff for invented API calls when
 *     ANTHROPIC_API_KEY is set.
 *
 * Suppression: `// hallucination-ok` on the import line skips that import.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const { workspacePackageNames } = require('../core/workspaces');
const { buildImportGraph } = require('../core/import-graph');
const BaseModule    = require('./base-module');
const { makeAutoFix } = require('../core/ai-fix-engine');

// ─── known-hallucinated method patterns ───────────────────────────────────

const HALLUCINATED_METHODS = [
  // Node built-ins that never existed
  { re: /\bfs\.readAllFiles\b/,            msg: '`fs.readAllFiles` does not exist — use `fs.readdirSync` + `fs.readFileSync`' },
  { re: /\bfs\.readDirectory\b/,           msg: '`fs.readDirectory` does not exist — use `fs.readdirSync`' },
  { re: /\bfs\.writeAll\b/,                msg: '`fs.writeAll` does not exist — use `fs.writeFileSync`' },
  { re: /\bpath\.combine\b/,               msg: '`path.combine` does not exist — use `path.join`' },
  { re: /\bArray\.flatten\b/,              msg: '`Array.flatten` does not exist — use `Array.prototype.flat()`' },
  { re: /\bObject\.entries\(.*\)\.toMap\b/,msg: '`Object.entries().toMap` does not exist — convert manually' },
  { re: /\bString\.prototype\.replaceAll\b.*Node\s*(?:[0-9]|1[0-4])\b/, msg: '`replaceAll` requires Node 15+' },
  // Express invented methods
  { re: /\bapp\.middleware\s*\(/,           msg: '`app.middleware()` does not exist — use `app.use()`' },
  { re: /\bres\.sendStatus\s*\(\s*(?!1\d\d|2\d\d|3\d\d|4\d\d|5\d\d)/, msg: 'Suspicious `res.sendStatus()` — should be a 3-digit HTTP status code' },
  // React invented hooks
  { re: /\buseServerState\s*\(/,            msg: '`useServerState` is not a real React hook' },
  { re: /\buseServerSideProps\s*\(/,        msg: '`useServerSideProps` is not a real hook — use Next.js `getServerSideProps` or server components' },
  // Prisma invented methods
  { re: /\bprisma\.\w+\.findByPk\b/,       msg: '`findByPk` is a Sequelize method — Prisma uses `findUnique`' },
  { re: /\bprisma\.\w+\.bulkCreate\b/,     msg: '`bulkCreate` is Sequelize — Prisma uses `createMany`' },
  { re: /\bprisma\.\w+\.findOrCreate\b/,   msg: '`findOrCreate` is Sequelize — Prisma uses `upsert`' },
  // Anthropic / OpenAI cross-contamination
  { re: /anthropic\.chat\.completions/,     msg: '`chat.completions` is OpenAI SDK API — Anthropic uses `anthropic.messages.create()`' },
  { re: /openai\.messages\.create/,         msg: '`messages.create` is Anthropic SDK API — OpenAI uses `openai.chat.completions.create()`' },
  // Mongoose invented methods
  { re: /\.\s*findOneAndUpsert\s*\(/,       msg: '`findOneAndUpsert` does not exist — use `findOneAndUpdate` with `{upsert:true}`' },
  // Next.js invented exports
  { re: /export\s+(?:const|function)\s+getInitialProps\b/, msg: '`getInitialProps` must be a static method on the component class, not a named export' },
];

// ─── package-shaped prefixes that are conventionally local ───────────────────
// A tsconfig / jsconfig `paths` alias that RESOLVES is already excluded by the
// graph (`via: 'alias'`), and `@/`, `~/`, `#/`, `$app/` are not package-shaped
// so never reach here. These are the scoped-looking conventions a project may
// use without declaring them anywhere the resolver can read (a bundler alias
// in webpack.config.js, a Vite `resolve.alias`).
const PATH_ALIAS_PREFIXES = [
  '@components/', '@utils/', '@hooks/', '@store/', '@types/', '@assets/',
  '@pages/', '@layouts/', '@lib/',
];

function isPathAlias(specifier) {
  return PATH_ALIAS_PREFIXES.some(p => specifier.startsWith(p));
}

// ─── common stdlib / well-known builtins (never flag these as unknown) ─────

const BUILT_IN_MODULES = new Set([
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns',
  'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'inspector', 'inspector/promises', 'module', 'net', 'os', 'path',
  'path/posix', 'path/win32', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'readline/promises', 'repl', 'sea', 'sqlite',
  'stream', 'stream/consumers', 'stream/promises', 'stream/web',
  'string_decoder', 'sys', 'test', 'test/reporters', 'timers',
  'timers/promises', 'tls', 'trace_events', 'tty', 'url',
  'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
  // Bun
  'bun', 'bun:sqlite', 'bun:ffi', 'bun:test',
  // Deno
  'deno',
  // Virtual / framework conventions
  'next/server', 'next/navigation', 'next/headers', 'next/image',
  'next/link', 'next/font/google', 'react', 'react/jsx-runtime',
  'react-dom', 'react-dom/client', 'react-dom/server',
  // Webpack / Vite virtual
  '$env/static/public', '$app/environment', '$app/stores',
  // VS Code extension host — injected at runtime, never an npm dependency
  'vscode',
]);

// `node:`-prefixed specifiers (e.g. `node:fs`, `node:test`) are the modern,
// explicit way to import a Node built-in — functionally identical to the
// bare form. BUILT_IN_MODULES lists bare names only; strip the prefix
// before checking so both forms resolve the same way.
function stripNodePrefix(specifier) {
  return specifier.startsWith('node:') ? specifier.slice(5) : specifier;
}

// bare package name (first path segment, strip @scope)
function barePackage(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.slice(0, 2).join('/');
  }
  return specifier.split('/')[0];
}

// The DefinitelyTyped package that types `pkg`: `@types/pkg`, or
// `@types/scope__name` for a scoped package. A type-only import of `pkg` is
// satisfied by either — the emitted JS never loads `pkg` at all (trpc's
// `import type { … } from 'aws-lambda'` next to `@types/aws-lambda`).
function typesPackage(pkg) {
  return pkg.startsWith('@') ? `@types/${pkg.slice(1).replace('/', '__')}` : `@types/${pkg}`;
}

// Virtual modules a framework provides at build time under its own scope.
// `@docusaurus/Link` is not on npm; declaring `@docusaurus/core` is what
// makes it resolvable (module-type-aliases). Keyed by the specifier prefix,
// valued by the package whose presence in the manifest provides it.
const PROVIDED_BY = [
  ['@docusaurus/', '@docusaurus/core'],
];
function providedBy(specifier, knownDeps) {
  return PROVIDED_BY.some(([prefix, provider]) => specifier.startsWith(prefix) && knownDeps.has(provider));
}

// ─── module ────────────────────────────────────────────────────────────────

/** Dependency names declared by one package.json. null when there is no file. */
function readPkgDeps(pkgPath) {
  let raw;
  try {
    raw = fs.readFileSync(pkgPath, 'utf-8');
  } catch {
    return null; // no manifest here — not an error
  }
  const names = new Set();
  try {
    const pkg = JSON.parse(raw);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const key of Object.keys(pkg[field] || {})) names.add(key);
    }
    // A workspace package can import itself by name (`@acme/ui` -> its own root).
    if (typeof pkg.name === 'string' && pkg.name) names.add(pkg.name);
  } catch {
    return null; // malformed manifest — treat as absent rather than guessing
  }
  return names;
}


/**
 * Is `name` a whole path SEGMENT of `rel`? `rel.includes('node_modules')`
 * is a substring test — it also matches a directory merely CONTAINING the
 * word. Same mistake as `.includes('.git')` matching `.github`.
 */
function hasSegment(rel, name) {
  return typeof rel === 'string' && rel.split(/[\\/]+/).includes(name);
}

/**
 * Is the import on masked line `lineIdx` GUARDED — a `require()` inside a
 * `try` block, or a dynamic `import()` with `.catch(` on the same line?
 * That is the optional-dependency idiom: the author expects the package to
 * be absent and handles it (`try { ts = require('typescript') } catch {
 * return 'typescript-unavailable' }`, src/core/direct-repair.js:514; every
 * Playwright module in src/modules loads the browser the same way). An
 * undeclared package there is still worth telling the customer — installs
 * cannot know about it — but it is not a hallucination, and it is not a
 * missing install: it is a peer the manifest should name as optional.
 *
 * Walks up from the import counting braces on the masked lines; the first
 * unmatched `{` whose line ends in `try` is the guard. Stops at 80 lines.
 */
function isGuardedImport(maskedLines, lineIdx) {
  const own = maskedLines[lineIdx] || '';
  if (/\btry\s*\{/.test(own) || /\bimport\s*\([^)]*\)\s*\.catch\s*\(/.test(own)) return true;
  let depth = 0;
  for (let k = lineIdx - 1; k >= 0 && k >= lineIdx - 80; k -= 1) {
    const l = maskedLines[k] || '';
    for (let c = l.length - 1; c >= 0; c -= 1) {
      if (l[c] === '}') depth += 1;
      else if (l[c] === '{') {
        if (depth > 0) { depth -= 1; continue; }
        if (/\btry\s*$/.test(l.slice(0, c))) return true;
      }
    }
  }
  return false;
}

class AiHallucinationDetector extends BaseModule {
  constructor() {
    super('aiHallucination', 'AI Hallucination Detector — fake imports, invented APIs, non-existent methods');
  }

  /**
   * Dependencies visible to a file, by its directory: the nearest package.json
   * plus every manifest between it and the project root, unioned.
   *
   * Before this existed, dependency resolution walked only UP from projectRoot,
   * so a manifest BELOW the root was invisible. Any nested package — a monorepo
   * workspace, a test fixture, an examples/ directory with its own deps — had
   * every one of its imports reported as a possible hallucination. On this repo
   * that was ~100 of 136 warnings (`playwright`, `express`, `openai`, `helmet`
   * under benchmarks/bench-target/), and for a customer with a monorepo it means
   * false positives across every workspace, which is the fastest way to teach
   * someone to ignore a scanner.
   *
   * Ancestors are unioned rather than shadowed on purpose: npm and pnpm hoist,
   * so a workspace package legitimately resolves the root's dependencies too.
   * Reporting a hoisted import as missing would just trade one false positive
   * class for another.
   *
   * Memoised per directory, and directories without a manifest SHARE the parent's
   * Set rather than copying it — otherwise this is O(files x depth) allocations
   * on a large monorepo, which is the cost that made this "more invasive" to
   * begin with.
   */
  _depsForDir(dir, projectRoot, cache, rootDeps) {
    const cached = cache.get(dir);
    if (cached) return cached;

    const parent = path.dirname(dir);
    const atOrAboveRoot = dir === projectRoot || parent === dir || dir.length <= projectRoot.length;
    const inherited = atOrAboveRoot
      ? rootDeps
      : this._depsForDir(parent, projectRoot, cache, rootDeps);

    const own = readPkgDeps(path.join(dir, 'package.json'));
    // No manifest here → same visibility as the parent. Share the object.
    const set = own === null ? inherited : new Set([...inherited, ...own]);

    cache.set(dir, set);
    return set;
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // Load known dependencies — check local package.json AND walk up to find
    // root workspace package.json (monorepos install deps at root, not per-package)
    const rootDeps = new Set();
    const pkgRoots = [projectRoot];
    // Walk up to find workspace root (stop at fs root or after 4 levels)
    let cur = projectRoot;
    for (let i = 0; i < 4; i++) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      if (fs.existsSync(path.join(parent, 'package.json'))) pkgRoots.push(parent);
      cur = parent;
    }
    for (const root of pkgRoots) {
      const pkgPath = path.join(root, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        for (const key of Object.keys(pkg.dependencies || {})) rootDeps.add(key);
        for (const key of Object.keys(pkg.devDependencies || {})) rootDeps.add(key);
        for (const key of Object.keys(pkg.peerDependencies || {})) rootDeps.add(key);
        for (const key of Object.keys(pkg.optionalDependencies || {})) rootDeps.add(key);
      } catch { /* skip */ }
    }

    // Also scan workspaces / monorepo packages
    const workspaceNames = this._collectWorkspaceNames(projectRoot);

    const extensions = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];
    const files = this._collectFiles(projectRoot, extensions);

    let issueCount = 0;

    // dir -> deps visible from it. Populated lazily by _depsForDir.
    const depsCache = new Map();

    // 1. Unknown package imports — read from the one import graph. A
    // specifier that resolved to a workspace package or through a declared
    // alias is a real file in this repo, not a package to look up; what is
    // left is what the resolver could not place. The graph reads the masked
    // source (src/core/source-strip.js), so an import inside a comment or a
    // fixture string never reaches here. (History: this module had NO string
    // guard — one of the unguarded modules KI #77 recorded — and fixture
    // strings alone produced 47 findings on this repo; the column guard that
    // replaced it missed trailing comments; the masked-text harvester that
    // replaced THAT was a second copy of the graph's, with its own alias
    // reader, and could not see `export … from 'pkg'`.)
    // The file set stays this module's (`_collectFiles`, Doctrine §4: which
    // files a module sees has one home); the graph answers what each imports.
    // A file the module sees but the graph never read — its walker skips
    // dot-directories, and a file over its size cap — is NOT CHECKED, and
    // the summary says so rather than passing it in silence.
    const graph = buildImportGraph({ projectRoot });
    const notRead = [];
    for (const file of files) {
      const rel = repoRelative(projectRoot, file);
      if (hasSegment(rel, 'node_modules') || hasSegment(rel, '.next')) continue;
      const specs = graph.externals.get(file);
      if (!specs || graph.skipped.has(file)) { notRead.push(rel); continue; }
      if (specs.size === 0) continue;

      // Nearest-manifest resolution, so a nested package's own dependencies count.
      const knownDeps = this._depsForDir(path.dirname(file), projectRoot, depsCache, rootDeps);
      let lines = null;
      let maskedLines = null;

      for (const [specifier, { line: lineNo, via, typeOnly }] of specs) {
        if (via !== 'unresolved') continue;
        if (isPathAlias(specifier)) continue;
        const pkg = barePackage(specifier);
        if (BUILT_IN_MODULES.has(stripNodePrefix(pkg)) || BUILT_IN_MODULES.has(stripNodePrefix(specifier))) continue;
        if (knownDeps.has(pkg)) continue;
        if (workspaceNames.has(pkg)) continue;
        if (providedBy(specifier, knownDeps)) continue;
        // Type-only imports are erased at compile time: `@types/pkg` satisfies
        // them, and an undeclared one is a warning for the reader, not a
        // missing install.
        const isTypeOnly = typeOnly === true;
        if (isTypeOnly && knownDeps.has(typesPackage(pkg))) continue;

        if (!lines) {
          let content = '';
          try { content = fs.readFileSync(file, 'utf-8'); } catch { content = ''; }
          lines = content.split(/\r?\n/);
          maskedLines = this._maskedLines(content, rel);
        }
        const lineText = lines[lineNo - 1] || '';
        if (lineText.includes('// hallucination-ok')) continue;
        const guarded = isGuardedImport(maskedLines, lineNo - 1);

        issueCount++;
        result.addCheck(`ai-hallucination:unknown-pkg:${rel}:${pkg}`, false, {
          severity: isTypeOnly || guarded ? 'info' : 'warning',
          message: guarded
            ? `Import of \`${pkg}\` is guarded (loaded inside try/catch) but declared in no package.json up to the project root — an optional dependency installs cannot see; name it under optionalDependencies or peerDependencies (peerDependenciesMeta optional)`
            : `Import of \`${pkg}\` not found in package.json (checked the nearest manifest and every one up to the project root) — possible AI hallucination or missing install`,
          file: rel,
          line: lineNo,
          guarded,
          fix: guarded
            ? `Declare \`${pkg}\` as an optional peer/optionalDependency so installs and SBOMs know about it.`
            : `Run \`npm install ${pkg}\` if the package is real, or remove the import if it was hallucinated.`,
          autoFix: makeAutoFix(
            file,
            'ai-hallucination:unknown-pkg',
            `Package "${pkg}" is not in package.json`,
            lineNo,
            `Either run npm install ${pkg} or remove this import if it was AI-hallucinated`
          ),
        });
      }
    }

    // 2. Known-hallucinated method patterns — matched on the MASKED source
    // (src/core/source-strip.js), so a comment naming `fs.readAllFiles`, a
    // fixture string in a test, or this module's own pattern table (regex
    // literals) cannot fire. Self-scan 2026-09-13: 10 of 11 `method`
    // findings were this file's HALLUCINATED_METHODS and its doc comment,
    // the 11th a test fixture string — the self-reference class KI #43
    // recorded for other modules.
    for (const file of files) {
      const rel = repoRelative(projectRoot, file);
      if (hasSegment(rel, 'node_modules') || hasSegment(rel, '.next')) continue;
      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const lines = content.split(/\r?\n/);
      const masked = this._maskedLines(content, rel).join('\n');

      for (const { re, msg } of HALLUCINATED_METHODS) {
        re.lastIndex = 0;
        let m;
        const reGlobal = new RegExp(re.source, (re.flags.includes('g') ? re.flags : re.flags + 'g'));
        while ((m = reGlobal.exec(masked)) !== null) {
          const lineNo   = masked.slice(0, m.index).split(/\r?\n/).length;
          const lineText = lines[lineNo - 1] || '';
          if (lineText.includes('// hallucination-ok')) continue;

          issueCount++;
          result.addCheck(`ai-hallucination:method:${rel}:L${lineNo}`, false, {
            severity: 'warning',
            message: `${msg} (${rel}:${lineNo})`,
            file: rel,
            line: lineNo,
            fix: msg,
            autoFix: makeAutoFix(file, 'ai-hallucination:method', msg, lineNo, msg),
          });
        }
      }
    }

    if (notRead.length > 0) {
      const shown = notRead.slice(0, 5).join(', ');
      result.addCheck('ai-hallucination:not-checked', true, {
        severity: 'info',
        message: `${notRead.length} file(s) the import graph did not read (under a dot-directory, or over its 2 MB cap) — their package imports were NOT checked: ${shown}${notRead.length > 5 ? ', …' : ''}`,
        notChecked: notRead,
      });
    }

    if (issueCount === 0) {
      result.addCheck('ai-hallucination:clean', true, {
        severity: 'info',
        message: notRead.length === 0
          ? 'No hallucinated imports or invented API calls detected'
          : `No hallucinated imports or invented API calls detected in the ${files.length - notRead.length} file(s) read (${notRead.length} not checked)`,
      });
    }
  }

  _collectWorkspaceNames(projectRoot) {
    // Every declared workspace member, not just apps/packages/libs/services
    // (trpc keeps members under examples/* and www; prisma under test/**).
    // One reader: src/core/workspaces.js.
    return workspacePackageNames(projectRoot);
  }
}

module.exports = AiHallucinationDetector;
