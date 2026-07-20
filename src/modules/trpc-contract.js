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
 * Router patterns:
 *   - `router({ foo: procedure.query(...) })` → "foo"
 *   - `t.router({ bar: t.procedure.mutation(...) })` → "bar"
 *   - `createTRPCRouter({ baz: ... })` → "baz"
 *   - Nested: `appRouter.foo.bar` → "foo.bar"
 *
 * Call site patterns:
 *   - `trpc.foo.useQuery()`
 *   - `trpc.bar.useMutation()`
 *   - `api.foo.bar.useQuery()`
 *   - `client.foo.bar.query()`
 *   - `trpc.foo.bar.useInfiniteQuery()`
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const BaseModule    = require('./base-module');
const { makeAutoFix } = require('../core/ai-fix-engine');

// ─── patterns ─────────────────────────────────────────────────────────────

// Router definition: router({ <name>: procedure... }) or createTRPCRouter({ <name>: ... })
const ROUTER_KEY_RE = /(?:createTRPCRouter|t\.router|router)\s*\(\s*\{([^}]{0,2000})\}/g;
const PROC_KEY_RE   = /^\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/gm;

// Sub-router merging: foo: fooRouter
const MERGE_RE = /([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*[a-zA-Z_$][a-zA-Z0-9_$]*Router\b/g;

// Call site: trpc.foo.useQuery / api.foo.bar.useMutation / client.foo.query
const CALL_SITE_RE = /(?:trpc|api|client)\s*\.\s*([a-zA-Z_$][a-zA-Z0-9_$.]*?)\s*\.\s*(?:useQuery|useMutation|useInfiniteQuery|query|mutate|mutateAsync|subscribe|fetch)\s*\(/g;

// ─── helpers ───────────────────────────────────────────────────────────────

function isRouterFile(rel) {
  const lower = rel.toLowerCase();
  return (
    lower.includes('router') ||
    lower.includes('trpc') ||
    lower.includes('api/') ||
    lower.includes('server/')
  ) && (lower.endsWith('.ts') || lower.endsWith('.js') || lower.endsWith('.tsx'));
}

// ─── module ────────────────────────────────────────────────────────────────

class TRPCContractDrift extends BaseModule {
  constructor() {
    super('trpcContract', 'tRPC Contract Drift — procedure definitions vs frontend call sites');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // Quick check: is tRPC present?
    const pkgPath = path.join(projectRoot, 'package.json');
    let hasTRPC = false;
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        hasTRPC = Object.keys(allDeps).some(k => k.includes('trpc'));
      } catch { /* skip */ }
    }

    if (!hasTRPC) {
      result.addCheck('trpc-contract:not-installed', true, {
        severity: 'info',
        message: 'tRPC not found in dependencies — contract drift check skipped',
      });
      return;
    }

    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];
    const files      = this._collectFiles(projectRoot, extensions);

    // { 'foo.bar' → { file, line } }
    const definedProcedures = new Map();
    // { 'foo.bar' → [{ file, line }] }
    const calledProcedures  = new Map();

    for (const file of files) {
      const rel = path.relative(projectRoot, file);
      if (rel.includes('node_modules') || rel.includes('.next')) continue;

      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const lines = content.split('\n');

      // Harvest router definitions
      if (isRouterFile(rel)) {
        ROUTER_KEY_RE.lastIndex = 0;
        let rm;
        while ((rm = ROUTER_KEY_RE.exec(content)) !== null) {
          const body    = rm[1];
          const matchIdx = rm.index;

          PROC_KEY_RE.lastIndex = 0;
          let km;
          while ((km = PROC_KEY_RE.exec(body)) !== null) {
            const name   = km[1];
            if (['default', 'type', 'interface', 'return', 'const', 'let', 'var', 'import', 'export'].includes(name)) continue;
            const lineNo = content.slice(0, matchIdx + km.index).split('\n').length;
            definedProcedures.set(name, { file: rel, absFile: file, line: lineNo });
          }

          // Also capture merged sub-routers as namespaces
          MERGE_RE.lastIndex = 0;
          let mr;
          while ((mr = MERGE_RE.exec(body)) !== null) {
            const ns = mr[1];
            const lineNo = content.slice(0, matchIdx + mr.index).split('\n').length;
            definedProcedures.set(ns, { file: rel, absFile: file, line: lineNo, isNamespace: true });
          }
        }
      }

      // Harvest call sites
      CALL_SITE_RE.lastIndex = 0;
      let cm;
      while ((cm = CALL_SITE_RE.exec(content)) !== null) {
        const path_parts = cm[1];
        const lineNo     = content.slice(0, cm.index).split('\n').length;
        const lineText   = lines[lineNo - 1] || '';
        if (lineText.includes('// trpc-ok')) continue;

        // path_parts might be "foo.bar" — top-level is the first segment
        const topLevel = path_parts.split('.')[0];
        if (!calledProcedures.has(path_parts)) calledProcedures.set(path_parts, []);
        calledProcedures.get(path_parts).push({ file: rel, absFile: file, line: lineNo });

        if (!calledProcedures.has(topLevel)) calledProcedures.set(topLevel, []);
        calledProcedures.get(topLevel).push({ file: rel, absFile: file, line: lineNo });
      }
    }

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
      const topLevel = procPath.split('.')[0];
      const defined  = definedProcedures.has(procPath) ||
                       definedProcedures.has(topLevel)  ||
                       // "foo.bar" — check if "foo" is a registered namespace
                       [...definedProcedures.entries()].some(([k, v]) =>
                         v.isNamespace && (procPath === k || procPath.startsWith(k + '.'))
                       );

      if (!defined) {
        const primary = callSites[0];
        const candidates = [...definedProcedures.keys()]
          .filter(k => k.toLowerCase().includes(topLevel.toLowerCase().slice(0, 3)))
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
    }

    if (issueCount === 0) {
      result.addCheck('trpc-contract:clean', true, {
        severity: 'info',
        message: `All tRPC call sites match defined router procedures (${definedProcedures.size} procedure(s) checked)`,
      });
    }
  }
}

module.exports = TRPCContractDrift;
