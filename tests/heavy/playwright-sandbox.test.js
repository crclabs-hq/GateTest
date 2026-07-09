// =============================================================================
// PLAYWRIGHT SANDBOX TEST
// =============================================================================
// Tests the process-level sandbox in isolation (no Playwright required).
// We exercise the parent's process-management code by writing tiny CommonJS
// worker scripts to a tmp dir that simulate the shapes a real Playwright
// worker would produce: success, throw, hang, OOM, malformed output.
// =============================================================================

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SB = require('../../src/core/playwright-sandbox.js');

let tmpRoot;
let workerDir;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-sb-'));
  workerDir = path.join(tmpRoot, 'workers');
  fs.mkdirSync(workerDir, { recursive: true });
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeWorker(name, body) {
  const p = path.join(workerDir, `${name}.js`);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('playwright-sandbox — shape', () => {
  it('exports runInSandbox', () => {
    assert.strictEqual(typeof SB.runInSandbox, 'function');
  });

  it('exports defaults', () => {
    assert.ok(SB.DEFAULT_TIMEOUT_MS > 0);
    assert.ok(SB.DEFAULT_MEMORY_MB > 0);
  });
});

// ---------------------------------------------------------------------------
// Bad config — missing worker path
// ---------------------------------------------------------------------------

describe('playwright-sandbox — bad config', () => {
  it('returns ok:false when workerPath is missing', async () => {
    const result = await SB.runInSandbox({ workerPath: '' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.killedReason, 'bad-config');
  });

  it('returns ok:false when workerPath does not exist', async () => {
    const result = await SB.runInSandbox({ workerPath: '/tmp/definitely-not-here.js' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.killedReason, 'bad-config');
  });
});

// ---------------------------------------------------------------------------
// Success path — worker returns a value
// ---------------------------------------------------------------------------

describe('playwright-sandbox — success', () => {
  it('returns ok:true with the worker\'s value', async () => {
    const worker = writeWorker('success', `
      module.exports.run = async function(task) {
        return { received: task, doubled: (task.n || 0) * 2 };
      };
    `);
    const result = await SB.runInSandbox({
      workerPath: worker,
      task: { n: 21 },
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.value.received, { n: 21 });
    assert.strictEqual(result.value.doubled, 42);
    assert.strictEqual(result.error, null);
    assert.ok(result.durationMs >= 0);
  });
});

// ---------------------------------------------------------------------------
// Worker throws
// ---------------------------------------------------------------------------

describe('playwright-sandbox — worker throws', () => {
  it('reports the thrown error without crashing the parent', async () => {
    const worker = writeWorker('throws', `
      module.exports.run = async function() {
        throw new Error('boom');
      };
    `);
    const result = await SB.runInSandbox({ workerPath: worker });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /boom/);
    assert.ok(typeof result.stack === 'string' || result.stack === null);
  });
});

// ---------------------------------------------------------------------------
// Missing run() export
// ---------------------------------------------------------------------------

describe('playwright-sandbox — worker missing run()', () => {
  it('reports the contract violation', async () => {
    const worker = writeWorker('no-run', `module.exports = { notRun: 42 };`);
    const result = await SB.runInSandbox({ workerPath: worker });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /missing run/);
  });
});

// ---------------------------------------------------------------------------
// Timeout — worker hangs, parent kills
// ---------------------------------------------------------------------------

describe('playwright-sandbox — timeout', () => {
  it('SIGKILLs the worker when it exceeds timeoutMs', async () => {
    // A bare unresolved Promise doesn't keep Node's event loop alive — the
    // process exits cleanly with no work pending. Use setInterval to hold
    // the loop open so the parent's timeout actually has to kick in.
    const worker = writeWorker('hang', `
      module.exports.run = async function() {
        const t = setInterval(() => {}, 60_000);
        return new Promise(() => { void t; });
      };
    `);
    const result = await SB.runInSandbox({
      workerPath: worker,
      timeoutMs: 800,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.killedReason, 'timeout');
    assert.ok(result.durationMs >= 800, `duration ${result.durationMs} should be ≥ timeout`);
    assert.ok(result.durationMs < 3000, 'timeout should fire promptly');
  });
});

// ---------------------------------------------------------------------------
// Malformed stdout
// ---------------------------------------------------------------------------

describe('playwright-sandbox — malformed output', () => {
  it('handles worker that crashes before emitting JSON', async () => {
    const worker = writeWorker('crash', `
      // Intentionally crashes before run() can emit anything
      process.exit(7);
    `);
    const result = await SB.runInSandbox({ workerPath: worker });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /no parseable result|sandbox killed/);
  });

  it('handles worker that prints unparseable garbage', async () => {
    const worker = writeWorker('garbage', `
      process.stdout.write('not json at all\\n');
      process.exit(0);
    `);
    const result = await SB.runInSandbox({ workerPath: worker });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /no parseable result/);
  });
});

// ---------------------------------------------------------------------------
// stderr quarantined — worker stderr never leaks to parent stdout
// ---------------------------------------------------------------------------

describe('playwright-sandbox — stderr quarantined', () => {
  it('captures worker stderr into result.stderr', async () => {
    const worker = writeWorker('stderr', `
      process.stderr.write('quarantined-stderr-line\\n');
      module.exports.run = async function() { return 'ok'; };
    `);
    const result = await SB.runInSandbox({ workerPath: worker });
    assert.strictEqual(result.ok, true);
    assert.match(result.stderr, /quarantined-stderr-line/);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap module — should be writable once and reused
// ---------------------------------------------------------------------------

describe('playwright-sandbox — bootstrap', () => {
  it('writes a bootstrap script to a tmp file', () => {
    const p = SB._ensureBootstrapPath();
    assert.ok(fs.existsSync(p));
    const body = fs.readFileSync(p, 'utf8');
    assert.match(body, /GATETEST_SANDBOX_WORKER/);
    assert.match(body, /JSON\.stringify/);
  });

  it('returns the SAME path on second call (cached)', () => {
    const a = SB._ensureBootstrapPath();
    const b = SB._ensureBootstrapPath();
    assert.strictEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// Task spec passed via env var
// ---------------------------------------------------------------------------

describe('playwright-sandbox — task IPC', () => {
  it('passes task spec to worker via env var (no inheritance from parent)', async () => {
    const worker = writeWorker('env-check', `
      module.exports.run = async function(task) {
        // Verify the parent's process.env.GATETEST_SANDBOX_WORKER was set,
        // and that the task arg matches what the parent serialised.
        return {
          gotWorker: !!process.env.GATETEST_SANDBOX_WORKER,
          gotTaskKeys: Object.keys(task).sort(),
        };
      };
    `);
    const result = await SB.runInSandbox({
      workerPath: worker,
      task: { url: 'https://x.com', kind: 'runtime-errors' },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value.gotWorker, true);
    assert.deepStrictEqual(result.value.gotTaskKeys, ['kind', 'url']);
  });
});
