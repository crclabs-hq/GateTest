const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ResourceLeakModule = require('../src/modules/resource-leak');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new ResourceLeakModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('ResourceLeakModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rl-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no source files exist', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'resource-leak:no-files'));
  });

  it('scans JS/TS sources', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'resource-leak:scanning'));
  });
});

describe('ResourceLeakModule — streams', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rl-stream-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on createReadStream that is never closed', async () => {
    write(tmp, 'src/a.ts', [
      'function readFile(p) {',
      '  const rs = fs.createReadStream(p);',
      '  rs.on("data", (chunk) => console.log(chunk));',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('resource-leak:stream:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('does NOT flag createReadStream piped through pipeline()', async () => {
    write(tmp, 'src/a.ts', [
      'function readFile(p, dest) {',
      '  const rs = fs.createReadStream(p);',
      '  const ws = fs.createWriteStream(dest);',
      '  stream.pipeline(rs, ws, (err) => { if (err) console.error(err); });',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('resource-leak:stream:')),
      undefined,
    );
  });

  it('does NOT flag createReadStream explicitly destroyed', async () => {
    write(tmp, 'src/a.ts', [
      'function readFile(p) {',
      '  const rs = fs.createReadStream(p);',
      '  try {',
      '    rs.on("data", () => {});',
      '  } finally {',
      '    rs.destroy();',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('resource-leak:stream:')),
      undefined,
    );
  });

  it('does NOT flag a stream that is returned from the function', async () => {
    write(tmp, 'src/a.ts', [
      'function openStream(p) {',
      '  const rs = fs.createReadStream(p);',
      '  return rs;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('resource-leak:stream:')),
      undefined,
    );
  });
});

describe('ResourceLeakModule — setInterval', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rl-si-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on bare setInterval with discarded return value', async () => {
    // Named to avoid the process-entrypoint carve-out (issue #633) so this
    // stays a plain "still fires" control test — see the dedicated
    // "process-entrypoint setInterval carve-out" describe block below.
    write(tmp, 'src/a.ts', [
      'function pollOnce() {',
      '  setInterval(() => console.log("tick"), 1000);',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('resource-leak:setinterval:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('warns on captured setInterval that is never cleared', async () => {
    write(tmp, 'src/a.ts', [
      'function pollOnce() {',
      '  const h = setInterval(() => console.log("tick"), 1000);',
      '  console.log("started", h);',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('resource-leak:uncleared-interval:'));
    assert.ok(hit, `expected uncleared-interval hit, got: ${JSON.stringify(r.checks.map((c) => c.name))}`);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('does NOT flag setInterval that is cleared', async () => {
    write(tmp, 'src/a.ts', [
      'function pollOnce() {',
      '  const h = setInterval(() => console.log("tick"), 1000);',
      '  setTimeout(() => clearInterval(h), 60000);',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0);
  });

  it('does NOT flag setInterval whose handle is returned', async () => {
    write(tmp, 'src/a.ts', [
      'function startTicker() {',
      '  const h = setInterval(() => console.log("tick"), 1000);',
      '  return h;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0);
  });
});

/**
 * Issue #633 (Tallrig false-positive report, 2026-09-22): 19/19 findings
 * from this module were setInterval calls inside process-lifetime daemon
 * entrypoints (start/startServer/main/etc.) — intervals that are meant to
 * run for the entire life of the process, so there is no shorter scope for
 * them to leak past. The control pair: a plain function unrelated to
 * process startup (`pollOnce`, tested above) must keep firing at full
 * severity; only the entrypoint-shaped names downgrade.
 */
describe('ResourceLeakModule — process-entrypoint setInterval carve-out (issue #633)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rl-entry-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('downgrades a bare setInterval inside function main()', async () => {
    write(tmp, 'src/a.ts', [
      'function main() {',
      '  setInterval(() => console.log("tick"), 1000);',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('resource-leak:setinterval:'));
    assert.ok(hit);
    assert.notStrictEqual(hit.severity, 'error');
  });

  it('downgrades a bare setInterval inside function startServer()', async () => {
    write(tmp, 'src/a.ts', [
      'function startServer() {',
      '  setInterval(() => console.log("heartbeat"), 5000);',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('resource-leak:setinterval:'));
    assert.ok(hit);
    assert.notStrictEqual(hit.severity, 'error');
  });

  it('downgrades a captured-but-uncleared setInterval inside function bootstrap()', async () => {
    write(tmp, 'src/a.ts', [
      'function bootstrap() {',
      '  const h = setInterval(() => console.log("poll"), 1000);',
      '  console.log("bootstrapped", h);',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('resource-leak:uncleared-interval:'));
    assert.ok(hit);
    assert.notStrictEqual(hit.severity, 'warning');
  });

  it('does NOT downgrade a setInterval inside an unrelated function whose name merely contains "start"', async () => {
    // Whole-word match only — `startupCheck` must not be treated as an
    // entrypoint just because it shares a prefix with `start`.
    write(tmp, 'src/a.ts', [
      'function startupCheck() {',
      '  setInterval(() => console.log("tick"), 1000);',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('resource-leak:setinterval:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('CONTROL: an ordinary per-request function called `pollOnce` with no clearInterval still fires at full severity', async () => {
    write(tmp, 'src/a.ts', [
      'function pollOnce() {',
      '  setInterval(() => console.log("tick"), 1000);',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('resource-leak:setinterval:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });
});

describe('ResourceLeakModule — sockets', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rl-sock-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on WebSocket that is never closed', async () => {
    write(tmp, 'src/a.ts', [
      'function connect() {',
      '  const ws = new WebSocket("wss://x.com");',
      '  ws.onmessage = (m) => console.log(m.data);',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('resource-leak:socket:')));
  });

  it('does NOT flag WebSocket that is closed on error', async () => {
    write(tmp, 'src/a.ts', [
      'function connect() {',
      '  const ws = new WebSocket("wss://x.com");',
      '  ws.onerror = () => ws.close();',
      '  return ws;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0);
  });
});

describe('ResourceLeakModule — file handles', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rl-fh-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on fs.promises.open that is never closed', async () => {
    write(tmp, 'src/a.ts', [
      'async function readFirst(p) {',
      '  const fh = await fs.promises.open(p, "r");',
      '  const buf = Buffer.alloc(100);',
      '  await fh.read(buf, 0, 100, 0);',
      '  return buf;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('resource-leak:file-handle:')));
  });

  it('does NOT flag file handle closed in finally', async () => {
    write(tmp, 'src/a.ts', [
      'async function readFirst(p) {',
      '  const fh = await fs.promises.open(p, "r");',
      '  try {',
      '    const buf = Buffer.alloc(100);',
      '    await fh.read(buf, 0, 100, 0);',
      '    return buf;',
      '  } finally {',
      '    await fh.close();',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0);
  });
});

describe('ResourceLeakModule — negatives', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rl-neg-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag fs.readFile / writeFile (these manage their own FDs)', async () => {
    write(tmp, 'src/a.ts', [
      'async function run(p) {',
      '  const data = await fs.promises.readFile(p);',
      '  await fs.promises.writeFile(p + ".bak", data);',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0);
  });

  it('does NOT flag setInterval patterns embedded in strings', async () => {
    write(tmp, 'src/a.ts', [
      'const docs = "setInterval(() => {}, 1000)";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0);
  });

  it('downgrades severity to info inside test files', async () => {
    write(tmp, 'tests/a.test.ts', [
      'it("ticks", () => {',
      '  setInterval(() => {}, 100);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('resource-leak:setinterval:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'info');
  });
});

describe('ResourceLeakModule — clean baseline', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rl-clean-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits zero findings for a stream wrapped in pipeline + cleared interval', async () => {
    write(tmp, 'src/a.ts', [
      'function startBackup(src, dest) {',
      '  const rs = fs.createReadStream(src);',
      '  const ws = fs.createWriteStream(dest);',
      '  stream.pipeline(rs, ws, (err) => console.log(err));',
      '  const h = setInterval(() => console.log("tick"), 1000);',
      '  process.on("SIGTERM", () => clearInterval(h));',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0, `got: ${JSON.stringify(leaks)}`);
  });

  it('records a summary', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    const s = r.checks.find((c) => c.name === 'resource-leak:summary');
    assert.ok(s);
    assert.match(s.message, /1 file\(s\)/);
  });
});

// ── the one stripper (2026-09-05, Doctrine §4): the private per-line quote
// counter this module carried could not see a template continuation line or a
// block comment that opened earlier, and read comment text as code ──
describe('ResourceLeakModule — matches on the masked line', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rl-strip-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a setInterval inside a string, a template or a comment is not a leak; the real one beside them is (2026-09-05)', async () => {
    write(tmp, 'src/a.ts', [
      'const doc = "setInterval(tick, 1000)";',              // 1 string
      'const tpl = `',                                        // 2
      '  setInterval(tick, 1000);',                           // 3 template continuation
      '`;',                                                   // 4
      '/* what not to do:',                                   // 5
      '   setInterval(tick, 1000);',                          // 6 block comment
      ' */',                                                  // 7
      'function start() {',
      '  setInterval(tick, 1000);',                           // 9 real
      '}',
    ].join('\n'));
    const r = await run(tmp);
    const names = r.checks.filter((c) => c.passed === false).map((c) => c.name);
    assert.deepStrictEqual(names, ['resource-leak:setinterval:src/a.ts:9']);
  });

  it('a handle.close() that exists only in a comment does not close the handle (2026-09-05)', async () => {
    write(tmp, 'src/b.ts', [
      'function open(p) {',
      '  const fd = fs.openSync(p, "r");',                    // 2 real acquire
      '  // remember: fd.close() is the caller\'s job',       // 3 comment, not a close
      '  use(fd);',
      '}',
    ].join('\n'));
    const r = await run(tmp);
    const names = r.checks.filter((c) => c.passed === false).map((c) => c.name);
    assert.deepStrictEqual(names, ['resource-leak:file-handle:src/b.ts:2']);
  });
});

describe('ResourceLeakModule — a numeric descriptor is closed by fs.closeSync(fd) (2026-09-05)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rl-fd-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag fs.openSync whose descriptor is passed to fs.closeSync in finally (src/core/log-streamer.js:90 shape)', async () => {
    write(tmp, 'src/a.js', [
      'function sizeOf(p) {',
      '  const fd = fs.openSync(p, "r");',
      '  try {',
      '    return fs.fstatSync(fd).size;',
      '  } finally {',
      '    fs.closeSync(fd);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.deepStrictEqual(r.checks.filter((c) => c.passed === false).map((c) => c.name), []);
  });

  it('a `/fd/1` inside a template string 70 lines later is not a return of the descriptor — the leak is reported', async () => {
    // Before the masked line, this was exactly how the log-streamer leak
    // stayed hidden: the raw return check read `fd` inside the template.
    const src = ['function sizeOf(p) {', '  const fd = fs.openSync(p, "r");', '  log(fs.fstatSync(fd).size);', '}'];
    for (let i = 0; i < 70; i += 1) src.push('');
    src.push('function tail(pid) {', '  return streamCommand(`tail -f /proc/${pid}/fd/1`);', '}', '');
    write(tmp, 'src/b.js', src.join('\n'));
    const r = await run(tmp);
    assert.deepStrictEqual(r.checks.filter((c) => c.passed === false).map((c) => c.name), ['resource-leak:file-handle:src/b.js:2']);
  });
});
