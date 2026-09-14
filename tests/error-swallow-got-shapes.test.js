'use strict';

// =============================================================================
// errorSwallow — sindresorhus/got's six deliberate `catch {}`, read as written
// =============================================================================
// got @ main, scanned 2026-09-14: 6 of its 11 blocking findings were
// `error-swallow:empty-catch` in `source/core/`, every one at confidence 1.0.
// Every one is deliberate, and none was in a shape the classifier knew. A
// library cannot be asked to carry our `// error-ok` marker (654a01b4 honours
// it on the first catch-body line — on OUR code), so the classifier learned to
// read what got does carry:
//
//   index.ts:1191   opt-in     — under `if (options.ignoreInvalidCookies)`
//   index.ts:1548   nested     — inside a try whose own catch is empty
//   index.ts:1553   documented — first try line is a comment; also returns
//   index.ts:1963   documented — three comment lines above the `if` + `try`
//   index.ts:2110   documented — two comment lines above `(async () => {`
//   options.ts:86   observer   — `void (async () => { try { await … } catch {} })()`
//
// Every judgement is a downgrade to warning with the reason in the message,
// never a suppression. Positive controls: the genuine swallow from
// guarded-catch.js's own doc (`try { await db.commit(); } catch {}` in a
// named function) still blocks; each judgement has a boundary that keeps
// blocking on the other side of it.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ErrorSwallowModule = require('../src/modules/error-swallow');

function makeResult() {
  return { checks: [], addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); } };
}
function run(projectRoot) {
  const mod = new ErrorSwallowModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
const emptyCatches = (r) => r.checks
  .filter((c) => !c.passed && /^error-swallow:empty-catch:/.test(c.name))
  .map((c) => ({ line: c.line, severity: c.severity, guarded: c.guarded, message: c.message }))
  .sort((a, b) => a.line - b.line);
async function scanOne(tmp, rel, src) {
  write(tmp, rel, src);
  const hits = emptyCatches(await run(tmp));
  assert.strictEqual(hits.length, 1, `expected one empty-catch finding in ${rel}, got ${JSON.stringify(hits)}`);
  return hits[0];
}

// ── got/source/core/index.ts:1178-1200 (the class body around it, verbatim) ──
const GOT_1191 = [
  'export default class Request extends Duplex {',
  '\tprivate async _onResponseBase(response: IncomingMessageWithTimings): Promise<void> {',
  '\t\tconst rawCookies = response.headers[\'set-cookie\'];',
  '\t\tif (is.object(options.cookieJar) && rawCookies) {',
  '\t\t\tlet promises: Array<Promise<unknown>> = rawCookies.map(async (rawCookie: string) => (options.cookieJar as PromiseCookieJar).setCookie(rawCookie, url!.toString()));',
  '',
  '\t\t\tif (options.ignoreInvalidCookies) {',
  '\t\t\t\tpromises = promises.map(async promise => {',
  '\t\t\t\t\ttry {',
  '\t\t\t\t\t\tawait promise;',
  '\t\t\t\t\t} catch {}',
  '\t\t\t\t});',
  '\t\t\t}',
  '',
  '\t\t\ttry {',
  '\t\t\t\tawait Promise.all(promises);',
  '\t\t\t} catch (error: unknown) {',
  '\t\t\t\tthis._beforeError(error as Error);',
  '\t\t\t\treturn;',
  '\t\t\t}',
  '\t\t}',
  '\t}',
  '}',
  '',
].join('\n');

// ── got/source/core/index.ts:1521-1557 (`_setRawBody`, verbatim) ─────────────
const GOT_SET_RAW_BODY = [
  'export default class Request extends Duplex {',
  '\tprivate async _setRawBody(from: Readable = this): Promise<boolean> {',
  '\t\ttry {',
  '\t\t\t// Errors are emitted via the `error` event',
  '\t\t\tconst fromArray = await from.toArray();',
  '\t\t\tconst hasNonStringChunk = fromArray.some(chunk => typeof chunk !== \'string\');',
  '\t\t\tconst rawBody = hasNonStringChunk',
  '\t\t\t\t? concatUint8Arrays((fromArray as Array<string | Uint8Array>).map(chunk => typeof chunk === \'string\' ? stringToUint8Array(chunk) : chunk))',
  '\t\t\t\t: stringToUint8Array((fromArray as string[]).join(\'\'));',
  '\t\t\tconst shouldUseIncrementalDecodedBody = from === this && this._incrementalDecode !== undefined;',
  '',
  '\t\t\t// On retry Request is destroyed with no error, therefore the above will successfully resolve.',
  '\t\t\t// So in order to check if this was really successful, we need to check if it has been properly ended.',
  '\t\t\tif (!this.isAborted && this.response) {',
  '\t\t\t\tthis.response.rawBody = rawBody;',
  '\t\t\t\tif (from !== this) {',
  '\t\t\t\t\tthis._downloadedSize = rawBody.byteLength;',
  '\t\t\t\t}',
  '',
  '\t\t\t\tif (shouldUseIncrementalDecodedBody) {',
  '\t\t\t\t\ttry {',
  '\t\t\t\t\t\tconst {decoder, chunks} = this._incrementalDecode!;',
  '\t\t\t\t\t\tconst finalDecodedChunk = decoder.decode();',
  '\t\t\t\t\t\tif (finalDecodedChunk.length > 0) {',
  '\t\t\t\t\t\t\tchunks.push(finalDecodedChunk);',
  '\t\t\t\t\t\t}',
  '',
  '\t\t\t\t\t\tcacheDecodedBody(this.response, chunks.join(\'\'));',
  '\t\t\t\t\t} catch {}',
  '\t\t\t\t}',
  '',
  '\t\t\t\treturn true;',
  '\t\t\t}',
  '\t\t} catch {} finally {',
  '\t\t\tthis._incrementalDecode = undefined;',
  '\t\t}',
  '',
  '\t\treturn false;',
  '\t}',
  '}',
  '',
].join('\n');

// ── got/source/core/index.ts:1943-1966 (`_destroyBody`, verbatim) ────────────
const GOT_1963 = [
  'export default class Request extends Duplex {',
  '\tprivate _destroyBody(body: unknown) {',
  '\t\tif (is.nodeStream(body)) {',
  '\t\t\tbody.destroy();',
  '\t\t} else if (is.asyncIterable(body) || (is.iterable(body) && !is.string(body) && !isBuffer(body))) {',
  '\t\t\tconst iterableBody = body as unknown as Iterator<unknown> | AsyncIterator<unknown>;',
  '',
  '\t\t\t// Signal the iterator to clean up, but don\'t await it:',
  '\t\t\t// the for-await loop in _sendBody exits via the options.body sentinel,',
  '\t\t\t// and awaiting return() would deadlock when next() is pending.',
  '\t\t\tif (typeof iterableBody.return === \'function\') {',
  '\t\t\t\ttry {',
  '\t\t\t\t\tconst result = iterableBody.return();',
  '\t\t\t\t\tif (result instanceof Promise) {',
  '\t\t\t\t\t\t// eslint-disable-next-line promise/prefer-await-to-then',
  '\t\t\t\t\t\tresult.catch(noop);',
  '\t\t\t\t\t}',
  '\t\t\t\t} catch {}',
  '\t\t\t}',
  '\t\t}',
  '\t}',
  '}',
  '',
].join('\n');

// ── got/source/core/index.ts:2098-2118 (the HTTP/2 promise event shim, verbatim) ──
const GOT_2110 = [
  'export default class Request extends Duplex {',
  '\tprivate _prepareCache(cache: string | StorageAdapter) {',
  '\t\tconst once = (event: string, handler: (...args: unknown[]) => void) => {',
  '\t\t\tif (event === \'error\') {',
  '\t\t\t\t(async () => {',
  '\t\t\t\t\ttry {',
  '\t\t\t\t\t\tawait result;',
  '\t\t\t\t\t} catch (error) {',
  '\t\t\t\t\t\thandler(error);',
  '\t\t\t\t\t}',
  '\t\t\t\t})();',
  '\t\t\t} else if (event === \'abort\' || event === \'destroy\') {',
  '\t\t\t\t// The empty catch is needed here in case when',
  '\t\t\t\t// it rejects before it\'s `await`ed in `_makeRequest`.',
  '\t\t\t\t(async () => {',
  '\t\t\t\t\ttry {',
  '\t\t\t\t\t\tconst request = (await result) as ClientRequest;',
  '\t\t\t\t\t\trequest.once(event, handler);',
  '\t\t\t\t\t} catch {}',
  '\t\t\t\t})();',
  '\t\t\t} else {',
  '\t\t\t\t/* istanbul ignore next: safety check */',
  '\t\t\t\tthrow new Error(`Unknown HTTP/2 promise event: ${event}`);',
  '\t\t\t}',
  '',
  '\t\t\treturn result;',
  '\t\t};',
  '\t}',
  '}',
  '',
].join('\n');

// ── got/source/core/options.ts:60-95 (`withTimeout`, verbatim) ───────────────
const GOT_OPTIONS_86 = [
  'const withTimeout = async <T>(promise: Promise<T>, timeout: number, onLateResolution?: (value: T) => void): Promise<T> => {',
  '\tlet timeoutId: NodeJS.Timeout | undefined;',
  '\tlet didTimeOut = false;',
  '\tconst timeoutPromise = new Promise<never>((_resolve, reject) => {',
  '\t\ttimeoutId = setTimeout(() => {',
  '\t\t\tdidTimeOut = true;',
  '\t\t\treject(new TimeoutError(timeout, \'request\'));',
  '\t\t}, timeout);',
  '\t\ttimeoutId.unref();',
  '\t});',
  '',
  '\tvoid (async () => {',
  '\t\ttry {',
  '\t\t\tconst value = await promise;',
  '',
  '\t\t\tif (didTimeOut) {',
  '\t\t\t\tonLateResolution?.(value);',
  '\t\t\t}',
  '\t\t} catch {}',
  '\t})();',
  '',
  '\ttry {',
  '\t\treturn await Promise.race([promise, timeoutPromise]);',
  '\t} finally {',
  '\t\tif (timeoutId) {',
  '\t\t\tclearTimeout(timeoutId);',
  '\t\t}',
  '\t}',
  '};',
  '',
].join('\n');

describe('errorSwallow — got/source/core, the six catches verbatim', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-es-got-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('index.ts:1191 — under `if (options.ignoreInvalidCookies)`: opt-in, warning', async () => {
    const h = await scanOne(tmp, 'source/core/index.ts', GOT_1191);
    assert.strictEqual(h.line, 11);
    assert.strictEqual(h.severity, 'warning');
    assert.strictEqual(h.guarded, 'opt-in');
    assert.match(h.message, /if \(options\.ignoreInvalidCookies\)/);
  });

  it('index.ts:1548 + 1553 — the inner catch is nested in a try whose catch is empty; the outer returns the outcome', async () => {
    write(tmp, 'source/core/index.ts', GOT_SET_RAW_BODY);
    const hits = emptyCatches(await run(tmp));
    assert.deepStrictEqual(hits.map((h) => [h.line, h.severity, h.guarded]), [
      [29, 'warning', 'nested'],
      [34, 'warning', 'documented'],
    ]);
    assert.match(hits[0].message, /own catch \(line 34\) is empty/);
    assert.match(hits[1].message, /on the first line of the try \(line 4\)/);
  });

  it('index.ts:1963 — three comment lines above the `if` that wraps the try: documented, warning', async () => {
    const h = await scanOne(tmp, 'source/core/index.ts', GOT_1963);
    assert.strictEqual(h.line, 18);
    assert.strictEqual(h.severity, 'warning');
    assert.strictEqual(h.guarded, 'documented');
    assert.match(h.message, /right above the try \(line 10\)/);
  });

  it('index.ts:2110 — the reason sits above `(async () => {`: documented, warning', async () => {
    const h = await scanOne(tmp, 'source/core/index.ts', GOT_2110);
    assert.strictEqual(h.line, 19);
    assert.strictEqual(h.severity, 'warning');
    assert.strictEqual(h.guarded, 'documented');
    assert.match(h.message, /right above the try \(line 14\)/);
  });

  it('options.ts:86 — `void (async () => { try { await … } catch {} })()`: observer, warning', async () => {
    const h = await scanOne(tmp, 'source/core/options.ts', GOT_OPTIONS_86);
    assert.strictEqual(h.line, 19);
    assert.strictEqual(h.severity, 'warning');
    assert.strictEqual(h.guarded, 'observer');
  });

  it('the got sources together produce zero blocking empty-catch findings, and every one is still on the report', async () => {
    write(tmp, 'source/core/index.ts', [GOT_1191, GOT_SET_RAW_BODY, GOT_1963, GOT_2110].join('\n'));
    write(tmp, 'source/core/options.ts', GOT_OPTIONS_86);
    const hits = emptyCatches(await run(tmp));
    assert.strictEqual(hits.length, 6);
    assert.deepStrictEqual(hits.filter((h) => h.severity === 'error'), []);
  });
});

describe('errorSwallow — the judgements have boundaries (positive controls)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-es-got-ctl-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('the genuine swallow from guarded-catch.js\'s own doc still blocks', async () => {
    const h = await scanOne(tmp, 'src/pay.ts', [
      'export async function settle(db: Db): Promise<void> {',
      '  await db.write(order);',
      '  try { await db.commit(); } catch {}',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(h.severity, 'error');
    assert.strictEqual(h.guarded, undefined);
  });

  it('DOCUMENTED needs a person\'s comment — an eslint directive above the try is not one', async () => {
    const h = await scanOne(tmp, 'src/pay.ts', [
      'export async function settle(db: Db): Promise<void> {',
      '  // eslint-disable-next-line no-empty',
      '  try { await db.commit(); } catch {}',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(h.severity, 'error');
  });

  it('DOCUMENTED does not climb past a NAMED function head: the doc block above `function real() {` documents `real`, not the attempt', async () => {
    const h = await scanOne(tmp, 'src/pay.ts', [
      '/**',
      ' * Settles the order. Best-effort: the journal replays a failed commit.',
      ' */',
      'export async function settle(db: Db): Promise<void> {',
      '  try { await db.commit(); } catch {}',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(h.severity, 'error');
  });

  it('DOCUMENTED does not climb past a statement: a comment on an unrelated earlier line does not count', async () => {
    const h = await scanOne(tmp, 'src/pay.ts', [
      'export async function settle(db: Db): Promise<void> {',
      '  // load the order first',
      '  const order = await db.load(id);',
      '  try { await db.commit(order); } catch {}',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(h.severity, 'error');
  });

  it('DOCUMENTED — the same swallow with its reason written above it is a warning', async () => {
    const h = await scanOne(tmp, 'src/pay.ts', [
      'export async function settle(db: Db): Promise<void> {',
      '  // commit is best-effort here: the journal replays it on restart',
      '  try { await db.commit(); } catch {}',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(h.severity, 'warning');
    assert.strictEqual(h.guarded, 'documented');
  });

  it('OPT-IN — a NEGATED flag is the branch that does not ignore, and blocks', async () => {
    const h = await scanOne(tmp, 'src/cookies.ts', [
      'export async function store(options: Options, promise: Promise<void>): Promise<void> {',
      '  if (!options.ignoreInvalidCookies) {',
      '    try { await promise; } catch {}',
      '  }',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(h.severity, 'error');
  });

  it('OPT-IN — a condition with no ignoring in its name blocks', async () => {
    const h = await scanOne(tmp, 'src/cookies.ts', [
      'export async function store(options: Options, promise: Promise<void>): Promise<void> {',
      '  if (options.cookieJar) {',
      '    try { await promise; } catch {}',
      '  }',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(h.severity, 'error');
  });

  it('NESTED — an outer catch that DOES something leaves the inner catch on its own', async () => {
    write(tmp, 'src/body.ts', [
      'export async function read(from: Readable): Promise<boolean> {',
      '  try {',
      '    const raw = await from.toArray();',
      '    try { cache.set(key, raw); } catch {}',
      '    return true;',
      '  } catch (error) {',
      '    log.error(error);',
      '    throw error;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const hits = emptyCatches(await run(tmp));
    assert.deepStrictEqual(hits.map((h) => [h.line, h.severity]), [[4, 'error']]);
  });

  it('OBSERVER — an anonymous async function that does more than await after the catch is not an observer', async () => {
    const h = await scanOne(tmp, 'src/timeout.ts', [
      'export function arm(promise: Promise<void>) {',
      '  void (async () => {',
      '    try {',
      '      await promise;',
      '    } catch {}',
      '    markDone();',
      '  })();',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(h.severity, 'error');
  });

  it('OBSERVER — a NAMED async function is a caller\'s contract, not an observer', async () => {
    const h = await scanOne(tmp, 'src/timeout.ts', [
      'export async function settle(promise: Promise<void>): Promise<void> {',
      '  try {',
      '    await promise;',
      '  } catch {}',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(h.severity, 'error');
  });

  it('RESULT-RETURN — a try that never returns, followed by `return true`, is the swallow that reports success', async () => {
    const h = await scanOne(tmp, 'src/flush.ts', [
      'export async function flush(sink: Sink): Promise<boolean> {',
      '  try {',
      '    await sink.write(buffer);',
      '  } catch {}',
      '  return true;',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(h.severity, 'error');
  });

  it('RESULT-RETURN — a `return` inside a nested callback in the try is not the try returning', async () => {
    const h = await scanOne(tmp, 'src/flush.ts', [
      'export async function flush(items: Item[]): Promise<boolean> {',
      '  try {',
      '    await Promise.all(items.map(async (item) => { return sink.write(item); }));',
      '  } catch {}',
      '  return false;',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(h.severity, 'error');
  });
});
