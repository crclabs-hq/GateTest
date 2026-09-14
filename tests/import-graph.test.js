/**
 * Import graph — the shared dependency spine.
 *
 * This logic was extracted from src/modules/import-cycle.js so structural
 * analysis could share ONE definition of "what depends on what". The extraction
 * was verified against the live module on 1191 real files (930 static edges,
 * byte-identical), but a one-off measurement is not a guard. These tests are the
 * guard: they pin BOTH the edge classification and the property import-cycle
 * depends on — that `staticGraph` contains only cycle-forming edges.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildImportGraph, collectSourceFiles, reverseGraph, tarjanSCC, isTopLevel,
} = require('../src/core/import-graph');

let ROOT;

/** Write a fixture tree; keys are relative paths. */
function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-import-graph-'));
  writeTree(ROOT, {
    // static: top-level import + require + export-from
    'a.js': "import b from './b';\nconst c = require('./c');\n",
    'b.js': "export { x } from './c';\n",
    'c.js': 'module.exports = {};\n',
    // lazy: require inside a function, and a dynamic import
    'lazy.js': "function f() {\n  const c = require('./c');\n  return c;\n}\nasync function g() { await import('./b'); }\n",
    // type-only: erased at build time
    'types.ts': "import type { T } from './c';\nexport type U = T;\n",
    // external packages are not our graph
    'ext.js': "const react = require('react');\nimport fs from 'node:fs';\n",
    // extension + index resolution
    'dir/index.js': 'module.exports = 1;\n',
    'uses-dir.js': "const d = require('./dir');\n",
    'uses-ts.js': "import t from './types';\n",
    // suppression marker
    'suppressed.js': "const c = require('./c'); // import-cycle-ok\n",
    // a real 2-node cycle
    'cyc1.js': "const two = require('./cyc2');\n",
    'cyc2.js': "const one = require('./cyc1');\n",
    // dynamic-registry references: relative paths as plain STRINGS, the shape
    // used by plugin registries / route tables / DI manifests.
    'registry.js': "module.exports = {\n  cee: './c.js',\n  bee: './b.js',\n};\n",
    // a path string that does NOT resolve is just a string, not an edge
    'ghost.js': "const missing = './does-not-exist.js';\nmodule.exports = missing;\n",
    // a non-path string must never be mistaken for one
    'prose.js': "const msg = 'see ./docs for details';\nmodule.exports = msg;\n",
    // must be ignored entirely
    'node_modules/pkg/index.js': "require('./other');\n",
    'notes.md': 'not source\n',
  });
});

after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } // error-ok
});

const relOf = (g, p) => g.rel(p);

function edgesFrom(g, relPath) {
  const abs = path.join(ROOT, relPath);
  return g.edges.filter((e) => e.from === abs).map((e) => ({ to: g.rel(e.to), kind: e.kind }));
}

describe('collectSourceFiles', () => {
  it('finds JS/TS sources and skips node_modules and non-source files', () => {
    const files = collectSourceFiles(ROOT).map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    assert.ok(files.includes('a.js'));
    assert.ok(files.includes('types.ts'));
    assert.ok(!files.some((f) => f.includes('node_modules')), 'node_modules must be excluded');
    assert.ok(!files.includes('notes.md'), 'non-source extensions must be excluded');
  });
});

describe('edge classification', () => {
  let g;
  before(() => { g = buildImportGraph({ projectRoot: ROOT }); });

  it('classifies top-level import and require as static', () => {
    const e = edgesFrom(g, 'a.js');
    assert.deepStrictEqual(
      e.sort((x, y) => (x.to < y.to ? -1 : 1)),
      [{ to: 'b.js', kind: 'static' }, { to: 'c.js', kind: 'static' }],
    );
  });

  it('classifies export-from as static', () => {
    assert.deepStrictEqual(edgesFrom(g, 'b.js'), [{ to: 'c.js', kind: 'static' }]);
  });

  it('classifies in-function require and dynamic import as lazy', () => {
    const kinds = edgesFrom(g, 'lazy.js');
    assert.strictEqual(kinds.length, 2);
    assert.ok(kinds.every((k) => k.kind === 'lazy'), `expected all lazy, got ${JSON.stringify(kinds)}`);
  });

  it('classifies import type as type', () => {
    assert.deepStrictEqual(edgesFrom(g, 'types.ts'), [{ to: 'c.js', kind: 'type' }]);
  });

  it('records no edge for bare package specifiers', () => {
    assert.deepStrictEqual(edgesFrom(g, 'ext.js'), []);
  });

  it('honours the import-cycle-ok suppression marker', () => {
    assert.deepStrictEqual(edgesFrom(g, 'suppressed.js'), []);
  });

  it('carries a 1-based line number for every edge', () => {
    const e = g.edges.find((x) => x.from === path.join(ROOT, 'b.js'));
    assert.strictEqual(e.line, 1);
    const lazyDyn = g.edges.filter((x) => x.from === path.join(ROOT, 'lazy.js'));
    assert.ok(lazyDyn.every((x) => x.line >= 1), 'line numbers must be 1-based');
  });
});

describe('specifier resolution', () => {
  let g;
  before(() => { g = buildImportGraph({ projectRoot: ROOT }); });

  it('resolves a directory to its index file', () => {
    assert.deepStrictEqual(edgesFrom(g, 'uses-dir.js'), [{ to: 'dir/index.js', kind: 'static' }]);
  });

  it('resolves an extensionless specifier by retrying extensions', () => {
    assert.deepStrictEqual(edgesFrom(g, 'uses-ts.js'), [{ to: 'types.ts', kind: 'static' }]);
  });
});

describe('staticGraph is exactly the cycle-forming view', () => {
  let g;
  before(() => { g = buildImportGraph({ projectRoot: ROOT }); });

  it('excludes lazy edges — import-cycle depends on this', () => {
    const lazyAbs = path.join(ROOT, 'lazy.js');
    assert.strictEqual(g.staticGraph.get(lazyAbs).size, 0,
      'a deferred require does not form a runtime cycle');
    assert.strictEqual(g.fullGraph.get(lazyAbs).size, 2,
      'but it IS real coupling, so the full view keeps it');
  });

  it('excludes type-only edges, which are erased at build time', () => {
    const typesAbs = path.join(ROOT, 'types.ts');
    assert.strictEqual(g.staticGraph.get(typesAbs).size, 0);
    assert.strictEqual(g.fullGraph.get(typesAbs).size, 1);
  });

  it('counts staticEdgeCount over the static view only', () => {
    let manual = 0;
    for (const s of g.staticGraph.values()) manual += s.size;
    assert.strictEqual(g.staticEdgeCount, manual);
    assert.ok(g.staticEdgeCount < g.edges.length,
      'the fixture has lazy/type edges, so static must be the smaller number');
  });
});

describe('tarjanSCC', () => {
  it('finds the planted 2-file cycle in the static view', () => {
    const g = buildImportGraph({ projectRoot: ROOT });
    const multi = tarjanSCC(g.staticGraph).filter((s) => s.length >= 2);
    assert.strictEqual(multi.length, 1, 'exactly one cycle in the fixture');
    const rels = multi[0].map((a) => g.rel(a)).sort();
    assert.deepStrictEqual(rels, ['cyc1.js', 'cyc2.js']);
  });

  it('returns one singleton SCC per node in an acyclic graph', () => {
    const graph = new Map([['a', new Set(['b'])], ['b', new Set(['c'])], ['c', new Set()]]);
    const sccs = tarjanSCC(graph);
    assert.strictEqual(sccs.length, 3);
    assert.ok(sccs.every((s) => s.length === 1));
  });

  it('survives a deep chain without blowing the stack (it is iterative)', () => {
    const graph = new Map();
    const N = 20000;
    for (let i = 0; i < N; i += 1) graph.set(`n${i}`, new Set(i + 1 < N ? [`n${i + 1}`] : []));
    assert.strictEqual(tarjanSCC(graph).length, N);
  });
});

describe('reverseGraph', () => {
  it('inverts direction so dependents can be counted', () => {
    const graph = new Map([['a', new Set(['c'])], ['b', new Set(['c'])], ['c', new Set()]]);
    const rev = reverseGraph(graph);
    assert.deepStrictEqual([...rev.get('c')].sort(), ['a', 'b']);
    assert.strictEqual(rev.get('a').size, 0);
  });
});

describe('require / import() / path literals are read through the one stripper (2026-09-05)', () => {
  // The line-level `//` stripper this replaced could not see a block comment
  // or a template literal spanning lines: a `require('./x')` quoted inside
  // either was a coupling edge, and a path string in a comment was a registry
  // reference. Control pair per shape.
  let R;
  let g;
  before(() => {
    R = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-import-graph-strip-'));
    writeTree(R, {
      'src/a.js': 'module.exports = 1;\n',
      'src/b.js': 'module.exports = 2;\n',
      'src/c.js': 'module.exports = 3;\n',
      // POSITIVE CONTROLS — real code: a top-level require, a lazy require, a dynamic import, a path string.
      'src/real.js': "const a = require('./a.js');\nfunction f() {\n  return require('./b.js');\n}\nexport const p = () => import('./c.js');\nconst reg = { x: './a.js' };\n",
      // NEGATIVE CONTROLS — the same text inside a block comment, a template literal, a string, a line comment.
      'src/fake.js': "/* const a = require('./a.js');\n   see ./b.js */\nconst t = `require('./c.js')\n  ./a.js`;\nconst s = \"require('./b.js')\";\n// require('./c.js') and ./b.js\nmodule.exports = 0;\n",
    });
    g = buildImportGraph({ projectRoot: R });
  });
  after(() => fs.rmSync(R, { recursive: true, force: true }));
  const edgesFrom = (rel) => g.edges.filter((e) => g.rel(e.from) === rel).map((e) => `${g.rel(e.to)}:${e.kind}`).sort();

  it('POSITIVE CONTROL — code edges are all read: static, lazy, dynamic, path-literal', () => {
    assert.deepStrictEqual(edgesFrom('src/real.js'), ['src/a.js:path-literal', 'src/a.js:static', 'src/b.js:lazy', 'src/c.js:lazy']);
  });
  it('NEGATIVE CONTROL — nothing inside a block comment, a template literal, a string or a line comment is an edge', () => {
    assert.deepStrictEqual(edgesFrom('src/fake.js'), []);
  });
});

describe('isTopLevel', () => {
  it('treats zero indentation as module scope', () => {
    assert.strictEqual(isTopLevel("const x = require('./y');"), true);
    assert.strictEqual(isTopLevel("  const x = require('./y');"), false);
    assert.strictEqual(isTopLevel(''), false);
  });
});

// ---------------------------------------------------------------------------
// Dynamic-registry edges (KI #96)
// ---------------------------------------------------------------------------
// Plugin registries reference code by PATH STRING, not by require:
// `registry.js` maps every GateTest module as `accessibility: '../modules/…'`.
// Because no resolver saw those, a dead-code signal called 115 live files
// unreachable — including src/modules/accessibility.js. Measured on this repo:
// 217 falsely-unreachable files before the pass, 102 after, while the one
// genuinely dead file (try-fix.js, KI #84) stayed flagged.

describe('path-literal edges (dynamic registries)', () => {
  it('records an edge for a relative path string that resolves', () => {
    const g = buildImportGraph({ projectRoot: ROOT });
    const from = path.join(ROOT, 'registry.js');
    const targets = [...(g.fullGraph.get(from) || [])].map((p) => relOf(g, p)).sort();
    assert.deepStrictEqual(targets, ['b.js', 'c.js']);
  });

  it('labels them a distinct kind so callers can tell them apart', () => {
    const g = buildImportGraph({ projectRoot: ROOT });
    const kinds = g.edges
      .filter((e) => relOf(g, e.from) === 'registry.js')
      .map((e) => e.kind);
    assert.deepStrictEqual([...new Set(kinds)], ['path-literal']);
  });

  it('NEGATIVE CONTROL — a path string that does not resolve is not an edge', () => {
    // Otherwise every quoted filename in a comment or error message would
    // invent coupling that does not exist.
    const g = buildImportGraph({ projectRoot: ROOT });
    const from = path.join(ROOT, 'ghost.js');
    assert.deepStrictEqual([...(g.fullGraph.get(from) || [])], []);
  });

  it('NEGATIVE CONTROL — prose mentioning a path is not an edge', () => {
    const g = buildImportGraph({ projectRoot: ROOT });
    const from = path.join(ROOT, 'prose.js');
    assert.deepStrictEqual([...(g.fullGraph.get(from) || [])], []);
  });

  it('does NOT change staticGraph — import-cycle must be unaffected', () => {
    // staticGraph is the cycle-forming view and was verified byte-identical to
    // import-cycle's old private graph. A registry reference is real coupling
    // but cannot form a require-time cycle, so it must stay out of this view.
    const g = buildImportGraph({ projectRoot: ROOT });
    const from = path.join(ROOT, 'registry.js');
    assert.deepStrictEqual([...(g.staticGraph.get(from) || [])], []);
    for (const e of g.edges) {
      if (e.kind === 'path-literal') {
        assert.ok(
          !(g.staticGraph.get(e.from) || new Set()).has(e.to),
          'a path-literal edge leaked into staticGraph'
        );
      }
    }
  });
});

// ── KI #96 step 3: the shapes that hid live files from reachability ──────────
describe('import-graph — aliases, workspaces, root-relative strings, multi-line imports', () => {
  let R;
  before(() => {
    R = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-import-graph-ki96-'));
    writeTree(R, {
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["src/*"] } } }',
      'tsconfig.json': '{ "extends": "./tsconfig.base.json", /* comment */ "include": ["**/*.ts"], }',
      'web/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./*"], "@lib/*": ["../lib/*"] } } }',
      'web/app/page.tsx': 'import { cn } from "@/app/lib/cn";\nimport gate from "@lib/gate";\nexport default function P() { return cn(gate); }\n',
      'web/app/lib/cn.ts': 'export const cn = (x: string) => x;\n',
      'lib/gate.js': 'module.exports = 1;\n',
      'src/index.ts': 'import { fmt } from "~/util/fmt";\nimport {\n  a,\n  b,\n} from "./multi";\nimport { esm } from "./esm.js";\nexport const main = () => fmt(a + b + esm);\n',
      'src/esm.ts': 'export const esm = 3;\n',
      'src/util/fmt.ts': 'export const fmt = (x: number) => String(x);\n',
      'src/multi.ts': 'export const a = 1; export const b = 2;\n',
      'packages/tool/package.json': JSON.stringify({ name: '@acme/tool', main: 'lib/main.js' }),
      'packages/tool/lib/main.js': 'module.exports = {};\n',
      'packages/tool/lib/extra.js': 'module.exports = {};\n',
      'uses-ws.js': "const t = require('@acme/tool');\nconst e = require('@acme/tool/lib/extra.js');\nconst x = require('left-pad');\n",
      'typed.ts': "import type { T } from 'left-pad';\nimport lp from 'left-pad';\nimport type { U } from 'only-types';\nexport const x = lp(1 as unknown as T as unknown as U);\n",
      'bin/doctor.js': "const { diagnose } = require(path.join(ROOT, 'src/doctor/diagnose.js'));\n",
      'src/doctor/diagnose.js': 'module.exports = {};\n',
    });
  });
  after(() => fs.rmSync(R, { recursive: true, force: true }));

  const kindsInto = (g, rel) => g.edges.filter((e) => g.rel(e.to) === rel).map((e) => `${e.kind}:${g.rel(e.from)}`).sort();

  it('resolves tsconfig path aliases, including one defined through `extends`', () => {
    const g = buildImportGraph({ projectRoot: R });
    assert.deepStrictEqual(kindsInto(g, 'web/app/lib/cn.ts'), ['alias:web/app/page.tsx']);
    assert.deepStrictEqual(kindsInto(g, 'lib/gate.js'), ['alias:web/app/page.tsx']);
    assert.deepStrictEqual(kindsInto(g, 'src/util/fmt.ts'), ['alias:src/index.ts']);
  });
  it('resolves a workspace package by name and by subpath; an external package stays external', () => {
    const g = buildImportGraph({ projectRoot: R });
    assert.deepStrictEqual(kindsInto(g, 'packages/tool/lib/main.js'), ['workspace:uses-ws.js']);
    assert.deepStrictEqual(kindsInto(g, 'packages/tool/lib/extra.js'), ['workspace:uses-ws.js']);
    assert.ok(!g.edges.some((e) => g.rel(e.to).includes('left-pad')));
  });
  it('a root-relative path string that resolves is a path-literal edge', () => {
    const g = buildImportGraph({ projectRoot: R });
    assert.deepStrictEqual(kindsInto(g, 'src/doctor/diagnose.js'), ['path-literal:bin/doctor.js']);
  });
  it('externals: a bare package specifier is a package import whether or not it resolves in-repo; a path alias and a scheme are not (2026-09-05)', () => {
    // dependencyReachability reads this instead of its own regex harvester.
    // A workspace package is both an edge and a package import (nest's
    // `@nestjs/common` is a published name); `@/x` has no scope and is a
    // path alias, not a package.
    const g = buildImportGraph({ projectRoot: R });
    const ext = (rel) => [...(g.externals.get(path.join(R, rel)) || new Map()).keys()].sort();
    assert.deepStrictEqual(ext('uses-ws.js'), ['@acme/tool', '@acme/tool/lib/extra.js', 'left-pad']);
    assert.deepStrictEqual(ext('web/app/page.tsx').filter((s) => s.startsWith('@/')), []);
    assert.deepStrictEqual(ext('src/index.ts'), []);
    assert.deepStrictEqual(ext('bin/doctor.js'), []);
    // Each external says how it resolved and where it was first seen, so a
    // consumer can tell a missing package from a monorepo's own package.
    const ws = g.externals.get(path.join(R, 'uses-ws.js'));
    assert.deepStrictEqual(ws.get('@acme/tool'), { line: 1, via: 'workspace', typeOnly: false });
    assert.deepStrictEqual(ws.get('left-pad'), { line: 3, via: 'unresolved', typeOnly: false });
    assert.deepStrictEqual(g.externals.get(path.join(R, 'web/app/page.tsx')).get('@lib/gate'), { line: 2, via: 'alias', typeOnly: false });
    // A value import outranks a type import of the same package: the entry
    // is the strongest use, not the first line seen.
    const typed = g.externals.get(path.join(R, 'typed.ts'));
    assert.deepStrictEqual(typed.get('left-pad'), { line: 2, via: 'unresolved', typeOnly: false });
    assert.deepStrictEqual(typed.get('only-types'), { line: 3, via: 'unresolved', typeOnly: true });
    assert.strictEqual(g.skipped.size, 0);
  });
  it('a `.js` specifier written for a `.ts` on disk is an edge — outside staticGraph, so import-cycle is unchanged', () => {
    const g = buildImportGraph({ projectRoot: R });
    assert.deepStrictEqual(kindsInto(g, 'src/esm.ts'), ['ts-esm:src/index.ts']);
    const idx = path.join(R, 'src/index.ts');
    assert.ok(!g.staticGraph.get(idx).has(path.join(R, 'src/esm.ts')));
  });
  it('the closing line of a multi-line import is an edge', () => {
    const g = buildImportGraph({ projectRoot: R });
    assert.deepStrictEqual(kindsInto(g, 'src/multi.ts'), ['multiline:src/index.ts']);
  });
  it('none of the new kinds enter staticGraph — import-cycle sees exactly what it saw before', () => {
    const g = buildImportGraph({ projectRoot: R });
    const statics = new Set(['static', 'type']);
    for (const e of g.edges) {
      if (!statics.has(e.kind)) assert.ok(!g.staticGraph.get(e.from).has(e.to), `${e.kind} edge leaked into staticGraph`);
    }
    assert.strictEqual(g.staticEdgeCount, 0);
  });
});

// ── KI #96 follow-up: type-only elision and the load / deferred split ────────
// What tsc, esbuild and swc do to `import { A } from './a.js'` when A is only
// ever a type: drop it. Until the graph modelled that, every NodeNext `.js`
// specifier was kept out of the cycle view (letting them in produced 15 false
// cycles on nest through `.interface.ts` files), so import-cycle reported
// silence on every such project. Each control below names the corpus shape
// it came from; the classifier was checked against `ts.transpileModule` on
// 33,011 import statements across eight repositories (0 disagreements in
// the elide-when-tsc-keeps direction outside JSX, which is not analysed).
describe('import-graph — type-only elision (TypeScript NodeNext)', () => {
  let E;
  let g;
  before(() => {
    E = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-import-graph-elide-'));
    writeTree(E, {
      // `a.ts` imports each file under test back, so every one sits inside a
      // candidate cycle: the use-scan runs only there (elision can only remove
      // edges, so a file outside every cycle needs no scan — see the lazy-scan
      // control pair below).
      'src/a.ts': "export class A { static k = 1; }\nimport './types-only.js';\nimport './value-use.js';\nimport './deferred-use.js';\nimport './multi.js';\nimport './inline-type.js';\n",
      // POSITIVE CONTROL — used only in type positions (nest's *.interface.ts): elided.
      'src/types-only.ts': "import { A } from './a.js';\nexport function f(x: A): Array<A> { return [x]; }\nexport interface I extends A { y?: A }\n",
      // NEGATIVE CONTROL — the same import with ONE value use at module scope: load-time.
      'src/value-use.ts': "import { A } from './a.js';\nexport class B extends A {}\n",
      // The same import read only inside a function body: runtime, but deferred
      // (the ESM shape of a lazy require — every nest/apollo/hono cycle was this).
      'src/deferred-use.ts': "import { A } from './a.js';\nexport function make() { return new A(); }\n",
      // Re-exports: `export { A } from` evaluates the module; `export type` does not.
      'src/reexport-value.ts': "export { A } from './a.js';\n",
      'src/reexport-type.ts': "export type { A } from './a.js';\n",
      'src/reexport-inline-type.ts': "export { type A } from './a.js';\n",
      // Inline `type` modifier on the only binding: elided (trpc's createUtilityFunctions).
      'src/inline-type.ts': "import { type A } from './a.js';\nexport class C extends A {}\n",
      // JavaScript has no types: an unused import still loads the module.
      'src/plain.js': "import { A } from './a.js';\nexport const k = 1;\n",
      // JSX is not analysed: kept as load-time and reported as unchecked.
      'src/comp.tsx': "import { A } from './a.js';\nexport const C = () => <A />;\n",
      // Multi-line import with a load-time use keeps the pre-existing 'multiline' kind.
      'src/multi.ts': "import {\n  A,\n} from './a.js';\nexport const x = A.k;\n",
    });
    g = buildImportGraph({ projectRoot: E });
  });
  after(() => fs.rmSync(E, { recursive: true, force: true }));

  const edge = (relFrom) => g.edges.find((e) => g.rel(e.from) === relFrom && g.rel(e.to) === 'src/a.ts');
  const inView = (view, relFrom) => (g[view].get(path.join(E, relFrom)) || new Set()).has(path.join(E, 'src/a.ts'));

  it('POSITIVE CONTROL — an import used only in type positions is elided (kind type, via ts-esm)', () => {
    assert.deepStrictEqual({ kind: edge('src/types-only.ts').kind, via: edge('src/types-only.ts').via }, { kind: 'type', via: 'ts-esm' });
    assert.ok(!inView('runtimeGraph', 'src/types-only.ts') && !inView('loadGraph', 'src/types-only.ts'));
  });
  it('NEGATIVE CONTROL — one value use at module scope makes it a load-time runtime edge', () => {
    assert.deepStrictEqual({ kind: edge('src/value-use.ts').kind, use: edge('src/value-use.ts').use }, { kind: 'ts-esm', use: 'load' });
    assert.ok(inView('runtimeGraph', 'src/value-use.ts') && inView('loadGraph', 'src/value-use.ts'));
  });
  it('a value use only inside a function body is a runtime edge that is deferred — in runtimeGraph, not loadGraph', () => {
    assert.strictEqual(edge('src/deferred-use.ts').use, 'deferred');
    assert.ok(inView('runtimeGraph', 'src/deferred-use.ts'));
    assert.ok(!inView('loadGraph', 'src/deferred-use.ts'));
  });
  it('`export { A } from` is a load-time re-export; `export type` / `export { type A }` are elided', () => {
    assert.strictEqual(edge('src/reexport-value.ts').use, 'load');
    assert.strictEqual(edge('src/reexport-type.ts').kind, 'type');
    assert.strictEqual(edge('src/reexport-inline-type.ts').kind, 'type');
  });
  it('an inline `type` modifier on the only binding elides the import even when the name is used as a value', () => {
    // tsc erases the binding; `extends A` would be a compile error, not a runtime edge.
    assert.strictEqual(edge('src/inline-type.ts').kind, 'type');
  });
  it('JavaScript is never elided — an unused import still loads the module', () => {
    assert.deepStrictEqual({ kind: edge('src/plain.js').kind, use: edge('src/plain.js').use }, { kind: 'ts-esm', use: 'load' });
  });
  it('JSX is kept as load-time and reported as unchecked (Doctrine §6)', () => {
    assert.strictEqual(edge('src/comp.tsx').use, 'load');
    assert.deepStrictEqual(g.unchecked.jsx.map((f) => g.rel(f)), ['src/comp.tsx']);
  });
  it('a multi-line import keeps the multiline kind and enters runtimeGraph, never staticGraph', () => {
    assert.deepStrictEqual({ kind: edge('src/multi.ts').kind, use: edge('src/multi.ts').use }, { kind: 'multiline', use: 'load' });
    assert.ok(inView('runtimeGraph', 'src/multi.ts') && !inView('staticGraph', 'src/multi.ts'));
  });
  it('staticGraph still holds only kind static — the pre-elision view the extraction tests pinned', () => {
    for (const e of g.edges) if (e.kind !== 'static') assert.ok(!g.staticGraph.get(e.from).has(e.to), `${e.kind} leaked into staticGraph`);
  });
});

describe('import-graph — the use-scan runs only inside candidate cycles (Doctrine §14)', () => {
  // Elision can only REMOVE edges. A file outside every strongly connected
  // component of the unscanned graph therefore cannot be in a cycle after
  // scanning, so its provisional labels are already right for every cycle view
  // and the scanner never reads it. prisma: 14 of 4,551 files scanned.
  let L;
  let g;
  before(() => {
    L = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-import-graph-lazy-'));
    writeTree(L, {
      'src/a.ts': "export class A {}\nimport './in-cycle.js';\n",
      // Inside a candidate cycle with a.ts: scanned, and elided (type-only use).
      'src/in-cycle.ts': "import { A } from './a.js';\nexport type T = A;\n",
      // Outside every cycle: identical text, never scanned — provisional load edge.
      'src/leaf.ts': "import { A } from './a.js';\nexport type U = A;\n",
      // Decided without a scan: explicit `import type`, and a declaration file.
      'src/explicit.ts': "import type { A } from './a.js';\nexport type V = A;\n",
      'src/decl.d.ts': "import { A } from './a.js';\nexport declare const w: A;\n",
    });
    g = buildImportGraph({ projectRoot: L });
  });
  after(() => fs.rmSync(L, { recursive: true, force: true }));
  const edge = (relFrom) => g.edges.find((e) => g.rel(e.from) === relFrom && g.rel(e.to) === 'src/a.ts');

  it('POSITIVE CONTROL — inside the candidate cycle the type-only use is scanned and elided', () => {
    assert.strictEqual(edge('src/in-cycle.ts').kind, 'type');
    assert.ok(!(g.runtimeGraph.get(path.join(L, 'src/in-cycle.ts')) || new Set()).has(path.join(L, 'src/a.ts')));
  });
  it('NEGATIVE CONTROL — outside every cycle the same text is not scanned: a provisional load edge, no cycle view changes', () => {
    assert.deepStrictEqual({ kind: edge('src/leaf.ts').kind, use: edge('src/leaf.ts').use }, { kind: 'ts-esm', use: 'load' });
    assert.deepStrictEqual(g.elision, { scanned: 1, pending: 1 });
  });
  it('an explicit `import type` and a `.d.ts` import are decided without any scan', () => {
    assert.strictEqual(edge('src/explicit.ts').kind, 'type');
    assert.strictEqual(edge('src/decl.d.ts').kind, 'type');
  });
});

describe('import-graph — verbatimModuleSyntax disables elision, isolatedModules does not', () => {
  // tsc keeps every import as written under verbatimModuleSyntax /
  // preserveValueImports / importsNotUsedAsValues: preserve|error;
  // `isolatedModules` alone (got's tsconfig) still elides.
  const build = (tsconfig) => {
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-import-graph-verbatim-'));
    writeTree(R, {
      'tsconfig.json': JSON.stringify({ compilerOptions: tsconfig }),
      'src/a.ts': "export class A {}\nimport './types-only.js';\n",
      'src/types-only.ts': "import { A } from './a.js';\nexport function f(x: A): A { return x; }\n",
    });
    const gr = buildImportGraph({ projectRoot: R });
    const e = gr.edges.find((x) => gr.rel(x.from) === 'src/types-only.ts');
    fs.rmSync(R, { recursive: true, force: true });
    return e;
  };
  it('verbatimModuleSyntax: the type-only-used import is KEPT as a load-time edge', () => {
    assert.deepStrictEqual({ kind: build({ verbatimModuleSyntax: true }).kind, use: build({ verbatimModuleSyntax: true }).use }, { kind: 'ts-esm', use: 'load' });
  });
  it('importsNotUsedAsValues: preserve — kept', () => {
    assert.strictEqual(build({ importsNotUsedAsValues: 'preserve' }).kind, 'ts-esm');
  });
  it('isolatedModules alone — still elided (control for the flag above)', () => {
    assert.strictEqual(build({ isolatedModules: true }).kind, 'type');
  });
});

describe('import-graph — Docusaurus `@site/*` resolves to the site root by convention (2026-09-05)', () => {
  // The tsconfig that declares the alias is `@docusaurus/tsconfig` inside
  // node_modules, so no project file says so. trpc's www/: five components
  // imported only from .mdx docs were "unreachable" for this.
  let D;
  let g;
  before(() => {
    D = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-import-graph-docusaurus-'));
    writeTree(D, {
      'www/docusaurus.config.js': 'module.exports = { title: "docs" };\n',
      'www/src/components/Card.tsx': 'export const Card = () => null;\n',
      'www/docs/intro.mdx': "import { Card } from '@site/src/components/Card';\nimport Layout from '@theme/Layout';\n\n<Card />\n",
      // NEGATIVE CONTROL — the same import in a tree with no docusaurus.config: not an edge.
      'other/src/components/Card.tsx': 'export const Card = () => null;\n',
      'other/docs/intro.mdx': "import { Card } from '@site/src/components/Card';\n",
    });
    const files = collectSourceFiles(D).concat([path.join(D, 'www/docs/intro.mdx'), path.join(D, 'other/docs/intro.mdx')]);
    g = buildImportGraph({ projectRoot: D, files });
  });
  after(() => fs.rmSync(D, { recursive: true, force: true }));
  const edgesFrom = (rel) => g.edges.filter((e) => g.rel(e.from) === rel).map((e) => `${g.rel(e.to)}:${e.kind}`).sort();

  it('POSITIVE CONTROL — under a docusaurus.config, `@site/src/…` is an edge; `@theme/*` stays external', () => {
    assert.deepStrictEqual(edgesFrom('www/docs/intro.mdx'), ['www/src/components/Card.tsx:alias']);
  });
  it('NEGATIVE CONTROL — without a docusaurus.config the alias is nothing', () => {
    assert.deepStrictEqual(edgesFrom('other/docs/intro.mdx'), []);
  });
});

describe('import-graph — a specifier built from __dirname / process.cwd() / a const derived from them is an edge (2026-09-13)', () => {
  // scripts/ops/mail-test.js and scripts/real-world-precision.js in this
  // repo require through `path.join(__dirname, …)` / `path.join(ROOT, …)`;
  // their targets were reported shipped-but-unreachable.
  let D;
  let g;
  before(() => {
    D = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-import-graph-computed-'));
    writeTree(D, {
      'lib/util.js': 'module.exports = { helper: () => 1 };\n',
      'lib/other.js': 'module.exports = { other: () => 2 };\n',
      'lib/third.js': 'module.exports = { third: () => 3 };\n',
      'lib/dyn.js': 'module.exports = { dyn: () => 4 };\n',
      'tools/run.js': [
        "const path = require('path');",
        "const ROOT = path.resolve(__dirname, '..');",
        "const { helper } = require(path.join(__dirname, '..', 'lib', 'util.js'));",
        'const { other } = require(path.resolve(',
        "  ROOT, 'lib', 'other'",
        '));',
        "const third = require(path.join(process.cwd(), 'lib/third.js'));",
        // NEGATIVE CONTROL — a variable segment cannot be resolved and must not be guessed.
        "const name = 'dyn.js';",
        "const dyn = require(path.join(__dirname, '..', 'lib', name));",
        'module.exports = { helper, other, third, dyn };',
        '',
      ].join('\n'),
    });
    g = buildImportGraph({ projectRoot: D });
  });
  after(() => fs.rmSync(D, { recursive: true, force: true }));

  it('POSITIVE CONTROL — __dirname, a const from __dirname, and process.cwd() bases resolve, on the statement\'s own line', () => {
    const edges = g.edges.filter((e) => g.rel(e.from) === 'tools/run.js').map((e) => `${g.rel(e.to)}:${e.kind}:${e.line}`).sort();
    assert.deepStrictEqual(edges, ['lib/other.js:static:4', 'lib/third.js:static:7', 'lib/util.js:static:3']);
  });
  it('NEGATIVE CONTROL — a variable segment is no edge', () => {
    assert.ok(!g.edges.some((e) => g.rel(e.to) === 'lib/dyn.js'), 'lib/dyn.js must stay unreferenced');
  });
});
