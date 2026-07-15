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
