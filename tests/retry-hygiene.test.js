const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RetryHygieneModule = require('../src/modules/retry-hygiene');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new RetryHygieneModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('RetryHygieneModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no source files exist', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'retry-hygiene:no-files'));
  });

  it('scans JS/TS sources', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'retry-hygiene:scanning'));
  });
});

describe('RetryHygieneModule — unbounded loop', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-ub-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on while(true) with fetch and no break', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  while (true) {',
      '    const res = await fetch("https://x.com/api");',
      '    if (res.ok) return res;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    // `if (res.ok) return res` is technically a break-shape but we only
    // look for `break` / max-attempts markers. The test locks in
    // current conservative behaviour: flag this as unbounded.
    const hit = r.checks.find((c) => c.name.startsWith('retry-hygiene:unbounded-loop:'));
    assert.ok(hit, `expected unbounded-loop hit, got: ${JSON.stringify(r.checks.map((c) => c.name))}`);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on for(;;) with axios and no break', async () => {
    write(tmp, 'src/a.js', [
      'async function run() {',
      '  for (;;) {',
      '    const res = await axios.get("/x");',
      '    console.log(res.data);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('retry-hygiene:unbounded-loop:')));
  });

  it('does NOT flag while(true) with explicit break', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  let attempts = 0;',
      '  while (true) {',
      '    const res = await fetch("/x");',
      '    if (res.ok) break;',
      '    attempts += 1;',
      '    if (attempts >= 5) break;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('retry-hygiene:unbounded-loop:')),
      undefined,
    );
  });
});

// ── GT-07 (issue #771): a hop-bounded for(;;) has a visible bound the old
// check could not see — it only knew the words attempts/tries/retries/
// maxAttempts/MAX_<UPPER>, and separately treated ANY `break` anywhere in
// the body (even a bare break-on-success, no counter, no delay) as proof of
// a bound.
describe('RetryHygieneModule — GT-07: a visible bound quiets the loop; no bound still fires (issue #771)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-771-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const unbounded = (r) => r.checks.filter((c) => !c.passed && c.name.startsWith('retry-hygiene:unbounded-loop:'));

  it('NEGATIVE: an incremented hop counter compared to a bound, then thrown, is quiet', async () => {
    write(tmp, 'src/a.ts', [
      'async function callWithHops() {',
      '  let hops = 0;',
      '  const MAX = 5;',
      '  for (;;) {',
      '    const res = await fetch(url);',
      '    if (res.ok) return res;',
      '    if (hops++ > MAX) throw new Error("too many hops");',
      '  }',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(unbounded(await run(tmp)).length, 0);
  });

  it('NEGATIVE: a Date.now() < deadline wall-clock bound is quiet', async () => {
    write(tmp, 'src/b.ts', [
      'async function callWithDeadline(deadline) {',
      '  for (;;) {',
      '    const res = await fetch(url);',
      '    if (res.ok) return res;',
      '    if (Date.now() < deadline) continue;',
      '    throw new Error("deadline exceeded");',
      '  }',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(unbounded(await run(tmp)).length, 0);
  });

  it('POSITIVE: for(;;) with a bare break-on-success — no counter, no deadline, no delay — still fires', async () => {
    write(tmp, 'src/c.ts', [
      'async function run() {',
      '  for (;;) {',
      '    try {',
      '      await fetch(url);',
      '      break;',
      '    } catch {}',
      '  }',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(unbounded(await run(tmp)).length, 1);
  });
});

// ── GT-07 residual (issue #771): AlecRae apps/api/src/lib/ssrf-guard.ts:369 —
// the bound is `if (hops >= maxRedirects) return err(...)`, a comparison that
// RETURNS rather than throws, with `hops` advanced later in the loop.
describe('RetryHygieneModule — GT-07 residual: a compared-and-mutated counter that returns/throws/breaks is a bound', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-771b-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const unbounded = (r) => r.checks.filter((c) => !c.passed && c.name.startsWith('retry-hygiene:unbounded-loop:'));

  it('NEGATIVE: the exact ssrf-guard shape (>= then return err, `hops += 1` later) is quiet', async () => {
    write(tmp, 'src/ssrf-guard.ts', [
      'export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}) {',
      '  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;',
      '  let currentUrl = rawUrl;',
      '  let hops = 0;',
      '',
      '  for (;;) {',
      '    const validation = await validateUrl(currentUrl);',
      '    if (!validation.ok) return validation;',
      '    const response = await fetch(validation.value.href, { redirect: "manual" });',
      '    if (!isRedirectStatus(response.status)) {',
      '      return ok(response);',
      '    }',
      '    if (hops >= maxRedirects) {',
      '      return err({ reason: "too_many_redirects", url: currentUrl });',
      '    }',
      '    const location = response.headers.get("location");',
      '    currentUrl = new URL(location, validation.value).href;',
      '    hops += 1;',
      '  }',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(unbounded(await run(tmp)).length, 0);
  });

  it('NEGATIVE: the other counter spellings (n = n + 1, ++n, break) and the reversed compare are quiet', async () => {
    const shapes = [
      ['a.ts', '    if (n > limit) break;', '    n = n + 1;'],
      ['b.ts', '    if (limit <= n) throw new Error("x");', '    ++n;'],
    ];
    for (const [file, cmp, bump] of shapes) {
      write(tmp, `src/${file}`, [
        'async function run(limit) {',
        '  let n = 0;',
        '  for (;;) {',
        '    const res = await fetch(url);',
        '    if (res.ok) return res;',
        cmp,
        bump,
        '  }',
        '}',
        '',
      ].join('\n'));
    }
    assert.strictEqual(unbounded(await run(tmp)).length, 0, JSON.stringify(unbounded(await run(tmp)).map((c) => c.file)));
  });

  it('POSITIVE CONTROL: for(;;) { await fetch(); } with no counter at all still fires', async () => {
    write(tmp, 'src/d.ts', [
      'async function spin() {',
      '  for (;;) {',
      '    await fetch(url);',
      '  }',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(unbounded(await run(tmp)).length, 1);
  });

  it('POSITIVE CONTROL: a counter that is compared and returned on but never mutated is infinite — still fires', async () => {
    write(tmp, 'src/e.ts', [
      'async function stuck(maxRedirects) {',
      '  let hops = 0;',
      '  for (;;) {',
      '    const res = await fetch(url);',
      '    if (res.ok) return res;',
      '    if (hops >= maxRedirects) {',
      '      return null;',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(unbounded(await run(tmp)).length, 1);
  });

  it('POSITIVE CONTROL: an HTTP status compared and thrown on is not a counter — still fires', async () => {
    write(tmp, 'src/f.ts', [
      'async function poll() {',
      '  for (;;) {',
      '    const res = await fetch(url);',
      '    if (res.status >= 500) throw new Error("upstream");',
      '  }',
      '}',
      '',
    ].join('\n'));
    assert.strictEqual(unbounded(await run(tmp)).length, 1);
  });
});

describe('RetryHygieneModule — no backoff / no jitter', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-nb-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on constant sleep in a retry loop (no backoff, no jitter)', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  for (let attempt = 0; attempt < 5; attempt += 1) {',
      '    const res = await fetch("/x");',
      '    if (res.ok) return res;',
      '    await sleep(1000);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const noBackoff = r.checks.find((c) => c.name.startsWith('retry-hygiene:no-backoff:'));
    const noJitter = r.checks.find((c) => c.name.startsWith('retry-hygiene:no-jitter:'));
    assert.ok(noBackoff, `expected no-backoff, got: ${JSON.stringify(r.checks.map((c) => c.name))}`);
    assert.strictEqual(noBackoff.severity, 'warning');
    assert.strictEqual(noBackoff.delay, 1000);
    assert.ok(noJitter);
  });

  it('does NOT warn no-backoff when multiplier uses attempt', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  for (let attempt = 0; attempt < 5; attempt += 1) {',
      '    const res = await fetch("/x");',
      '    if (res.ok) return res;',
      '    await sleep(100 * 2 ** attempt);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('retry-hygiene:no-backoff:')),
      undefined,
    );
  });

  it('does NOT warn no-jitter when Math.random is in the window', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  for (let attempt = 0; attempt < 5; attempt += 1) {',
      '    const res = await fetch("/x");',
      '    if (res.ok) return res;',
      '    const base = 100 * 2 ** attempt;',
      '    await sleep(base * (0.5 + Math.random()));',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('retry-hygiene:no-jitter:')),
      undefined,
    );
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('retry-hygiene:no-backoff:')),
      undefined,
    );
  });

  it('warns on setTimeout with literal ms inside a retry loop', async () => {
    write(tmp, 'src/a.js', [
      'function doRetry() {',
      '  let attempt = 0;',
      '  while (attempt < 5) {',
      '    fetch("/x").then(() => {});',
      '    setTimeout(() => {}, 500);',
      '    attempt += 1;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('retry-hygiene:no-backoff:')));
  });
});

describe('RetryHygieneModule — library-backed retry', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-lib-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('records info when async-retry is imported at file top', async () => {
    write(tmp, 'src/a.ts', [
      'const retry = require(\'async-retry\');',
      'async function run() {',
      '  return retry(async (bail) => {',
      '    const res = await fetch("/x");',
      '    if (!res.ok) throw new Error("retry");',
      '    return res;',
      '  }, { retries: 5, factor: 2, randomize: true });',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    // The retry(...) call is not itself a loop, but the scanner
    // shouldn't flag anything bad here — zero issues.
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0, `got: ${JSON.stringify(issues)}`);
  });
});

describe('RetryHygieneModule — retry on 4xx', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-4xx-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns when retry loop references 4xx status without a guard', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  let attempt = 0;',
      '  while (attempt < 5) {',
      '    const res = await fetch("/x");',
      '    if (res.status === 429) {',
      '      attempt += 1;',
      '      continue;',
      '    }',
      '    return res;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    // Note: 429 is a 4xx that IS genuinely retryable; this test
    // captures the conservative "flag it, let the dev review" shape.
    const hit = r.checks.find((c) => c.name.startsWith('retry-hygiene:retry-on-4xx:'));
    assert.ok(hit, `expected retry-on-4xx hit, got: ${JSON.stringify(r.checks.map((c) => c.name))}`);
  });

  it('does NOT warn when the retry block guards 4xx via throw', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  let attempt = 0;',
      '  while (attempt < 5) {',
      '    const res = await fetch("/x");',
      '    if (res.status >= 400 && res.status < 500) throw new Error("4xx");',
      '    if (res.ok) return res;',
      '    attempt += 1;',
      '    await sleep(100 * 2 ** attempt + Math.random() * 100);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('retry-hygiene:retry-on-4xx:')),
      undefined,
    );
  });
});

describe('RetryHygieneModule — negatives', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-neg-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag a plain for loop with no HTTP call', async () => {
    write(tmp, 'src/a.ts', [
      'function run(items) {',
      '  for (const item of items) {',
      '    console.log(item);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0);
  });

  it('does NOT flag retry text embedded in a string literal', async () => {
    write(tmp, 'src/a.ts', [
      'function docs() {',
      '  return "while (true) { await fetch(\'/x\'); }";',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0);
  });
});

describe('RetryHygieneModule — clean baseline', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-clean-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits zero findings for a well-formed exponential-backoff-with-jitter retry', async () => {
    write(tmp, 'src/a.ts', [
      'async function run() {',
      '  const MAX_ATTEMPTS = 5;',
      '  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {',
      '    const res = await fetch("/x");',
      '    if (res.status >= 400 && res.status < 500) throw new Error("4xx");',
      '    if (res.ok) return res;',
      '    const base = 100 * 2 ** attempt;',
      '    await sleep(base * (0.5 + Math.random()));',
      '  }',
      '  throw new Error("max attempts");',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0, `got: ${JSON.stringify(issues)}`);
  });

  it('records a summary', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    const s = r.checks.find((c) => c.name === 'retry-hygiene:summary');
    assert.ok(s);
    assert.match(s.message, /1 file\(s\)/);
  });
});

describe('retry-hygiene — prose about sleep() is not a call to sleep()', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-retry-cmt-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  async function scan(source) {
    fs.writeFileSync(path.join(tmp, 'probe.js'), source);
    const mod = new RetryHygieneModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    return result.checks.filter((c) => !c.passed && /no-backoff|no-jitter/.test(c.name));
  }

  // Real case: website/app/lib/pentest/probes.js:145 was reported as an
  // un-backed-off retry because the line above reads
  //   // Time-based: send sleep(5), expect response delay
  // The module matched sleep(5) in a sentence ABOUT sleep(5).
  it('does not flag a literal sleep that only appears in a comment', async () => {
    const found = await scan([
      'async function probe(client) {',
      '  for (let attempt = 0; attempt < 3; attempt++) {',
      '    // Time-based: send sleep(5), expect response delay',
      '    // Only run if we have a baseline duration to compare against',
      '    await client.send();',
      '  }',
      '}',
      'module.exports = { probe };',
    ].join('\n'));
    assert.deepStrictEqual(found.map((f) => f.name), []);
  });

  it('still flags a REAL constant-delay retry', async () => {
    const found = await scan([
      'async function probe(client) {',
      '  for (let attempt = 0; attempt < 3; attempt++) {',
      '    try { await client.send(); return; } catch (e) { /* retry */ }',
      '    await new Promise((r) => setTimeout(r, 250));',
      '  }',
      '}',
      'module.exports = { probe };',
    ].join('\n'));
    assert.ok(found.length > 0, 'a genuine constant-delay retry must still be reported');
  });
});

describe('RetryHygieneModule — one stripper (control pair)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rh-mask-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a constant-delay retry inside a string, a template or a comment is not a retry; the real one beside them is (2026-09-05)', async () => {
    write(tmp, 'src/poll.js', [
      'const doc = "while (true) { await fetch(url); await sleep(1000); }";',
      'const tpl = `while (true) {',
      '  await fetch(url);',
      '  await sleep(1000);',
      '}`;',
      '/*',
      'while (true) {',
      '  await fetch(url);',
      '  await sleep(1000);',
      '}',
      '*/',
      'async function real(url) {',
      '  for (let attempt = 0; attempt < 5; attempt += 1) {',
      '    const res = await fetch(url);',
      '    if (res.ok) return res;',
      '    await sleep(1000);',
      '  }',
      '}',
      'module.exports = { doc, tpl, real };',
    ].join('\n'));
    const r = await run(tmp);
    const flagged = r.checks.filter((c) => !c.passed && /^retry-hygiene:/.test(c.name));
    assert.deepStrictEqual(
      flagged.map((c) => c.name).sort(),
      ['retry-hygiene:no-backoff:src/poll.js:16', 'retry-hygiene:no-jitter:src/poll.js:16'],
      'only the real sleep(1000) on line 16 is a retry delay; the string, the template and the comment are not',
    );
    assert.ok(!r.checks.some((c) => c.name.startsWith('retry-hygiene:unbounded-loop:')), 'the `while (true)` in the comment is prose, not a loop');
  });
});
