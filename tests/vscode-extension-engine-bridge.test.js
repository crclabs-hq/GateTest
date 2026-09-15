// =============================================================================
// vscode-extension-engine-bridge.test.js
//
// The VS Code extension runs the engine IN-PROCESS through
// vscode-extension/engine/engine-bridge.js. Before this the extension spawned
// `gatetest --format json --file <f>` — two flags the CLI never had — so every
// editor scan printed "unknown option" and JSON.parse'd a console banner.
//
// The bridge has no `vscode` import on purpose: these tests load it directly
// and pin (a) engine resolution order, (b) the finding → diagnostic mapping,
// (c) the one-line verdict. The end-to-end worker run lives in
// tests/heavy/vscode-extension-engine-worker.test.js.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'vscode-extension');
const bridge = require(path.join(EXT_DIR, 'engine', 'engine-bridge.js'));

describe('engine-bridge: resolveEngineEntry', () => {
  it('finds the sibling checkout when the extension lives inside the repo', () => {
    const hit = bridge.resolveEngineEntry({ extensionDir: EXT_DIR, workspaceRoot: os.tmpdir() });
    assert.ok(hit.entry, 'an entry is resolved');
    // Either the bundled node_modules copy (after npm install) or the checkout —
    // both are legitimate; neither is a CLI binary on PATH. The version is
    // whatever that package.json says, so pin it to the resolved package.
    assert.strictEqual(hit.version, require(path.join(hit.packageDir, 'package.json')).version);
    assert.match(hit.version, /^\d+\.\d+\.\d+/);
    assert.ok(['bundled', 'checkout'].includes(hit.source), `source is ${hit.source}`);
    assert.ok(fs.existsSync(hit.entry));
    assert.match(path.basename(hit.entry), /index\.js$/);
  });

  it('prefers the workspace-pinned @gatetest/cli over everything else', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ws-'));
    const pkgDir = path.join(ws, 'node_modules', '@gatetest', 'cli');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@gatetest/cli', version: '0.0.1-ws', main: 'src/index.js' }));
    fs.writeFileSync(path.join(pkgDir, 'src', 'index.js'), 'module.exports = {};');
    try {
      const hit = bridge.resolveEngineEntry({ extensionDir: EXT_DIR, workspaceRoot: ws });
      assert.strictEqual(hit.source, 'workspace');
      assert.strictEqual(hit.version, '0.0.1-ws');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('honours gatetest.enginePath given as a checkout dir OR as a file inside it', () => {
    const asDir = bridge.resolveEngineEntry({ configuredPath: ROOT });
    assert.strictEqual(asDir.source, 'setting');
    assert.strictEqual(asDir.entry, path.join(ROOT, 'src', 'index.js'));

    const asFile = bridge.resolveEngineEntry({ configuredPath: path.join(ROOT, 'src', 'index.js') });
    assert.strictEqual(asFile.source, 'setting');
    assert.strictEqual(asFile.version, require(path.join(ROOT, 'package.json')).version);
  });

  it('reports every path it tried when nothing resolves', () => {
    const miss = bridge.resolveEngineEntry({ configuredPath: path.join(os.tmpdir(), 'nope-gatetest'), workspaceRoot: os.tmpdir(), extensionDir: os.tmpdir() });
    assert.strictEqual(miss.entry, null);
    assert.ok(Array.isArray(miss.attempts) && miss.attempts.length >= 3);
    assert.ok(miss.attempts.every((a) => a.ok === false));
  });

  it('does not accept a directory that is not @gatetest/cli', () => {
    assert.strictEqual(bridge.entryFromPath(EXT_DIR), null, 'the extension itself is not the engine');
  });
});

describe('engine-bridge: findingsToDiagnostics', () => {
  const root = path.join(os.tmpdir(), 'proj');
  const summary = {
    gateStatus: 'BLOCKED',
    findings: [
      { module: 'secrets', rule: 'secrets:aws-key', severity: 'error', file: 'src/a.js', line: 12, message: 'AWS key', suggestion: 'move to env', blocking: true },
      { module: 'lint', rule: 'lint:unused', severity: 'warning', file: 'src/a.js', line: 3, message: 'unused var' },
      { module: 'lint', rule: 'lint:dup', severity: 'warning', file: 'src/a.js', line: 4, message: 'dup', duplicateOf: 'lint:unused' },
      { module: 'ciSecurity', rule: 'ci:none', severity: 'info', file: null, line: null, message: 'no CI config' },
      { module: 'deadCode', rule: 'dead', severity: 'weird', file: path.join(root, 'src', 'b.js'), line: 0, message: 'dead fn' },
    ],
  };

  it('maps file findings to absolute paths, sorted error → warning → info then by line', () => {
    const { inFiles, repoLevel } = bridge.findingsToDiagnostics(summary, root);
    assert.deepStrictEqual(inFiles.map((d) => [path.basename(d.file), d.line, d.severity]), [
      ['a.js', 12, 'error'],
      ['a.js', 3, 'warning'],
      ['b.js', 1, 'info'],
    ]);
    assert.ok(inFiles.every((d) => path.isAbsolute(d.file)));
    assert.strictEqual(inFiles[0].suggestion, 'move to env');
    assert.strictEqual(inFiles[0].blocking, true);
    assert.strictEqual(inFiles[2].severity, 'info', 'an unknown severity degrades to info, never to error');
  });

  it('keeps repo-level findings (no file) out of the diagnostics but returns them', () => {
    const { repoLevel } = bridge.findingsToDiagnostics(summary, root);
    assert.strictEqual(repoLevel.length, 1);
    assert.strictEqual(repoLevel[0].module, 'ciSecurity');
  });

  it('drops cross-module duplicates the registry already folded', () => {
    const { inFiles } = bridge.findingsToDiagnostics(summary, root);
    assert.ok(!inFiles.some((d) => d.message === 'dup'));
  });

  it('scopes to one file for "Scan This File"', () => {
    const { inFiles } = bridge.findingsToDiagnostics(summary, root, { onlyFile: path.join(root, 'src', 'b.js') });
    assert.deepStrictEqual(inFiles.map((d) => path.basename(d.file)), ['b.js']);
  });

  it('tolerates a summary with no findings at all', () => {
    const { inFiles, repoLevel } = bridge.findingsToDiagnostics({ gateStatus: 'PASSED' }, root);
    assert.deepStrictEqual(inFiles, []);
    assert.deepStrictEqual(repoLevel, []);
  });
});

describe('engine-bridge: summarize', () => {
  it('reads the verdict from gateStatus and the counts from checks/modules', () => {
    const v = bridge.summarize({
      gateStatus: 'BLOCKED',
      modules: { total: 42, passed: 40 },
      checks: { blockingErrors: 2, warnings: 5 },
      deferred: ['mutation', 'chaos'],
    }, { inFilesCount: 7 });
    assert.strictEqual(v.passed, false);
    assert.strictEqual(v.errors, 2);
    assert.match(v.text, /^BLOCKED · 40\/42 modules passed · 2 blocking, 5 warning\(s\) · 7 finding\(s\)/);
    assert.match(v.text, /deferred to CI: mutation, chaos/);
  });

  it('says so when the engine checked nothing — an empty scan must never read as clean', () => {
    const v = bridge.summarize({ gateStatus: 'PASSED', nothingChecked: true, modules: {}, checks: {} });
    assert.strictEqual(v.passed, true);
    assert.match(v.text, /nothing was checked/);
  });
});

describe('vscode-extension: the CLI-spawn design is gone', () => {
  const src = fs.readFileSync(path.join(EXT_DIR, 'src', 'extension.ts'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'package.json'), 'utf8'));

  it('never spawns a child process or passes flags the CLI does not have', () => {
    assert.ok(!/child_process/.test(src), 'no child_process import');
    assert.ok(!/--format/.test(src), 'no --format flag');
    assert.ok(!/'--file'/.test(src), 'no --file flag');
    assert.match(src, /worker_threads/);
    assert.match(src, /engine-worker\.js/);
  });

  it('does not write global settings on activation', () => {
    assert.ok(!/autoRegisterMcpServer/.test(src));
    assert.ok(!/ConfigurationTarget\.Global/.test(src));
  });

  it('bundles the engine and exposes enginePath instead of gatePath', () => {
    assert.ok(manifest.dependencies && manifest.dependencies['@gatetest/cli'], '@gatetest/cli is a runtime dependency');
    const props = manifest.contributes.configuration.properties;
    assert.ok(props['gatetest.enginePath']);
    assert.ok(!props['gatetest.gatePath']);
    assert.ok(manifest.contributes.commands.some((c) => c.command === 'gatetest.cancelScan'));
  });

  it('ships the engine files in the vsix', () => {
    const ignore = fs.readFileSync(path.join(EXT_DIR, '.vscodeignore'), 'utf8');
    assert.ok(!/^engine/m.test(ignore), 'engine/ is not ignored');
    assert.ok(fs.existsSync(path.join(EXT_DIR, 'engine', 'engine-worker.js')));
  });
});
