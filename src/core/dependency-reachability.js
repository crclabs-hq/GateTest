'use strict';

/**
 * Dependency reachability — turn "N vulnerabilities" into "which of these
 * can actually hurt you".
 *
 * Why (2026-08-18, Craig: "nailing the sore points matters most"): the
 * second-loudest complaint about every incumbent — Dependabot, Snyk, GHAS,
 * npm audit — is alert fatigue: CVEs in dev-only tooling, in packages that
 * are installed but never imported, in transitive deps of a build script.
 * Filippo Valsorda's "Dependabot is a noise machine" is exactly this. A
 * gate that blocks on them teaches the team to bypass the gate.
 *
 * Classification per vulnerable package (npm audit v7+ JSON):
 *   dev-only         every direct root that pulls it in is a devDependency
 *   installed-unused production dependency, but no non-test source file
 *                    imports it (or its direct root)
 *   reachable        production dependency AND imported from source
 *
 * Only `reachable` critical/high advisories should BLOCK. The others are
 * shown — as warning (installed-unused) or info (dev-only / low) — with the
 * reason stated, never hidden. Pure functions + a tiny fs adapter so it is
 * testable on fixture JSON.
 */

const fs = require('fs');
const path = require('path');
const { isTestPath } = require('./test-paths');
const { buildImportGraph, collectSourceFiles } = require('./import-graph');

// "Is this a test path" comes from the one definition (src/core/test-paths.js).
// This walker asks a BROADER question — is the file SHIPPED production source?
// — so it also excludes what the test predicate deliberately does not: build
// and maintenance scripts, tooling, benchmarks, docs, cypress trees, and
// tool config files. A CVE reachable only from a script never runs in prod.
// A tool config may carry a variant segment — nest's `vitest.config.coverage.mts`
// and `vitest.config.integration.mts` are still vitest configs, not shipped code.
const NOT_SHIPPED_RE = /(^|\/)(cypress|scripts?|tools?|bench(marks?)?|docs?)\/|\.bench\.[a-z]+$|\.config(?:\.[\w-]+)*\.[cm]?[jt]s$/i;

/**
 * Collect the set of package names imported from PRODUCTION source.
 *
 * JavaScript / TypeScript is read through the one import graph
 * (src/core/import-graph.js — the same statements, the same masked text, no
 * file cap): a package named in a comment or a string is not an import, and
 * a repository with more than 4,000 source files is read whole (prisma has
 * 4,551; the private walker this replaced stopped at 4,000). Vue and Svelte
 * single-file components are not JavaScript files, so their script blocks
 * still go through the regex harvester below.
 */
function collectImportedPackages(projectRoot) {
  const imported = new Set();
  const production = (abs) => {
    const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
    return !isTestPath(rel) && !NOT_SHIPPED_RE.test(rel);
  };
  const files = collectSourceFiles(projectRoot).filter(production);
  const graph = buildImportGraph({ projectRoot, files });
  for (const specs of graph.externals.values()) for (const spec of specs.keys()) imported.add(barePackage(spec));
  for (const file of sfcFiles(projectRoot).filter(production)) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; } // error-ok — unreadable component
    for (const name of extractImports(src)) imported.add(name);
  }
  return imported;
}

const SFC_EXTS = new Set(['.vue', '.svelte']);
const { WALK_EXCLUDE_SET: SKIP_DIRS } = require('./walk-excludes');

/** Vue / Svelte single-file components under the project (the graph walks only JS/TS). */
function sfcFiles(projectRoot) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } // error-ok — unreadable dir
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1); continue; }
      if (SFC_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  };
  walk(projectRoot, 0);
  return out;
}

/** `@scope/pkg/sub` → `@scope/pkg`; `lodash/fp` → `lodash`. */
function barePackage(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Package names from require()/import/import()/export-from specifiers. */
function extractImports(src) {
  const out = new Set();
  const re = /(?:require\s*\(\s*|import\s*\(\s*|from\s+|import\s+)['"]([^'"\n]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('#')) continue;
    out.add(barePackage(spec));
  }
  return out;
}

function readManifest(projectRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    return {
      prod: new Set(Object.keys(pkg.dependencies || {})),
      dev: new Set([...Object.keys(pkg.devDependencies || {}), ...Object.keys(pkg.optionalDependencies || {})]),
    };
  } catch {
    return { prod: new Set(), dev: new Set() };
  }
}

/**
 * Walk `via` chains up to the DIRECT roots (packages named in package.json).
 * npm audit v7+: vulnerabilities[name].via = [advisory objects | parent names];
 * `effects` lists packages that depend on this one. A root is direct when
 * `isDirect` is true or the name is in the manifest.
 */
function directRootsOf(name, vulns, manifest, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);
  const v = vulns[name];
  const roots = new Set();
  const isDirect = (v && v.isDirect) || manifest.prod.has(name) || manifest.dev.has(name);
  if (isDirect) roots.add(name);
  const parents = new Set([...(v && Array.isArray(v.effects) ? v.effects : [])]);
  for (const p of parents) for (const r of directRootsOf(p, vulns, manifest, seen)) roots.add(r);
  if (roots.size === 0 && !isDirect) roots.add(name); // orphan chain — treat itself as the root (unknown provenance)
  return roots;
}

/**
 * @param {object} audit          parsed `npm audit --json`
 * @param {object} ctx            { manifest: {prod,dev}, imported: Set<string> }
 * @returns {Array<{name, severity, class, roots, reason, fixAvailable, direct}>}
 */
function classifyAdvisories(audit, ctx) {
  const vulns = (audit && audit.vulnerabilities) || {};
  const manifest = ctx.manifest || { prod: new Set(), dev: new Set() };
  const imported = ctx.imported || new Set();
  const out = [];
  for (const [name, v] of Object.entries(vulns)) {
    const severity = String(v.severity || 'info').toLowerCase();
    const roots = [...directRootsOf(name, vulns, manifest)];
    const prodRoots = roots.filter((r) => manifest.prod.has(r) || !manifest.dev.has(r));
    const devOnly = roots.length > 0 && prodRoots.length === 0;
    const anyImported = [name, ...roots].some((r) => imported.has(r));
    let cls;
    let reason;
    if (devOnly) {
      cls = 'dev-only';
      reason = `pulled in only by devDependencies (${roots.join(', ')}) — never ships to production`;
    } else if (!anyImported) {
      cls = 'installed-unused';
      reason = `a production dependency${roots.length && roots[0] !== name ? ` (via ${prodRoots.join(', ')})` : ''} that no non-test source file imports — installed, not used`;
    } else {
      cls = 'reachable';
      reason = `imported from production source${roots.length && roots[0] !== name ? ` via ${prodRoots.join(', ')}` : ''}`;
    }
    out.push({ name, severity, class: cls, roots, reason, fixAvailable: v.fixAvailable !== false && v.fixAvailable !== undefined ? v.fixAvailable : false, direct: Boolean(v.isDirect), range: v.range || null });
  }
  return out;
}

/** Severity a gate should apply: only reachable critical/high blocks. */
function gateSeverity(item) {
  const hi = item.severity === 'critical' || item.severity === 'high';
  if (item.class === 'reachable') return hi ? 'error' : 'warning';
  if (item.class === 'installed-unused') return hi ? 'warning' : 'info';
  return 'info';
}

function analyseProject(audit, projectRoot) {
  const manifest = readManifest(projectRoot);
  const imported = collectImportedPackages(projectRoot);
  const items = classifyAdvisories(audit, { manifest, imported });
  const counts = { reachable: 0, 'installed-unused': 0, 'dev-only': 0 };
  for (const i of items) counts[i.class]++;
  return { items, counts, imported, manifest };
}

module.exports = { classifyAdvisories, gateSeverity, analyseProject, collectImportedPackages, extractImports };
