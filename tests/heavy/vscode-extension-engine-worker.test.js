// =============================================================================
// vscode-extension-engine-worker.test.js (heavy — runs the real engine)
//
// End-to-end: the extension's worker thread loads the checked-out engine,
// scans a small fixture project, and posts back a summary the bridge can
// turn into diagnostics. Also pins the two behaviours that made the old
// spawn design unusable: the worker must not need a binary on PATH, and the
// engine's process.exitCode=1 on BLOCKED must not leak out of the worker.
//
//   node --test tests/heavy/vscode-extension-engine-worker.test.js
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT_DIR = path.join(ROOT, 'vscode-extension');
const bridge = require(path.join(EXT_DIR, 'engine', 'engine-bridge.js'));

function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const events = [];
    const logs = [];
    const w = new Worker(path.join(EXT_DIR, 'engine', 'engine-worker.js'), { workerData });
    const timer = setTimeout(() => { w.terminate(); reject(new Error('worker timed out')); }, 240_000);
    w.on('message', (m) => {
      if (m.type === 'progress') events.push(m.event);
      else if (m.type === 'log') logs.push(m);
      else if (m.type === 'done') { clearTimeout(timer); resolve({ summary: m.summary, events, logs }); }
      else if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.message)); }
    });
    w.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function fixtureProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ext-e2e-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }));
  // A hard-coded credential the secrets module flags, plus a clean file.
  fs.writeFileSync(path.join(dir, 'src', 'leaky.js'),
    "const AWS_SECRET_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLEKEY0';\nmodule.exports = { AWS_SECRET_ACCESS_KEY };\n");
  fs.writeFileSync(path.join(dir, 'src', 'clean.js'), 'module.exports = (a, b) => a + b;\n');
  return dir;
}

describe('vscode-extension worker: end-to-end with the checked-out engine', () => {
  it('scans a fixture in-process and the bridge maps its findings to diagnostics', async () => {
    const project = fixtureProject();
    const entry = bridge.resolveEngineEntry({ configuredPath: ROOT }).entry;
    const exitBefore = process.exitCode;
    try {
      const { summary, events } = await runWorker({ entry, root: project, suite: 'quick', skipModules: bridge.EDITOR_SKIP_MODULES });

      assert.ok(['PASSED', 'BLOCKED'].includes(summary.gateStatus));
      assert.ok(summary.modules.total > 10, `ran ${summary.modules.total} modules`);
      assert.ok(events.includes('suite:start') && events.includes('suite:end'), 'progress events flow back');
      assert.ok(events.filter((e) => e === 'module:end').length > 0);
      assert.ok(Array.isArray(summary.findings));
      assert.ok(!summary.results.some((r) => r.module === 'mutation' || r.module === 'chaos'), 'editor-skipped modules did not run');

      const { inFiles } = bridge.findingsToDiagnostics(summary, project);
      for (const d of inFiles) {
        assert.ok(path.isAbsolute(d.file));
        assert.ok(d.line >= 1);
        assert.ok(['error', 'warning', 'info'].includes(d.severity));
        assert.ok(d.message.length > 0);
      }
      const verdict = bridge.summarize(summary, { inFilesCount: inFiles.length });
      assert.match(verdict.text, /^(PASSED|BLOCKED) · \d+\/\d+ modules passed/);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
    assert.strictEqual(process.exitCode, exitBefore, 'the engine exit code never leaks out of the worker');
  });

  it('scopes to a single file when changedFiles is given', async () => {
    const project = fixtureProject();
    const entry = bridge.resolveEngineEntry({ configuredPath: ROOT }).entry;
    try {
      const { summary } = await runWorker({
        entry, root: project, suite: 'quick', changedFiles: ['src/clean.js'], skipModules: bridge.EDITOR_SKIP_MODULES,
      });
      const { inFiles } = bridge.findingsToDiagnostics(summary, project, { onlyFile: path.join(project, 'src', 'clean.js') });
      assert.ok(inFiles.every((d) => path.basename(d.file) === 'clean.js'));
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('reports a clean error when the entry does not exist instead of crashing the host', async () => {
    await assert.rejects(
      runWorker({ entry: path.join(os.tmpdir(), 'no-such-engine', 'index.js'), root: os.tmpdir(), suite: 'quick' }),
      /Cannot find module/
    );
  });
});
