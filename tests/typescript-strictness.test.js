const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TypeScriptStrictnessModule = require('../src/modules/typescript-strictness');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new TypeScriptStrictnessModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('TypeScriptStrictnessModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tss-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no TS files or tsconfig exist', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'typescript-strictness:no-files'));
  });

  it('discovers tsconfig.json and TS source files', async () => {
    write(tmp, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }, null, 2));
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    const scanning = r.checks.find((c) => c.name === 'typescript-strictness:scanning');
    assert.ok(scanning);
    assert.match(scanning.message, /1 tsconfig/);
    assert.match(scanning.message, /1 TypeScript/);
  });
});

describe('TypeScriptStrictnessModule — tsconfig regressions', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tss-cfg-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  // REVISED 2026-09-05 (corpus6): error -> warning for both master flags. A
  // compiler flag is a decision the project made and can defend; nestjs/nest
  // was gated on seven `noImplicitAny: false` tsconfigs it chose on purpose.
  // See the "preferences, not defects" block at the end of this file.
  it('warns on strict: false', async () => {
    write(tmp, 'tsconfig.json', JSON.stringify({
      compilerOptions: { strict: false },
    }, null, 2));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('typescript-strictness:tsconfig-strict-false:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on noImplicitAny: false', async () => {
    write(tmp, 'tsconfig.json', JSON.stringify({
      compilerOptions: { strict: true, noImplicitAny: false },
    }, null, 2));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('typescript-strictness:tsconfig-no-implicit-any-false:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on skipLibCheck: true', async () => {
    write(tmp, 'tsconfig.json', JSON.stringify({
      compilerOptions: { strict: true, skipLibCheck: true },
    }, null, 2));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('typescript-strictness:tsconfig-skip-lib-check:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on strictNullChecks: false', async () => {
    write(tmp, 'tsconfig.json', JSON.stringify({
      compilerOptions: { strict: true, strictNullChecks: false },
    }, null, 2));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('typescript-strictness:tsconfig-strict-null-checks-false:')));
  });

  it('parses tsconfig with // comments (JSONC)', async () => {
    write(tmp, 'tsconfig.json', [
      '{',
      '  // base strictness',
      '  "compilerOptions": {',
      '    "strict": false // temporary',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('typescript-strictness:tsconfig-strict-false:')));
  });

  it('does NOT escalate strictness rules on tsconfig.test.json', async () => {
    write(tmp, 'tsconfig.test.json', JSON.stringify({
      compilerOptions: { strict: false, noImplicitAny: false },
    }, null, 2));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('typescript-strictness:tsconfig-strict-false:')),
      undefined,
    );
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('typescript-strictness:tsconfig-no-implicit-any-false:')),
      undefined,
    );
  });

  it('handles JSON strings containing /* and // (e.g. paths mappings)', async () => {
    // Regression test: a string-unaware comment stripper chews into
    // `"@/*": ["./*"]` and corrupts the JSON. Must stay valid.
    write(tmp, 'tsconfig.json', [
      '{',
      '  "compilerOptions": {',
      '    "strict": true,',
      '    "paths": {',
      '      "@/*": ["./*"],',
      '      "~/*": ["./src/*"]',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('typescript-strictness:tsconfig-unparseable:')),
      undefined,
    );
  });

  it('flags unparseable tsconfig.json with warning', async () => {
    write(tmp, 'tsconfig.json', '{ "compilerOptions": { "strict": true, } }\n'); // trailing comma kills JSON.parse
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('typescript-strictness:tsconfig-unparseable:')));
  });
});

describe('TypeScriptStrictnessModule — suppression abuse', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tss-sup-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on @ts-nocheck at top of file', async () => {
    write(tmp, 'src/a.ts', [
      '// @ts-nocheck',
      'export const x = 1;',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('typescript-strictness:ts-nocheck:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('warns on @ts-ignore with no reason', async () => {
    write(tmp, 'src/a.ts', [
      'export function foo() {',
      '  // @ts-ignore',
      '  return bar();',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('typescript-strictness:ts-ignore-no-reason:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('does NOT warn on @ts-ignore with a reason', async () => {
    write(tmp, 'src/a.ts', [
      'export function foo() {',
      '  // @ts-ignore — upstream @foo/bar types are wrong (issue #123)',
      '  return bar();',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('typescript-strictness:ts-ignore-no-reason:')),
      undefined,
    );
    // but we still record it for dashboards
    assert.ok(r.checks.find((c) => c.name.startsWith('typescript-strictness:ts-ignore-counted:')));
  });

  it('warns on @ts-expect-error with no reason', async () => {
    write(tmp, 'src/a.ts', [
      'export function foo() {',
      '  // @ts-expect-error',
      '  return bar();',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('typescript-strictness:ts-expect-error-no-reason:')));
  });

  it('does NOT warn on @ts-expect-error with a reason', async () => {
    write(tmp, 'src/a.ts', [
      'export function foo() {',
      '  // @ts-expect-error: Stripe types lag runtime (fixed in stripe@18)',
      '  return bar();',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('typescript-strictness:ts-expect-error-no-reason:')),
      undefined,
    );
  });
});

describe('TypeScriptStrictnessModule — any leaks', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tss-any-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on exported function with any parameter', async () => {
    write(tmp, 'src/a.ts', 'export function foo(x: any): string { return String(x); }\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('typescript-strictness:any-leak:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on exported const typed as any', async () => {
    write(tmp, 'src/a.ts', 'export const config: any = {};\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('typescript-strictness:any-leak:')));
  });

  it('does NOT flag `any` substring in non-type positions (e.g. `canyon`)', async () => {
    write(tmp, 'src/a.ts', 'export const canyon = "Grand Canyon";\n');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('typescript-strictness:any-leak:')),
      undefined,
    );
  });

  it('warns on `as any` cast', async () => {
    write(tmp, 'src/a.ts', [
      'function foo() {',
      '  const x = {} as any;',
      '  return x;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('typescript-strictness:as-any:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('does NOT read prose as a cast: "same as any other host" in a JSDoc (PR #606)', async () => {
    write(tmp, 'src/a.ts', [
      '/**',
      ' * falls through to the normal classification, same as any',
      ' * other host.',
      ' */',
      'export function load(): number { return 1; } // treat it as any other value',
      'const label = "cast as any";',
      'const tpl = `as any`;',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('typescript-strictness:as-any:')), undefined);
  });

  it('still flags a real cast that shares a line with a comment', async () => {
    write(tmp, 'src/a.ts', [
      '/* header */ const x = JSON.parse(raw) as any; // why',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('typescript-strictness:as-any:'));
    assert.ok(hit, 'a real `as any` must still fire');
    assert.strictEqual(hit.line, 1);
  });

  it('maskCommentsAndStrings keeps line count and columns', () => {
    const { maskCommentsAndStrings } = require('../src/modules/typescript-strictness');
    const src = ['a /* b', 'c */ d // e', 'f = "g\\"h" as any'];
    const out = maskCommentsAndStrings(src);
    assert.strictEqual(out.length, src.length);
    out.forEach((l, i) => assert.strictEqual(l.length, src[i].length));
    assert.ok(!/b|c|e|g|h/.test(out.join('')), 'comment and string contents are masked');
    assert.ok(/\bas\s+any\b/.test(out[2]), 'code after a string survives');
  });
  it('records `as unknown as X` as info', async () => {
    write(tmp, 'src/a.ts', [
      'interface StripeEvent { id: string }',
      'function foo(raw: string) {',
      '  const e = JSON.parse(raw) as unknown as StripeEvent;',
      '  return e.id;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('typescript-strictness:unknown-double-cast:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'info');
  });

  it('does NOT flag `any` in *.test.ts files', async () => {
    write(tmp, 'src/a.test.ts', 'export function mock(x: any): any { return x; }\n');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('typescript-strictness:any-leak:')),
      undefined,
    );
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('typescript-strictness:as-any:')),
      undefined,
    );
  });

  it('does NOT flag `any` in *.d.ts files', async () => {
    write(tmp, 'types/foo.d.ts', 'export declare function foo(x: any): any;\n');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('typescript-strictness:any-leak:')),
      undefined,
    );
  });
});

describe('TypeScriptStrictnessModule — clean baseline', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tss-clean-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits zero findings for a strict tsconfig + well-typed source', async () => {
    write(tmp, 'tsconfig.json', JSON.stringify({
      compilerOptions: {
        strict: true,
        noImplicitAny: true,
        strictNullChecks: true,
        strictFunctionTypes: true,
        target: 'ES2022',
      },
    }, null, 2));
    write(tmp, 'src/a.ts', [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0, `unexpected findings: ${JSON.stringify(issues, null, 2)}`);
  });

  it('records a summary', async () => {
    write(tmp, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
    write(tmp, 'src/a.ts', 'export const x: number = 1;\n');
    const r = await run(tmp);
    const summary = r.checks.find((c) => c.name === 'typescript-strictness:summary');
    assert.ok(summary);
    assert.match(summary.message, /1 tsconfig/);
    assert.match(summary.message, /1 source/);
  });
});

// ── tsconfig flags are preferences, not defects (corpus6, 2026-09-05) ────────
//
// nestjs/nest sets `noImplicitAny: false` in seven tsconfigs — root,
// packages/tsconfig.build.json (the config that BUILDS the published
// packages), tools/gulp/, and four integration suites — and the gate blocked
// on every one. That is a framework being failed for a flag it chose:
// CLAUDE.md Forbidden #25. The flags are still reported so the slider stays
// visible; nothing in the tsconfig family may block.
describe('TypeScriptStrictnessModule — tsconfig flags are preferences, not defects', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tss-pref-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('NEGATIVE: nestjs/nest root tsconfig.json is reported as a warning, never blocking', async () => {
    // compilerOptions verbatim from nest @ corpus6 (paths map trimmed)
    write(tmp, 'tsconfig.json', JSON.stringify({ compilerOptions: {
      module: 'Node16', moduleResolution: 'Node16', esModuleInterop: true,
      noImplicitAny: false, noUnusedLocals: false, removeComments: true,
      strictNullChecks: true, strictPropertyInitialization: false,
      forceConsistentCasingInFileNames: true, target: 'ES2023', types: ['node'],
    }, include: ['packages/**/*', 'integration/**/*'] }, null, 2));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name === 'typescript-strictness:tsconfig-no-implicit-any-false:tsconfig.json');
    assert.ok(hit, 'the flag must still be reported — downgraded, not hidden');
    assert.strictEqual(hit.severity, 'warning');
    assert.ok(!r.checks.some((c) => !c.passed && c.severity === 'error'), 'no tsconfig rule may block');
  });

  it('NEGATIVE: a tsconfig under a canonical test path is a test config whatever its basename', async () => {
    write(tmp, 'test/tsconfig.json', JSON.stringify({ compilerOptions: { strict: false, noImplicitAny: false } }));
    write(tmp, 'e2e/tsconfig.json', JSON.stringify({ compilerOptions: { strict: false } }));
    const r = await run(tmp);
    // Silence needs its own positive control: both files were actually seen.
    assert.match(r.checks.find((c) => c.name === 'typescript-strictness:scanning').message, /2 tsconfig/);
    assert.ok(!r.checks.some((c) => /tsconfig-(strict|no-implicit-any)/.test(c.name)), r.checks.map((c) => c.name).join());
  });

  it('POSITIVE CONTROL: @ts-nocheck is a per-file opt-out, not a preference — still an error', async () => {
    write(tmp, 'src/a.ts', '// @ts-nocheck\nexport const x = 1;\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('typescript-strictness:ts-nocheck:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });
});
