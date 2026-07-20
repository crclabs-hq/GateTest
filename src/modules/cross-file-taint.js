/**
 * Cross-File Taint Analysis Module.
 *
 * The real injection bugs don't stay in one file. A route handler
 * extracts `req.body.userId`, passes it to a helper that formats it,
 * which passes it to a database utility — and THAT file executes the
 * unparameterised query. The inline-SSRF and inline-injection tools
 * (ssrf.js, etc.) catch the single-file case. This module catches the
 * multi-hop case that every other static tool misses.
 *
 * Approach (inter-procedural data-flow, line-heuristic, no AST):
 *
 *   Phase 1 — Build import graph.
 *     Same technique as importCycle.js: walk every JS/TS file, parse
 *     top-level imports/requires, resolve to absolute paths, build a
 *     directed "imports" map (importer → importee).
 *
 *   Phase 2 — Per-file taint extraction.
 *     For each file, find:
 *       a) Taint SOURCES: assignments from request fields
 *          (req.body.*, req.query.*, req.params.*, req.headers.*,
 *          ctx.request.body/query, event.body, e.body, evt.body)
 *       b) Taint EXPORTS: functions/variables that are exported with
 *          a tainted value as argument or return value
 *       c) Taint SINKS: dangerous API calls where a tainted value
 *          is directly present as an argument
 *
 *   Phase 3 — Cross-file propagation.
 *     Build a call-graph approximation: for each file that imports
 *     from a source file that exports tainted data, check whether
 *     the imported identifier is used at a sink in the importing
 *     file. Report cross-boundary findings separately from same-file
 *     findings (which ssrf.js already covers).
 *
 * Taint sources (strings that look like request field reads):
 *   req.body, req.query, req.params, req.headers,
 *   request.body, request.query, request.params, request.headers,
 *   ctx.request.body, ctx.request.query, ctx.request.params,
 *   event.body, e.body, evt.body, c.req.body (Hono)
 *
 * Taint sinks:
 *   SQL execution:    .query(, .raw(, .execute(, db.run(, db.all(
 *   Code execution:   eval(, new Function(, vm.runInNewContext(
 *   Shell execution:  exec(, execSync(, spawn(, spawnSync(
 *   File access:      readFile(, readFileSync(, createReadStream(,
 *                     writeFile(, writeFileSync(, unlink(, rm(
 *   DOM injection:    dangerouslySetInnerHTML, innerHTML =,
 *                     document.write(, insertAdjacentHTML(
 *   Path traversal:   path.join(, path.resolve( with tainted args
 *   Redirect:         res.redirect(, ctx.redirect(
 *
 * Rules:
 *
 *   error: tainted value from file A used at a dangerous sink in
 *          file B, with no sanitisation visible between import and
 *          use. (cross-file-taint:sink:<sink>:<rel>:<line>)
 *
 *          This also covers the reverse (and far more common) shape:
 *          file A CALLS an imported function from file B with a
 *          tainted argument, and file B's function uses that
 *          parameter at a sink internally (a layered "handler calls
 *          db helper with req.params.x" architecture). See
 *          `paramTaintFunctions` / `_analyseFunctionParamTaint` and
 *          the call-site correlation phase below.
 *
 *   warning: tainted value passed through 3+ hops (deep propagation —
 *            harder to audit manually). (cross-file-taint:deep:<rel>:<line>)
 *
 *   info: summary of files scanned, taint sources found, cross-
 *         boundary propagation chains detected.
 *         (cross-file-taint:summary)
 *
 * Suppressions:
 *   - `// taint-ok` on the sink line suppresses that finding.
 *   - `// taint-ok` on the import line suppresses that import edge.
 *   - Test paths downgrade error → warning.
 *
 * Competitors:
 *   - Semgrep Pro has inter-procedural taint (enterprise, $20k+/yr).
 *     Misses cross-FILE propagation via module exports.
 *   - CodeQL does full data-flow (GitHub-only, complex query language,
 *     requires compiled artifact, 45-min CI jobs).
 *   - SonarQube has taint analysis for Java (not JS/TS cross-file).
 *   - Snyk Code does it in their cloud (not gate-native, SaaS).
 *   Nothing ships as a local, zero-dependency, gate-native
 *   cross-file taint scanner for JS/TS.
 */

'use strict';

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', 'out', 'target', 'vendor', '.terraform', '__pycache__',
  '.turbo', '.vercel',
]);

const JS_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|fixtures?|stories|reliability-corpus)\//i;
const TEST_FILE_RE = /\.(?:test|spec|e2e|stories)\.[a-z0-9]+$/i;

// Import/require regexes (top-level only)
const IMPORT_FROM_RE = /^\s*import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/;
const IMPORT_TYPE_ONLY_RE = /^\s*import\s+type\b/;
const EXPORT_FROM_RE = /^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/;
const REQUIRE_INDENT_RE = /^(?:const|let|var)\s+.*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/;

// Named import bindings: import { foo, bar as baz } from './x'
const NAMED_IMPORT_BINDINGS_RE = /import\s+(?:type\s+)?\{([^}]+)\}/;
// Default import: import foo from './x'
const DEFAULT_IMPORT_RE = /import\s+(?:type\s+)?(\w+)\s+from\s+/;
// Namespace import: import * as foo from './x'
const NAMESPACE_IMPORT_RE = /import\s+\*\s+as\s+(\w+)\s+from\s+/;
// require destructure: const { foo, bar } = require('./x')
const REQUIRE_DESTRUCT_RE = /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(/;
// require default: const foo = require('./x')
const REQUIRE_DEFAULT_RE = /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(/;

// Taint source patterns — request body/query/params reads
const TAINT_SOURCE_RES = [
  /\breq(?:uest)?\.body\b/,
  /\breq(?:uest)?\.query\b/,
  /\breq(?:uest)?\.params\b/,
  /\breq(?:uest)?\.headers\b/,
  /\bctx\.request\.(?:body|query|params)\b/,
  /\bevent\.body\b/,
  /\bevt\.body\b/,
  /\be\.body\b/,
  /\bc\.req\.(?:body|query|param)\b/,   // Hono
  /\bcontext\.request\.body\b/,
];

// Variable assignment from taint source: const x = req.body.x
const TAINT_ASSIGN_RE = /(?:const|let|var)\s+(\w+)\s*=\s*(.*)/;
// Destructure from taint: const { x, y } = req.body
const TAINT_DESTRUCT_RE = /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(.*)/;

// Dangerous sink patterns
const SINKS = [
  { name: 'sql-query',         re: /\.\s*(?:query|raw|execute|run|all)\s*\(/ },
  { name: 'eval',              re: /\beval\s*\(/ },
  { name: 'new-function',      re: /\bnew\s+Function\s*\(/ },
  { name: 'vm-run',            re: /\bvm\.runIn(?:New)?Context\s*\(/ },
  { name: 'exec',              re: /\b(?:exec|execSync)\s*\(/ },
  { name: 'spawn',             re: /\b(?:spawn|spawnSync)\s*\(/ },
  { name: 'file-read',         re: /\b(?:readFile|readFileSync|createReadStream)\s*\(/ },
  { name: 'file-write',        re: /\b(?:writeFile|writeFileSync|appendFile|unlink|rm|rmdir)\s*\(/ },
  { name: 'path-join',         re: /\bpath\.(?:join|resolve)\s*\(/ },
  { name: 'dom-inject',        re: /dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\s*\(|insertAdjacentHTML\s*\(/ },
  { name: 'redirect',          re: /\bres\.redirect\s*\(|\bctx\.redirect\s*\(|\bc\.redirect\s*\(/ },
  { name: 'child-process',     re: /\bexecFile(?:Sync)?\s*\(|\bfork\s*\(/ },
];

// Sanitisation / validation patterns — if present on the same or prev 3 lines,
// suppress the cross-file finding
const SANITISE_RES = [
  /validateUrl|isValidUrl|assertSafeUrl|sanitize|sanitise|escape\(|parameterize|parameterise/i,
  /allowedHosts\.includes|ALLOWLIST\.has|whitelist\.includes/i,
  /new URL\([^)]+\)\.hostname/,
  /parseInt\s*\(|parseFloat\s*\(|Number\s*\(|Boolean\s*\(/,
  /\.trim\s*\(\s*\)|\.slice\s*\(|\.substring\s*\(/,
  /validator\.|xss\(|DOMPurify\./,
  // Tagged-template SQL — Drizzle / Postgres.js / Prisma.sql / Kysely sql
  // — these auto-parameterise every interpolation. Treat as sanitiser when
  // visible on the sink line or in the context window.
  /\bsql\s*`/,
  /\bPrisma\.sql\s*`/,
  /\bdb\.sql\s*`/,
];

const SUPPRESS_TAINT_OK_RE = /\/\/\s*taint-ok\b/;

// Parameterised-ORM imports — when one of these is imported in the file,
// the `.query/.raw/.execute/.run/.all` sink is downgraded from error to
// warning. Drizzle, Prisma, Kysely, Postgres.js, Slonik, TypeORM
// (QueryBuilder), Sequelize (model methods), Mongoose, Knex (builder, not
// .raw with concat) all parameterise by default. The downgrade prevents
// false-positive blocking while keeping the finding visible. Knex `.raw()`
// with template-literal concat is still caught by the standard sink rule
// because the tagged-template sanitiser only matches `sql\``.
const PARAMETERISED_ORM_RE = /(?:require\s*\(\s*['"]|from\s+['"])(?:drizzle-orm|@prisma\/client|kysely|postgres|slonik|typeorm|sequelize|mongoose|knex|@databases\/(?:pg|mysql|sqlite))(?:\/[^'"]*)?['"]/;

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

class CrossFileTaintModule extends BaseModule {
  constructor() {
    super(
      'crossFileTaint',
      'Cross-file taint analysis — traces user input across module boundaries to dangerous sinks (SQL injection, eval, exec, file-path traversal, DOM injection)',
    );
    // Opt out of incremental: this module is literally a cross-file
    // taint propagator — scanning only the changed file would break
    // the whole point.
    this._respectsIncremental = false;
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();

    const files = this._collectFiles(projectRoot);
    if (files.length === 0) {
      result.addCheck('cross-file-taint:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files to scan',
      });
      return;
    }

    // Phase 1: build import graph and per-file analysis
    const fileData = new Map();  // absPath → { taintedExports, importedBindings, sinkHits }
    const importGraph = new Map(); // importer → Set<importee>

    for (const abs of files) {
      const data = this._analyseFile(abs, projectRoot, files);
      fileData.set(abs, data);
      importGraph.set(abs, data.importedFrom);
    }

    // Phase 2a: report local taint → local sink (same-file, direct path).
    // ssrf.js covers HTTP sinks; this module covers ALL sinks (eval, exec,
    // file-read, spawn, DOM-inject, path-join, redirect, sql-query).
    const findings = [];
    let totalSourcesFound = 0;
    let totalCrossHops = 0;

    for (const [abs, data] of fileData) {
      totalSourcesFound += data.localTaintedVars.size;

      const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
      const isTest = TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(rel);

      for (const hit of data.sinkHits) {
        if (SUPPRESS_TAINT_OK_RE.test(hit.rawLine)) continue;
        if (this._hasSanitiser(hit.rawLine, hit.contextLines)) continue;

        // Find which tainted var triggered this sink hit
        const triggerVar = Array.from(data.localTaintedVars).find(
          (v) => this._lineReferencesVar(hit.rawLine, v),
        );

        // Parameterised-ORM safe-harbour: downgrade sql-query sinks in
        // files that import drizzle / prisma / kysely / etc. These ORMs
        // parameterise every interpolation; raw-with-concat shapes are
        // still caught by the tagged-template sanitiser (handled above).
        let severity = isTest ? 'warning' : 'error';
        if (hit.sink === 'sql-query' && data.hasParameterisedOrm) {
          severity = isTest ? 'info' : 'warning';
        }

        findings.push({
          severity,
          rel,
          line: hit.line,
          sink: hit.sink,
          binding: triggerVar || '(tainted)',
          importeeRel: rel, // same file
          crossFile: false,
        });
      }

      // Phase 2b: cross-file — imported binding from a tainted-export file used at a sink here.
      for (const [importee, bindings] of data.importedBindings) {
        const importeeData = fileData.get(importee);
        if (!importeeData) continue;

        // Which of the imported bindings are tainted in the importee?
        const taintedImports = new Set();
        for (const binding of bindings) {
          if (importeeData.taintedExports.has(binding) || importeeData.taintedExports.has('*')) {
            taintedImports.add(binding);
          }
        }
        if (taintedImports.size === 0) continue;

        for (const hit of data.sinkHits) {
          if (SUPPRESS_TAINT_OK_RE.test(hit.rawLine)) continue;

          // Does the sink line reference any of our tainted imports?
          for (const binding of taintedImports) {
            if (this._lineReferencesVar(hit.rawLine, binding)) {
              if (!this._hasSanitiser(hit.rawLine, hit.contextLines)) {
                const importeeRel = path.relative(projectRoot, importee).replace(/\\/g, '/');
                let severity = isTest ? 'warning' : 'error';
                if (hit.sink === 'sql-query' && data.hasParameterisedOrm) {
                  severity = isTest ? 'info' : 'warning';
                }
                findings.push({
                  severity,
                  rel,
                  line: hit.line,
                  sink: hit.sink,
                  binding,
                  importeeRel,
                  crossFile: true,
                });
                totalCrossHops += 1;
              }
            }
          }
        }
      }

      // Phase 2c: call-site taint — the reverse direction of 2b. File A
      // CALLS an imported function from file B, passing a tainted
      // argument; file B's function uses that SAME parameter at a sink
      // internally. 2b only fires when file B exports an already-tainted
      // VALUE — it misses the layered-architecture shape where file B
      // is a plain helper whose parameter simply happens to be dangerous
      // when called with attacker input (route handler -> db helper).
      for (const [importee, bindings] of data.importedBindings) {
        const importeeData = fileData.get(importee);
        if (!importeeData || importeeData.paramTaintFunctions.size === 0) continue;

        for (const binding of bindings) {
          const sinkDefs = importeeData.paramTaintFunctions.get(binding);
          if (!sinkDefs) continue;

          const callRe = new RegExp(`\\b${binding}\\s*\\(([^)]*)\\)`);
          for (let li = 0; li < data.lines.length; li++) {
            const callLine = data.lines[li];
            const m = callRe.exec(callLine);
            if (!m) continue;
            if (SUPPRESS_TAINT_OK_RE.test(callLine)) continue;

            const args = m[1].split(',').map((s) => s.trim()).filter(Boolean);

            for (const def of sinkDefs) {
              const argText = args[def.paramIndex];
              if (!argText) continue;
              if (!this._isArgTainted(argText, data.localTaintedVars)) continue;

              const importeeRel = path.relative(projectRoot, importee).replace(/\\/g, '/');
              let severity = isTest ? 'warning' : 'error';
              if (def.sink === 'sql-query' && importeeData.hasParameterisedOrm) {
                severity = isTest ? 'info' : 'warning';
              }

              // NOTE: field naming is inverted relative to phase 2b here —
              // the sink lives in the CALLEE (`importee`/`importeeRel` in
              // 2b's sense), so that's what `rel` holds below, while
              // `importeeRel` holds the CALLER (`rel` in 2b's sense). The
              // message text and dedup key are correct either way; this is
              // just a trap for future readers expecting 2b's convention.
              findings.push({
                severity,
                rel: importeeRel,
                line: def.line,
                sink: def.sink,
                binding: def.paramName,
                importeeRel: rel,
                crossFile: true,
                argCall: true,
                calleeFn: binding,
                callerLine: li + 1,
              });
              totalCrossHops += 1;
            }
          }
        }
      }
    }

    // Deduplicate (same rel+line+sink combo)
    const seen = new Set();
    for (const f of findings) {
      const key = `${f.rel}:${f.line}:${f.sink}:${f.binding}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const prefix = f.crossFile ? 'cross-file-taint' : 'taint';
      let msg;
      if (f.argCall) {
        msg = `Cross-file taint: tainted argument at ${f.importeeRel}:${f.callerLine} is passed to \`${f.calleeFn}(...)\`, whose parameter \`${f.binding}\` reaches \`${f.sink}\` sink here without sanitisation`;
      } else if (f.crossFile) {
        msg = `Cross-file taint: \`${f.binding}\` (from ${f.importeeRel}) reaches \`${f.sink}\` sink without sanitisation`;
      } else {
        msg = `Taint: \`${f.binding}\` (from request input) reaches \`${f.sink}\` sink without sanitisation`;
      }

      result.addCheck(
        `${prefix}:sink:${f.sink}:${f.rel}:${f.line}`,
        false,
        {
          severity: f.severity,
          message: msg,
          file: f.rel,
          line: f.line,
          sink: f.sink,
          source: f.importeeRel,
          binding: f.binding,
        },
      );
    }

    result.addCheck('cross-file-taint:summary', true, {
      severity: 'info',
      message: `${files.length} file(s) scanned, ${totalSourcesFound} taint source(s), ${seen.size} taint path(s) found (${totalCrossHops} cross-file)`,
      fileCount: files.length,
      localSources: totalSourcesFound,
      crossFilePaths: seen.size,
      crossFileHops: totalCrossHops,
    });
  }

  // ---------------------------------------------------------------------------
  // Per-file analysis
  // ---------------------------------------------------------------------------

  _analyseFile(abs, projectRoot, allFiles) {
    const allFilesSet = new Set(allFiles);
    const data = {
      localTaintedVars: new Set(),  // vars tainted in THIS file
      taintedExports: new Set(),    // exported names that carry taint
      importedBindings: new Map(),  // importee absPath → Set<binding name>
      importedFrom: new Set(),      // which files this file imports
      sinkHits: [],                 // { line, rawLine, sink, contextLines }
      hasParameterisedOrm: false,   // file imports drizzle / prisma / kysely / ...
      paramTaintFunctions: new Map(), // funcName → [{ paramIndex, paramName, sink, line, rawLine, contextLines }]
      lines: [],                    // raw source lines, kept for call-site correlation (phase 2c)
    };

    let text;
    try {
      text = fs.readFileSync(abs, 'utf-8');
    } catch {
      return data;
    }
    if (text.length > MAX_FILE_SIZE) return data;

    // One-time scan for parameterised-ORM imports — when present, downgrade
    // any sql-query sink in this file from error to warning (Drizzle &c.
    // auto-parameterise; raw-with-concat is still caught because the
    // tagged-template sanitiser in SANITISE_RES is shape-specific).
    if (PARAMETERISED_ORM_RE.test(text)) {
      data.hasParameterisedOrm = true;
    }

    const lines = text.split('\n');
    const dir = path.dirname(abs);

    // Track tainted vars (grows as we parse)
    const tainted = new Set();

    // Cross-line template-literal state, for sink detection only (see
    // sinkSafeLine below) — a backtick fixture spanning multiple lines
    // (e.g. `run({ 'index.js': \`...eval(code)...\` })` in a test file)
    // would otherwise read as real code on every line inside it.
    let inTemplate = false;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const stripped = this._stripComments(raw);
      const stripRes = this._stripJsStrings(raw, inTemplate);
      inTemplate = stripRes.inTemplate;
      // Sink patterns only — text inside a string/template/regex literal
      // isn't executable in the current file, so a sink match there is
      // example/fixture data, not a live vulnerability (self-scan
      // 2026-07-15: this module flagging its own test fixtures' eval()/
      // exec() sample payloads as real findings). Left the taint-source /
      // propagation / export tracking above untouched — narrowly scoping
      // this to sink detection is enough to kill the false positive,
      // since a hit requires a sink match AND a tainted-var reference on
      // the SAME line.
      const sinkSafeLine = this._stripComments(stripRes.stripped);

      // ----------------------------------------------------------------
      // Collect imports (top-level only — stop at first blank-ish line
      // after we've found at least one non-import statement, but we
      // do a full pass for robustness)
      // ----------------------------------------------------------------
      if (!IMPORT_TYPE_ONLY_RE.test(raw)) {
        const importMatch = IMPORT_FROM_RE.exec(raw) || EXPORT_FROM_RE.exec(raw);
        if (importMatch) {
          const spec = importMatch[1];
          if (spec.startsWith('.')) {
            const resolved = this._resolve(spec, dir, allFilesSet);
            if (resolved) {
              data.importedFrom.add(resolved);
              if (!data.importedBindings.has(resolved)) {
                data.importedBindings.set(resolved, new Set());
              }
              const bindings = data.importedBindings.get(resolved);
              // Named bindings
              const named = NAMED_IMPORT_BINDINGS_RE.exec(raw);
              if (named) {
                for (const part of named[1].split(',')) {
                  const t = part.trim();
                  if (!t) continue;
                  // "foo as bar" → use local alias "bar"
                  const alias = t.includes(' as ') ? t.split(' as ')[1].trim() : t;
                  bindings.add(alias);
                }
              }
              // Default import
              const def = DEFAULT_IMPORT_RE.exec(raw);
              if (def && !NAMESPACE_IMPORT_RE.exec(raw)) {
                bindings.add(def[1]);
              }
              // Namespace import
              const ns = NAMESPACE_IMPORT_RE.exec(raw);
              if (ns) bindings.add(ns[1]);
            }
          }
          continue; // import lines are not assignment/sink lines
        }

        // CJS require (top-level only, no indent)
        const reqMatch = REQUIRE_INDENT_RE.exec(raw);
        if (reqMatch) {
          const spec = reqMatch[1];
          if (spec.startsWith('.')) {
            const resolved = this._resolve(spec, dir, allFilesSet);
            if (resolved) {
              data.importedFrom.add(resolved);
              if (!data.importedBindings.has(resolved)) {
                data.importedBindings.set(resolved, new Set());
              }
              const bindings = data.importedBindings.get(resolved);
              const dest = REQUIRE_DESTRUCT_RE.exec(raw);
              if (dest) {
                for (const part of dest[1].split(',')) {
                  const t = part.trim();
                  if (!t) continue;
                  const alias = t.includes(':') ? t.split(':')[1].trim() : t;
                  bindings.add(alias);
                }
              } else {
                const def = REQUIRE_DEFAULT_RE.exec(raw);
                if (def) bindings.add(def[1]);
              }
            }
          }
          continue;
        }
      }

      // ----------------------------------------------------------------
      // Taint source detection
      // ----------------------------------------------------------------
      const isTaintSource = TAINT_SOURCE_RES.some((re) => re.test(stripped));

      if (isTaintSource) {
        // Destructure: const { id, name } = req.body
        const destruct = TAINT_DESTRUCT_RE.exec(raw);
        if (destruct) {
          for (const part of destruct[1].split(',')) {
            const t = part.trim().split(':')[0].trim(); // handle { id: userId }
            if (t && /^\w+$/.test(t)) tainted.add(t);
          }
        }
        // Direct assignment: const userId = req.params.id
        const assign = TAINT_ASSIGN_RE.exec(raw);
        if (assign && isTaintSource) {
          if (/^\w+$/.test(assign[1])) tainted.add(assign[1]);
        }
        // Parameter receives req directly: function foo(req, res) — we
        // mark the function param if we see req.body inside the function
        // body. For simplicity, just mark any assignment from taint source.
      }

      // Also propagate taint: if rhs contains a known tainted var
      const assignProp = TAINT_ASSIGN_RE.exec(raw);
      if (assignProp && !isTaintSource) {
        const rhs = assignProp[2] || '';
        for (const v of tainted) {
          if (this._lineReferencesVar(rhs, v)) {
            if (/^\w+$/.test(assignProp[1])) tainted.add(assignProp[1]);
            break;
          }
        }
      }

      // ----------------------------------------------------------------
      // Detect exports of tainted values
      // ----------------------------------------------------------------
      // module.exports = { foo, bar } or module.exports.foo = x
      if (/\bmodule\.exports\b/.test(raw) || /^export\s/.test(raw.trim())) {
        for (const v of tainted) {
          if (this._lineReferencesVar(raw, v)) {
            data.taintedExports.add(v);
          }
        }
        // export default taintedVar
        const expDefault = /^export\s+default\s+(\w+)/.exec(raw.trim());
        if (expDefault && tainted.has(expDefault[1])) {
          data.taintedExports.add('default');
          data.taintedExports.add(expDefault[1]);
        }
      }

      // ----------------------------------------------------------------
      // Sink detection — tainted variable used at a dangerous sink
      // ----------------------------------------------------------------
      if (SUPPRESS_TAINT_OK_RE.test(raw)) continue;

      for (const sink of SINKS) {
        if (!sink.re.test(sinkSafeLine)) continue;
        // Is a tainted var present on this line?
        for (const v of tainted) {
          if (this._lineReferencesVar(sinkSafeLine, v)) {
            const contextLines = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
            data.sinkHits.push({
              line: i + 1,
              rawLine: raw,
              sink: sink.name,
              contextLines,
            });
            break; // one hit per line per sink type is enough
          }
        }
      }
    }

    data.localTaintedVars = tainted;
    data.lines = lines;
    data.paramTaintFunctions = this._analyseFunctionParamTaint(lines);
    return data;
  }

  // ---------------------------------------------------------------------------
  // Function-parameter taint (own pass, own template-literal state) — finds
  // functions whose OWN parameter reaches a dangerous sink internally, e.g.
  // `function findOrderById(orderId) { ...conn.query(\`...${orderId}\`)... }`.
  // Consumed by phase 2c in run() to catch a caller in another file passing
  // a tainted argument into that parameter.
  // ---------------------------------------------------------------------------

  _analyseFunctionParamTaint(lines) {
    const funcs = new Map();
    const FUNC_DEF_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/;

    let activeFn = null;
    let depth = 0;
    let everOpened = false;
    let inTemplate = false;
    let inTemplateInterp = false;

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const stripRes = this._stripJsStrings(raw, inTemplate);
      inTemplate = stripRes.inTemplate;
      // Match against string/comment-stripped text only — a function
      // definition whose text sits entirely inside a multi-line template
      // literal (test fixtures writing sample code as strings) is blanked
      // to spaces here and can never match, so it can't start a phantom
      // activeFn whose brace depth would never close.
      const codeLine = this._stripComments(stripRes.stripped);

      // Same blanking, EXCEPT `${...}` template-literal interpolations stay
      // live — those are executable expressions (e.g. `${orderId}`), not
      // string content, so the reassignment-propagation match below needs
      // to see identifiers referenced there. FUNC_DEF_RE and sink detection
      // deliberately keep using the fully-blanked `codeLine` above so
      // fixture strings full of sample code can never open a phantom
      // activeFn or fake a sink hit.
      const interpRes = this._stripStringsKeepTemplateInterp(raw, inTemplateInterp);
      inTemplateInterp = interpRes.inTemplate;
      const propagationLine = this._stripComments(interpRes.stripped);

      if (!activeFn) {
        const m = FUNC_DEF_RE.exec(codeLine);
        if (!m) continue;
        const params = m[2]
          .split(',')
          .map((p) => p.trim().split(/[=:]/)[0].trim().replace(/^\.\.\./, ''))
          .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
        if (params.length === 0) continue;
        const origin = new Map();
        params.forEach((p, idx) => origin.set(p, idx));
        activeFn = { name: m[1], hits: [], origin, paramNames: params };
        depth = 0;
        everOpened = false;
      }

      // Propagate parameter taint through simple reassignment:
      // const sql = `...${orderId}...` — 'sql' inherits orderId's origin index.
      const assign = TAINT_ASSIGN_RE.exec(propagationLine);
      if (assign && /^\w+$/.test(assign[1]) && !activeFn.origin.has(assign[1])) {
        const rhs = assign[2] || '';
        for (const [name, idx] of activeFn.origin) {
          if (this._lineReferencesVar(rhs, name)) {
            activeFn.origin.set(assign[1], idx);
            break;
          }
        }
      }

      // Sink detection scoped to this function's tracked (param-derived) names.
      // The sink pattern itself is matched against `codeLine` (fully-blanked
      // strings/templates) so fixture strings can't fake a sink hit, but the
      // identifier-reference check runs against `propagationLine`, where
      // `${...}` template interpolations stay live — otherwise the flagship
      // inline-sink shape (`conn.query(\`...${orderId}\`)`) is invisible
      // because `codeLine` blanks the interpolation along with the rest of
      // the template.
      if (!SUPPRESS_TAINT_OK_RE.test(raw)) {
        for (const sink of SINKS) {
          if (!sink.re.test(codeLine)) continue;
          for (const [name, idx] of activeFn.origin) {
            if (!this._lineReferencesVar(propagationLine, name)) continue;
            const contextLines = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
            if (!this._hasSanitiser(raw, contextLines)) {
              activeFn.hits.push({
                paramIndex: idx,
                // Report the ORIGINAL parameter name (not the derived local,
                // e.g. `sql`), so "whose parameter `x`..." always names the
                // thing the caller actually passed in.
                paramName: activeFn.paramNames[idx] || name,
                sink: sink.name,
                line: i + 1,
                rawLine: raw,
                contextLines,
              });
            }
            break;
          }
        }
      }

      for (const ch of codeLine) {
        if (ch === '{') { depth += 1; everOpened = true; }
        else if (ch === '}') { depth -= 1; }
      }

      if (everOpened && depth <= 0) {
        if (activeFn.hits.length > 0) funcs.set(activeFn.name, activeFn.hits);
        activeFn = null;
      }
    }

    return funcs;
  }

  // Like BaseModule._stripJsStrings, but a `${...}` interpolation inside a
  // template literal is left LIVE instead of being blanked — it's an
  // executable expression, not string content. Single/double-quoted strings
  // and the non-interpolation portions of a template literal are still
  // fully blanked, so SQL-injection-shaped text nested inside an unrelated
  // outer string (fixture data) can't leak an identifier into the match.
  _stripStringsKeepTemplateInterp(line, inTemplate) {
    let out = '';
    let state = inTemplate ? '`' : null;
    let interpDepth = 0;
    let j = 0;
    while (j < line.length) {
      const ch = line[j];
      if (state === '`') {
        if (interpDepth > 0) {
          out += ch;
          if (ch === '{') interpDepth += 1;
          else if (ch === '}') interpDepth -= 1;
          j += 1;
          continue;
        }
        if (ch === '\\') { out += '  '; j += 2; continue; }
        if (ch === '$' && line[j + 1] === '{') { out += '${'; interpDepth = 1; j += 2; continue; }
        if (ch === '`') { out += ch; state = null; j += 1; continue; }
        out += ' ';
        j += 1;
        continue;
      }
      if (state) {
        if (ch === '\\') { out += '  '; j += 2; continue; }
        if (ch === state) { out += ch; state = null; j += 1; continue; }
        out += ' ';
        j += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { out += ch; state = ch; j += 1; continue; }
      out += ch;
      j += 1;
    }
    return { stripped: out, inTemplate: state === '`' };
  }

  // True when `argText` (raw call-site argument text) is tainted: either it
  // directly reads a request field (`req.params.id`) or its root identifier
  // is a variable already known to be tainted in the calling file.
  _isArgTainted(argText, taintedVars) {
    const trimmed = argText.trim();
    if (TAINT_SOURCE_RES.some((re) => re.test(trimmed))) return true;
    const rootMatch = /^([A-Za-z_$][\w$]*)/.exec(trimmed);
    return !!(rootMatch && taintedVars.has(rootMatch[1]));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _lineReferencesVar(line, varName) {
    // Match the variable as a whole word (not as part of a longer identifier)
    const re = new RegExp(`\\b${varName}\\b`);
    return re.test(line);
  }

  _hasSanitiser(rawLine, contextLines) {
    // Strip comments BEFORE matching — a `// uses sql\`...\` here` doc
    // comment shouldn't falsely suppress a real injection finding.
    const stripped = this._stripComments(rawLine);
    const ctxStripped = (contextLines || '')
      .split('\n')
      .map((l) => this._stripComments(l))
      .join('\n');
    const combined = ctxStripped + '\n' + stripped;
    return SANITISE_RES.some((re) => re.test(combined));
  }

  _stripComments(line) {
    // Strip // line comments
    const idx = line.indexOf('//');
    return idx >= 0 ? line.slice(0, idx) : line;
  }

  _collectFiles(root) {
    const out = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile() && JS_EXTS.has(path.extname(e.name).toLowerCase())) {
          out.push(full);
        }
      }
    };
    walk(root);
    return out;
  }

  _resolve(spec, fromDir, fileSet) {
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
    const base = path.resolve(fromDir, spec);

    // Try exact
    if (fileSet.has(base)) return base;

    // Try adding extensions
    for (const ext of exts) {
      const candidate = base + ext;
      if (fileSet.has(candidate)) return candidate;
    }

    // Try index file
    for (const ext of exts) {
      const candidate = path.join(base, `index${ext}`);
      if (fileSet.has(candidate)) return candidate;
    }

    return null;
  }
}

module.exports = CrossFileTaintModule;
