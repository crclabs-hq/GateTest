const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const UndefinedRefModule = require('../src/modules/undefined-ref');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new UndefinedRefModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, file, content) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('UndefinedRefModule — Crontech regression patterns', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-uref-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  // The actual bug shape that crashed Crontech's api on 2026-05-24:
  // a configuration object passes a function-as-value where the function
  // name was never imported. Crashes at module load.
  it('flags Crontech-shape object-property value referencing undefined name', async () => {
    write(tmp, 'src/handler.ts', `
const app = createSomething({
  tenantCapResolver: resolveTenantCapForHotPath,
});
`);
    const r = await run(tmp);
    const finding = r.checks.find(
      (c) => c.name && c.name.includes('undefined-ref:resolveTenantCapForHotPath:src/handler.ts:'),
    );
    assert.ok(finding, 'should flag the undefined function reference');
    assert.strictEqual(finding.severity, 'error');
    assert.match(finding.message, /never imported or declared/);
  });

  it('passes when the function IS imported', async () => {
    write(tmp, 'src/handler.ts', `
import { resolveTenantCapForHotPath } from './quotas';
const app = createSomething({
  tenantCapResolver: resolveTenantCapForHotPath,
});
`);
    const r = await run(tmp);
    const finding = r.checks.find(
      (c) => c.name && c.name.includes('undefined-ref:resolveTenantCapForHotPath:'),
    );
    assert.strictEqual(finding, undefined, 'should not flag — name is imported');
  });

  it('passes when the function IS declared in the same file', async () => {
    write(tmp, 'src/handler.ts', `
function resolveTenantCapForHotPath() { return Infinity; }
const app = createSomething({
  tenantCapResolver: resolveTenantCapForHotPath,
});
`);
    const r = await run(tmp);
    const finding = r.checks.find(
      (c) => c.name && c.name.includes('undefined-ref:resolveTenantCapForHotPath:'),
    );
    assert.strictEqual(finding, undefined, 'should not flag — name is declared');
  });

  it('catches the second Crontech bug shape (function-call in module init)', async () => {
    write(tmp, 'src/index.ts', `
// createBuilderPublicApiApp defined elsewhere but NEVER imported
const config = {
  builder: createBuilderPublicApiApp,
  tracker: buildTrackingApp,
};
`);
    const r = await run(tmp);
    const a = r.checks.find((c) => c.name && c.name.includes('undefined-ref:createBuilderPublicApiApp:'));
    const b = r.checks.find((c) => c.name && c.name.includes('undefined-ref:buildTrackingApp:'));
    assert.ok(a, 'should flag createBuilderPublicApiApp');
    assert.ok(b, 'should flag buildTrackingApp');
  });
});

describe('UndefinedRefModule — false-positive guards', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-uref-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does not flag globals (console, fetch, process, Buffer)', async () => {
    write(tmp, 'src/x.ts', `
const cfg = {
  log: console,
  http: fetch,
  proc: process,
  buf: Buffer,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0, `expected 0 errors, got ${findings.length}: ${findings.map((f) => f.name).join(', ')}`);
  });

  it('does not flag TS utility types (Partial, Record, etc.)', async () => {
    write(tmp, 'src/x.ts', `
const cfg = {
  shape: Partial,
  pick: Pick,
  record: Record,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0);
  });

  it('does not flag identifiers under 4 chars (noise reduction)', async () => {
    // Too many 1-3 char identifiers in real code (loop vars, etc.) — V1
    // skips them to keep FP rate low.
    write(tmp, 'src/x.ts', `
const cfg = {
  x: foo,
  y: bar,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0);
  });

  it('does not flag destructure-bound names', async () => {
    write(tmp, 'src/x.ts', `
const { databaseClient, redisClient } = require('./deps');
const cfg = {
  db: databaseClient,
  cache: redisClient,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0);
  });

  it('does not flag renamed imports (`import { X as Y }`)', async () => {
    write(tmp, 'src/x.ts', `
import { someFunction as renamedHandler } from './lib';
const cfg = {
  handler: renamedHandler,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0);
  });

  it('does not flag names appearing inside string literals', async () => {
    write(tmp, 'src/x.ts', `
import { realName } from './lib';
const message = "looksLikeUndefinedFunctionName is fine in a string";
const cfg = {
  handler: realName,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0);
  });

  it('does not flag names appearing inside line comments', async () => {
    write(tmp, 'src/x.ts', `
import { realName } from './lib';
// looksLikeUndefinedFunctionName: not real, just a comment
const cfg = {
  handler: realName,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0);
  });

  it('does not flag test-runner globals (describe, it, expect, vi)', async () => {
    write(tmp, 'tests/something.test.ts', `
const cfg = {
  d: describe,
  i: it,
  e: expect,
};
`);
    const r = await run(tmp);
    // In test paths, severity is downgraded to warning anyway; but
    // these names are in the global allowlist so they should never fire.
    const findings = r.checks.filter((c) => c.severity === 'error' || c.severity === 'warning');
    const errs = findings.filter((c) => c.name && c.name.startsWith('undefined-ref:describe') ||
                                        c.name && c.name.startsWith('undefined-ref:it') ||
                                        c.name && c.name.startsWith('undefined-ref:expect'));
    assert.strictEqual(errs.length, 0);
  });
});

describe('UndefinedRefModule — severity & suppression', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-uref-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('downgrades severity in test paths', async () => {
    write(tmp, 'tests/handler.test.ts', `
const cfg = { handler: undefinedFunctionName };
`);
    const r = await run(tmp);
    const f = r.checks.find((c) => c.name && c.name.includes('undefined-ref:undefinedFunctionName:'));
    assert.ok(f);
    assert.strictEqual(f.severity, 'warning', 'test paths should downgrade error → warning');
  });

  it('respects `// undefined-ref-ok` suppression on same line', async () => {
    write(tmp, 'src/x.ts', `
const cfg = { handler: knownLateBindingFunction }; // undefined-ref-ok
`);
    const r = await run(tmp);
    const errs = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(errs.length, 0, 'same-line suppression should silence the rule');
  });

  it('respects `// undefined-ref-ok` suppression on preceding line', async () => {
    write(tmp, 'src/x.ts', `
// undefined-ref-ok
const cfg = { handler: knownLateBindingFunction };
`);
    const r = await run(tmp);
    const errs = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(errs.length, 0);
  });
});

describe('UndefinedRefModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-uref-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits the no-files info check when nothing to scan', async () => {
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'undefined-ref:no-files'));
  });

  it('skips .d.ts files (ambient declarations)', async () => {
    write(tmp, 'src/types.d.ts', `
declare const someAmbientGlobal: any;
const cfg = { x: maybeUndefinedThing };
`);
    const r = await run(tmp);
    // .d.ts is excluded, so the scan finds no files
    assert.ok(r.checks.find((c) => c.name === 'undefined-ref:no-files'));
  });

  it('skips node_modules / dist / build / coverage', async () => {
    write(tmp, 'node_modules/bad/x.ts', `const cfg = { x: thisShouldNotBeFlaggedFromNodeModules };`);
    write(tmp, 'dist/x.ts', `const cfg = { x: thisShouldNotBeFlaggedFromDist };`);
    write(tmp, 'src/real.ts', `const realCfg = { x: realFinding };`);
    const r = await run(tmp);
    const nodeFind = r.checks.find((c) => c.name && c.name.includes('thisShouldNotBeFlaggedFromNodeModules'));
    const distFind = r.checks.find((c) => c.name && c.name.includes('thisShouldNotBeFlaggedFromDist'));
    const realFind = r.checks.find((c) => c.name && c.name.includes('undefined-ref:realFinding:'));
    assert.strictEqual(nodeFind, undefined);
    assert.strictEqual(distFind, undefined);
    assert.ok(realFind);
  });
});

describe('UndefinedRefModule — multi-line multi-declarator statements (2026-08-18 audit)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-uref-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('declares every binding of `let a = 1,\n b = f(),\n c;` — the NodeGoat chart shape', async () => {
    write(tmp, 'app/chart.js', `
var margin = { top: 20, right: 20, bottom: 30, left: 50 },
    width = 960 - margin.left - margin.right,
    height = 500 - margin.top - margin.bottom,
    parseDate;
function draw() {
  parseDate = width + height;
  return { margin: margin, w: width, h: height, p: parseDate };
}
module.exports = draw;
`);
    const r = await run(tmp);
    const bad = r.checks.filter((c) => !c.passed && /width|height|parseDate|margin/.test(c.message || ''));
    assert.strictEqual(bad.length, 0, JSON.stringify(bad.map((c) => c.message)));
  });

  it('POSITIVE CONTROL: a genuinely undeclared name in the same file is still flagged', async () => {
    write(tmp, 'app/x.js', `
var a = 1,
    b = 2;
const config = {
  handler: neverDeclaredAnywhere,
  values: [a, b],
};
module.exports = config;
`);
    const r = await run(tmp);
    assert.ok(r.checks.some((c) => !c.passed && c.name && c.name.includes('undefined-ref:neverDeclaredAnywhere:')), JSON.stringify(r.checks));
    assert.ok(!r.checks.some((c) => !c.passed && /undefined-ref:(a|b):/.test(c.name || '')), 'a and b are declared');
  });

  it('_splitTopLevel ignores commas inside brackets and strings', () => {
    const parts = UndefinedRefModule._splitTopLevel(`a = { x: 1, y: [1, 2] }, b = "p,q", c = f(1, 2)`);
    assert.deepStrictEqual(parts.map((p) => p.trim().split(/\s/)[0]), ['a', 'b', 'c']);
  });
});

describe('UndefinedRefModule — declaration shapes missed on the 2026-09-05 corpus (nest / apollo-server / prisma)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-uref-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const errors = (r) => r.checks.filter((c) => !c.passed && c.severity === 'error').map((c) => c.name);
  const has = (r, name) => errors(r).some((n) => n.includes(`undefined-ref:${name}:`));

  // nest packages/common/decorators/http/route-params.decorator.ts:53 —
  // a rest parameter whose type annotation contains parentheses; the whole
  // parameter list was invisible to `\([^()]*\)` so `legacyPipes` blocked at :68.
  it('NEGATIVE: parameter list containing parentheses in a type (nest legacyPipes)', async () => {
    write(tmp, 'src/route-params.decorator.ts', `
export function assignMetadata<TParamtype = any, TArgs = any>(
  args: TArgs,
  paramtype: TParamtype,
  index: number,
  options?: ({ data?: ParamData } & ParameterDecoratorOptions) | ParamData,
  ...legacyPipes: (Type<PipeTransform> | PipeTransform)[]
) {
  const normalizedOptions = isOptionsObject
    ? (options as { data?: ParamData } & ParameterDecoratorOptions)
    : { data: options as ParamData, pipes: legacyPipes };
  return normalizedOptions;
}
`);
    const r = await run(tmp);
    assert.ok(!has(r, 'legacyPipes'), errors(r).join(', '));
  });

  // prisma examples/prisma-8-demo/src/prisma-no-emit/runtime.ts:7 — a
  // default value that is a call; `databaseUrl` blocked at :21.
  it('NEGATIVE: parameter list with a call in a default value (prisma databaseUrl)', async () => {
    write(tmp, 'src/runtime.ts', `
import { createCacheMiddleware } from '@prisma/orm-extension-middleware-cache';
import postgres from '@prisma/orm-postgres/runtime';
export async function getRuntime(
  databaseUrl: string,
  middleware: readonly SqlMiddleware[] = [
    createCacheMiddleware({ maxEntries: 1_000 }),
    budgets({ maxRows: 10_000, tableRows: { user: 10_000, post: 10_000 } }),
  ],
): Promise<Runtime> {
  const client = postgres({
    contract,
    url: databaseUrl,
    middleware,
  });
  return client.connect();
}
`);
    const r = await run(tmp);
    assert.ok(!has(r, 'databaseUrl'), errors(r).join(', '));
  });

  // prisma packages/3-extensions/sql-orm-client/src/collection.ts:531 — a
  // method parameter list containing a function type `(collection: X) => R`;
  // `relationName` blocked at :593/:603/:613.
  it('NEGATIVE: parameter list with a function-typed parameter (prisma relationName)', async () => {
    write(tmp, 'src/collection.ts', `
class Collection {
  include<RelName extends string>(
    relationName: RelName,
    refineFn?: (
      collection: IncludeRefinementCollection<TContract, RelatedName>,
    ) => RefinedResult,
  ): Collection {
    if (refineFn) {
      throw ormError('ORM.INCLUDE_UNSUPPORTED', 'scalar aggregations', {
        meta: { relation: relationName, kind: 'scalar' },
      });
    }
    return this;
  }
}
`);
    const r = await run(tmp);
    assert.ok(!has(r, 'relationName'), errors(r).join(', '));
  });

  it('POSITIVE CONTROL: an undeclared name in a body whose parameter list contains parentheses still fires', async () => {
    write(tmp, 'src/x.ts', `
export function build(
  options: (Foo | Bar)[],
  onDone: (result: Result) => void = () => {},
) {
  return createThing({ handler: neverDeclaredHandler, done: onDone, opts: options });
}
`);
    const r = await run(tmp);
    assert.ok(has(r, 'neverDeclaredHandler'), errors(r).join(', '));
    assert.ok(!has(r, 'onDone') && !has(r, 'options'), errors(r).join(', '));
  });

  // nest packages/core/repl/repl-context.ts:130 and
  // packages/core/router/route-conflict-detector.ts:41 — an arrow with a
  // single unparenthesised parameter; `aliasName` blocked at :134,
  // `rawSegment` at :58.
  it('NEGATIVE: unparenthesised arrow parameter (nest aliasName / rawSegment)', async () => {
    write(tmp, 'src/repl-context.ts', `
class ReplContext {
  private addNativeFunction(nativeFunction: any, nativeFunctions: any[]) {
    nativeFunction.fnDefinition.aliases?.forEach(aliasName => {
      const aliasNativeFunction = Object.create(nativeFunction);
      aliasNativeFunction.fnDefinition = {
        name: aliasName,
        description: aliasNativeFunction.fnDefinition.description,
      };
      nativeFunctions.push(aliasNativeFunction);
    });
    return path
      .split('/')
      .filter(rawSegment => rawSegment.length > 0)
      .forEach(rawSegment => {
        segments.push({ kind: 'wildcard', value: rawSegment });
      });
  }
}
`);
    const r = await run(tmp);
    assert.ok(!has(r, 'aliasName') && !has(r, 'rawSegment'), errors(r).join(', '));
  });

  it('POSITIVE CONTROL: an undeclared name inside an unparenthesised-arrow body still fires', async () => {
    write(tmp, 'src/x.ts', `
items.forEach(itemName => {
  register({ name: itemName, handler: neverDeclaredHandler });
});
`);
    const r = await run(tmp);
    assert.ok(has(r, 'neverDeclaredHandler'), errors(r).join(', '));
    assert.ok(!has(r, 'itemName'), errors(r).join(', '));
  });

  // apollo-server packages/server/src/plugin/usageReporting/plugin.ts:83 —
  // a destructured method parameter with a rename and a return-type
  // annotation; the `:` strip cut the pattern to `{ logger` so
  // `serverLogger` blocked at :87.
  it('NEGATIVE: renamed destructured parameter with a return-type annotation (apollo serverLogger)', async () => {
    write(tmp, 'src/plugin.ts', `
export function plugin(options: Options) {
  return internalPlugin({
    async serverWillStart({
      logger: serverLogger,
      apollo,
      startedInBackground,
      schema,
    }): Promise<GraphQLServerListener> {
      const logger = options.logger ?? serverLogger;
      return { logger: serverLogger, apollo, schema, bg: startedInBackground };
    },
  });
}
`);
    const r = await run(tmp);
    assert.ok(!has(r, 'serverLogger'), errors(r).join(', '));
  });

  it('POSITIVE CONTROL: the destructured-parameter method still fires on a name it does not bind', async () => {
    write(tmp, 'src/x.ts', `
const plugin = {
  async serverWillStart({ logger: serverLogger }): Promise<Listener> {
    return { logger: serverLogger, reporter: neverDeclaredReporter };
  },
};
`);
    const r = await run(tmp);
    assert.ok(has(r, 'neverDeclaredReporter'), errors(r).join(', '));
    assert.ok(!has(r, 'serverLogger'), errors(r).join(', '));
  });

  // prisma packages/3-extensions/postgres/src/runtime/postgres.ts:4 and :30 —
  // a default import combined with named imports; `postgresTarget` /
  // `postgresDriver` blocked at :168/:170/:177 (and sqliteTarget in sqlite.ts:31).
  it('NEGATIVE: default import combined with named imports (prisma postgresTarget / postgresDriver)', async () => {
    write(tmp, 'src/postgres.ts', `
import postgresDriver, { suppressIdleConnectionErrors } from '@internal/driver-postgres/runtime';
import postgresTarget, { PostgresContractSerializer } from '@internal/target-postgres/runtime';
import sqliteTarget, {
  type SqliteTargetId,
} from '@internal/target-sqlite/runtime';
import * as nsOnly from 'x';
const stack = createSqlExecutionStack({
  target: postgresTarget,
  driver: postgresDriver,
  alt: sqliteTarget,
});
`);
    const r = await run(tmp);
    assert.ok(!has(r, 'postgresTarget') && !has(r, 'postgresDriver') && !has(r, 'sqliteTarget'), errors(r).join(', '));
  });

  it('POSITIVE CONTROL: a name that is NOT the default binding of a combined import still fires', async () => {
    write(tmp, 'src/x.ts', `
import postgresDriver, { suppressIdleConnectionErrors } from '@internal/driver-postgres/runtime';
const stack = createSqlExecutionStack({
  driver: postgresDriver,
  target: postgresTargetNeverImported,
});
`);
    const r = await run(tmp);
    assert.ok(has(r, 'postgresTargetNeverImported'), errors(r).join(', '));
    assert.ok(!has(r, 'postgresDriver'), errors(r).join(', '));
  });

  // prisma packages/3-extensions/sqlite/src/runtime/sqlite.ts:146 — a
  // destructuring declaration with a type annotation between the pattern
  // and the `=`; `rawSqlTag` blocked at :150 and :243.
  it('NEGATIVE: type-annotated destructuring declaration (prisma rawSqlTag)', async () => {
    write(tmp, 'src/sqlite.ts', `
export default function sqlite(options: SqliteOptions) {
  const {
    sql,
    raw: rawSqlTag,
    enums,
  }: SqliteStaticContext<TContract> = buildSqliteStaticContext<TContract>(options);
  let [first, { nested: nestedBinding }]: [string, { nested: number }] = pair();
  return { sql, orm, enums, raw: rawSqlTag, head: first, deep: nestedBinding };
}
`);
    const r = await run(tmp);
    assert.ok(!has(r, 'rawSqlTag') && !has(r, 'nestedBinding'), errors(r).join(', '));
  });

  it('POSITIVE CONTROL: a name next to a type-annotated destructure that it does not bind still fires', async () => {
    write(tmp, 'src/x.ts', `
const { raw: rawSqlTag }: Ctx = build();
const out = { raw: rawSqlTag, orm: ormClientNeverDeclared };
`);
    const r = await run(tmp);
    assert.ok(has(r, 'ormClientNeverDeclared'), errors(r).join(', '));
    assert.ok(!has(r, 'rawSqlTag'), errors(r).join(', '));
  });

  it('NEGATIVE: JSX apostrophes and regex literals do not derail the parameter walk', async () => {
    // A `'` inside JSX text must not open a string that eats the next
    // function's parameter list; `/\\(/` must not be read as an open paren.
    write(tmp, 'src/page.tsx', `
export function Banner() {
  return <p>Don't panic — it's fine</p>;
}
export function Handler(requestPayload: Payload) {
  const cleaned = requestPayload.text.replace(/\\(/g, '');
  return render({ payload: requestPayload, text: cleaned });
}
`);
    const r = await run(tmp);
    assert.ok(!has(r, 'requestPayload'), errors(r).join(', '));
  });

  it('_readBalanced / _splitParams / _parseDestructureNames primitives', () => {
    assert.strictEqual(UndefinedRefModule._readBalanced('{ a: { b }, c: "}" }: T = x', 0), ' a: { b }, c: "}" ');
    assert.strictEqual(UndefinedRefModule._readBalanced('( a ', 0), null);
    const mod = new UndefinedRefModule();
    assert.deepStrictEqual(
      mod._splitParams('cb: (x: A) => B, next: Map<string, number>, last'),
      ['cb: (x: A) => B', ' next: Map<string, number>', ' last'],
    );
    assert.deepStrictEqual(
      mod._parseDestructureNames('a, b: renamed, c: { d, e: [f] }, ...rest, type Foo as Bar, g = 1'),
      ['a', 'renamed', 'd', 'f', 'rest', 'Bar', 'g'],
    );
  });
});

describe('UndefinedRefModule — two declarations on one line (PR #435 bot finding)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-uref2-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('NEGATIVE: `let tmp; let eventFile;` declares both — the second is not "never declared"', async () => {
    write(tmp, 'src/a.js', 'let tmp; let eventFile;\nfunction go() { tmp = 1; eventFile = tmp + 1; return eventFile; }\nmodule.exports = go;\n');
    const r = await run(tmp);
    const bad = r.checks.filter((c) => !c.passed && /eventFile|\btmp\b/.test(c.message || ''));
    assert.strictEqual(bad.length, 0, bad.map((c) => c.message).join('\n'));
  });

  it('POSITIVE: a name declared nowhere on that line is still caught (the Crontech shape)', async () => {
    write(tmp, 'src/b.ts', 'let tmp; let other;\nconst app = createSomething({\n  tenantCapResolver: neverDeclaredAnywhere,\n});\nexport { app, tmp, other };\n');
    const r = await run(tmp);
    assert.ok(r.checks.some((c) => !c.passed && /neverDeclaredAnywhere/.test(c.name || '')), r.checks.map((c) => c.name).join('\n'));
  });
});

// Issue #657 (Tallrig, services/object-storage/src/drivers/minio.ts:222):
// reported as a false positive on `head`, a typed local from
// `headObject(): Promise<ObjectMetadata | null>`, null-checked, then used
// as an object-literal property value.
//
// Investigation (this session): the customer's own reproduction —
// `const head = await client.headObject(key); if (!head) return null;
// return head.size;` — cannot fire under the CURRENT engine regardless of
// the fix in this PR: `_shouldFlag` requires `name.length >= 8`
// (undefined-ref.js), and `head` is 4 characters, filtered before scope is
// even consulted. Re-tested the same shape with a qualifying-length
// camelCase name (`headObjectResult`, `headMetadata`) — including the
// customer's own multi-line and `this.headObject(bucket, key)` shapes,
// with the value narrowed via `=== null` / `!== null` — and every variant
// is already correctly scoped: `_harvestScope`'s `const|let|var` regex
// (undefined-ref.js) captures ANY declared name, of any length, from
// `const NAME = ...`, independent of null-narrowing (the rule does not
// need to reason about types at all — it only needs the name declared
// somewhere in the file). No code change was justified by reproduction;
// this locks in the already-correct behavior as a regression test and
// documents the length-filter reason a literal `head` never reaches the
// scope check in the first place.
describe('UndefinedRefModule — issue #657: a narrowed, declared local used as an object-literal value stays quiet', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-uref-657-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('NEGATIVE: the customer\'s exact shape (this.headObject, === null narrowing, object-literal value) is quiet, with a qualifying-length name', async () => {
    write(tmp, 'src/minio.ts', [
      'class MinioDriver {',
      '  async headObject(bucket, key) {',
      '    return null;',
      '  }',
      '',
      '  async completeMultipart(bucket, key) {',
      '    const headObjectResult = await this.headObject(bucket, key);',
      '    if (headObjectResult === null) {',
      "      throw new Error('minio: completeMultipart returned no object');",
      '    }',
      '    return { metadata: headObjectResult };',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.deepStrictEqual(r.checks.filter((c) => !c.passed), []);
  });

  it('NEGATIVE: the customer\'s own literal reproduction fixture (short name) is quiet', async () => {
    write(tmp, 'src/minio-repro.ts', 'function getSize(client, key) { const head = client.headObject(key); if (!head) return null; return head.size; }\n');
    const r = await run(tmp);
    assert.deepStrictEqual(r.checks.filter((c) => !c.passed), []);
  });

  it('POSITIVE (control): the same shape with a genuinely undeclared value name still fires', async () => {
    write(tmp, 'src/minio-bad.ts', [
      'class MinioDriver {',
      '  async completeMultipart(bucket, key) {',
      '    return { metadata: neverDeclaredObjectHead };',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(
      r.checks.some((c) => !c.passed && /neverDeclaredObjectHead/.test(c.name || '')),
      r.checks.map((c) => c.name).join('\n'),
    );
  });
});
