// Control pairs for perf:event-cleanup / perf:interval-cleanup judged on code
// only (2026-10-03). Shapes from Gluecron (inline <script> strings on
// server-rendered pages, a doc comment, src/__tests__/, module singletons)
// and Tallrig (a RUM beacon's top-level window listeners, an interface's
// method signatures). Each sits beside the leaky shape that must still fire.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PerformanceModule = require('../src/modules/performance');

function run(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-perf-mask-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    }
    const checks = [];
    new PerformanceModule()._checkMemoryLeakPatterns(root, {
      addCheck(n, passed, d = {}) { checks.push({ name: n, passed, ...d }); },
    });
    return checks.filter((c) => !c.passed).map((c) => c.name).sort();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const LEAKY_MOUNT = [
  'export function mount() {',
  "  window.addEventListener('resize', onResize);",
  "  window.addEventListener('scroll', onScroll);",
  "  document.addEventListener('keydown', onKey);",
  '  setInterval(poll, 1000);',
  '}',
].join('\n');

describe('perf cleanup rules — what is not a leak', () => {
  it('inline <script> inside a template string on a server-rendered page', () => {
    const page = [
      'export const Editor = () => html`<script>',
      "  form.addEventListener('submit', sync);",
      "  ta.addEventListener('scroll', sync);",
      "  ta.addEventListener('input', sync);",
      '  setInterval(render, 60000);',
      '</script>`;',
    ].join('\n');
    assert.deepStrictEqual(run({ 'src/routes/editor.tsx': page }), []);
  });

  it('a call named in a comment', () => {
    const lib = ['/**', ' * Usage:', ' *   setInterval(() => void tick(), intervalMs);', ' */', 'export function tick() {}'].join('\n');
    assert.deepStrictEqual(run({ 'src/lib/worker-stall.ts': lib }), []);
  });

  it('a file under src/__tests__/', () => {
    assert.deepStrictEqual(run({ 'src/__tests__/push.test.ts': LEAKY_MOUNT }), []);
  });

  it('module-level intervals: bare, bound, and stored in a module-level let', () => {
    const lib = [
      'const _sweepInterval = setInterval(sweep, 1000);',
      'setInterval(() => {}, 5000);',
      'let snapshotTimer: ReturnType<typeof setInterval> | null = null;',
      'export function start() {',
      '  if (snapshotTimer) return;',
      '  snapshotTimer = setInterval(() => flush(), 1000);',
      '}',
    ].join('\n');
    assert.deepStrictEqual(run({ 'src/middleware/rate-limit.ts': lib }), []);
  });

  it('top-level window listeners in a beacon script', () => {
    const beacon = [
      'window.addEventListener("error", onError);',
      'window.addEventListener("unhandledrejection", onRejection);',
      'addEventListener("pagehide", flush);',
    ].join('\n');
    assert.deepStrictEqual(run({ 'services/rum/src/beacon/index.ts': beacon }), []);
  });

  it('TypeScript method signatures in an interface', () => {
    const iface = [
      'export interface SocketLike {',
      '  addEventListener(type: "open", listener: () => void): void;',
      '  addEventListener(type: "close", listener: () => void): void;',
      '  addEventListener(type: "error", listener: () => void): void;',
      '}',
    ].join('\n');
    assert.deepStrictEqual(run({ 'src/daemon.ts': iface }), []);
  });
});

describe('perf cleanup rules — what still fires', () => {
  it('listeners and an interval registered inside a mount function', () => {
    assert.deepStrictEqual(run({ 'src/mount.ts': LEAKY_MOUNT }), [
      'perf:event-cleanup:src/mount.ts', 'perf:interval-cleanup:src/mount.ts',
    ]);
  });

  it('an interval whose handle is a function-local binding', () => {
    const lib = ['export function onRequest() {', '  const t = setInterval(poll, 100);', '}'].join('\n');
    assert.deepStrictEqual(run({ 'src/handler.ts': lib }), ['perf:interval-cleanup:src/handler.ts']);
  });
});
