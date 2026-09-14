const { describe, it } = require('node:test');
const assert = require('node:assert');

const CodeQualityModule = require('../src/modules/code-quality');

describe('CodeQualityModule — baseline shape', () => {
  it('exposes the expected BaseModule shape', () => {
    const mod = new CodeQualityModule();
    assert.strictEqual(typeof mod.name, 'string');
    assert.ok(mod.name.length > 0);
    assert.strictEqual(typeof mod.description, 'string');
    assert.ok(mod.description.length > 0);
    assert.strictEqual(typeof mod.run, 'function');
  });
});

describe('CodeQualityModule — _neutraliseContent regex-context detection (behaviour preserved after Known Issue #40 fix)', () => {
  const mod = new CodeQualityModule();

  it('treats a `/` after `=` as a regex literal, not division', () => {
    const out = mod._neutraliseContent('const re = /foo bar/;\n');
    // Regex body is blanked but delimiters + non-regex code remain.
    assert.match(out, /const re = \/ {7}\/;/);
  });

  it('treats a `/` after `return` as a regex literal', () => {
    const out = mod._neutraliseContent('function f() { return /abc/.test(x); }\n');
    assert.match(out, /return \/ {3}\//);
  });

  it('treats a `/` after `typeof` as a regex literal', () => {
    const out = mod._neutraliseContent('if (typeof /x/.test) {}\n');
    assert.match(out, /typeof \/ *\//);
  });

  it('does NOT treat a bare division as a regex literal', () => {
    const out = mod._neutraliseContent('const x = a / b / c;\n');
    // No regex state entered — the divisions and identifiers survive untouched.
    assert.strictEqual(out, 'const x = a / b / c;\n');
  });

  it('handles JSX self-closing and closing tags (dense in `/`) without misfiring as regex', () => {
    const jsx = '<Foo bar={1} />\n<Baz>\n  <Qux />\n</Baz>\n';
    const out = mod._neutraliseContent(jsx);
    // No string/regex content to blank here — JSX tag syntax passes through
    // unchanged; this just proves the dense-`/` path doesn't throw or corrupt output.
    assert.strictEqual(out, jsx);
  });
});

// =============================================================================
// Self-scan 2026-09-13 — three codeQuality shapes, each with its control.
// =============================================================================
describe('CodeQualityModule — unused-import counts usage on the masked source', () => {
  function unusedIn(rel, content) {
    const mod = new CodeQualityModule();
    const result = { checks: [], addCheck(name, passed, d = {}) { this.checks.push({ name, passed, ...d }); } };
    mod._checkUnusedImports(rel, content, content.split('\n'), result);
    return result.checks.filter((c) => c.name.startsWith('quality:unused-import:')).map((c) => c.name.split(':').pop());
  }

  it('a `/*` inside a regex literal no longer swallows the usage after it (src/core/confidence.js, import-graph.js, auth-bypass.js, webhook-payload.js)', () => {
    const src = [
      "const { maskSource, literalKindAt } = require('./source-strip');",
      "const BLOCK_RE = /\\/\\*[\\s\\S]*?\\*\\//g;",
      'function run(text) {',
      '  const masked = maskSource(text);',
      '  return literalKindAt(masked, 0, 0) + BLOCK_RE.source;',
      '}',
      'module.exports = run;',
    ].join('\n');
    assert.deepStrictEqual(unusedIn('src/x.js', src), []);
  });

  it('a use inside a template interpolation counts', () => {
    const src = "import { siteUrl } from './site-url';\nexport const link = `${siteUrl()}/docs`;\n";
    assert.deepStrictEqual(unusedIn('src/y.ts', src), []);
  });

  it('POSITIVE CONTROL: an import mentioned only in a comment or a string is unused (website/app/components/Hero.tsx Link)', () => {
    const src = 'import Link from "next/link";\n// Link is handy\nconst s = "Link";\nexport const Hero = () => <div>hero</div>;\n';
    assert.deepStrictEqual(unusedIn('website/app/components/Hero.tsx', src), ['Link']);
  });
});

describe('CodeQualityModule — commented-out code vs documentation that quotes code', () => {
  function commentedIn(lines) {
    const mod = new CodeQualityModule();
    const result = { checks: [], addCheck(name, passed, d = {}) { this.checks.push({ name, passed, ...d }); } };
    mod._checkCommentedCode('/x.js', 'x.js', lines, result);
    return result.checks.filter((c) => c.name.startsWith('quality:commented-code:')).length;
  }

  it('three example lines inside a prose comment are documentation (src/modules/n-plus-one.js:100)', () => {
    assert.strictEqual(commentedIn([
      '// The raw-driver shape above is the only one whose ARGUMENT decides',
      '// whether the loop is an N+1. Measured on prisma/prisma (2026-09-05):',
      '// 25 findings, 6 of them blocking, and not one a per-row lookup —',
      '//   for (let i = 0; i < count; i++) await client.query("CREATE DATABASE db_" + i)',
      '//   while (waiting) { try { await client.query(\'SELECT 1\'); break; } catch {} }',
      '//   for (const statement of setupSql) await connection.query(statement)',
      '// DDL, session control and SELECT 1 cannot be batched into one query,',
      '// so those are not reported.',
      'const x = 1;',
    ]), 0);
  });

  it('POSITIVE CONTROL: the same three lines with no prose around them are commented-out code', () => {
    assert.strictEqual(commentedIn([
      'const a = 1;',
      '// for (let i = 0; i < count; i++) await client.query("CREATE DATABASE db_" + i)',
      '// while (waiting) { try { await client.query(\'SELECT 1\'); break; } catch {} }',
      '// for (const statement of setupSql) await connection.query(statement)',
      'const b = 2;',
    ]), 1);
  });
});

describe('CodeQualityModule — a module that runs at load is a script, and its console is its output', () => {
  it('top-level await or process.exit at column 0 gives the file the cli role (website/capture-baseline.mjs)', () => {
    const mod = new CodeQualityModule();
    assert.strictEqual(mod._fileRole('website/capture-baseline.mjs', [
      "import { chromium } from '@playwright/test';",
      'const browser = await chromium.launch({ headless: true });',
      'console.log(`captured`);',
    ]), 'cli');
    assert.strictEqual(mod._fileRole('scripts/check.js', ['const ok = check();', 'process.exit(ok ? 0 : 1);']), 'cli');
  });

  it('POSITIVE CONTROL: an await inside a function is not a script', () => {
    const mod = new CodeQualityModule();
    assert.strictEqual(mod._fileRole('src/lib/fetcher.js', [
      'async function load() {',
      '  const r = await fetch(url);',
      '  return r;',
      '}',
      'module.exports = load;',
    ]), null);
  });
});

describe('CodeQualityModule — _neutraliseContent performance (Known Issue #40 root cause)', () => {
  // Root cause found via the Gluecron.com hang repro 2026-07-16: a 257KB TSX
  // file hung codeQuality for 9.5+ minutes (bisected to _neutraliseContent
  // alone, confirmed via a 60s isolated timeout). Cause: the regex-context
  // check called `out.trim()` / `out.replace(/\s+$/, "")` on the ENTIRE
  // accumulated output string every time it saw a `/` in code state — O(n)
  // per call, and JSX/TSX files are dense with `/` (every `<Foo />` and
  // `</Foo>` is one), so total cost was O(n^2). Fixed by bounding the
  // lookback to `out.slice(-24)`. This is a SYNCHRONOUS hang (blocks the
  // event loop), which is why runner.js's Promise.race-based per-module
  // timeout could not have rescued it — the timer callback never gets a
  // chance to fire until the synchronous loop returns. The real fix has to
  // be here, not in the runner.
  const mod = new CodeQualityModule();

  it('stays fast on a large, `/`-dense JSX-like file (was O(n^2), now O(n))', () => {
    // Reproduces the shape that hung: many short JSX-like lines, each with
    // multiple `/` characters, repeated enough to reach a comparable size
    // to the file that triggered the original hang (~257KB).
    const line = '  <Component prop1={a} prop2={b} onClick={() => f()} />\n  <SubComponent />\n  </Wrapper>\n';
    const content = line.repeat(3000); // ~270KB, comparable to the real repro file
    assert.ok(content.length > 200_000, 'fixture should be large enough to actually exercise the bug');

    const start = Date.now();
    const out = mod._neutraliseContent(content);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, `_neutraliseContent took ${elapsed}ms on a ${content.length}-byte JSX-dense file — expected well under 5s, the O(n^2) bug took 60s+`);
    assert.strictEqual(out.length, content.length, 'neutralised output must preserve line/character positions');
  });
});
