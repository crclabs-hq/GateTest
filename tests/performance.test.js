const { describe, it } = require('node:test');
const assert = require('node:assert');

const PerformanceModule = require('../src/modules/performance');

describe('PerformanceModule — baseline shape', () => {
  it('exposes the expected BaseModule shape', () => {
    const mod = new PerformanceModule();
    assert.strictEqual(typeof mod.name, 'string');
    assert.ok(mod.name.length > 0);
    assert.strictEqual(typeof mod.description, 'string');
    assert.ok(mod.description.length > 0);
    assert.strictEqual(typeof mod.run, 'function');
  });
});

// ── event-cleanup: what actually leaks ────────────────────────────────────
//
// The rule counted raw `addEventListener` occurrences and accepted only
// `removeEventListener` as cleanup. That reported a leak that does not exist in
// website/app/admin/pipeline-trace/LiveScanFeed.tsx: three listeners on a
// `const es = new EventSource(...)` created inside a useEffect and `es.close()`d
// in the effect's return. Once the source is closed and the local binding is out
// of scope, the object AND its listeners are garbage — there is nothing left to
// remove listeners from.
//
// A listener leaks when its TARGET outlives the registering code. These tests
// pin both directions: the exemptions, and the cases that must keep firing.
describe('PerformanceModule — event-cleanup counts only listeners that can outlive their scope', () => {
  const mod = () => new PerformanceModule();

  const LIVE_SCAN_FEED = [
    'useEffect(() => {',
    '  const es = new EventSource("/api/admin/pipeline-trace/stream", { withCredentials: true });',
    '  es.onopen = () => setConnected(true);',
    '  es.addEventListener("scan", (e) => { setEvents((p) => [...p, JSON.parse(e.data)]); });',
    '  es.addEventListener("error", (e) => { console.error(e); });',
    '  es.addEventListener("close", () => { es.close(); setConnected(false); });',
    '  es.onerror = () => setConnected(false);',
    '  return () => { es.close(); };',
    '}, []);',
  ].join('\n');

  it('NEGATIVE: listeners on a locally-created EventSource that is closed in cleanup do not count', () => {
    assert.strictEqual(mod()._leakyListenerCount(LIVE_SCAN_FEED), 0);
  });

  it('POSITIVE: the SAME file with the close() calls removed is a real leak and still counts', () => {
    // The discriminator is disposal, not the constructor. Without this control,
    // "quieter" and "broken" would be indistinguishable.
    const neverClosed = LIVE_SCAN_FEED.replace(/es\.close\(\);?/g, '');
    assert.strictEqual(mod()._leakyListenerCount(neverClosed), 3);
  });

  it('POSITIVE: listeners on long-lived globals (window/document) still count', () => {
    // Inside a function: registered on every call. (Top level runs once per
    // load and is exempt — tests/performance-masked-cleanup.test.js.)
    const src = [
      'function mount() {',
      '  window.addEventListener("resize", onResize);',
      '  document.addEventListener("keydown", onKey);',
      '  window.addEventListener("scroll", onScroll);',
      '}',
    ].join('\n');
    assert.strictEqual(mod()._leakyListenerCount(src), 3);
  });

  it('NEGATIVE: the AbortController { signal } pattern is real cleanup', () => {
    const src = [
      'const c = new AbortController();',
      'window.addEventListener("resize", onResize, { signal: c.signal });',
      'document.addEventListener("keydown", onKey, { signal: c.signal });',
      'window.addEventListener("scroll", onScroll, { signal: c.signal });',
      'return () => c.abort();',
    ].join('\n');
    assert.strictEqual(mod()._leakyListenerCount(src), 0);
  });

  it('a { signal } on ONE call does not exempt the others (args are read to the matching paren)', () => {
    const src = [
      'function mount(c) {',
      '  window.addEventListener("resize", onResize, { signal: c.signal });',
      '  window.addEventListener("keydown", onKey);',
      '  window.addEventListener("scroll", onScroll);',
      '  document.addEventListener("click", onClick);',
      '}',
    ].join('\n');
    assert.strictEqual(mod()._leakyListenerCount(src), 3);
  });

  it('END-TO-END: the LiveScanFeed shape produces no perf:event-cleanup check; the leaky one does', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const run = (content) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-perf-'));
      try {
        fs.mkdirSync(path.join(root, 'app'), { recursive: true });
        fs.writeFileSync(path.join(root, 'app', 'Feed.tsx'), content);
        const checks = [];
        const result = { addCheck(name, passed, details = {}) { checks.push({ name, passed, ...details }); } };
        mod()._checkMemoryLeakPatterns(root, result);
        return checks.filter((c) => !c.passed).map((c) => c.name);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    };
    assert.ok(!run(LIVE_SCAN_FEED).some((n) => n.startsWith('perf:event-cleanup:')));
    const leaky = 'useEffect(() => {\n  window.addEventListener("a", f);\n  window.addEventListener("b", g);\n  document.addEventListener("c", h);\n}, []);';
    assert.ok(run(leaky).some((n) => n.startsWith('perf:event-cleanup:')), run(leaky).join());
  });
});

// ── event-cleanup: injected / qualified constructors (trpc, 2026-09-05) ────
//
// packages/server/src/unstable-core-do-not-import/stream/sse.ts registers six
// listeners on `const eventSource = (_es = new opts.EventSource(url, init))`
// and closes it on RETURN, on abort and in cancel(). `new opts.EventSource`
// did not read as `new EventSource`, so the file was a blocking "leak".
describe('PerformanceModule — event-cleanup accepts a qualified constructor behind an assignment chain', () => {
  const mod = () => new PerformanceModule();

  const TRPC_SSE = [
    'const signal = opts.signal;',
    'let _es = null;',
    'const createStream = () =>',
    '  new ReadableStream({',
    '    async start(controller) {',
    '      const [url, init] = await Promise.all([opts.url(), opts.init()]);',
    '      const eventSource = (_es = new opts.EventSource(',
    '        url,',
    '        init,',
    '      ) as InstanceType<TConfig["EventSource"]>);',
    '      eventSource.addEventListener(CONNECTED_EVENT, (_msg) => { controller.enqueue({ type: "connected", eventSource }); });',
    '      eventSource.addEventListener(SERIALIZED_ERROR_EVENT, (_msg) => { controller.enqueue({ type: "serialized-error", eventSource }); });',
    '      eventSource.addEventListener(PING_EVENT, () => { controller.enqueue({ type: "ping", eventSource }); });',
    '      eventSource.addEventListener(RETURN_EVENT, () => {',
    '        eventSource.close();',
    '        controller.close();',
    '        _es = null;',
    '      });',
    '      eventSource.addEventListener("error", (event) => { controller.error(event); });',
    '      eventSource.addEventListener("message", (_msg) => { controller.enqueue({ type: "data", eventSource }); });',
    '      const onAbort = () => { eventSource.close(); controller.close(); };',
    '      if (signal.aborted) { onAbort(); } else { signal.addEventListener("abort", onAbort); }',
    '    },',
    '    cancel() { _es?.close(); },',
    '  });',
  ].join('\n');

  it('NEGATIVE: the trpc sse.ts shape counts only the caller-owned signal listener (below the >2 threshold)', () => {
    assert.strictEqual(mod()._leakyListenerCount(TRPC_SSE), 1);
  });

  it('POSITIVE: the SAME file with every close() removed is a real leak and counts all seven', () => {
    const neverClosed = TRPC_SSE.replace(/(?:eventSource|_es\?)\.close\(\);?/g, '');
    assert.strictEqual(mod()._leakyListenerCount(neverClosed), 7);
  });

  it('NEGATIVE: `new globalThis.WebSocket(...)` / `new ws.WebSocket(...)` that is closed is disposable', () => {
    const src = [
      'const sock = new globalThis.WebSocket(url);',
      'sock.addEventListener("open", onOpen);',
      'sock.addEventListener("message", onMessage);',
      'sock.addEventListener("close", onClose);',
      'return () => sock.close();',
    ].join('\n');
    assert.strictEqual(mod()._leakyListenerCount(src), 0);
    assert.strictEqual(mod()._leakyListenerCount(src.replace('globalThis.', 'ws.')), 0);
  });

  it('POSITIVE: a qualified constructor that is never disposed still counts', () => {
    const src = [
      'const sock = new globalThis.WebSocket(url);',
      'sock.addEventListener("open", onOpen);',
      'sock.addEventListener("message", onMessage);',
      'sock.addEventListener("close", onClose);',
    ].join('\n');
    assert.strictEqual(mod()._leakyListenerCount(src), 3);
  });
});

// ── event-cleanup: a service worker keeps its listeners (#842 DR-5) ────────
//
// DavenRoe frontend/public/sw.js: install / activate / fetch / message on
// `self`, never removed — by design. The listeners ARE the worker and live
// exactly as long as it does; there is no unmount to remove them in.
describe('PerformanceModule — a service worker lifecycle listener is not a leak (#842 DR-5)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const mod = () => new PerformanceModule();
  const run = (name, content) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-perf-sw-'));
    try {
      fs.mkdirSync(path.join(root, 'public'), { recursive: true });
      fs.writeFileSync(path.join(root, 'public', name), content);
      const checks = [];
      const result = { addCheck(n, passed, details = {}) { checks.push({ name: n, passed, ...details }); } };
      mod()._checkMemoryLeakPatterns(root, result);
      return checks.filter((c) => !c.passed && c.name.startsWith('perf:event-cleanup:')).map((c) => c.name);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  };

  const SW = [
    "const CACHE_VERSION = 'app-v1';",
    "self.addEventListener('install', () => { self.skipWaiting(); });",
    "self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });",
    "self.addEventListener('fetch', (event) => { event.respondWith(fetch(event.request)); });",
    "self.addEventListener('message', (event) => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });",
  ].join('\n');
  const PAGE = [
    'export function mount() {',
    "  window.addEventListener('resize', onResize);",
    "  window.addEventListener('scroll', onScroll);",
    "  document.addEventListener('keydown', onKey);",
    '}',
  ].join('\n');

  it('NEGATIVE: the DavenRoe service worker produces no perf:event-cleanup', () => {
    assert.ok(mod()._isServiceWorker(SW));
    assert.deepStrictEqual(run('sw.js', SW), []);
  });

  it('POSITIVE: a page adding window/document listeners with no cleanup still fires', () => {
    assert.ok(!mod()._isServiceWorker(PAGE));
    assert.deepStrictEqual(run('page.js', PAGE), ['perf:event-cleanup:public/page.js']);
  });
});
