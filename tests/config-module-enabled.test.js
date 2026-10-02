'use strict';

// .gatetest.json `modules.<name>.enabled` and `modules.<name>.severity` are
// honoured. Audit 2026-10-02: Tallrig disabled unitTests, integrationTests,
// links and e2e and lowered severities; GateTest read neither key, ran all
// four modules anyway, and printed nothing about it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { GateTest } = require('../src/index.js');

function project(config, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-modcfg-'));
  fs.writeFileSync(path.join(root, '.gatetest.json'), JSON.stringify(config));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

async function quick(root, keep) {
  const gt = new GateTest(root, { silent: true, quiet: true });
  await gt.init();
  const suite = gt.config.getSuite('quick');
  const summary = await gt.runSuite('quick', { skipModules: suite.filter((m) => !keep.includes(m)) });
  // A blocked gate sets process.exitCode = 1 (src/index.js); the planted
  // findings block on purpose, and that must not fail this test file.
  process.exitCode = 0;
  return summary;
}

test('enabled: false — the module does not run, and the summary says it was not checked and why', async () => {
  const root = project({ modules: { codeQuality: { enabled: false } } }, { 'src/a.js': 'debugger;\n' });
  try {
    const summary = await quick(root, ['codeQuality', 'secrets']);
    const ran = (summary.results || []).map((r) => r.module);
    assert.ok(!ran.includes('codeQuality'), `codeQuality must not run: ${ran}`);
    const d = summary.deferred.find((x) => x.module === 'codeQuality');
    assert.ok(d, 'a disabled module is disclosed in summary.deferred');
    assert.match(d.reason, /modules\.codeQuality\.enabled: false/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('control: without the key, the same module runs and finds the planted debugger', async () => {
  const root = project({}, { 'src/a.js': 'debugger;\n' });
  try {
    const summary = await quick(root, ['codeQuality']);
    assert.ok((summary.results || []).some((r) => r.module === 'codeQuality'));
    assert.ok(!summary.deferred.some((x) => x.module === 'codeQuality'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('severity: "warning" re-levels that module\'s failing errors; other modules keep theirs', async () => {
  const src = { 'src/a.js': 'function f(x) {\n  debugger;\n  return x;\n}\nmodule.exports = { f };\n' };
  const levelOf = (summary) => (summary.results || [])
    .filter((r) => r.module === 'codeQuality')
    .flatMap((r) => r.checks || [])
    .filter((c) => !c.passed && /debugger/.test(c.name))
    .map((c) => c.severity);
  const plain = project({}, src);
  const lowered = project({ modules: { codeQuality: { severity: 'warning' } } }, src);
  try {
    const before = levelOf(await quick(plain, ['codeQuality']));
    const after = levelOf(await quick(lowered, ['codeQuality']));
    assert.ok(before.includes('error'), `control: the debugger finding is an error by default (${before})`);
    assert.ok(after.length > 0 && after.every((s) => s === 'warning'), `re-levelled to warning (${after})`);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
    fs.rmSync(lowered, { recursive: true, force: true });
  }
});
