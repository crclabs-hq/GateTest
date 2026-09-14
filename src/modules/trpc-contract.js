/**
 * tRPC Contract Drift Detector — procedure definitions vs call sites.
 *
 * In tRPC projects the router defines procedures (`.query`, `.mutation`,
 * `.subscription`). The frontend calls them via the tRPC client. If a
 * procedure is renamed, removed, or its path changes in the router, the
 * frontend call silently fails at runtime.
 *
 * This module:
 *   1. Harvests procedure paths from router definition files.
 *   2. Harvests procedure call sites from client files.
 *   3. Flags calls to procedures that don't exist in any router.
 *   4. Flags procedures defined in routers that are never called (dead
 *      procedures — informational, since they may be called from outside).
 *
 * Router patterns (the object body is read with balanced braces — until
 * 2026-09-05 it was `[^}]{0,2000}`, which stopped at the first `}` of the
 * first procedure's function body, so only the leading key of every real
 * router was ever harvested; the tRPC monorepo itself produced 62 errors):
 *   - `router({ foo: procedure.query(...) })` → "foo"
 *   - `t.router({ bar: t.procedure.mutation(...) })` → "bar"
 *   - `createTRPCRouter({ baz: ... })` → "baz"
 *   - Inline nested: `admin: router({ secret })`, `examples: { iterable }`
 *     → "admin.secret", "examples.iterable" (and "admin", "examples" as
 *     namespaces)
 *   - Merged: `posts: postsRouter`, shorthand `{ router01 }` → namespace.
 *     When `const postsRouter = router({…})` is somewhere in the tree its
 *     members are copied under `posts.` and the namespace is closed;
 *     otherwise (defined in a package we cannot see) any child is accepted
 *   - `...spread` → the namespace is open; nothing under it can be judged
 *
 * Routers are harvested from EVERY non-test file. The old path guess
 * (`router` / `trpc` / `api/` / `server/` in the path) dropped
 * `examples/soa/faux-gateway/index.ts`, whose router defined every
 * procedure the client called.
 *
 * Call site patterns:
 *   - `trpc.foo.useQuery()`
 *   - `trpc.bar.useMutation()`
 *   - `api.foo.bar.useQuery()`
 *   - `client.foo.bar.query()`
 *   - `trpc.foo.bar.useInfiniteQuery()`
 * `trpc` is unambiguous. `api` and `client` are not: they must be a
 * binding this file imports, or creates with `createTRPC*(` / `useTRPC(`.
 * A destructured `const { client } = opts` in `@trpc/client`'s own
 * wsLink.ts is a WebSocket connection, and `client.connectionState
 * .subscribe(` on it was an error-severity finding.
 *
 * A call site on a comment line (a JSDoc usage example) is prose, not a
 * call. Test paths are skipped on both sides: a test that calls `not.found` to
 * assert "No procedure found" is correct code, and the rule is about the
 * frontend call sites that fail silently.
 *
 * Three-state: when the workspace member containing a call site
 * `.gitignore`s its router directory (generated at install — the
 * `next-big-router` example runs `tsx scripts/codegen` on postinstall),
 * the definitions are not in the tree and its call sites are reported as
 * NOT CHECKED, never as missing.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const BaseModule    = require('./base-module');
const { makeAutoFix } = require('../core/ai-fix-engine');
const { listWorkspacePackages, manifestDeclares, nearestWorkspacePackage } = require('../core/workspaces');

// ─── patterns ─────────────────────────────────────────────────────────────

// Router definition opener: router({ / t.router({ / createTRPCRouter({
const ROUTER_OPEN_RE = /\b(?:createTRPCRouter|t\.router|router)\s*\(\s*\{/g;

// Call site: trpc.foo.useQuery / api.foo.bar.useMutation / client.foo.query
const CALL_SITE_RE = /\b(trpc|api|client)\s*\.\s*([a-zA-Z_$][a-zA-Z0-9_$.]*?)\s*\.\s*(?:useQuery|useMutation|useInfiniteQuery|query|mutate|mutateAsync|subscribe|fetch)\s*\(/g;

const IDENT = '[a-zA-Z_$][a-zA-Z0-9_$]*';
const IDENT_RE = new RegExp(`^${IDENT}$`);
// Identifier-only value, e.g. `posts: postsRouter` (a router defined elsewhere).
const VALUE_IDENT_RE = new RegExp(`^(${IDENT})\\s*(?:,|$)`);
// Value that is itself a router object literal.
const VALUE_ROUTER_RE = /^(?:createTRPCRouter|t\.router|router)\s*\(\s*\{/;
// What a character before `/` must be for `/` to begin a regex literal.
const REGEX_PRECEDER_RE = /[(,=:[!&|?{};]$|^$/;

const KEYWORDS = new Set(['default', 'type', 'interface', 'return', 'const', 'let', 'var', 'import', 'export']);

// ─── source walking ────────────────────────────────────────────────────────

/** Index just past the closing quote of the string starting at `i`, or -1. */
function skipString(content, i) {
  const q = content[i];
  i++;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === q) return i + 1;
    if (q === '`' && ch === '$' && content[i + 1] === '{') {
      const end = findClosingBrace(content, i + 1);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (q !== '`' && ch === '\n') return -1; // unterminated
    i++;
  }
  return -1;
}

/** Index just past the closing `/` of the regex literal starting at `i`, or -1. */
function skipRegex(content, i) {
  let inClass = false;
  i++;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '\n') return -1;
    if (inClass) { if (ch === ']') inClass = false; }
    else if (ch === '[') inClass = true;
    else if (ch === '/') return i + 1;
    i++;
  }
  return -1;
}

/**
 * Index just past the `}` matching the `{` at `openIdx`, skipping strings,
 * template literals (with nested `${}`), comments and regex literals.
 */
function findClosingBrace(content, openIdx) {
  let depth = 0;
  let i = openIdx;
  let lastCode = '';
  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === '/' && next === '/') { i = content.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (ch === '/' && next === '*') { i = content.indexOf('*/', i + 2); if (i < 0) return -1; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(content, i); if (i < 0) return -1; lastCode = ch; continue; }
    if (ch === '/' && REGEX_PRECEDER_RE.test(lastCode)) { i = skipRegex(content, i); if (i < 0) return -1; lastCode = '/'; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i + 1; }
    if (!/\s/.test(ch)) lastCode = ch;
    i++;
  }
  return -1;
}

/**
 * Split the object body between `open` (`{`) and `close` (just past `}`)
 * into its depth-0 entries: `[{ start, end }]` slices of `content`.
 */
function topLevelEntries(content, open, close) {
  const entries = [];
  let i = open + 1;
  let start = i;
  let depth = 0;
  let lastCode = '';
  const push = (end) => { if (content.slice(start, end).trim()) entries.push({ start, end }); };
  while (i < close - 1) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === '/' && next === '/') { i = content.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && next === '*') { i = content.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { const e = skipString(content, i); if (e < 0) break; i = e; lastCode = ch; continue; }
    if (ch === '/' && REGEX_PRECEDER_RE.test(lastCode)) { const e = skipRegex(content, i); if (e < 0) break; i = e; lastCode = '/'; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { push(i); start = i + 1; }
    if (!/\s/.test(ch)) lastCode = ch;
    i++;
  }
  push(close - 1);
  return entries;
}

/** Leading comments and whitespace stripped from an entry. */
function stripLeadingTrivia(text) {
  let t = text;
  for (;;) {
    const before = t;
    t = t.replace(/^\s+/, '').replace(/^\/\/[^\n]*\n?/, '').replace(/^\/\*[\s\S]*?\*\//, '');
    if (t === before) return t;
  }
}

/**
 * Harvest the procedures and namespaces of one router object literal
 * (`open` at its `{`) into `defs`, prefixed by `prefix` for nested
 * routers. A spread entry marks the prefix as open (`spread: true`).
 */
function harvestRouterBody(content, open, prefix, defs, loc) {
  const close = findClosingBrace(content, open);
  if (close < 0) return;
  for (const { start, end } of topLevelEntries(content, open, close)) {
    const raw = stripLeadingTrivia(content.slice(start, end));
    const lineNo = content.slice(0, end - raw.length).split(/\r?\n/).length;
    if (raw.startsWith('...')) { defs.set(prefix || '*', { ...loc, line: lineNo, isNamespace: true, spread: true }); continue; }
    if (raw.startsWith('[')) continue; // computed key — cannot be named statically
    const keyMatch = raw.match(new RegExp(`^(?:(${IDENT})|'([^']+)'|"([^"]+)")\\s*(:|,|\\(|$)`));
    if (!keyMatch) continue;
    const key = keyMatch[1] || keyMatch[2] || keyMatch[3];
    if (KEYWORDS.has(key) || (keyMatch[2] || keyMatch[3]) && !IDENT_RE.test(key)) continue;
    const full = prefix ? `${prefix}.${key}` : key;
    const sep = keyMatch[4];
    if (sep === '(') continue; // method shorthand — not a procedure
    if (sep !== ':') { defs.set(full, { ...loc, line: lineNo, isNamespace: true }); continue; } // `{ router01 }`
    const value = raw.slice(keyMatch[0].length).trimStart();
    const valueStart = end - value.length;
    if (value.startsWith('{')) {
      // inline nested object: every member is right here, so the namespace is closed
      defs.set(full, { ...loc, line: lineNo, isNamespace: true, closed: true });
      harvestRouterBody(content, valueStart, full, defs, loc);
    } else if (VALUE_ROUTER_RE.test(value)) {
      defs.set(full, { ...loc, line: lineNo, isNamespace: true, closed: true });
      harvestRouterBody(content, valueStart + value.indexOf('{'), full, defs, loc);
    } else if (VALUE_IDENT_RE.test(value)) {
      defs.set(full, { ...loc, line: lineNo, isNamespace: true, aliasOf: value.match(VALUE_IDENT_RE)[1] });
    } else {
      defs.set(full, { ...loc, line: lineNo });
    }
  }
}

const ROUTER_NAME_RE = new RegExp(`(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]*)?=\\s*$`);

/**
 * Every `router({…})` in `content`, harvested into `defs` (every router's
 * top-level keys land at the root — which one is the app router is not
 * knowable statically, so the merge is lenient). A router assigned to a
 * variable is also kept by name in `named` (the union of every router with
 * that name in the tree) so `key: thatVariable` can be resolved to its
 * members.
 */
function harvestRouters(content, defs, named, loc) {
  ROUTER_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = ROUTER_OPEN_RE.exec(content)) !== null) {
    const local = new Map();
    harvestRouterBody(content, m.index + m[0].length - 1, '', local, loc);
    const nameMatch = content.slice(Math.max(0, m.index - 120), m.index).match(ROUTER_NAME_RE);
    if (nameMatch) {
      // Union across the tree: a monorepo of examples defines a `postRouter`
      // per example, and `post: postRouter` must accept the members of every
      // one of them, never just the last file walked.
      const union = named.get(nameMatch[1]) || new Map();
      for (const [k, v] of local) if (!union.has(k)) union.set(k, v);
      named.set(nameMatch[1], union);
    }
    for (const [k, v] of local) if (!defs.has(k)) defs.set(k, v);
  }
}

/**
 * `posts: postsRouter` → the members of `postsRouter` under `posts.`, and
 * the namespace closed. Bounded rounds: aliases inside copied routers
 * resolve on the next pass; a self-referential alias cannot run away.
 */
function resolveAliases(defs, named) {
  for (let round = 0; round < 5; round++) {
    let changed = false;
    for (const [key, def] of [...defs]) {
      if (!def.aliasOf || def.closed || !named.has(def.aliasOf)) continue;
      defs.set(key, { ...def, closed: true });
      for (const [sub, subDef] of named.get(def.aliasOf)) {
        const full = sub === '*' ? `${key}.*` : `${key}.${sub}`;
        if (!defs.has(full)) defs.set(full, subDef);
      }
      changed = true;
    }
    if (!changed) return;
  }
}

/** `trpc` always; `api` / `client` only when this file imports the binding or creates it from a tRPC factory / hook. */
function bindingIsTrpcClient(content, name) {
  if (name === 'trpc') return true;
  const imported = new RegExp(`import\\s+(?:type\\s+)?(?:[^;]*?\\b${name}\\b[^;]*?)\\s+from\\s+['"]`);
  const created  = new RegExp(`\\b${name}\\s*(?::[^=]+)?=\\s*(?:await\\s+)?(?:create\\w*TRPC\\w*|use\\w*TRPC\\w*)\\s*[<(]`);
  return imported.test(content) || created.test(content);
}

/**
 * Is `procPath` defined — exactly, or under an ancestor we cannot see into
 * (an open namespace, a spread, a procedure used as a prefix)? A closed
 * namespace (an alias whose router is in the tree) answers for its
 * children: `serverA.greeet` is undefined when `serverA_appRouter` only
 * has `greet`.
 */
function isDefined(defs, procPath) {
  if (defs.has('*') || defs.has(procPath)) return true;
  const parts = procPath.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('.');
    if (defs.has(`${prefix}.*`)) return true;
    const d = defs.get(prefix);
    if (!d) continue;
    return !d.closed;
  }
  return false;
}

/**
 * Does `.gitignore` in `dir` ignore a path with a `router`/`routers`/`trpc`
 * segment? Then the router definitions are generated and not in the tree.
 * Returns the ignore line, or null.
 */
function ignoredRouterDir(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8'); } catch { return null; } // error-ok — no .gitignore: nothing generated is hidden
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const segs = line.replace(/\\/g, '/').split('/').filter((s) => s && s !== '*' && s !== '**');
    if (segs.some((s) => /^(?:routers?|trpc)$/i.test(s))) return line;
  }
  return null;
}

// ─── module ────────────────────────────────────────────────────────────────


/**
 * Is `name` a whole path SEGMENT of `rel`? `rel.includes('node_modules')`
 * is a substring test — it also matches a directory merely CONTAINING the
 * word. Same mistake as `.includes('.git')` matching `.github`.
 */
function hasSegment(rel, name) {
  return typeof rel === 'string' && rel.split(/[\\/]+/).includes(name);
}

// ─── is tRPC present anywhere in the workspace? ───────────────────────────
//
// KI #106: the gate read only the ROOT package.json. In a workspace the
// dependency lives in the member that uses it (the tRPC monorepo itself:
// `packages/*`, `examples/*`, `www` — its root never lists `@trpc/*`), so
// the module reported "not installed" over the one repository that is
// nothing but tRPC. Root OR any declared workspace member now counts; the
// scan itself stays repo-wide because routers and their call sites live
// in different members.

/** `trpc`, `@trpc/server`, `trpc-openapi`, `nestjs-trpc` — a `trpc` token, not a substring. */
const TRPC_PKG_RE = /(?:^|[@/.-])trpc(?:$|[/.-])/;

class TRPCContractDrift extends BaseModule {
  constructor() {
    super('trpcContract', 'tRPC Contract Drift — procedure definitions vs frontend call sites');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const members = listWorkspacePackages(projectRoot);
    const hasTRPC = manifestDeclares(projectRoot, TRPC_PKG_RE) || members.some((m) => manifestDeclares(m.dir, TRPC_PKG_RE));

    if (!hasTRPC) {
      result.addCheck('trpc-contract:not-installed', true, {
        severity: 'info',
        message: 'tRPC not found in dependencies (root or any workspace member) — contract drift check skipped',
      });
      return;
    }

    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];
    const files      = this._collectFiles(projectRoot, extensions);

    // { 'foo.bar' → { file, line, isNamespace?, spread? } }
    const definedProcedures = new Map();
    // { 'foo.bar' → [{ file, line }] }
    const calledProcedures  = new Map();
    // router variable name → its harvested members
    const namedRouters      = new Map();
    // member rel (or '' for root) → the .gitignore line hiding its routers
    const notChecked = new Map();
    const generatedCache = new Map();

    for (const file of files) {
      const rel = repoRelative(projectRoot, file);
      if (hasSegment(rel, 'node_modules') || hasSegment(rel, '.next')) continue;
      if (this._isTestPath(rel)) continue;

      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      harvestRouters(content, definedProcedures, namedRouters, { file: rel, absFile: file });

      // A file only holds call sites if one of the client objects is present.
      CALL_SITE_RE.lastIndex = 0;
      let cm;
      const lines = content.split(/\r?\n/);
      while ((cm = CALL_SITE_RE.exec(content)) !== null) {
        const [, obj, path_parts] = cm;
        if (!bindingIsTrpcClient(content, obj)) continue;
        const lineNo   = content.slice(0, cm.index).split(/\r?\n/).length;
        const lineText = lines[lineNo - 1] || '';
        if (lineText.includes('// trpc-ok')) continue;
        // A usage example in a JSDoc block is prose about a call, not a call
        // (`@trpc/react-query`'s rsc.tsx documents `trpc.post.get.useQuery`).
        if (this._isCommentLine(lineText)) continue;

        // Generated routers (gitignored) — the contract is not in the tree.
        const member = nearestWorkspacePackage(members, rel.split(path.sep).join('/'));
        const scopeKey = member ? member.rel : '';
        if (!generatedCache.has(scopeKey)) generatedCache.set(scopeKey, ignoredRouterDir(member ? member.dir : projectRoot));
        const ignoreLine = generatedCache.get(scopeKey);
        if (ignoreLine) { notChecked.set(scopeKey, ignoreLine); continue; }

        if (!calledProcedures.has(path_parts)) calledProcedures.set(path_parts, []);
        calledProcedures.get(path_parts).push({ file: rel, absFile: file, line: lineNo });
      }
    }

    for (const [scope, ignoreLine] of notChecked) {
      result.addCheck(`trpc-contract:not-checked:${scope || '.'}`, true, {
        severity: 'info',
        message: `NOT CHECKED: tRPC call sites in \`${scope || '.'}\` — its .gitignore hides the router directory (\`${ignoreLine}\`), so the procedure definitions are generated and not in the tree`,
      });
    }

    resolveAliases(definedProcedures, namedRouters);

    if (definedProcedures.size === 0) {
      result.addCheck('trpc-contract:no-routers', true, {
        severity: 'info',
        message: 'No tRPC router definitions found — drift check skipped',
      });
      return;
    }

    let issueCount = 0;

    // Calls to undefined procedures
    for (const [procPath, callSites] of calledProcedures) {
      if (isDefined(definedProcedures, procPath)) continue;
      const topLevel = procPath.split('.')[0];
      const primary = callSites[0];
      const candidates = [...definedProcedures.keys()]
        .filter(k => k !== '*' && k.toLowerCase().includes(topLevel.toLowerCase().slice(0, 3)))
        .slice(0, 3);

      issueCount++;
      result.addCheck(`trpc-contract:undefined-call:${procPath}`, false, {
        severity: 'error',
        message: `tRPC call to \`${procPath}\` has no matching router procedure. Called from: ${callSites.map(c => `${c.file}:${c.line}`).join(', ')}${candidates.length ? `. Similar procedures: ${candidates.join(', ')}` : ''}`,
        file: primary.file,
        line: primary.line,
        fix: `Define a \`${procPath}\` procedure in your tRPC router, or update the call to use an existing procedure.`,
        autoFix: makeAutoFix(
          primary.absFile,
          'trpc-contract:undefined-call',
          `tRPC procedure "${procPath}" is called but not defined in any router`,
          primary.line,
          candidates.length
            ? `Rename this call to use an existing procedure: ${candidates.join(', ')}`
            : `Add a "${topLevel}" procedure to your tRPC router, or remove this call`
        ),
      });
    }

    if (calledProcedures.size === 0) {
      result.addCheck('trpc-contract:no-call-sites', true, {
        severity: 'info',
        message: `No tRPC call sites found outside test paths (${definedProcedures.size} procedure(s) defined) — nothing to compare`,
      });
    } else if (issueCount === 0) {
      result.addCheck('trpc-contract:clean', true, {
        severity: 'info',
        message: `All ${calledProcedures.size} tRPC call site path(s) match defined router procedures (${definedProcedures.size} procedure(s) checked)`,
      });
    }
  }
}

module.exports = TRPCContractDrift;
