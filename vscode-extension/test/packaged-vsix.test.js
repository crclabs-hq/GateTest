'use strict';
// =============================================================================
// packaged-vsix.test.js — the .vsix is the environment that decides.
//
// .vscodeignore whitelists node_modules down to the engine and its three
// runtime dependencies (acorn, pixelmatch, pngjs). A whitelist fails quietly:
// a dependency it forgot is a module the registry skips with a console.warn,
// and a scan that "passes" with fewer modules than the CLI. So this test opens
// the packaged .vsix itself — not the working tree — and proves that
//   (1) the manifest, LICENSE, host code and engine bridge + worker are inside,
//       and nothing from node_modules but the engine and those three packages;
//   (2) every module src/core/registry.js declares loads from the vsix layout,
//       exactly as many as load from the unpacked npm install beside it;
//   (3) engine-worker.js completes a quick scan of a small fixture from that
//       layout and reports the hard-coded secret planted in it.
//
// Run after `npm run package` (publish-vscode.yml does). With no .vsix present
// the suite is SKIPPED and says so — never a green pass for a package that
// was not checked.
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Worker } = require('worker_threads');

const EXT_DIR = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'package.json'), 'utf8'));
const VSIX = process.env.GATETEST_VSIX
  ? path.resolve(process.env.GATETEST_VSIX)
  : path.join(EXT_DIR, `${manifest.name}-${manifest.version}.vsix`);

/** The one hand-typed decision in .vscodeignore, mirrored here so a drift in either fails. */
const ALLOWED_PACKAGES = ['@gatetest/cli', 'acorn', 'pixelmatch', 'pngjs'];
/** A ceiling, not a target: 3,580 files before the whitelist, 339 after. Only ratchets down. */
const MAX_FILES = 450;

// ─── a dependency-free zip reader (a .vsix is a plain deflate zip) ───────────

function extractZip(file, dest) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, `${file}: end-of-central-directory record not found — not a zip`);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  assert.ok(count !== 0xffff && off !== 0xffffffff, 'zip64 archive — the package grew past 4 GB / 65535 entries?');

  const names = [];
  for (let n = 0; n < count; n++) {
    assert.strictEqual(buf.readUInt32LE(off), 0x02014b50, `central directory entry ${n}`);
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    assert.ok(!name.split('/').includes('..') && !path.isAbsolute(name), `unsafe zip entry ${name}`);
    if (name.endsWith('/')) continue;
    assert.strictEqual(buf.readUInt32LE(localOff), 0x04034b50, `local header of ${name}`);
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = data;
    else if (method === 8) content = zlib.inflateRawSync(data);
    else assert.fail(`unsupported zip compression method ${method} for ${name}`);

    const target = path.join(dest, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    names.push(name);
  }
  return names;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Load the registry in a worker (its console.warn is the only signal of a dropped module). */
function loadRegistryIn(registryPath) {
  const code = `
    const { parentPort, workerData } = require('worker_threads');
    const warnings = [];
    console.warn = (...a) => warnings.push(a.join(' '));
    const { ModuleRegistry, BUILT_IN_MODULES } = require(workerData.registry);
    const loaded = new ModuleRegistry().loadBuiltIn().list();
    parentPort.postMessage({ declared: Object.keys(BUILT_IN_MODULES).length, loaded: loaded.length, warnings });
  `;
  return new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: { registry: registryPath } });
    w.on('message', resolve);
    w.on('error', reject);
  });
}

function runEngineWorker(workerFile, workerData) {
  return new Promise((resolve, reject) => {
    const events = [];
    const logs = [];
    const w = new Worker(workerFile, { workerData });
    const timer = setTimeout(() => { w.terminate(); reject(new Error('engine worker timed out')); }, 240_000);
    w.on('message', (m) => {
      if (m.type === 'progress') events.push(m.event);
      else if (m.type === 'log') logs.push(m.text);
      else if (m.type === 'done') { clearTimeout(timer); resolve({ summary: m.summary, events, logs }); }
      else if (m.type === 'error') { clearTimeout(timer); reject(new Error(`${m.message}\n${m.stack || ''}`)); }
    });
    w.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function fixtureProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-vsix-smoke-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }));
  // A hard-coded credential the secrets module flags (positive control), plus a clean file.
  fs.writeFileSync(path.join(dir, 'src', 'leaky.js'),
    "const AWS_SECRET_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLEKEY0';\nmodule.exports = { AWS_SECRET_ACCESS_KEY };\n");
  fs.writeFileSync(path.join(dir, 'src', 'clean.js'), 'module.exports = (a, b) => a + b;\n');
  return dir;
}

// ─── the suite ───────────────────────────────────────────────────────────────

// Skipped per test (not per suite) so the runner's counters say "skipped 4",
// never "tests 0 / pass 0" for a package that was not checked.
const skip = fs.existsSync(VSIX) ? false : `not checked: ${VSIX} not found — run \`npm run package\` first`;

describe('the packaged .vsix', () => {
  let dir;
  let names;
  const ext = (...p) => path.join(dir, 'extension', ...p);

  before(() => {
    if (skip) return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-vsix-'));
    names = extractZip(VSIX, dir);
  });
  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ships the manifest, the LICENSE, the compiled host and the engine bridge + worker', { skip }, () => {
    for (const f of ['package.json', 'LICENSE.txt', 'out/extension.js', 'engine/engine-bridge.js', 'engine/engine-worker.js']) {
      assert.ok(names.includes(`extension/${f}`), `extension/${f} is in the package`);
    }
    assert.ok(names.includes('extension.vsixmanifest'), 'vsixmanifest present');
    assert.match(fs.readFileSync(path.join(dir, 'extension.vsixmanifest'), 'utf8'), /extension\/LICENSE\.txt/, 'the manifest points at the LICENSE');

    const packaged = JSON.parse(fs.readFileSync(ext('package.json'), 'utf8'));
    assert.strictEqual(packaged.version, manifest.version);
    assert.strictEqual(packaged.license, 'MIT');
    assert.match(fs.readFileSync(ext('LICENSE.txt'), 'utf8'), /^MIT License/, 'LICENSE text matches package.json "license"');
    const repoLicense = path.join(EXT_DIR, '..', 'LICENSE');
    if (fs.existsSync(repoLicense)) {
      const norm = (s) => s.replace(/\r\n/g, '\n');
      assert.strictEqual(norm(fs.readFileSync(ext('LICENSE.txt'), 'utf8')), norm(fs.readFileSync(repoLicense, 'utf8')), 'the packaged LICENSE is the repo LICENSE');
    }
  });

  it(`carries nothing from node_modules but ${ALLOWED_PACKAGES.join(', ')}, and stays under ${MAX_FILES} files`, { skip }, () => {
    const inNodeModules = names.filter((n) => n.startsWith('extension/node_modules/'));
    const strays = inNodeModules.filter((n) => !ALLOWED_PACKAGES.some((p) => n.startsWith(`extension/node_modules/${p}/`)));
    assert.deepStrictEqual(strays, [], 'unexpected packages in the vsix — .vscodeignore whitelist drifted');
    for (const p of ALLOWED_PACKAGES) {
      assert.ok(names.includes(`extension/node_modules/${p}/package.json`), `${p} is in the package`);
    }
    assert.ok(names.length <= MAX_FILES, `${names.length} files in the vsix (ceiling ${MAX_FILES}; 3,580 before the whitelist)`);
    assert.ok(!names.some((n) => /\.(map|d\.ts|md)$/.test(n) && n.startsWith('extension/node_modules/')), 'no maps, typings or docs from dependencies');
  });

  it('loads every module the registry declares from the vsix layout — as many as the unpacked install loads', { skip }, async () => {
    const fromVsix = await loadRegistryIn(ext('node_modules', '@gatetest', 'cli', 'src', 'core', 'registry.js'));
    assert.deepStrictEqual(fromVsix.warnings, [], 'no "Could not load module" warnings from the packaged engine');
    assert.ok(fromVsix.declared > 0, 'the registry declares modules');
    assert.strictEqual(fromVsix.loaded, fromVsix.declared, `all ${fromVsix.declared} declared modules load from the vsix`);

    const unpacked = path.join(EXT_DIR, 'node_modules', '@gatetest', 'cli', 'src', 'core', 'registry.js');
    if (fs.existsSync(unpacked)) {
      const fromInstall = await loadRegistryIn(unpacked);
      assert.strictEqual(fromVsix.loaded, fromInstall.loaded, 'the vsix loads the same module count as the npm install it was cut from');
    }
  });

  it('engine-worker.js completes a quick scan from the vsix layout and reports the planted secret', { skip }, async () => {
    const bridge = require(ext('engine', 'engine-bridge.js'));
    const resolved = bridge.entryFromPath(ext('node_modules', '@gatetest', 'cli'));
    assert.ok(resolved && resolved.entry, 'the packaged @gatetest/cli resolves as an engine');
    const project = fixtureProject();
    try {
      const { summary, events, logs } = await runEngineWorker(ext('engine', 'engine-worker.js'), {
        entry: resolved.entry, root: project, suite: 'quick', skipModules: bridge.EDITOR_SKIP_MODULES,
      });
      assert.ok(['PASSED', 'BLOCKED'].includes(summary.gateStatus), `gateStatus ${summary.gateStatus}`);
      assert.ok(!summary.nothingChecked, 'the fixture was checked');
      assert.ok(summary.modules.total > 10, `ran ${summary.modules.total} modules`);
      assert.ok(events.includes('suite:start') && events.includes('suite:end'), 'progress events flow back');
      const loadFailures = logs.filter((t) => /Could not load/i.test(t));
      assert.deepStrictEqual(loadFailures, [], 'no module failed to load during the scan');

      const { inFiles } = bridge.findingsToDiagnostics(summary, project);
      const leaky = path.join(project, 'src', 'leaky.js');
      assert.ok(inFiles.some((d) => path.resolve(d.file) === leaky), 'the hard-coded credential in src/leaky.js is reported (positive control)');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
