'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const GATETEST_BIN = path.join(__dirname, '..', 'bin', 'gatetest.js');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Run `node bin/gatetest.js <args>` and collect stdout/stderr/exit code. */
function runCli(args, { cwd, env, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATETEST_BIN, ...args], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, GATETEST_NO_TELEMETRY: '1', ...(env || {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
  });
}

describe('live-crawler — concurrent runs never read each other\'s report', () => {
  let serverA;
  let serverB;
  let urlA;
  let urlB;
  let projectRoot;

  async function setup() {
    if (serverA) return;
    serverA = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Site A</title></head><body>this is site A, plenty of visible text on this page so it does not look blank</body></html>');
    });
    urlA = `http://127.0.0.1:${serverA.address().port}/`;

    serverB = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Site B</title></head><body>this is site B, a totally different origin with different findings text</body></html>');
    });
    urlB = `http://127.0.0.1:${serverB.address().port}/`;

    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-concurrency-'));
  }

  after(() => {
    if (serverA) serverA.close();
    if (serverB) serverB.close();
  });

  it('CONTROL PAIR — two concurrent --crawl runs against different origins, same project root, each report its own target', async () => {
    await setup();
    const commonArgs = ['--project', projectRoot, '--crawl-max', '1', '--crawl-page-timeout', '5000'];

    const [resultA, resultB] = await Promise.all([
      runCli(['--crawl', urlA, ...commonArgs]),
      runCli(['--crawl', urlB, ...commonArgs]),
    ]);

    assert.match(resultA.stdout, new RegExp(`# URL: ${urlA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `run A's own output must show its own URL header. stdout:\n${resultA.stdout}`);
    assert.ok(!resultA.stdout.includes('Site B') && !resultA.stdout.includes(urlB),
      `run A's output must never contain run B's target/content. stdout:\n${resultA.stdout}`);

    assert.match(resultB.stdout, new RegExp(`# URL: ${urlB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `run B's own output must show its own URL header. stdout:\n${resultB.stdout}`);
    assert.ok(!resultB.stdout.includes('Site A') && !resultB.stdout.includes(urlA),
      `run B's output must never contain run A's target/content. stdout:\n${resultB.stdout}`);
  });
});

describe('live-crawler — a timed-out run never prints a prior run\'s stale report', () => {
  let okServer;
  let hangServer;
  let okUrl;
  let hangUrl;
  let projectRoot;
  const hangingSockets = new Set();

  async function setup() {
    if (okServer) return;
    okServer = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Earlier Site</title></head><body>an earlier, unrelated, successful crawl with enough visible text</body></html>');
    });
    okUrl = `http://127.0.0.1:${okServer.address().port}/`;

    hangServer = await startServer(() => { /* never responds — the fixture holds the connection open forever */ });
    hangServer.on('connection', (socket) => hangingSockets.add(socket));
    hangUrl = `http://127.0.0.1:${hangServer.address().port}/`;

    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-timeout-'));
  }

  after(() => {
    if (okServer) okServer.close();
    for (const socket of hangingSockets) socket.destroy();
    if (hangServer) hangServer.close();
  });

  it('CONTROL — a prior successful crawl leaves a report; a later timed-out crawl (same project root) does not print it', async () => {
    await setup();

    // Round 1: a real, successful crawl — populates the "latest" report file
    // that the pre-fix code would blindly re-read on the next run.
    const first = await runCli(['--crawl', okUrl, '--project', projectRoot, '--crawl-max', '1']);
    assert.match(first.stdout, /ALL CLEAR/, `expected round 1 to produce a clean report.\nstdout:\n${first.stdout}`);
    assert.ok(first.stdout.includes(`# URL: ${okUrl}`), `expected round 1's own URL in its report.\nstdout:\n${first.stdout}`);

    // Round 2: a target that never responds, with a module ceiling far
    // shorter than the per-page timeout, so the OUTER module timeout (not
    // the per-page budget) is what fires.
    const second = await runCli(
      ['--crawl', hangUrl, '--project', projectRoot, '--crawl-max', '1'],
      { env: { GATETEST_MODULE_TIMEOUT_MS: '1500' } },
    );

    assert.match(second.stdout, /No crawl report/i, `expected an explicit no-report message.\nstdout:\n${second.stdout}`);
    assert.match(second.stdout, /timed out after \d+ms/i, `expected the timeout to be named.\nstdout:\n${second.stdout}`);
    assert.ok(!second.stdout.includes(`# URL: ${okUrl}`),
      `round 2 must NOT print round 1's stale report (its URL header).\nstdout:\n${second.stdout}`);
    assert.ok(!second.stdout.includes('ALL CLEAR'),
      `a timed-out run must never claim ALL CLEAR from a stale file.\nstdout:\n${second.stdout}`);
  });
});
