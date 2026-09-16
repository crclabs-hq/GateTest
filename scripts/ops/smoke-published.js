#!/usr/bin/env node
'use strict';

/**
 * Post-publish smoke — install every PUBLISHED GateTest artifact the way a
 * stranger would, and fail loudly when one is broken.
 *
 *   node scripts/ops/smoke-published.js            # table, exit 1 on any FAIL
 *   node scripts/ops/smoke-published.js --json     # the same rows as JSON
 *   node scripts/ops/smoke-published.js --only npm,mcp,vscode,action,ghcr
 *
 * Why this exists (2026-09-15): `npx @gatetest/cli` could not run at all —
 * 1.61.0 shipped no bin named after the package — and `npx -y
 * @gatetest/mcp-server` (1.1.3) crashed on start with `Cannot find module
 * './site-url'` from the cli it depends on. Every test in this repo ran from
 * a checkout or a locally packed tarball; nothing ever installed from the
 * registry. This script does only that: a fresh temp dir, an empty npm
 * cache, `npm install @gatetest/cli@latest`, and then the commands a README
 * tells a stranger to type.
 *
 * Three-state on purpose (Doctrine §1): PASS, FAIL, KNOWN GAP — a channel
 * that is EXPECTED to be missing until 1.61.1 is on npm is reported as a gap,
 * and turns into a FAIL by itself the day that release ships (see
 * smoke-published-lib.js). NOT CHECKED is printed for a channel whose
 * prerequisite already failed; it never wears a tick. Every subprocess and
 * every network call has a timeout. Only FAIL rows set the exit code.
 *
 * Node 22+, CommonJS, node builtins only. No repo code is imported — this
 * must judge the published bytes, not the checkout it runs from.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('./smoke-published-lib');

const { RESULT } = lib;
const WIN = process.platform === 'win32';
const CLI_PKG = '@gatetest/cli';
const MCP_PKG = '@gatetest/mcp-server';
const VSCODE_EXT = 'GateTestHQ.gatetest';
const ACTION_PAGE = 'https://github.com/marketplace/actions/gatetest-quality-gate';
const GHCR_REPO = 'crclabs-hq/gatetest';
const USER_AGENT = 'gatetest-smoke-published (+https://github.com/crclabs-hq/GateTest)';

const T = Object.freeze({
  npmView: 60_000,
  npmInstall: 300_000,
  npxRun: 120_000,
  scan: 240_000,
  mcp: 180_000,
  mcpExit: 15_000,
  http: 30_000,
});

const log = (msg) => process.stderr.write(`[smoke] ${msg}\n`);

/**
 * The part of a stderr worth putting in a table cell: from the first line
 * that names an error (Node prints `Error: Cannot find module …` BEFORE the
 * stack, so the tail of a trace says `Module._compile` and nothing useful),
 * else the head. Whitespace collapsed.
 */
function excerpt(text, n = 500) {
  const flat = String(text || '').trim();
  const at = flat.search(/^.*(?:\bError\b|Cannot find|ERR_|error:)/im);
  return flat.slice(at > 0 ? at : 0).replace(/\s+/g, ' ').slice(0, n);
}

// ── subprocesses ────────────────────────────────────────────────────────────

/** Quote one argument for cmd.exe — npm/npx on Windows are .cmd shims and need a shell. */
function shellArg(a) {
  return WIN && /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/** Kill a process and, on Windows, the tree the shell shim spawned under it. */
function killTree(proc) {
  if (proc.exitCode !== null || proc.signalCode) return;
  if (WIN) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
  else proc.kill('SIGKILL');
}

function spawnCmd(cmd, args, { cwd, env }) {
  return WIN
    ? spawn([cmd, ...args].map(shellArg).join(' '), { cwd, env, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    : spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Run to completion with a wall clock. Never rejects: a timeout is a result (`timedOut`), not an exception. */
function run(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const proc = spawnCmd(cmd, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(proc); }, timeoutMs);
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('error', (err) => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut }); });
    proc.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
    proc.stdin.end();
  });
}

/**
 * Speak MCP to a server over stdio: send `initialize`, resolve on the first
 * reply to it, on exit, or on the wall clock — whichever comes first. Then
 * close stdin (the server exits 0 on EOF) and make sure the tree is gone.
 */
function mcpInitialize(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const proc = spawnCmd(cmd, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdin.end();
      if (proc.exitCode === null && !proc.signalCode) {
        const grace = setTimeout(() => killTree(proc), T.mcpExit);
        proc.on('close', () => clearTimeout(grace));
      }
      resolve({ stdout, stderr, ...lib.parseJsonRpcStream(stdout), ...extra });
    };
    const timer = setTimeout(() => finish({ timedOut: true, code: null }), timeoutMs);
    proc.stdout.on('data', (c) => {
      stdout += c;
      if (lib.parseJsonRpcStream(stdout).messages.some((m) => m.id === 1)) finish({ timedOut: false, code: null });
    });
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('error', (err) => { stderr += `\n${err.message}`; finish({ timedOut: false, code: null, spawnError: err.message }); });
    proc.on('close', (code, signal) => finish({ timedOut: false, code, signal }));
    proc.stdin.write(lib.frameJsonRpc(lib.initializeRequest(1)));
  });
}

// ── network ─────────────────────────────────────────────────────────────────

/** fetch with a hard timeout; never throws — a network error is a result too. */
async function http(url, init = {}) {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'user-agent': USER_AGENT, ...(init.headers || {}) },
      signal: AbortSignal.timeout(T.http),
      redirect: 'follow',
    });
    const text = await res.text();
    return { ok: true, status: res.status, url: res.url, headers: res.headers, text };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'TimeoutError' ? `timeout after ${T.http}ms` : err.message };
  }
}

// ── channels ────────────────────────────────────────────────────────────────

const row = (id, channel, version, result, detail) => ({ id, channel, version: version || '-', result, detail });

async function npmView(pkg, env) {
  const r = await run('npm', ['view', pkg, 'version'], { cwd: os.tmpdir(), env, timeoutMs: T.npmView });
  const v = r.stdout.trim().split(/\r?\n/).pop();
  return { version: lib.parseVersion(v) ? v : null, error: r.timedOut ? `npm view timed out after ${T.npmView}ms` : excerpt(r.stderr, 300) };
}

function writeFixture(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'smoke-fixture', version: '1.0.0', private: true, main: 'src/index.js', scripts: { test: 'node src/index.js' } }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), "'use strict';\n\nfunction add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n");
  fs.writeFileSync(path.join(dir, 'README.md'), '# smoke fixture\n\nA tiny project the published CLI is pointed at.\n');
}

/** Rows a–c: install the cli, run it both ways npx offers, scan a fixture. */
async function checkNpmCli(ctx) {
  const { workdir, env, publishedVersion } = ctx;
  const rows = [];
  const installDir = path.join(workdir, 'install');
  fs.mkdirSync(installDir, { recursive: true });
  log(`npm init + npm install ${CLI_PKG}@latest in ${installDir}`);
  const init = await run('npm', ['init', '-y'], { cwd: installDir, env, timeoutMs: T.npmView });
  const inst = init.code === 0 ? await run('npm', ['install', `${CLI_PKG}@latest`], { cwd: installDir, env, timeoutMs: T.npmInstall }) : init;
  if (inst.code !== 0) {
    const why = inst.timedOut ? `install timed out after ${T.npmInstall}ms` : `npm ${init.code === 0 ? 'install' : 'init'} exit ${inst.code}: ${excerpt(inst.stderr)}`;
    rows.push(row('npm-cli', `npm ${CLI_PKG} (npx -p … gatetest)`, publishedVersion, RESULT.FAIL, why));
    rows.push(row('npm-cli-bare', `npm ${CLI_PKG} (bare npx)`, publishedVersion, RESULT.NOT_CHECKED, 'install failed'));
    rows.push(row('npm-cli-scan', `npm ${CLI_PKG} (--suite quick on a fixture)`, publishedVersion, RESULT.NOT_CHECKED, 'install failed'));
    return rows;
  }

  log(`npx -p ${CLI_PKG} gatetest --version`);
  const explicit = await run('npx', ['-p', CLI_PKG, 'gatetest', '--version'], { cwd: installDir, env, timeoutMs: T.npxRun });
  const explicitVersion = (explicit.stdout.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/) || [])[0] || null;
  const explicitOk = explicit.code === 0 && Boolean(explicitVersion);
  rows.push(row('npm-cli', `npm ${CLI_PKG} (npx -p … gatetest)`, explicitVersion || publishedVersion, explicitOk ? RESULT.PASS : RESULT.FAIL,
    explicitOk ? `--version printed ${explicitVersion}${publishedVersion && explicitVersion !== publishedVersion ? ` (npm view says ${publishedVersion})` : ''}` : `exit ${explicit.code}${explicit.timedOut ? ' (timed out)' : ''}: ${excerpt(explicit.stderr || explicit.stdout)}`));

  log(`npx ${CLI_PKG} --version (bare form)`);
  const bare = await run('npx', [CLI_PKG, '--version'], { cwd: installDir, env, timeoutMs: T.npxRun });
  const bareVersion = (bare.stdout.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/) || [])[0] || null;
  const bareOk = bare.code === 0 && Boolean(bareVersion);
  const bareResult = lib.classifyGapChannel({ ok: bareOk, publishedVersion });
  rows.push(row('npm-cli-bare', `npm ${CLI_PKG} (bare npx)`, bareVersion || publishedVersion, bareResult,
    bareOk ? `bare npx resolves the cli bin (${bareVersion})`
      : `${bareResult === RESULT.KNOWN_GAP ? `no 'cli' bin before ${lib.BARE_NPX_SINCE}; ` : ''}exit ${bare.code}: ${excerpt(bare.stderr || bare.stdout, 200)}`));

  if (!explicitOk) {
    rows.push(row('npm-cli-scan', `npm ${CLI_PKG} (--suite quick on a fixture)`, publishedVersion, RESULT.NOT_CHECKED, 'cli did not answer --version'));
    return rows;
  }
  const fixture = path.join(workdir, 'fixture');
  writeFixture(fixture);
  log(`npx -p ${CLI_PKG} gatetest --suite quick --project ${fixture}`);
  const scan = await run('npx', ['-p', CLI_PKG, 'gatetest', '--suite', 'quick', '--project', fixture], { cwd: installDir, env, timeoutMs: T.scan });
  const verdict = scan.timedOut ? { result: RESULT.FAIL, reason: `no exit within ${T.scan}ms` } : lib.classifyScanRun(scan);
  rows.push(row('npm-cli-scan', `npm ${CLI_PKG} (--suite quick on a fixture)`, explicitVersion, verdict.result,
    verdict.result === RESULT.PASS ? verdict.reason : `${verdict.reason}: ${excerpt(scan.stderr || scan.stdout)}`));
  return rows;
}

/** Row d: the published MCP server answers `initialize` over stdio. */
async function checkMcpServer(ctx) {
  const { workdir, env } = ctx;
  const cwd = path.join(workdir, 'mcp');
  fs.mkdirSync(cwd, { recursive: true });
  const { version: published } = await npmView(MCP_PKG, env);
  log(`npx -y ${MCP_PKG}@latest  → initialize`);
  const r = await mcpInitialize('npx', ['-y', `${MCP_PKG}@latest`], { cwd, env, timeoutMs: T.mcp });
  const reply = r.messages.find((m) => m.id === 1);
  const channel = `npm ${MCP_PKG} (initialize over stdio)`;
  if (lib.isValidInitializeResult(reply, 1)) {
    const v = `${published || '?'} (server ${reply.result.serverInfo.name}@${reply.result.serverInfo.version || '?'})`;
    const violation = r.nonJson.length ? `; ${r.nonJson.length} non-JSON line(s) on stdout` : '';
    return [row('mcp-server', channel, v, violation ? RESULT.FAIL : RESULT.PASS, violation ? `initialize answered but stdout is not clean JSON-RPC${violation}: ${excerpt(r.nonJson.join(' '), 200)}` : `initialize ok, protocol ${reply.result.protocolVersion}`)];
  }
  const why = r.timedOut ? `no initialize reply within ${T.mcp}ms`
    : reply ? `initialize returned an error: ${JSON.stringify(reply.error || reply).slice(0, 200)}`
      : `exited ${r.code}${r.signal ? ` (${r.signal})` : ''} before replying`;
  return [row('mcp-server', channel, published, RESULT.FAIL, `${why}; stderr: ${excerpt(r.stderr) || '(empty)'}`)];
}

/** Row e: the VS Code Marketplace lists the extension as validated + public. */
async function checkVsCodeMarketplace() {
  log(`VS Code Marketplace gallery query for ${VSCODE_EXT}`);
  const res = await http('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: { accept: 'application/json;api-version=3.0-preview.1', 'content-type': 'application/json' },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: VSCODE_EXT }] }], flags: 103 }),
  });
  const channel = `VS Code Marketplace ${VSCODE_EXT}`;
  if (!res.ok || res.status !== 200) return [row('vscode-extension', channel, null, RESULT.FAIL, res.ok ? `HTTP ${res.status}` : res.error)];
  let ext;
  try {
    ext = JSON.parse(res.text).results[0].extensions.find((e) => `${e.publisher.publisherName}.${e.extensionName}`.toLowerCase() === VSCODE_EXT.toLowerCase());
  } catch (err) {
    return [row('vscode-extension', channel, null, RESULT.FAIL, `unparseable gallery response: ${err.message}`)];
  }
  if (!ext) return [row('vscode-extension', channel, null, RESULT.FAIL, 'extension not found in the gallery')];
  const flags = String(ext.flags || '').split(/\s*,\s*/).filter(Boolean);
  const version = ext.versions && ext.versions[0] && ext.versions[0].version;
  const ok = flags.includes('validated') && flags.includes('public');
  return [row('vscode-extension', channel, version, ok ? RESULT.PASS : RESULT.FAIL, `flags=[${flags.join(', ')}] lastUpdated=${ext.lastUpdated || '?'}`)];
}

/** Row f: the GitHub Marketplace page for the Action answers 200. */
async function checkActionMarketplace() {
  log(`GET ${ACTION_PAGE}`);
  const res = await http(ACTION_PAGE, { headers: { accept: 'text/html' } });
  const channel = 'GitHub Action Marketplace gatetest-quality-gate';
  if (!res.ok) return [row('github-action-marketplace', channel, null, RESULT.FAIL, res.error)];
  const version = (res.text.match(/\bv?(\d+\.\d+\.\d+)\b(?=[^<]{0,40}Latest)/) || [])[1] || null;
  return [row('github-action-marketplace', channel, version, res.status === 200 ? RESULT.PASS : RESULT.FAIL, `HTTP ${res.status}${res.url !== ACTION_PAGE ? ` (final ${res.url})` : ''}`)];
}

/** Row g: ghcr.io/crclabs-hq/gatetest:latest exists — a gap until the 1.61.1 tag publishes it. */
async function checkGhcrImage(ctx) {
  const channel = `ghcr.io/${GHCR_REPO}:latest`;
  log(`ghcr.io token + manifest for ${GHCR_REPO}:latest`);
  // Measured 2026-09-16: ghcr's token endpoint answers 200 for a public
  // image, 401 UNAUTHORIZED for one that exists but is not public, and 403
  // DENIED for one that does not exist. To a stranger the last two are the
  // same thing — no image — so both are "missing", not "the check broke".
  const missing = (status) => [401, 403, 404].includes(status);
  const gapOrFail = (status, what) => {
    const result = lib.classifyGapChannel({ ok: false, publishedVersion: ctx.publishedVersion });
    return [row('ghcr-image', channel, null, result, `image not pullable anonymously (${what} HTTP ${status})${result === RESULT.KNOWN_GAP ? ` — publishes on the v${lib.BARE_NPX_SINCE} tag` : ''}`)];
  };
  const tok = await http(`https://ghcr.io/token?scope=repository:${GHCR_REPO}:pull`, { headers: { accept: 'application/json' } });
  if (!tok.ok) return [row('ghcr-image', channel, null, RESULT.FAIL, `anonymous token: ${tok.error}`)];
  if (missing(tok.status)) return gapOrFail(tok.status, 'token');
  let token = null;
  try { token = tok.status === 200 ? JSON.parse(tok.text).token : null; } catch { token = null; } // error-ok — reported below
  if (!token) return [row('ghcr-image', channel, null, RESULT.FAIL, `anonymous token: HTTP ${tok.status}, no token in body`)];
  const man = await http(`https://ghcr.io/v2/${GHCR_REPO}/manifests/latest`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
    },
  });
  if (!man.ok) return [row('ghcr-image', channel, null, RESULT.FAIL, man.error)];
  if (man.status === 200) return [row('ghcr-image', channel, 'latest', RESULT.PASS, `manifest ${man.headers.get('docker-content-digest') || 'present'}`)];
  if (missing(man.status)) return gapOrFail(man.status, 'manifest');
  return [row('ghcr-image', channel, null, RESULT.FAIL, `manifest HTTP ${man.status}`)];
}

// ── main ────────────────────────────────────────────────────────────────────

const CHANNELS = [
  { key: 'npm', check: checkNpmCli, ids: ['npm-cli', 'npm-cli-bare', 'npm-cli-scan'] },
  { key: 'mcp', check: checkMcpServer, ids: ['mcp-server'] },
  { key: 'vscode', check: checkVsCodeMarketplace, ids: ['vscode-extension'] },
  { key: 'action', check: checkActionMarketplace, ids: ['github-action-marketplace'] },
  { key: 'ghcr', check: checkGhcrImage, ids: ['ghcr-image'] },
];

function parseArgs(argv) {
  const only = argv.includes('--only') ? String(argv[argv.indexOf('--only') + 1] || '').split(',').filter(Boolean) : null;
  const unknown = only ? only.filter((k) => !CHANNELS.some((c) => c.key === k)) : [];
  if (unknown.length) throw new Error(`--only: unknown channel(s) ${unknown.join(', ')}; known: ${CHANNELS.map((c) => c.key).join(', ')}`);
  return { json: argv.includes('--json'), only, keep: argv.includes('--keep') };
}

/** A stranger's environment: an empty npm cache, no prompts, no telemetry from the fixture scan. */
function childEnv(workdir) {
  const env = { ...process.env, GATETEST_NO_TELEMETRY: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  env.npm_config_cache = path.join(workdir, 'npm-cache');
  env.npm_config_yes = 'true';
  env.npm_config_update_notifier = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_audit = 'false';
  env.npm_config_loglevel = 'error';
  return env;
}

async function runSmoke(opts) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-smoke-'));
  const env = childEnv(workdir);
  const rows = [];
  try {
    const view = await npmView(CLI_PKG, env);
    if (!view.version) log(`could not read ${CLI_PKG} from the registry: ${view.error}`);
    const ctx = { workdir, env, publishedVersion: view.version };
    for (const ch of CHANNELS) {
      if (opts.only && !opts.only.includes(ch.key)) continue;
      try {
        rows.push(...await ch.check(ctx));
      } catch (err) {
        for (const id of ch.ids) rows.push(row(id, ch.key, ctx.publishedVersion, RESULT.FAIL, `smoke check threw: ${err.message}`));
      }
    }
    return { generatedAt: new Date().toISOString(), publishedCliVersion: view.version, node: process.version, platform: process.platform, rows, summary: lib.summarize(rows), exitCode: lib.exitCodeFor(rows) };
  } finally {
    if (!opts.keep) fs.rm(workdir, { recursive: true, force: true, maxRetries: 3 }, () => {});
    else log(`kept ${workdir}`);
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  const report = await runSmoke(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const s = report.summary;
    process.stdout.write(`${lib.renderTable(report.rows)}\n\n${report.exitCode ? 'SMOKE: FAILED' : 'SMOKE: PASSED'}  ${s.pass} pass, ${s.fail} fail, ${s.knownGap} known gap, ${s.notChecked} not checked  (${CLI_PKG}@${report.publishedCliVersion || '?'} on npm)\n`);
  }
  return report.exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { process.stderr.write(`smoke-published could not run: ${err.message}\n`); process.exitCode = 2; },
  );
}

module.exports = { ...lib, CHANNELS, runSmoke, main, parseArgs, childEnv, writeFixture, T };
