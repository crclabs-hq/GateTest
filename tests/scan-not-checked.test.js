'use strict';

// The paid scan page says what was NOT checked (audit 2026-10-02, item 15):
// a fallback engine or the per-scan file cap must never wear "All Clear"
// unqualified. The PR comment and the playground already said so.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { notCheckedNotices } = require('../website/app/lib/scan-not-checked');

test('the full engine ran on every file: nothing to disclose', () => {
  assert.deepEqual(notCheckedNotices({ filesAnalysed: 120, filesInRepo: 120, truncated: false, engine: 'cli' }), []);
  assert.deepEqual(notCheckedNotices(null), []);
});

test('fallback engine: a partial-scan notice', () => {
  const out = notCheckedNotices({ filesAnalysed: 120, filesInRepo: 120, truncated: false, engine: 'runTier' });
  assert.equal(out.length, 1);
  assert.match(out[0], /Partial scan/);
});

test('file cap: says how many files were not checked', () => {
  const out = notCheckedNotices({ filesAnalysed: 4000, filesInRepo: 4108, truncated: true, engine: 'cli' });
  assert.equal(out.length, 1);
  assert.match(out[0], /4000 of 4108 files/);
  assert.match(out[0], /108 files were not checked/);
});

test('control: truncated without both counts says nothing it cannot back up', () => {
  assert.deepEqual(notCheckedNotices({ truncated: true, engine: 'cli' }), []);
});

test('the paid scan page renders the notices from the run response', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'scan', 'status', 'page.tsx'), 'utf8');
  assert.match(src, /import \{ notCheckedNotices \} from "@\/app\/lib\/scan-not-checked"/);
  assert.match(src, /isComplete && notCheckedNotices\(scanResult\?\.coverage\)\.length > 0/);
  const run = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'api', 'scan', 'run', 'route.ts'), 'utf8');
  assert.match(run, /coverage: \{[\s\S]{0,200}truncated:[\s\S]{0,80}engine:/, 'the run route still returns the coverage block the page reads');
});

// The e2e module crashed on Tallrig (`framework.packages` undefined for a
// custom `test:e2e` script) and showed as "failed" with no finding.
test('e2e: a custom test:e2e script with no node_modules is skipped as not checked, not a crash', async () => {
  const os = require('os');
  const E2eModule = require('../src/modules/e2e');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-e2e-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'test:e2e': 'playwright test' } }));
    const checks = [];
    const result = { addCheck: (name, passed, d = {}) => checks.push({ name, passed, ...d }) };
    await new E2eModule().run(result, { projectRoot: root });
    const run = checks.find((c) => c.name === 'e2e:run');
    assert.ok(run && run.passed && run.severity === 'info', JSON.stringify(checks));
    assert.match(run.message, /not installed|Skipped/);

    // Control: with dependencies installed, the custom script is executed.
    fs.mkdirSync(path.join(root, 'node_modules'));
    const mod = new E2eModule();
    let ran = null;
    mod._exec = (cmd) => { ran = cmd; return { exitCode: 0, stdout: '', stderr: '' }; };
    const checks2 = [];
    await mod.run({ addCheck: (name, passed, d = {}) => checks2.push({ name, passed, ...d }) }, { projectRoot: root });
    assert.equal(ran, 'npm run test:e2e 2>&1');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
