const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SyntaxModule = require('../src/modules/syntax');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

describe('SyntaxModule — baseline shape', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-syntax-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('exposes the expected BaseModule shape', () => {
    const mod = new SyntaxModule();
    assert.strictEqual(typeof mod.name, 'string');
    assert.ok(mod.name.length > 0);
    assert.strictEqual(typeof mod.description, 'string');
    assert.ok(mod.description.length > 0);
    assert.strictEqual(typeof mod.run, 'function');
  });

  it('runs without throwing on an empty project root', async () => {
    const mod = new SyntaxModule();
    const result = makeResult();
    await assert.doesNotReject(mod.run(result, { projectRoot: tmp }));
  });
});

describe('SyntaxModule — dangling patterns do not false-positive on valid code', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-syn-dp-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  async function run(root) {
    const mod = new SyntaxModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: root });
    return result;
  }

  it('does NOT flag a valid .js file with backticks inside strings/comments/regex', async () => {
    // Odd raw-backtick count (one lives in a string, one in a comment), but the
    // file parses fine — the old heuristic flagged it, the fix must not.
    fs.writeFileSync(path.join(tmp, 'a.js'), [
      'const msg = "use `code` here";      // mentions a `backtick` in a comment',
      'const re = /[`]/;',
      'module.exports = { msg, re };',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('syntax:template-literal:')),
      undefined,
      'valid JS must not be flagged for odd backticks',
    );
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('syntax:parens:')),
      undefined,
    );
  });

  it('does NOT run the crude heuristic on .ts/.tsx files', async () => {
    // TS gets real validation from tsc; the JS-oriented stripper mishandles
    // generics/JSX, so dangling patterns must not run on TS at all.
    fs.writeFileSync(path.join(tmp, 'a.ts'), [
      'const f = <T,>(x: T): T => x;',
      'const s = `template ${f(1)}`;',
      'export { f, s };',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => (c.name || '').startsWith('syntax:template-literal:')),
      undefined,
      'TS files must not get the crude backtick heuristic',
    );
  });

  it('STILL catches a genuinely unclosed template literal in a broken .js', async () => {
    // A real unclosed backtick makes the file unparseable → vm.Script throws
    // SyntaxError → not in parsedOk → the dangling heuristic gets its look.
    fs.writeFileSync(path.join(tmp, 'broken.js'), 'const x = `unclosed;\nconst y = 2;\n');
    const r = await run(tmp);
    const flagged = r.checks.find((c) => !c.passed &&
      ((c.name || '').startsWith('syntax:template-literal:') || (c.name || '').startsWith('syntax:broken.js')));
    assert.ok(flagged, 'a real unclosed template literal must still be caught');
  });
});
