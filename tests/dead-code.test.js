const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DeadCodeModule = require('../src/modules/dead-code');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot, extraConfig = {}) {
  const mod = new DeadCodeModule();
  const result = makeResult();
  return mod.run(result, { projectRoot, ...extraConfig }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('DeadCodeModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dc-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no source files exist', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'dead-code:no-files'));
  });

  it('records a summary when source files are scanned', async () => {
    write(tmp, 'src/index.js', 'console.log("hi");\n');
    const r = await run(tmp);
    const summary = r.checks.find((c) => c.name === 'dead-code:summary');
    assert.ok(summary);
    assert.match(summary.message, /1 file\(s\)/);
  });
});

describe('DeadCodeModule — unused JS/TS exports', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dc-js-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('flags an exported function that nothing imports', async () => {
    write(tmp, 'src/lib.js', [
      'export function unusedHelper() { return 42; }',
      '',
    ].join('\n'));
    write(tmp, 'src/index.js', 'console.log("entry");\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('dead-code:unused-export:'));
    assert.ok(hit, 'expected unused-export finding');
    assert.strictEqual(hit.severity, 'warning');
    assert.strictEqual(hit.export, 'unusedHelper');
  });

  it('does NOT flag an exported function that is imported elsewhere', async () => {
    write(tmp, 'src/lib.js', 'export function helper() { return 1; }\n');
    write(tmp, 'src/index.js', [
      'import { helper } from "./lib";',
      'console.log(helper());',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('dead-code:unused-export:')),
      undefined,
    );
  });

  it('handles module.exports.X syntax', async () => {
    write(tmp, 'src/lib.js', 'module.exports.deadOne = () => 1;\n');
    write(tmp, 'src/index.js', 'console.log("hi");\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.export === 'deadOne');
    assert.ok(hit);
  });

  it('handles require() with destructuring', async () => {
    write(tmp, 'src/lib.js', [
      'function usedOne() { return 1; }',
      'module.exports.usedOne = usedOne;',
      '',
    ].join('\n'));
    write(tmp, 'src/index.js', [
      'const { usedOne } = require("./lib");',
      'console.log(usedOne());',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('dead-code:unused-export:')),
      undefined,
    );
  });

  it('does NOT flag framework-reserved names (default, GET, metadata)', async () => {
    write(tmp, 'app/route.ts', [
      'export function GET() { return new Response("ok"); }',
      'export function POST() { return new Response("ok"); }',
      'export const metadata = { title: "x" };',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter((c) => c.name.startsWith('dead-code:unused-export:'));
    assert.strictEqual(hits.length, 0);
  });

  it('does NOT flag Next.js route segment config (dynamic, revalidate, runtime)', async () => {
    write(tmp, 'app/api/x/route.ts', [
      'export const dynamic = "force-dynamic";',
      'export const revalidate = 0;',
      'export const runtime = "edge";',
      'export const maxDuration = 60;',
      'export async function GET() { return new Response("ok"); }',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter((c) => c.name.startsWith('dead-code:unused-export:'));
    assert.strictEqual(hits.length, 0, `unexpected findings: ${JSON.stringify(hits, null, 2)}`);
  });
});

describe('DeadCodeModule — module.exports = { a, b } shorthand', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dc-cjsobj-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('flags the unused half of a two-export module.exports = { used, unused } object', async () => {
    // Corpus shape (src/utils/dead.js): the object-literal export form was
    // invisible to both the acorn path (CJS assignments aren't ESM export
    // nodes) and the regex fallback (only `exports.NAME =` was matched),
    // so the whole file came back with ZERO exports and every downstream
    // check (unused-export, orphan-file) silently had nothing to flag.
    write(tmp, 'src/dead.js', [
      'function legacyFormatCurrency(amount) {',
      '  return "$" + amount.toFixed(2);',
      '}',
      '',
      'function formatCurrency(amount) {',
      '  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);',
      '}',
      '',
      'module.exports = { formatCurrency, legacyFormatCurrency };',
      '',
    ].join('\n'));
    write(tmp, 'src/index.js', [
      'const { formatCurrency } = require("./dead");',
      'console.log(formatCurrency(1));',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.export === 'formatCurrency'),
      undefined,
      'formatCurrency is imported by name elsewhere — must not be flagged',
    );
    assert.ok(
      r.checks.find((c) => c.export === 'legacyFormatCurrency'),
      'legacyFormatCurrency is referenced nowhere — must be flagged as an unused named CommonJS export',
    );
  });

  it('does NOT treat a module.exports = { a, b } shape nested inside a string literal as a real export', async () => {
    write(tmp, 'src/log.js', [
      'console.log("Example: module.exports = { totallyFake, alsoFake };");',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.export === 'totallyFake'), undefined);
    assert.strictEqual(r.checks.find((c) => c.export === 'alsoFake'), undefined);
  });
});

describe('DeadCodeModule — unused Python exports', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dc-py-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('flags a top-level def that nothing imports', async () => {
    write(tmp, 'src/lib.py', [
      'def unused_helper():',
      '    return 42',
      '',
    ].join('\n'));
    write(tmp, 'src/main.py', 'print("hi")\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.export === 'unused_helper'));
  });

  it('does NOT flag a def imported via from X import', async () => {
    write(tmp, 'src/lib.py', [
      'def used_helper():',
      '    return 42',
      '',
    ].join('\n'));
    write(tmp, 'src/main.py', [
      'from lib import used_helper',
      'print(used_helper())',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.export === 'used_helper'),
      undefined,
    );
  });

  it('does NOT flag private (_prefixed) functions — they are intentionally internal', async () => {
    write(tmp, 'src/lib.py', [
      'def _private_helper():',
      '    return 42',
      '',
    ].join('\n'));
    write(tmp, 'src/main.py', 'print("hi")\n');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.export === '_private_helper'),
      undefined,
    );
  });
});

describe('DeadCodeModule — orphaned files', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dc-orph-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('flags a file with exports that nothing imports', async () => {
    write(tmp, 'src/orphan.js', 'export function foo() {}\n');
    write(tmp, 'src/index.js', 'console.log("entry");\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('dead-code:orphan-file:')));
  });

  it('does NOT flag an index file as orphaned', async () => {
    write(tmp, 'src/index.js', 'export function foo() {}\n');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('dead-code:orphan-file:')),
      undefined,
    );
  });

  it('does NOT flag a file under tests/ as orphaned', async () => {
    write(tmp, 'tests/foo.test.js', 'export function foo() {}\n');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('dead-code:orphan-file:')),
      undefined,
    );
  });

  it('does NOT flag a referenced file as orphaned', async () => {
    write(tmp, 'src/lib.js', 'export function foo() {}\n');
    write(tmp, 'src/index.js', [
      'import { foo } from "./lib";',
      'foo();',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('dead-code:orphan-file:')),
      undefined,
    );
  });

  it('does NOT flag Next.js convention files (page/layout/route)', async () => {
    write(tmp, 'app/dashboard/page.tsx', 'export default function Page() { return null; }\n');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('dead-code:orphan-file:')),
      undefined,
    );
  });

  it('does NOT flag Next.js metadata files (robots.ts, sitemap.ts, opengraph-image.tsx)', async () => {
    write(tmp, 'app/robots.ts', 'export default function robots() { return { rules: [] }; }\n');
    write(tmp, 'app/sitemap.ts', 'export default function sitemap() { return []; }\n');
    write(tmp, 'app/opengraph-image.tsx', [
      'export const runtime = "edge";',
      'export const alt = "hi";',
      'export const size = { width: 1200, height: 630 };',
      'export const contentType = "image/png";',
      'export default function OG() { return null; }',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('dead-code:orphan-file:')),
      undefined,
    );
  });
});

describe('DeadCodeModule — commented-out code blocks', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dc-cmt-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('flags a block of 10+ consecutive commented-out code lines (JS)', async () => {
    const block = [];
    for (let i = 0; i < 12; i += 1) {
      block.push(`// const x${i} = ${i};`);
    }
    write(tmp, 'src/index.js', [
      'export function foo() { return 1; }',
      ...block,
      'console.log("end");',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('dead-code:commented-block:')));
  });

  it('flags a block of 10+ consecutive commented-out code lines (Python)', async () => {
    const block = [];
    for (let i = 0; i < 11; i += 1) {
      block.push(`# x = ${i};`);
    }
    write(tmp, 'src/main.py', [
      'def foo():',
      '    return 1',
      ...block,
      'print("end")',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('dead-code:commented-block:')));
  });

  it('does NOT flag doc-comment banners or short comment blocks', async () => {
    write(tmp, 'src/index.js', [
      '// This function does a thing.',
      '// It takes nothing and returns nothing.',
      '// See the docs for details.',
      'export function foo() { return 1; }',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('dead-code:commented-block:')),
      undefined,
    );
  });
});

describe('DeadCodeModule — workspace package alias suppression', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dc-ws-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag exports in a workspace package that is imported by a sibling', async () => {
    // Monorepo root with packages/* workspace
    write(tmp, 'package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    write(tmp, 'packages/utils/package.json', JSON.stringify({ name: '@mono/utils' }));
    write(tmp, 'packages/utils/index.js', [
      'export function buildCaddyBlock() { return {}; }',
      'export function helperUtil() { return 1; }',
      '',
    ].join('\n'));
    // Sibling app imports the workspace package by name
    write(tmp, 'packages/app/package.json', JSON.stringify({ name: '@mono/app' }));
    write(tmp, 'packages/app/main.js', [
      'import { buildCaddyBlock } from "@mono/utils";',
      'buildCaddyBlock();',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter((c) => c.name.startsWith('dead-code:unused-export:'));
    assert.strictEqual(hits.length, 0, `unexpected findings: ${JSON.stringify(hits.map((h) => h.name))}`);
  });

  it('does NOT flag orphaned file in a workspace package that is imported by a sibling', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    write(tmp, 'packages/lib/package.json', JSON.stringify({ name: '@mono/lib' }));
    write(tmp, 'packages/lib/src/util.js', 'export function doThing() { return 42; }\n');
    write(tmp, 'packages/lib/index.js', [
      'export { doThing } from "./src/util";',
      '',
    ].join('\n'));
    write(tmp, 'packages/web/package.json', JSON.stringify({ name: '@mono/web' }));
    write(tmp, 'packages/web/index.js', [
      'import { doThing } from "@mono/lib";',
      'doThing();',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const orphans = r.checks.filter((c) => c.name.startsWith('dead-code:orphan-file:'));
    assert.strictEqual(orphans.length, 0, `unexpected orphans: ${JSON.stringify(orphans.map((h) => h.name))}`);
  });

  it('still flags exports in a workspace package that is NEVER imported', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    write(tmp, 'packages/unused-lib/package.json', JSON.stringify({ name: '@mono/unused-lib' }));
    write(tmp, 'packages/unused-lib/src/helpers.js', [
      'export function trulyDeadFn() { return 0; }',
      '',
    ].join('\n'));
    // No other package imports @mono/unused-lib
    write(tmp, 'packages/app/package.json', JSON.stringify({ name: '@mono/app' }));
    write(tmp, 'packages/app/main.js', 'console.log("hi");\n');
    const r = await run(tmp);
    const hits = r.checks.filter((c) => c.export === 'trulyDeadFn');
    assert.ok(hits.length > 0, 'should still flag truly dead export in unimported workspace package');
  });

  it('reads pnpm-workspace.yaml patterns', async () => {
    write(tmp, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    write(tmp, 'packages/tools/package.json', JSON.stringify({ name: '@pnpm/tools' }));
    write(tmp, 'packages/tools/index.js', 'export function toolFn() { return 1; }\n');
    write(tmp, 'packages/consumer/package.json', JSON.stringify({ name: '@pnpm/consumer' }));
    write(tmp, 'packages/consumer/main.js', [
      'import { toolFn } from "@pnpm/tools";',
      'toolFn();',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter((c) => c.name.startsWith('dead-code:unused-export:'));
    assert.strictEqual(hits.length, 0, `unexpected findings: ${JSON.stringify(hits.map((h) => h.name))}`);
  });

  it('handles scoped-package subpath imports (@scope/pkg/utils) correctly', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    write(tmp, 'packages/core/package.json', JSON.stringify({ name: '@acme/core' }));
    write(tmp, 'packages/core/index.js', 'export function coreApi() { return {}; }\n');
    // Consumer imports a subpath — GateTest sees the package name @acme/core prefix
    write(tmp, 'packages/app/package.json', JSON.stringify({ name: '@acme/app' }));
    write(tmp, 'packages/app/main.js', [
      'import { something } from "@acme/core/utils";',
      'something();',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter((c) => c.name.startsWith('dead-code:unused-export:'));
    assert.strictEqual(hits.length, 0, `unexpected findings from subpath import`);
  });
});

describe('DeadCodeModule — Phase 1B AST entry-surface precision', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dc-ast-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('suppresses named exports that flow through the package entry point', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    // Library package: entry re-exports from src/
    write(tmp, 'packages/lib/package.json', JSON.stringify({ name: '@acme/lib', main: 'index.js' }));
    write(tmp, 'packages/lib/index.js', [
      'export { buildPlan, validatePlan } from "./src/planner";',
      '',
    ].join('\n'));
    write(tmp, 'packages/lib/src/planner.js', [
      'export function buildPlan() { return {}; }',
      'export function validatePlan(p) { return !!p; }',
      '',
    ].join('\n'));
    // Consumer imports the package by name
    write(tmp, 'packages/app/package.json', JSON.stringify({ name: '@acme/app' }));
    write(tmp, 'packages/app/main.js', [
      'import { buildPlan } from "@acme/lib";',
      'buildPlan();',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hits = r.checks.filter((c) => c.name.startsWith('dead-code:unused-export:'));
    assert.strictEqual(hits.length, 0, `unexpected findings: ${JSON.stringify(hits.map((h) => h.name))}`);
  });

  it('suppresses files reachable via export * re-export chain', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    write(tmp, 'packages/utils/package.json', JSON.stringify({ name: '@acme/utils', main: 'index.js' }));
    // Entry barrel re-exports everything from sub-modules
    write(tmp, 'packages/utils/index.js', [
      'export * from "./helpers";',
      'export * from "./formatters";',
      '',
    ].join('\n'));
    write(tmp, 'packages/utils/helpers.js', 'export function help() { return 1; }\n');
    write(tmp, 'packages/utils/formatters.js', 'export function fmt() { return ""; }\n');
    write(tmp, 'packages/app/package.json', JSON.stringify({ name: '@acme/app' }));
    write(tmp, 'packages/app/index.js', [
      'import { help } from "@acme/utils";',
      'help();',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const orphans = r.checks.filter((c) => c.name.startsWith('dead-code:orphan-file:'));
    assert.strictEqual(orphans.length, 0, `unexpected orphans: ${JSON.stringify(orphans.map((h) => h.name))}`);
  });

  it('_parseExportsWithAcorn extracts multi-line export blocks', () => {
    const mod = new DeadCodeModule();
    const tmpFile = path.join(tmp, 'multi.js');
    fs.writeFileSync(tmpFile, [
      'export {',
      '  alpha,',
      '  beta,',
      '  gamma',
      '} from "./base";',
      'export function delta() {}',
      '',
    ].join('\n'));
    const { exports, reExportPaths } = mod._parseExportsWithAcorn(tmpFile);
    const names = exports.map((e) => e.name);
    assert.ok(names.includes('alpha'), 'should find alpha from multi-line export block');
    assert.ok(names.includes('beta'), 'should find beta');
    assert.ok(names.includes('gamma'), 'should find gamma');
    assert.ok(names.includes('delta'), 'should find delta');
    assert.ok(reExportPaths.includes('./base'), 'should capture re-export source path');
  });

  it('flags truly internal exports not in the entry surface', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    write(tmp, 'packages/lib/package.json', JSON.stringify({ name: '@acme/lib', main: 'index.js' }));
    // Entry only exposes publicFn — internalFn is not in the entry surface
    write(tmp, 'packages/lib/index.js', 'export function publicFn() { return 1; }\n');
    write(tmp, 'packages/lib/internal.js', [
      'export function internalFn() { return 2; }',
      '',
    ].join('\n'));
    write(tmp, 'packages/app/package.json', JSON.stringify({ name: '@acme/app' }));
    write(tmp, 'packages/app/main.js', [
      'import { publicFn } from "@acme/lib";',
      'publicFn();',
      '',
    ].join('\n'));
    const r = await run(tmp);
    // publicFn is in the entry surface — should not be flagged
    const publicHit = r.checks.find((c) => c.export === 'publicFn');
    assert.ok(!publicHit, 'publicFn (in entry surface) should not be flagged');
    // internal.js is not reachable from the entry — it IS an orphaned file
    const orphan = r.checks.find((c) => c.name.includes('internal.js'));
    assert.ok(orphan, 'internal.js (not in entry chain) should still be flagged');
  });
});

describe('DeadCodeModule — configurable ignore patterns', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dc-ignore-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('_matchesIgnorePattern returns false when no patterns given', () => {
    const mod = new DeadCodeModule();
    assert.strictEqual(mod._matchesIgnorePattern('src/foo.js', []), false);
    assert.strictEqual(mod._matchesIgnorePattern('src/foo.js', null), false);
    assert.strictEqual(mod._matchesIgnorePattern('src/foo.js', undefined), false);
  });

  it('_matchesIgnorePattern matches exact relative path', () => {
    const mod = new DeadCodeModule();
    assert.strictEqual(mod._matchesIgnorePattern('src/generated/schema.js', ['src/generated/schema.js']), true);
    assert.strictEqual(mod._matchesIgnorePattern('src/other.js', ['src/generated/schema.js']), false);
  });

  it('_matchesIgnorePattern matches ** glob across directories', () => {
    const mod = new DeadCodeModule();
    assert.strictEqual(mod._matchesIgnorePattern('src/generated/foo.js', ['**/generated/**']), true);
    assert.strictEqual(mod._matchesIgnorePattern('generated/foo.js', ['**/generated/**']), true);
    assert.strictEqual(mod._matchesIgnorePattern('src/live/foo.js', ['**/generated/**']), false);
  });

  it('_matchesIgnorePattern matches *.stories.* pattern', () => {
    const mod = new DeadCodeModule();
    assert.strictEqual(mod._matchesIgnorePattern('src/Button.stories.tsx', ['**/*.stories.*']), true);
    assert.strictEqual(mod._matchesIgnorePattern('Button.stories.js', ['**/*.stories.*']), true);
    assert.strictEqual(mod._matchesIgnorePattern('src/Button.tsx', ['**/*.stories.*']), false);
  });

  it('suppresses unused-export findings for ignored files', async () => {
    write(tmp, 'src/live.js', 'export function used() { return 1; }\n');
    write(tmp, 'src/stories/Live.stories.js', 'export function StoryA() { return 2; }\n');
    write(tmp, 'src/main.js', 'import { used } from "./live.js"; used();\n');
    const r = await run(tmp, { deadCode: { ignore: ['**/*.stories.*'] } });
    const hits = r.checks.filter((c) => c.name.startsWith('dead-code:unused-export:'));
    const storyHit = hits.find((c) => c.name.includes('stories'));
    assert.ok(!storyHit, 'stories file should be suppressed by ignore pattern');
  });

  it('suppresses orphaned-file findings for ignored files', async () => {
    write(tmp, 'src/live.js', 'export function used() { return 1; }\n');
    write(tmp, 'src/generated/schema.js', 'export const Schema = {};\n');
    write(tmp, 'src/main.js', 'import { used } from "./live.js"; used();\n');
    const r = await run(tmp, { deadCode: { ignore: ['src/generated/**'] } });
    const orphans = r.checks.filter((c) => c.name.startsWith('dead-code:orphan-file:'));
    const genOrphan = orphans.find((c) => c.name.includes('schema'));
    assert.ok(!genOrphan, 'generated/schema.js should be suppressed by ignore pattern');
  });

  it('also reads ignore from top-level config.ignore', async () => {
    write(tmp, 'src/live.js', 'export function used() { return 1; }\n');
    write(tmp, 'src/mock/data.js', 'export const mock = {};\n');
    write(tmp, 'src/main.js', 'import { used } from "./live.js"; used();\n');
    const r = await run(tmp, { ignore: ['src/mock/**'] });
    const orphans = r.checks.filter((c) => c.name.startsWith('dead-code:orphan-file:'));
    const mockOrphan = orphans.find((c) => c.name.includes('mock'));
    assert.ok(!mockOrphan, 'mock/data.js should be suppressed via top-level config.ignore');
  });
});

describe('DeadCodeModule — namespace imports protect all exports', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dc-ns-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag a helper used only via two-step require (const M = require; M.helper)', async () => {
    // The classic "exported for the test" CommonJS pattern.
    write(tmp, 'src/util.js', 'function helper() { return 1; }\nmodule.exports = { helper };\n');
    write(tmp, 'tests/util.test.js', [
      "const Util = require('../src/util');",
      'test("x", () => { Util.helper(); });',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.export === 'helper'),
      undefined,
      'a whole-module require must protect all its exports',
    );
  });

  it('does NOT flag exports when the module is default-imported (import M from)', async () => {
    write(tmp, 'src/lib.ts', 'export function a() {}\nexport function b() {}\nexport default { a, b };\n');
    write(tmp, 'src/main.ts', "import Lib from './lib';\nLib.a();\n");
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.export === 'a'), undefined);
    assert.strictEqual(r.checks.find((c) => c.export === 'b'), undefined);
  });

  it('STILL flags a truly-unused export in a named-only-imported module', async () => {
    write(tmp, 'src/lib.ts', 'export function used() {}\nexport function deadOne() {}\n');
    write(tmp, 'src/main.ts', "import { used } from './lib';\nused();\n");
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.export === 'used'), undefined, 'used export not flagged');
    assert.ok(r.checks.find((c) => c.export === 'deadOne'), 'genuinely-dead export still flagged');
  });
});

describe('DeadCodeModule — TS import type is tracked', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dc-it-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag a type imported via `import type { X } from`', async () => {
    write(tmp, 'src/types.ts', 'export interface Foo { a: number; }\nexport interface Bar { b: string; }\n');
    write(tmp, 'src/main.ts', "import type { Foo } from './types';\nconst x: Foo = { a: 1 };\nconsole.log(x);\n");
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.export === 'Foo'), undefined, 'import type { Foo } must count');
    // Bar is genuinely never imported → still flagged.
    assert.ok(r.checks.find((c) => c.export === 'Bar'), 'unused Bar still flagged');
  });

  it('does NOT flag a type imported via inline `{ type X }`', async () => {
    write(tmp, 'src/types.ts', 'export interface Baz { c: boolean; }\n');
    write(tmp, 'src/main.ts', "import { type Baz } from './types';\nconst y: Baz = { c: true };\nconsole.log(y);\n");
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.export === 'Baz'), undefined);
  });
});

describe('DeadCodeModule — barrel re-exports and test files', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dc-barrel-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag exports re-exported via `export * from` (barrel)', async () => {
    write(tmp, 'src/adapter.ts', 'export function doThing() {}\nexport interface Opts { a: number; }\n');
    write(tmp, 'src/index.ts', "export * from './adapter';\n");
    // The barrel itself is imported by a consumer (so it isn't orphaned).
    write(tmp, 'src/consumer.ts', "import { doThing } from './index';\ndoThing();\n");
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.export === 'doThing'), undefined, 'export * must protect doThing');
    assert.strictEqual(r.checks.find((c) => c.export === 'Opts'), undefined, 'export * must protect Opts');
  });

  it('does NOT flag exports re-exported via `export { X } from`', async () => {
    write(tmp, 'src/a.ts', 'export function keep() {}\nexport function drop() {}\n');
    write(tmp, 'src/index.ts', "export { keep } from './a';\n");
    write(tmp, 'src/consumer.ts', "import { keep } from './index';\nkeep();\n");
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.export === 'keep'), undefined, 'named re-export protects keep');
    // drop is neither re-exported nor imported → still flagged.
    assert.ok(r.checks.find((c) => c.export === 'drop'), 'genuinely-dead drop still flagged');
  });

  it('does NOT flag incidental exports in *.test.* files', async () => {
    write(tmp, 'src/main.ts', 'export function real() {}\n'); // real dead code (control)
    write(tmp, 'tests/foo.test.js', 'function run() {}\nmodule.exports = { run };\ntest("x", () => run());\n');
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.export === 'run'), undefined, 'test-file export must not be flagged');
    assert.ok(r.checks.find((c) => c.export === 'real'), 'non-test dead code still flagged');
  });
});
