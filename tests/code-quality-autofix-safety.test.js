// =============================================================================
// CODE QUALITY — the deterministic fixer may only delete lines that do nothing
// =============================================================================
// Audit 2026-10-02: `gatetest --fix` attached "remove this line" to EVERY
// forbidden pattern. On a fixture it deleted `return eval('(' + s + ')');`,
// so load() silently returned undefined, and reported "Fixed: 2". The same
// fixer split a multi-line `console.log(` and left its arguments behind as a
// syntax error, and would delete `el.innerHTML = html;` (a page that no longer
// renders) or a TODO (information, not code).
//
// The rule now: a finding carries an autoFix only when its line is exactly
// one `console.log|debug|info(...)` call or `debugger;`. Everything else is
// reported for a person (or the AI fixer) to change.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodeQualityModule = require('../src/modules/code-quality');
const { isRemovableStatementLine } = require('../src/modules/code-quality');
const { GateTestConfig } = require('../src/core/config');

const FIXTURE = [
  'function load(s) {',
  "  return eval('(' + s + ')');",
  '}',
  'function build(s) { return new Function(s); }',
  'function show(el, html) {',
  '  el.innerHTML = html;',
  '}',
  '// TODO: cache the parse',
  'function trace(a, b) {',
  "  console.log('trace', a);",
  '  debugger;',
  '  console.log(',
  "    'multi', a,",
  '    b);',
  '  console.log(a) || notify(b);',
  '}',
  'module.exports = { load, build, show, trace };',
  '',
].join('\n');

async function scan(root) {
  const checks = [];
  const result = { addCheck(id, passed, meta) { checks.push({ id, passed, meta: meta || {} }); }, addInfo() {} };
  await new CodeQualityModule().run(result, new GateTestConfig(root));
  return checks.filter((c) => !c.passed && c.meta.file === 'src/app.js');
}

describe('code-quality autofix never changes behaviour', () => {
  it('only the single-statement console.log and debugger lines get an autoFix', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cqfix-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'app.js'), FIXTURE);
      const findings = await scan(root);
      const fixable = findings.filter((c) => typeof c.meta.autoFix === 'function').map((c) => c.meta.line).sort((a, b) => a - b);
      const reported = findings.map((c) => c.meta.line);
      // Control: the dangerous lines are still REPORTED — just not deleted.
      for (const line of [2, 4, 6, 12, 15]) assert.ok(reported.includes(line), `line ${line} still reported: ${reported}`);
      assert.deepStrictEqual(fixable, [10, 11]);

      // Apply every autoFix the module offered; the program keeps its meaning.
      for (const c of findings.filter((f) => f.meta.autoFix).sort((a, b) => b.meta.line - a.meta.line)) c.meta.autoFix();
      const after = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
      assert.match(after, /return eval\('\(' \+ s \+ '\)'\);/);
      assert.match(after, /el\.innerHTML = html;/);
      assert.match(after, /\/\/ TODO: cache the parse/);
      assert.match(after, /console\.log\(\n {4}'multi', a,\n {4}b\);/);
      assert.doesNotMatch(after, /console\.log\('trace'/);
      assert.doesNotMatch(after, /debugger/);
      assert.doesNotThrow(() => new Function(after.replace('module.exports =', 'void')));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('_removeLineFromFile re-proves the line before deleting (file changed since the scan)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cqfix2-'));
    try {
      const abs = path.join(root, 'a.js');
      fs.writeFileSync(abs, "x();\nreturn eval(s);\ny();\n");
      const r = new CodeQualityModule()._removeLineFromFile(abs, 1, 'a.js', 'eval() usage detected');
      assert.strictEqual(r.fixed, false);
      assert.strictEqual(fs.readFileSync(abs, 'utf8'), "x();\nreturn eval(s);\ny();\n");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('isRemovableStatementLine', () => {
  for (const ok of ["console.log('a', b);", '  console.debug(x)', 'console.info(f(g(1)));', 'debugger;', 'debugger']) {
    it(`removable: ${ok.trim()}`, () => assert.strictEqual(isRemovableStatementLine(ok), true));
  }
  for (const no of ['console.log(', 'console.log(a) || run();', 'const v = console.log(a);', "return eval('x');", 'el.innerHTML = h;', 'console.error(e);', 'console.log(a); run();', 'if (x) console.log(x);']) {
    it(`kept: ${no}`, () => assert.strictEqual(isRemovableStatementLine(no), false));
  }
});
