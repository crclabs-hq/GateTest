/**
 * Import-Cycle / Circular-Dependency Detector Module.
 *
 * Circular imports are the silent killer of large JS/TS codebases.
 * They don't crash at build time (webpack/esbuild/Next.js all
 * tolerate them with varying degrees of correctness), but at
 * runtime one of the two modules wins the race and the other gets
 * an `undefined` for the symbol it imported. The bug reproduces
 * randomly — test order, hot-reload state, module-cache warmth —
 * and the fix is always a refactor because you can't patch a
 * circular dependency without breaking the cycle.
 *
 * Why this matters more than ever:
 *
 *   - Next.js 16 App Router splits server/client boundaries; a
 *     cycle that was fine in v12 now yields "Cannot read property
 *     of undefined" on the server-rendered side.
 *   - ES modules are strictly live bindings. A cycle that CJS
 *     would silently paper over (via the mutable `module.exports`
 *     object) becomes a TDZ error under ESM.
 *   - TypeScript `isolatedModules` + `--verbatimModuleSyntax`
 *     turn a cycle into a hard error if any type is re-exported.
 *
 * We build an import graph from JS/TS source files, run Tarjan's
 * SCC algorithm to find every strongly-connected component of size
 * ≥ 2 (= a cycle), and report one error per distinct cycle. Single-
 * node self-loops (file imports itself) are also flagged because
 * they're always bugs.
 *
 * Design choices:
 *
 *   - Type-only imports are erased at build time and cannot form a runtime
 *     cycle — and that includes a plain `import { A } from './a.js'` whose
 *     A is only ever used as a type, which tsc / esbuild / swc all drop.
 *     `src/core/import-elision.js` decides that per file, the way the
 *     compiler does. Before it existed this module was blind to NodeNext
 *     `.js`-for-`.ts` specifiers altogether (KI #96): it reported silence on
 *     every such project because letting those edges in without elision
 *     produced 15 false cycles on nest through `.interface.ts` files.
 *
 *   - Function-scoped `require(...)` / dynamic `import(...)` expressions
 *     are LAZY. They defer resolution to call time, which is the
 *     standard workaround for breaking a cycle. Skipped.
 *
 *   - An ESM import whose bindings are read ONLY inside function bodies,
 *     arrow bodies, instance-field initialisers or parameter defaults is
 *     the same thing with different syntax: the edge is real (the module
 *     loads) but nothing reads the binding while the graph is still
 *     loading, so it cannot produce the undefined-at-import bug. Such a
 *     cycle is reported as `cycle-deferred` at WARNING — measured on
 *     eight third-party TypeScript repositories, every cycle the old rule
 *     blocked on (hono 4, prisma 3) and every cycle the NodeNext edges
 *     added (nest 10, apollo 1, zod 1) was of this kind, and each ships.
 *
 *   - Only relative imports (`./`, `../`) form cycles. Bare-package
 *     imports (`react`, `lodash`) are external and skipped. tsconfig
 *     path aliases and workspace packages are resolved for coupling but
 *     still kept out of the cycle views (their own corpus-validated change).
 *
 *   - Resolved to real files via `path.resolve` + extension-retry
 *     (`./x` → `./x.ts`, `./x.tsx`, `./x/index.ts`, etc.). If we
 *     can't resolve, we skip silently.
 *
 * Rules:
 *
 *   error:   load-time cycle of 2+ files — every edge is read at module
 *            evaluation (top level, class heritage, decorator, static
 *            initialiser, enum initialiser). One error per distinct SCC.
 *            (rule: `import-cycle:cycle:<a>|<b>|...|<a>`)
 *
 *   warning: runtime cycle whose back-edges are all deferred to call time.
 *            Real coupling; breaks the moment one of those reads moves to
 *            module scope. (rule: `import-cycle:cycle-deferred:<a>|<b>|...`)
 *
 *   error:   file imports itself (self-loop).
 *            (rule: `import-cycle:self-loop:<rel>`)
 *
 *   info:    summary — files, edges, cycles, and what was NOT checked:
 *            JSX files (kept as load-time imports, unexamined) and the
 *            emitDecoratorMetadata case (a class-typed annotation on a
 *            decorated member is a runtime reference the scanner cannot
 *            see without type information).
 *            (rule: `import-cycle:summary`)
 *
 * Suppressions:
 *   - `// import-cycle-ok` on the import line (tells us this
 *     specific edge is expected and can be ignored for cycle-
 *     formation).
 *   - Test / spec / fixture paths downgrade error → warning.
 *
 * Competitors:
 *   - `madge --circular` (standalone CLI, separate install, no
 *     gate integration).
 *   - `eslint-plugin-import/no-cycle` (opt-in, needs per-project
 *     config, slow, and doesn't handle TS path aliases out of the
 *     box).
 *   - `dependency-cruiser` (heavy config, enterprise-pitch).
 *   - TypeScript itself catches NOTHING — tsc happily compiles
 *     circular modules.
 *   - Nothing unifies JS + TS + cycle reporting + gate-native
 *     enforcement + suppression markers at one call site.
 *
 * TODO(gluecron): host-neutral — pure static scan.
 */

const BaseModule = require('./base-module');
const { repoRelative } = require('../core/repo-path');
// The graph builder lives in src/core so structural analysis shares ONE
// definition of "what depends on what" — see the note at the top of that file.
// This module reads its `loadGraph` and `runtimeGraph` views; the older
// `staticGraph` view (pre-elision, no NodeNext edges) is kept for the
// equivalence tests in tests/import-graph.test.js.
const { collectSourceFiles, buildImportGraph, tarjanSCC } = require('../core/import-graph');

class ImportCycleModule extends BaseModule {
  constructor() {
    super('importCycle', 'Import-cycle detector — catches circular dependencies that cause runtime TDZ / undefined-import bugs');
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const files = collectSourceFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('import-cycle:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('import-cycle:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} file(s)`,
      fileCount: files.length,
    });

    // Two views of one graph (src/core/import-graph.js): `loadGraph` holds
    // every import the emitted JavaScript reads while the module graph is
    // still loading — a cycle there is the undefined-at-import bug;
    // `runtimeGraph` adds the imports whose reads are all deferred to call
    // time — a cycle there is real coupling that does not break at load.
    // Lazy requires and type-only (or type-only-used) imports are in neither.
    const built = buildImportGraph({ projectRoot, files });
    const graph = built.loadGraph;
    const edgeCount = built.runtimeEdgeCount;

    // SCCs via iterative Tarjan — iterative so a deep chain can't blow the stack.
    const sccs = tarjanSCC(graph);

    // A cycle = SCC with 2+ nodes, OR a single-node SCC that has
    // an edge to itself.
    const cycles = [];
    const selfLoops = [];
    for (const scc of sccs) {
      if (scc.length >= 2) {
        cycles.push(scc);
      } else if (scc.length === 1) {
        const n = scc[0];
        if (graph.get(n)?.has(n)) selfLoops.push(n);
      }
    }
    // Deferred cycles: SCCs of the runtime view that are not load-time SCCs.
    // A runtime SCC that contains a load-time cycle is already reported above
    // (the load cycle is the actionable part); only wholly-deferred SCCs
    // get the warning.
    const loadSccKeys = new Set(cycles.map((scc) => [...scc].sort().join('|')));
    const inLoadCycle = new Set(cycles.flat());
    const deferredCycles = tarjanSCC(built.runtimeGraph)
      .filter((scc) => scc.length >= 2 && !loadSccKeys.has([...scc].sort().join('|')) && !scc.some((n) => inLoadCycle.has(n)));

    // Report self-loops
    for (const abs of selfLoops) {
      const rel = repoRelative(projectRoot, abs);
      const isTest = this._isTestPath(rel);
      result.addCheck(`import-cycle:self-loop:${rel}`, false, {
        severity: isTest ? 'warning' : 'error',
        message: `${rel} imports itself — runtime undefined import`,
        file: rel,
      });
    }

    // Report cycles. Rotate each cycle to start at the lexicographically
    // smallest member for a stable rule name, and include a closing
    // repeat for human readability.
    for (const scc of cycles) {
      const ordered = this._orderCycle(scc, graph, projectRoot);
      const rels = ordered.map((a) => repoRelative(projectRoot, a));
      const isTest = rels.some((r) => this._isTestPath(r));
      const display = [...rels, rels[0]].join(' -> ');
      const ruleKey = rels.join('|');
      result.addCheck(`import-cycle:cycle:${ruleKey}`, false, {
        severity: isTest ? 'warning' : 'error',
        message: `Import cycle (${rels.length} files): ${display}`,
        files: rels,
      });
    }

    for (const scc of deferredCycles) {
      const ordered = this._orderCycle(scc, built.runtimeGraph, projectRoot);
      const rels = ordered.map((a) => repoRelative(projectRoot, a));
      const display = [...rels, rels[0]].join(' -> ');
      result.addCheck(`import-cycle:cycle-deferred:${rels.join('|')}`, false, {
        severity: 'warning',
        message: `Import cycle (${rels.length} files), load-safe: ${display} — every read of the cycle's bindings happens inside a function, so nothing is undefined at import time; it breaks the moment one of those reads moves to module scope`,
        files: rels,
      });
    }

    const jsxUnchecked = (built.unchecked && built.unchecked.jsx) || [];
    const notChecked = [];
    if (jsxUnchecked.length) notChecked.push(`${jsxUnchecked.length} JSX file(s) kept every import as load-time (type-only elision is not analysed in JSX)`);
    notChecked.push('emitDecoratorMetadata: a class-typed annotation on a decorated member is a runtime reference this scan cannot see without type information');
    const el = built.elision || { scanned: 0, pending: 0 };
    const scanned = `type-only elision scanned ${el.scanned} file(s) inside candidate cycles; ${el.pending} file(s) outside every cycle needed no scan`;
    result.addCheck('import-cycle:summary', true, {
      severity: 'info',
      message: `${files.length} file(s) scanned, ${edgeCount} runtime edge(s), ${cycles.length} load-time cycle(s), ${deferredCycles.length} deferred cycle(s), ${selfLoops.length} self-loop(s). ${scanned}. Not checked: ${notChecked.join('; ')}`,
      fileCount: files.length,
      edgeCount,
      cycleCount: cycles.length,
      deferredCycleCount: deferredCycles.length,
      selfLoopCount: selfLoops.length,
      notChecked,
      jsxUncheckedCount: jsxUnchecked.length,
    });
  }

  /**
   * Rotate the cycle so it starts at the lexicographically smallest
   * member (stable key for the rule name). Also try to order around
   * the actual cycle direction using the graph edges.
   */
  _orderCycle(scc, graph, projectRoot) {
    const rels = scc.map((a) => ({ abs: a, rel: repoRelative(projectRoot, a) }));
    rels.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const start = rels[0].abs;

    // Walk edges to produce a traversal order from `start`
    const visited = new Set([start]);
    const order = [start];
    const sccSet = new Set(scc);
    let cur = start;
    while (order.length < scc.length) {
      const outs = graph.get(cur) || new Set();
      let picked = null;
      for (const n of outs) {
        if (sccSet.has(n) && !visited.has(n)) {
          picked = n;
          break;
        }
      }
      if (!picked) {
        // Fallback — append any remaining node
        for (const r of rels) {
          if (!visited.has(r.abs)) { picked = r.abs; break; }
        }
      }
      if (!picked) break;
      visited.add(picked);
      order.push(picked);
      cur = picked;
    }
    return order;
  }
}

module.exports = ImportCycleModule;
