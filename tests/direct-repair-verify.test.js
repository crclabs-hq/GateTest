// =============================================================================
// DIRECT REPAIR — no fix is committed unless it is VERIFIED, fail-closed.
// =============================================================================
// Until 2026-09-02 the engine's `_verify` was defined and never called; even
// if it had been, it returned a boolean nothing read and its catch returned
// `true`. AI patches went to real branches with no syntax check and no
// re-scan. These tests pin the contract: a fix that breaks the parse, leaves
// its finding in place, introduces a new blocking finding, or cannot be
// re-scanned at all is reverted on disk and recorded in `report.skipped`.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DirectRepair, patternHash } = require('../src/core/direct-repair');

function workspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-direct-verify-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const finding = (module, file, detail) => ({ module, file, detail, severity: 'error', pHash: patternHash(module, detail) });

function engineWith(rescanResult) {
  const engine = new DirectRepair({ dryRun: true, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dr-cache-')) });
  engine._rescan = typeof rescanResult === 'function' ? rescanResult : async () => rescanResult;
  return engine;
}

async function run(engine, root, fixes, priorFindings = fixes.map((f) => f.finding)) {
  const report = { findings: priorFindings, fixes, skipped: [] };
  for (const f of fixes) fs.writeFileSync(path.join(root, f.finding.file), f.after);
  await engine._verifyOrRevert(root, report);
  return report;
}

describe('direct-repair — verification gate', () => {
  it('keeps a fix that parses and whose finding is gone', async () => {
    const f = finding('tlsSecurity', 'src/a.js', 'src/a.js:1 rejectUnauthorized: false');
    const root = workspace({ 'src/a.js': 'x' });
    try {
      const report = await run(engineWith([]), root, [{ finding: f, before: 'const a = { rejectUnauthorized: false };\n', after: 'const a = { rejectUnauthorized: true };\n', strategy: 'builtin' }]);
      assert.strictEqual(report.fixes.length, 1);
      assert.strictEqual(report.verified, 1);
      assert.deepStrictEqual(report.skipped, []);
      assert.strictEqual(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), 'const a = { rejectUnauthorized: true };\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('REVERTS a fix that no longer parses, before any module runs', async () => {
    const f = finding('codeQuality', 'src/a.js', 'src/a.js:1 eval');
    const root = workspace({ 'src/a.js': 'x' });
    let rescanned = false;
    try {
      const report = await run(engineWith(async () => { rescanned = true; return []; }), root,
        [{ finding: f, before: 'const ok = 1;\n', after: 'const ok = ;\n', strategy: 'claude' }]);
      assert.strictEqual(report.fixes.length, 0);
      assert.match(report.skipped[0].reason, /^verify-failed:syntax:/);
      assert.strictEqual(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), 'const ok = 1;\n', 'original content restored');
      assert.strictEqual(rescanned, false, 'no re-scan for a fix that cannot parse');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('REVERTS a fix whose finding is still reported after the patch', async () => {
    const f = finding('secrets', 'src/k.js', 'src/k.js:3 API key');
    const root = workspace({ 'src/k.js': 'x' });
    try {
      const report = await run(engineWith([f]), root, [{ finding: f, before: 'const k = "sk-old";\n', after: 'const k = "sk-old"; // moved?\n', strategy: 'claude' }]);
      assert.strictEqual(report.fixes.length, 0);
      assert.strictEqual(report.skipped[0].reason, 'verify-failed:finding-persists');
      assert.strictEqual(fs.readFileSync(path.join(root, 'src/k.js'), 'utf8'), 'const k = "sk-old";\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('REVERTS a fix that introduces a NEW blocking finding in the same file', async () => {
    const f = finding('codeQuality', 'src/a.js', 'src/a.js:1 console.log');
    const introduced = finding('security', 'src/a.js', 'src/a.js:1 eval()');
    const root = workspace({ 'src/a.js': 'x' });
    try {
      const report = await run(engineWith([introduced]), root, [{ finding: f, before: 'console.log(1);\n', after: 'eval("1");\n', strategy: 'claude' }]);
      assert.strictEqual(report.fixes.length, 0);
      assert.strictEqual(report.skipped[0].reason, 'verify-failed:new-blocking-finding');
      assert.strictEqual(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), 'console.log(1);\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('a pre-existing finding in the same file is not counted as a regression', async () => {
    const f = finding('codeQuality', 'src/a.js', 'src/a.js:1 console.log');
    const preexisting = finding('errorSwallow', 'src/a.js', 'src/a.js:9 empty catch');
    const root = workspace({ 'src/a.js': 'x' });
    try {
      const report = await run(engineWith([preexisting]), root,
        [{ finding: f, before: 'console.log(1);\n', after: '// removed\n', strategy: 'builtin' }], [f, preexisting]);
      assert.strictEqual(report.fixes.length, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('FAIL-CLOSED: when the re-scan throws, every fix is reverted', async () => {
    const f = finding('codeQuality', 'src/a.js', 'src/a.js:1 console.log');
    const root = workspace({ 'src/a.js': 'x' });
    try {
      const report = await run(engineWith(async () => { throw new Error('runner exploded'); }), root,
        [{ finding: f, before: 'console.log(1);\n', after: '// removed\n', strategy: 'builtin' }]);
      assert.strictEqual(report.fixes.length, 0);
      assert.strictEqual(report.verified, 0);
      assert.match(report.skipped[0].reason, /^verify-failed:rescan-error:runner exploded/);
      assert.strictEqual(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), 'console.log(1);\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('JSON fixes are parse-checked too', async () => {
    const f = finding('syntax', 'config.json', 'config.json:1 trailing comma');
    const root = workspace({ 'config.json': '{}' });
    try {
      const report = await run(engineWith([]), root, [{ finding: f, before: '{"a":1,}', after: '{"a":1,,}', strategy: 'claude' }]);
      assert.strictEqual(report.fixes.length, 0);
      assert.match(report.skipped[0].reason, /^verify-failed:syntax:/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('the repair loop calls verification before commit (and `verify: false` is the only way out)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'direct-repair.js'), 'utf8');
    const apply = src.indexOf('await this._applyFixes(workspace, report);');
    const verify = src.indexOf('await this._verifyOrRevert(workspace, report);');
    const commit = src.indexOf('await this._commit(workspace, options, report);');
    assert.ok(apply > 0 && verify > apply && commit > verify, 'apply → verify → commit, in that order');
    assert.ok(!/async _verify\(workspace, report\)/.test(src), 'the dead boolean _verify is gone');
    assert.ok(!/verification failure is non-blocking/.test(src), 'no non-blocking verification anywhere');
  });
});
