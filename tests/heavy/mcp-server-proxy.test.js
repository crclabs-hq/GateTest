'use strict';

// =============================================================================
// THE PUBLISHED @gatetest/mcp-server MUST ANSWER `initialize`.
// =============================================================================
// This is the shape a user gets from `npx -y @gatetest/mcp-server`: the
// mcp-server tarball, with @gatetest/cli resolved from its node_modules. Both
// tarballs are built here with `npm pack` — not read from the repo tree — so
// the test sees exactly the bytes npm would ship, then the proxy bin is run
// over stdio and spoken to as an MCP client would.
//
// 1.1.3 on npm failed this: the proxy imported the cli's bin, the bin's
// isMain guard was false under the proxy, and the process exited 0 with an
// empty stdout. No test spoke to the proxy, so nothing noticed.
//
// The cli's third-party dependencies are linked in from the repo's
// node_modules rather than fetched: the question is whether the two shipped
// packages find each other and start, not whether npm can download the SDK.
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'proxy-test', version: '0' } } };

let tmp = null;
let cliDir = null;   // extracted @gatetest/cli tarball
let proxyDir = null; // extracted @gatetest/mcp-server tarball
let fakeDir = null;  // proxy bin over a cli that predates startServer
let legacyProxyDir = null; // the 1.1.3 proxy bin (import only) over the packed cli
let strangerDir = null;    // an import-only server.mjs that is NOT @gatetest/mcp-server
let linked = false;
let legacyLinked = false;

// bin/server.mjs of @gatetest/mcp-server 1.1.3 as published (npm pack
// @gatetest/mcp-server@1.1.3, comments dropped): resolve the cli bin, import
// it, nothing else. Its dependency range (@gatetest/cli ^1.56.3) resolves to
// every cli released since, so this is what `npx -y @gatetest/mcp-server`
// runs until a newer proxy is on npm — and the cli has to start itself
// under it (bin/gatetest-mcp.mjs, startedByProxyBin).
const PROXY_1_1_3_BIN = `#!/usr/bin/env node
const serverUrl = import.meta.resolve('@gatetest/cli/bin/gatetest-mcp.mjs');
await import(serverUrl);
`;

/** A package dir with `bin/server.mjs` = the 1.1.3 proxy body and the packed cli linked under node_modules. */
function makeImportOnlyHost(dir, pkgName) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName, version: '1.1.3', type: 'module', bin: { 'gatetest-mcp-server': 'bin/server.mjs' } }));
  fs.writeFileSync(path.join(dir, 'bin', 'server.mjs'), PROXY_1_1_3_BIN);
  fs.mkdirSync(path.join(dir, 'node_modules', '@gatetest'), { recursive: true });
  fs.symlinkSync(cliDir, path.join(dir, 'node_modules', '@gatetest', 'cli'), 'junction');
}

/** `npm pack <spec>` into a fresh dir under `dest`, extract the one tarball into `<dir>/<name>/package`. */
function packAndExtract(spec, dest, name) {
  const out = fs.mkdtempSync(path.join(dest, 'tgz-'));
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', out, spec], {
    cwd: REPO, stdio: 'pipe', shell: true, timeout: 180_000,
  });
  const tgz = fs.readdirSync(out).find((f) => f.endsWith('.tgz'));
  assert.ok(tgz, `npm pack ${spec} produced no tarball`);
  fs.mkdirSync(path.join(out, name));
  // Relative arguments, deliberately: GNU tar reads a colon in an argument
  // as `host:path`, so a Windows path fails with "Cannot connect to C:".
  execFileSync('tar', ['-xzf', tgz, '-C', name], { cwd: out, stdio: 'pipe', timeout: 120_000 });
  const pkgDir = path.join(out, name, 'package');
  assert.ok(fs.existsSync(path.join(pkgDir, 'package.json')), `${spec} did not extract to ${pkgDir}`);
  return pkgDir;
}

/**
 * Run a proxy bin as an MCP client would: write the requests, close stdin,
 * collect everything until the process exits. Resolves with the exit code,
 * the parsed stdout lines, the stdout lines that were NOT JSON (a protocol
 * violation the caller asserts on), and stderr.
 */
function runProxy(binPath, requests, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [binPath], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`proxy did not exit within ${timeoutMs}ms\nstdout so far:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      const lines = [];
      const nonJson = [];
      for (const l of stdout.split(/\r?\n/).filter((x) => x.trim())) {
        try { lines.push(JSON.parse(l)); } catch { nonJson.push(l); } // error-ok — collected and asserted on
      }
      resolve({ code, signal, lines, nonJson, stderr });
    });
    for (const r of requests) proc.stdin.write(`${JSON.stringify(r)}\n`);
    proc.stdin.end();
  });
}

// What every @gatetest/cli <= 1.61.1 looks like to the proxy: a
// bin/gatetest-mcp.mjs with no startServer export that only answers when it
// is the process entrypoint. Answers each request with a recognisable name.
const LEGACY_CLI_BIN = `
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
const isMain = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; });
  process.stdin.on('end', () => {
    for (const line of buf.split('\\n').filter((l) => l.trim())) {
      const req = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { serverInfo: { name: 'legacy-cli-as-entrypoint' } } }) + '\\n');
    }
  });
}
`;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mcp-proxy-'));
  cliDir = packAndExtract('.', tmp, 'cli');
  proxyDir = packAndExtract('./packages/mcp-server', tmp, 'mcp');

  // The cli's dependencies (the MCP SDK and friends) come from the repo.
  // The proxy's only runtime dependency is the cli, which it resolves
  // through its own node_modules — that link IS the published layout.
  try {
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(cliDir, 'node_modules'), 'junction');
    fs.mkdirSync(path.join(proxyDir, 'node_modules', '@gatetest'), { recursive: true });
    fs.symlinkSync(cliDir, path.join(proxyDir, 'node_modules', '@gatetest', 'cli'), 'junction');
    linked = true;
  } catch {
    linked = false; // surfaced by the test below rather than silently skipped
  }

  // The fallback layout: the SHIPPED proxy bin (copied out of the tarball)
  // over the legacy cli above.
  fakeDir = path.join(tmp, 'fake');
  const fakeCli = path.join(fakeDir, 'node_modules', '@gatetest', 'cli');
  fs.mkdirSync(path.join(fakeCli, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(fakeDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(fakeCli, 'package.json'), JSON.stringify({ name: '@gatetest/cli', version: '1.61.1', type: 'module' }));
  fs.writeFileSync(path.join(fakeCli, 'bin', 'gatetest-mcp.mjs'), LEGACY_CLI_BIN);
  fs.writeFileSync(path.join(fakeDir, 'package.json'), JSON.stringify({ name: 'fake-host', type: 'module' }));
  fs.copyFileSync(path.join(proxyDir, 'bin', 'server.mjs'), path.join(fakeDir, 'bin', 'server.mjs'));

  // The published 1.1.3 proxy over the packed cli, and the same import-only
  // bin under a package that is not @gatetest/mcp-server (the auto-start must
  // not fire for that one).
  legacyProxyDir = path.join(tmp, 'legacy-1.1.3');
  strangerDir = path.join(tmp, 'stranger');
  try {
    makeImportOnlyHost(legacyProxyDir, '@gatetest/mcp-server');
    makeImportOnlyHost(strangerDir, 'some-other-wrapper');
    legacyLinked = true;
  } catch {
    legacyLinked = false;
  }
});

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } // error-ok
});

describe('published @gatetest/mcp-server over a published @gatetest/cli', () => {
  it('the layout was linked (otherwise the runs below prove nothing)', () => {
    assert.ok(linked, 'could not link the packed packages together — a silent pass here would be a false all-clear');
  });

  it('ships exactly the bin package.json declares, and the cli ships the bin the proxy resolves', () => {
    const proxyPkg = JSON.parse(fs.readFileSync(path.join(proxyDir, 'package.json'), 'utf8'));
    assert.deepEqual(proxyPkg.bin, { 'gatetest-mcp-server': 'bin/server.mjs' });
    assert.ok(fs.existsSync(path.join(proxyDir, 'bin', 'server.mjs')), 'bin/server.mjs missing from the mcp-server tarball');
    assert.ok(fs.existsSync(path.join(cliDir, 'bin', 'gatetest-mcp.mjs')), 'bin/gatetest-mcp.mjs missing from the cli tarball');
  });

  it('answers initialize with serverInfo.name within 30 s, exits 0 on stdin EOF, and puts only JSON on stdout', async () => {
    const r = await runProxy(path.join(proxyDir, 'bin', 'server.mjs'), [INIT]);
    assert.deepEqual(r.nonJson, [], `non-JSON on stdout:\n${r.nonJson.join('\n')}`);
    const reply = r.lines.find((l) => l.id === 1);
    assert.ok(reply, `no reply to initialize — this is the 1.1.3 failure (exit ${r.code}, stdout ${r.lines.length} lines)\nstderr:\n${r.stderr}`);
    assert.ok(reply.result, `initialize returned an error: ${JSON.stringify(reply.error)}`);
    assert.equal(reply.result.serverInfo.name, 'gatetest');
    assert.match(reply.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
    assert.equal(r.code, 0, `expected a clean exit on EOF, got ${r.code} (signal ${r.signal})\nstderr:\n${r.stderr}`);
  });

  it('tools/list through the proxy returns at least 20 tools', async () => {
    const r = await runProxy(path.join(proxyDir, 'bin', 'server.mjs'), [INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]);
    assert.deepEqual(r.nonJson, []);
    const reply = r.lines.find((l) => l.id === 2);
    assert.ok(reply && reply.result, `no tools/list result: ${JSON.stringify(reply)}\nstderr:\n${r.stderr}`);
    assert.ok(Array.isArray(reply.result.tools));
    assert.ok(reply.result.tools.length >= 20, `expected >= 20 tools, got ${reply.result.tools.length}`);
    assert.ok(reply.result.tools.some((t) => t.name === 'scan_local'), 'scan_local missing from the proxied tool list');
  });

  it('an unknown method gets JSON-RPC -32601 through the proxy', async () => {
    const r = await runProxy(path.join(proxyDir, 'bin', 'server.mjs'), [INIT, { jsonrpc: '2.0', id: 3, method: 'no/such/method', params: {} }]);
    const reply = r.lines.find((l) => l.id === 3);
    assert.ok(reply && reply.error, `expected an error reply: ${JSON.stringify(reply)}`);
    assert.equal(reply.error.code, -32601);
  });
});

describe('the PUBLISHED 1.1.3 proxy (import only, no startServer call) over this cli', () => {
  it('the layout was linked', () => {
    assert.ok(legacyLinked, 'could not build the 1.1.3 layout — a silent pass here would be a false all-clear');
  });

  it('answers initialize: the cli starts itself when @gatetest/mcp-server/bin/server.mjs is the entrypoint', async () => {
    const r = await runProxy(path.join(legacyProxyDir, 'bin', 'server.mjs'), [INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]);
    assert.deepEqual(r.nonJson, [], `non-JSON on stdout:\n${r.nonJson.join('\n')}`);
    const init = r.lines.find((l) => l.id === 1);
    assert.ok(init && init.result, `no reply to initialize under the 1.1.3 proxy (exit ${r.code}, stdout ${r.lines.length} lines)\nstderr:\n${r.stderr}`);
    assert.equal(init.result.serverInfo.name, 'gatetest');
    const list = r.lines.find((l) => l.id === 2);
    assert.ok(list && list.result && list.result.tools.length >= 20, `tools/list did not answer through the 1.1.3 proxy: ${JSON.stringify(list)}`);
    assert.equal(r.code, 0, `expected a clean exit on EOF, got ${r.code} (signal ${r.signal})\nstderr:\n${r.stderr}`);
  });

  it('does NOT start under an import-only bin from any other package (the auto-start is scoped to @gatetest/mcp-server)', async () => {
    const r = await runProxy(path.join(strangerDir, 'bin', 'server.mjs'), [INIT]);
    assert.equal(r.lines.length, 0, `a stranger wrapper got MCP replies — the auto-start fired outside @gatetest/mcp-server:\n${JSON.stringify(r.lines)}`);
    assert.equal(r.code, 0);
  });

  it('starts under any wrapper when GATETEST_MCP_AUTOSTART=1 is set', async () => {
    const r = await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [path.join(strangerDir, 'bin', 'server.mjs')], {
        stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GATETEST_MCP_AUTOSTART: '1' },
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { proc.kill(); reject(new Error(`did not exit\nstderr:\n${stderr}`)); }, 30_000);
      proc.stdout.on('data', (c) => { stdout += c; });
      proc.stderr.on('data', (c) => { stderr += c; });
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
      proc.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      proc.stdin.write(`${JSON.stringify(INIT)}\n`);
      proc.stdin.end();
    });
    const reply = r.stdout.split(/\r?\n/).filter((x) => x.trim()).map((l) => JSON.parse(l)).find((l) => l.id === 1);
    assert.ok(reply && reply.result, `GATETEST_MCP_AUTOSTART=1 did not start the server (exit ${r.code})\nstderr:\n${r.stderr}`);
    assert.equal(reply.result.serverInfo.name, 'gatetest');
  });
});

describe('the proxy over a cli that predates startServer (the spawn fallback)', () => {
  it('still answers initialize, by running the cli bin as its own entrypoint', async () => {
    const r = await runProxy(path.join(fakeDir, 'bin', 'server.mjs'), [INIT]);
    assert.deepEqual(r.nonJson, [], `non-JSON on stdout:\n${r.nonJson.join('\n')}`);
    const reply = r.lines.find((l) => l.id === 1);
    assert.ok(reply, `fallback did not start the legacy cli (exit ${r.code})\nstderr:\n${r.stderr}`);
    assert.equal(reply.result.serverInfo.name, 'legacy-cli-as-entrypoint');
    assert.equal(r.code, 0, `child exit code was not forwarded: ${r.code}`);
  });
});
