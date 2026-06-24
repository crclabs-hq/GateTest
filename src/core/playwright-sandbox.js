/**
 * Playwright sandbox (Manifest item #4 — JS-runtime layer).
 *
 * Runs Playwright-based tasks (chaos.js, runtime-errors.js, live-crawler-
 * browser-engine.js) inside a forked child Node process with:
 *
 *   - HARD WALLCLOCK BUDGET — parent SIGKILLs the child if it doesn't
 *     deliver a result before the deadline. Frozen Chromium can't lock
 *     up the gate.
 *   - MEMORY CAP — child runs with --max-old-space-size so a runaway
 *     page leak OOMs the child only, not the parent.
 *   - STRUCTURED-RESULT IPC — child sends one JSON line on stdout; parent
 *     parses it. Raw browser console output never reaches the parent
 *     logs.
 *   - STDERR QUARANTINED — child's stderr is captured into the result
 *     for debugging but never re-emitted by the parent unless requested.
 *
 * This is the process-layer of defence. The container/firecracker layer
 * (true OS-level isolation) is a separate piece that ships at the infra
 * level (a future docker/sandbox runner image). The two layers compose:
 * the same task spec can run inside both this process sandbox AND a
 * Docker container with --read-only --cap-drop=ALL.
 *
 * USAGE:
 *   const { runInSandbox } = require('./playwright-sandbox.js');
 *   const result = await runInSandbox({
 *     workerPath: '/path/to/worker-script.js',  // CommonJS module
 *     task: { kind: 'runtime-errors', url: 'https://example.com' },
 *     timeoutMs: 30_000,
 *     memoryMb: 256,
 *   });
 *   // result = { ok, value, error, stderr, exitCode, durationMs }
 *
 * Worker contract:
 *   The workerPath module is loaded in the child. It must export
 *   `async function run(task) → any`. The child's bootstrap calls it,
 *   stringifies the result as one JSON line, prints it, then exits 0.
 *   Any throw is caught and reported as { ok: false, error }.
 *
 * RESILIENCE: never throws on the parent side. All failure modes (child
 * crash, OOM, kill, malformed output) return a structured result with
 * ok:false.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_MB = 256;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;   // 8 MB cap on stdout
const MAX_STDERR_BYTES = 1 * 1024 * 1024;   // 1 MB cap on stderr

// ---------------------------------------------------------------------------
// Bootstrap script — written once to a temp file, executed by the child.
// Loads the worker module, invokes run(task), prints JSON on stdout.
// ---------------------------------------------------------------------------

const BOOTSTRAP_SOURCE = `
'use strict';
async function main() {
  const workerPath = process.env.GATETEST_SANDBOX_WORKER;
  const taskJson = process.env.GATETEST_SANDBOX_TASK || '{}';
  let task;
  try { task = JSON.parse(taskJson); } catch { task = {}; }
  try {
    const mod = require(workerPath);
    if (typeof mod.run !== 'function') {
      process.stdout.write(JSON.stringify({ ok: false, error: 'worker missing run()' }) + '\\n');
      process.exit(0);
    }
    const value = await mod.run(task);
    process.stdout.write(JSON.stringify({ ok: true, value }) + '\\n');
    process.exit(0);
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: (err && err.message) ? err.message : String(err),
      stack: (err && err.stack) ? String(err.stack).slice(0, 4000) : null,
    }) + '\\n');
    process.exit(0);
  }
}
main();
`;

let _bootstrapPath = null;
function ensureBootstrapPath() {
  if (_bootstrapPath && fs.existsSync(_bootstrapPath)) return _bootstrapPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-sandbox-'));
  const p = path.join(dir, 'bootstrap.js');
  fs.writeFileSync(p, BOOTSTRAP_SOURCE, 'utf8');
  _bootstrapPath = p;
  return p;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a task in a sandboxed child Node process.
 *
 * @param {object} opts
 * @param {string} opts.workerPath   absolute path to a CommonJS module
 *                                   exporting `async function run(task)`
 * @param {object} [opts.task={}]    JSON-serialisable task spec
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.memoryMb]
 * @param {string} [opts.cwd]
 * @returns {Promise<{
 *   ok: boolean,
 *   value: any,
 *   error: string | null,
 *   stack: string | null,
 *   stderr: string,
 *   exitCode: number | null,
 *   killedReason: string | null,
 *   durationMs: number,
 * }>}
 */
function runInSandbox(opts = {}) {
  const workerPath = opts.workerPath;
  const task = opts.task || {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const memoryMb = Number.isFinite(opts.memoryMb) ? opts.memoryMb : DEFAULT_MEMORY_MB;
  const cwd = opts.cwd || process.cwd();

  if (!workerPath || !fs.existsSync(workerPath)) {
    return Promise.resolve({
      ok: false,
      value: null,
      error: `worker path missing: ${workerPath}`,
      stack: null,
      stderr: '',
      exitCode: null,
      killedReason: 'bad-config',
      durationMs: 0,
    });
  }

  const bootstrap = ensureBootstrapPath();
  const t0 = Date.now();

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${memoryMb}`,
      bootstrap,
    ], {
      cwd,
      env: {
        ...process.env,
        GATETEST_SANDBOX_WORKER: workerPath,
        GATETEST_SANDBOX_TASK: JSON.stringify(task),
        // Belt-and-braces: don't inherit weird parent flags.
        NODE_OPTIONS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let killed = false;
    let killedReason = null;
    let settled = false;

    const timer = setTimeout(() => {
      killed = true;
      killedReason = 'timeout';
      try { child.kill('SIGKILL'); } catch { /* swallow */ }
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      if (stdout.length + buf.length > MAX_STDOUT_BYTES) {
        killed = true;
        killedReason = 'stdout-overflow';
        try { child.kill('SIGKILL'); } catch { /* swallow */ }
        return;
      }
      stdout = Buffer.concat([stdout, buf]);
    });
    child.stderr.on('data', (buf) => {
      if (stderr.length + buf.length > MAX_STDERR_BYTES) {
        // Don't kill on stderr overflow — just clamp.
        stderr = Buffer.concat([stderr, buf.subarray(0, MAX_STDERR_BYTES - stderr.length)]);
        return;
      }
      stderr = Buffer.concat([stderr, buf]);
    });

    function settle(exitCode) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = stdout.toString('utf8');
      const errOut = stderr.toString('utf8');
      const durationMs = Date.now() - t0;

      // Parse the LAST JSON line of stdout (bootstrap emits exactly one).
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      let parsed = null;
      if (lastLine) {
        try { parsed = JSON.parse(lastLine); } catch { /* not parseable */ }
      }

      if (killed) {
        resolve({
          ok: false,
          value: null,
          error: `sandbox killed (${killedReason})`,
          stack: null,
          stderr: errOut,
          exitCode,
          killedReason,
          durationMs,
        });
        return;
      }
      if (!parsed) {
        resolve({
          ok: false,
          value: null,
          error: 'sandbox produced no parseable result',
          stack: null,
          stderr: errOut,
          exitCode,
          killedReason: null,
          durationMs,
        });
        return;
      }
      if (parsed.ok !== true) {
        resolve({
          ok: false,
          value: null,
          error: parsed.error || 'worker reported failure',
          stack: parsed.stack || null,
          stderr: errOut,
          exitCode,
          killedReason: null,
          durationMs,
        });
        return;
      }
      resolve({
        ok: true,
        value: parsed.value,
        error: null,
        stack: null,
        stderr: errOut,
        exitCode,
        killedReason: null,
        durationMs,
      });
    }

    child.on('exit', (code) => settle(code));
    child.on('error', (err) => {
      killed = true;
      killedReason = `spawn-error: ${err.message}`;
      settle(null);
    });
  });
}

// ---------------------------------------------------------------------------

module.exports = {
  runInSandbox,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MEMORY_MB,
  // exposed for tests
  _ensureBootstrapPath: ensureBootstrapPath,
  _BOOTSTRAP_SOURCE: BOOTSTRAP_SOURCE,
};
