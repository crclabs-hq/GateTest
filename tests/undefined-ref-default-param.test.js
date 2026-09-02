// undefinedRef — a default parameter whose value is a nested call declares its
// name. PR #418 (2026-09-02): `async function run(engine, root, fixes,
// priorFindings = fixes.map((f) => f.finding))` was reported as "priorFindings
// used as a value but never declared — module will crash on load". The
// parameter-list regex could not cross the inner parentheses.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const UndefinedRef = require('../src/modules/undefined-ref');

async function findings(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-undef-default-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), body);
    const r = { checks: [], addCheck(n, p, m) { this.checks.push({ name: n, passed: p, ...(m || {}) }); }, addInfo() {} };
    await new UndefinedRef().run(r, { projectRoot: root });
    return r.checks.filter((c) => !c.passed).map((c) => c.message || c.name);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('undefinedRef — default parameters with nested calls', () => {
  // The exact shape from tests/direct-repair-verify.test.js that was flagged.
  const SHAPE = [
    "const fs = require('fs');",
    'function workspace(files) {',
    '  return files;',
    '}',
    'const finding = (module, file, detail) => ({ module, file, detail });',
    '',
    'async function run(engine, root, fixes, priorFindings = fixes.map((f) => f.finding)) {',
    '  const report = { findings: priorFindings, fixes, skipped: [] };',
    '  for (const f of fixes) fs.writeFileSync(root + f.finding.file, f.after);',
    '  await engine._verifyOrRevert(root, report);',
    '  return report;',
    '}',
    'module.exports = { run, workspace, finding };',
    '',
  ].join('\n');

  it('a default value that is a call still declares the parameter', async () => {
    const f = await findings(SHAPE);
    assert.deepStrictEqual(f.filter((m) => /priorFindings/.test(m)), [], `reported: ${JSON.stringify(f)}`);
  });
  it('NEGATIVE CONTROL: a genuinely undeclared module-level reference is still reported', async () => {
    // The rule's one shape: an object-property value that is a bare name.
    const f = await findings(SHAPE + 'const boot = { handler: reallyUndeclaredThing, run };\n');
    assert.ok(f.some((m) => /reallyUndeclaredThing/.test(m)), `expected a finding, got: ${JSON.stringify(f)}`);
  });
});
