'use strict';

// =============================================================================
// @gatetest/mcp-server MUST START THE SERVER IT PROXIES TO.
// =============================================================================
// `npx -y @gatetest/mcp-server` (1.1.3 on npm) resolved @gatetest/cli, did
// `await import()` of bin/gatetest-mcp.mjs, and exited 0 with an empty
// stdout. The cli's bin only attaches its stdio transport when it is the
// process entrypoint (argv[1] is its own file) — under the proxy, argv[1] is
// the proxy — so the import registered every handler and listened to
// nothing. Every MCP client sat on `initialize` forever.
//
// The behavioural proof over the real tarballs is tests/heavy/
// mcp-server-proxy.test.js (npm pack both packages, resolve one through the
// other, speak JSON-RPC over stdio). These in-process pins are the fast
// tripwire: the export the proxy depends on exists, the proxy calls it, and
// the three places that name the proxy bin (package.json, the DXT manifest,
// the registry server.json) agree with each other.
// =============================================================================

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(ROOT, 'packages', 'mcp-server');
const read = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));

const rootPkg = readJson(path.join(ROOT, 'package.json'));
const proxyPkg = readJson(path.join(PKG_DIR, 'package.json'));
const manifest = readJson(path.join(PKG_DIR, 'manifest.json'));
const serverJson = readJson(path.join(PKG_DIR, 'server.json'));
const proxySrc = read(path.join(PKG_DIR, 'bin', 'server.mjs'));

/** `^a.b.c` satisfied by `x.y.z` — same major, not below a.b.c. No semver dep in this repo. */
function caretSatisfies(range, version) {
  const r = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  assert.ok(r, `expected a plain caret range, got ${range}`);
  const [rMaj, rMin, rPat] = r.slice(1).map(Number);
  const [maj, min, pat] = version.split('.').map(Number);
  return maj === rMaj && (min > rMin || (min === rMin && pat >= rPat));
}

describe('bin/gatetest-mcp.mjs — the start function the proxy relies on', () => {
  let mcp;
  before(async () => { mcp = await import('../bin/gatetest-mcp.mjs'); });

  it('exports startServer as a function (importing must NOT start it — that is the whole bug)', () => {
    assert.equal(typeof mcp.startServer, 'function');
  });

  it('keeps the isMain guard so `gatetest-mcp` run directly still starts itself', () => {
    const src = read(path.join(ROOT, 'bin', 'gatetest-mcp.mjs'));
    assert.match(src, /if \(isMain\) \{\s*await startServer\(\);\s*\}/);
  });
});

describe('packages/mcp-server/bin/server.mjs — the proxy', () => {
  it('resolves the cli bin through module resolution, not a hardcoded node_modules path', () => {
    assert.match(proxySrc, /import\.meta\.resolve\('@gatetest\/cli\/bin\/gatetest-mcp\.mjs'\)/);
    // A string literal only — the comment above that line names the path it avoids.
    assert.doesNotMatch(proxySrc, /['"]\.\.\/node_modules\//, 'a hardcoded ../node_modules/ path breaks under npm hoisting');
  });

  it('calls startServer after the import — an import alone exits 0 with nothing on stdout', () => {
    assert.match(proxySrc, /await cli\.startServer\(\)/);
  });

  it('falls back to spawning the cli bin with inherited stdio for a cli that predates startServer', () => {
    // `^1.61.0` can resolve to a published 1.61.x without the export; the
    // proxy must still start the server then, or the release order bites.
    assert.match(proxySrc, /typeof cli\.startServer === 'function'/);
    assert.match(proxySrc, /spawn\(process\.execPath, \[fileURLToPath\(serverUrl\)\], \{ stdio: 'inherit' \}\)/);
    assert.match(proxySrc, /child\.on\('exit'/);
  });

  it('never writes to stdout itself — stdout is the JSON-RPC stream', () => {
    assert.doesNotMatch(proxySrc, /console\.log\(|process\.stdout\.write\(/);
  });
});

describe('packages/mcp-server — the three files that name the bin agree', () => {
  it('declares exactly one bin, gatetest-mcp-server -> bin/server.mjs, and ships bin/', () => {
    assert.deepEqual(proxyPkg.bin, { 'gatetest-mcp-server': 'bin/server.mjs' });
    assert.ok(proxyPkg.files.includes('bin/'), 'files must include bin/');
    assert.equal(proxyPkg.type, 'module', 'server.mjs uses top-level await; the package must be ESM');
    assert.ok(fs.existsSync(path.join(PKG_DIR, proxyPkg.bin['gatetest-mcp-server'])));
  });

  it('depends on a @gatetest/cli range that admits the version this tree would publish', () => {
    const range = proxyPkg.dependencies['@gatetest/cli'];
    assert.ok(caretSatisfies(range, rootPkg.version),
      `@gatetest/cli ${range} does not admit the repo's ${rootPkg.version}`);
  });

  it('DXT manifest.json points at the same bin and the same npx command', () => {
    assert.equal(manifest.server.entry_point, proxyPkg.bin['gatetest-mcp-server']);
    assert.equal(manifest.server.mcp_config.command, 'npx');
    assert.deepEqual(manifest.server.mcp_config.args, ['-y', proxyPkg.name]);
  });

  it('registry server.json names this package at this version with the same npx command', () => {
    const npm = serverJson.versions.find((v) => v.registryType === 'npm');
    assert.ok(npm, 'server.json has no npm entry');
    assert.equal(npm.identifier, proxyPkg.name);
    assert.equal(npm.version, proxyPkg.version);
    assert.equal(serverJson.version, proxyPkg.version);
    assert.equal(npm.transport.type, 'stdio');
    assert.equal(npm.transport.command, 'npx');
    assert.deepEqual(npm.transport.args, ['-y', proxyPkg.name]);
  });
});
