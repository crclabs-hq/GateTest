const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HardcodedUrlModule = require('../src/modules/hardcoded-url');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new HardcodedUrlModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('HardcodedUrlModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hu-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no source files exist', async () => {
    write(tmp, 'notes.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'hardcoded-url:no-files'));
  });

  it('scans JS/TS sources', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'hardcoded-url:scanning'));
  });
});

describe('HardcodedUrlModule — localhost', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hu-local-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on http://localhost hardcoded in source', async () => {
    write(tmp, 'src/api.ts', [
      'export async function fetchUsers() {',
      '  const r = await fetch("http://localhost:3000/api/users");',
      '  return r.json();',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('hardcoded-url:localhost:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
    assert.match(hit.message, /localhost leaks break every non-developer machine/);
    assert.doesNotMatch(hit.message, /test file/);
  });

  it('errors on http://127.0.0.1 hardcoded in source', async () => {
    write(tmp, 'src/api.ts', [
      'const BASE = "http://127.0.0.1:8080";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('hardcoded-url:localhost:')));
  });

  it('errors on http://0.0.0.0 hardcoded in source', async () => {
    write(tmp, 'src/api.ts', [
      'const BASE = "http://0.0.0.0:3000";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('hardcoded-url:localhost:')));
  });

  it('does NOT flag when variable name says LOCAL_URL', async () => {
    write(tmp, 'src/api.ts', [
      'const LOCAL_URL = "http://localhost:3000";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0);
  });

  it('does NOT flag under NODE_ENV !== production guard', async () => {
    write(tmp, 'src/api.ts', [
      'if (process.env.NODE_ENV !== "production") {',
      '  globalThis.API_BASE = "http://localhost:3000";',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0);
  });

  it('downgrades to info in test files', async () => {
    write(tmp, 'tests/a.test.ts', [
      'it("works", async () => {',
      '  const r = await fetch("http://localhost:3000");',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('hardcoded-url:localhost:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'info');
    // The message must match the severity: a fixture in a test file is not a leak.
    assert.match(hit.message, /in a test file — a fixture, not a leak/);
    assert.doesNotMatch(hit.message, /break every non-developer machine/);
    assert.match(hit.suggestion, /Nothing to change/);
  });
});

describe('HardcodedUrlModule — private IPs', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hu-priv-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on 10.x.x.x RFC1918 URL', async () => {
    write(tmp, 'src/api.ts', [
      'const BACKEND = "http://10.0.1.42:5000";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('hardcoded-url:private-ip:')));
  });

  it('errors on 192.168.x.x URL', async () => {
    write(tmp, 'src/api.ts', [
      'fetch("http://192.168.1.100:8080/api");',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('hardcoded-url:private-ip:')));
  });

  it('errors on 172.16-31.x URL', async () => {
    write(tmp, 'src/api.ts', [
      'const HOST = "https://172.20.5.1:9000";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('hardcoded-url:private-ip:')));
  });

  it('does NOT flag 172.8.x.x (not in RFC1918 range)', async () => {
    write(tmp, 'src/api.ts', [
      'const HOST = "https://172.8.5.1";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('hardcoded-url:private-ip:'));
    assert.strictEqual(hit, undefined);
  });
});

describe('HardcodedUrlModule — internal TLDs / staging', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hu-int-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on .internal TLD', async () => {
    write(tmp, 'src/api.ts', [
      'const BACKEND = "https://api.mycompany.internal/v1";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('hardcoded-url:internal-tld:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on staging.*', async () => {
    write(tmp, 'src/api.ts', [
      'const BACKEND = "https://staging.mycompany.com/api";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('hardcoded-url:internal-tld:')));
  });

  it('warns on dev.*', async () => {
    write(tmp, 'src/api.ts', [
      'fetch("https://dev.mycompany.com/api");',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('hardcoded-url:internal-tld:')));
  });
});

describe('HardcodedUrlModule — insecure scheme', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hu-scheme-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on plain http:// to an external host', async () => {
    write(tmp, 'src/api.ts', [
      'const r = await fetch("http://api.thirdparty.io/data");',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('hardcoded-url:insecure-scheme:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('does NOT warn on https://', async () => {
    write(tmp, 'src/api.ts', [
      'fetch("https://api.stripe.com/v1/charges");',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0);
  });

  it('does NOT warn on doc-example URLs', async () => {
    write(tmp, 'src/api.ts', [
      'const EXAMPLE = "http://example.com/docs";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0);
  });

  // ── Identifiers, not locations (2026-09-13) ──────────────────────────
  // Our own scanner reported seven `insecure-scheme` findings on the
  // website: six were `xmlns="http://www.w3.org/2000/svg"` in badge SVGs
  // and one was the sentence "use https:// instead of http://." — a host
  // of `.`. The control pair is the genuine `http://` fetch beside them.
  // Names carry the relative path, so separators are normalised (KI #109).
  const leaks = (r) => r.checks.filter((c) => c.passed === false).map((c) => c.name.replace(/\\/g, '/'));

  it('does NOT warn on an XML namespace name — W3C host, or any host in an xmlns attribute', async () => {
    write(tmp, 'src/badge.ts', [
      'export function svg(w: number) {',
      '  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}">`;',
      '}',
      'const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");',
      'const android = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">`;',
      '',
    ].join('\n'));
    write(tmp, 'src/Spinner.tsx', [
      'export const Spinner = () => (',
      '  <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" />',
      ');',
      '',
    ].join('\n'));
    assert.deepStrictEqual(leaks(await run(tmp)), []);
  });

  it('does NOT read "http://." at the end of a sentence as a host', async () => {
    // website/app/lib/website-scanner.ts:321, verbatim.
    write(tmp, 'src/scanner.ts', [
      'const fix = "Change all src= and href= values to use https:// instead of http://.";',
      '',
    ].join('\n'));
    assert.deepStrictEqual(leaks(await run(tmp)), []);
  });

  it('DOES warn on a plain http:// fetch beside a namespace declaration', async () => {
    write(tmp, 'src/mixed.ts', [
      'const NS = "http://www.w3.org/2000/svg";',
      'const r = await fetch("http://cdn.partner-widgets.com/v1/embed.js");',
      '',
    ].join('\n'));
    assert.deepStrictEqual(leaks(await run(tmp)), ['hardcoded-url:insecure-scheme:src/mixed.ts:2']);
  });
});

describe('HardcodedUrlModule — RFC 2606 documentation TLDs', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hu-2606-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const leaks = (r) => r.checks.filter((c) => c.passed === false).map((c) => c.name.replace(/\\/g, '/'));

  it('does NOT warn on *.example / *.invalid — they exist to be written down', async () => {
    // website/app/modules/[slug]/availability.ts:94 and src/core/doctor.js:255.
    write(tmp, 'src/usage.ts', [
      'const cli = `gatetest --crawl https://your-site.example --module ${name}`;',
      "const hint = 'Set NEXT_PUBLIC_BASE_URL=https://your-domain.example in your deploy env';",
      'const bad = "https://nowhere.invalid/";',
      '',
    ].join('\n'));
    assert.deepStrictEqual(leaks(await run(tmp)), []);
  });

  it('DOES still warn on .test, .internal and staging hosts', async () => {
    write(tmp, 'src/api.ts', [
      'const A = "https://connect-timeout.test/";',
      'const B = "https://api.corp.internal/v1";',
      'const C = "https://staging.example.com/api";',
      '',
    ].join('\n'));
    assert.deepStrictEqual(leaks(await run(tmp)), [
      'hardcoded-url:internal-tld:src/api.ts:1',
      'hardcoded-url:internal-tld:src/api.ts:2',
      'hardcoded-url:internal-tld:src/api.ts:3',
    ]);
  });
});

describe('HardcodedUrlModule — negatives', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hu-neg-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag URL in comment', async () => {
    write(tmp, 'src/api.ts', [
      '// See http://localhost:3000 for dev setup',
      'export const x = 1;',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0);
  });

  it('does NOT flag URL in block-comment / JSDoc', async () => {
    write(tmp, 'src/api.ts', [
      '/**',
      ' * Example: http://localhost:3000/api',
      ' * See https://192.168.1.1',
      ' */',
      'export const x = 1;',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0);
  });

  it('does NOT flag proper env-driven URL', async () => {
    write(tmp, 'src/api.ts', [
      'const BASE = process.env.API_BASE_URL || "https://api.prod.com";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const leaks = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(leaks.length, 0);
  });

  it('records a summary', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    const s = r.checks.find((c) => c.name === 'hardcoded-url:summary');
    assert.ok(s);
    assert.match(s.message, /1 file\(s\)/);
  });
});

// ── localhost: the env-fallback pattern in its other spellings (trpc, prisma, 2026-09-05) ──
describe('HardcodedUrlModule — localhost dev defaults that are NOT leaks', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hu-dev-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const localhost = (r) => r.checks.filter((c) => c.name.startsWith('hardcoded-url:localhost:') && c.severity === 'error');

  it('NEGATIVE: a ternary env fallback across lines (trpc www/og-image/pages/api/_ref/vercel.tsx:36-38, utils/fetchFont.ts:3-5)', async () => {
    write(tmp, 'src/og/vercel.tsx', [
      'const src = `${',
      '  process.env.VERCEL_URL',
      "    ? 'https://' + process.env.VERCEL_URL",
      "    : 'http://localhost:3000'",
      '}/pattern.svg`;',
      'const baseUrl = process.env.VERCEL',
      "  ? 'https://' + process.env.VERCEL_URL",
      "  : 'http://localhost:3001';",
    ].join('\n'));
    const r = await run(tmp);
    assert.deepStrictEqual(localhost(r).map((c) => c.name), []);
  });

  it('NEGATIVE: a schema default for an env var (trpc www/src/utils/env.js:13-16) and a `case \'development\':` branch (env.js:41-42)', async () => {
    write(tmp, 'src/utils/env.js', [
      'const envSchema = z.object({',
      '  VERCEL_URL: z',
      '    .string()',
      "    .default('http://localhost:3000'),",
      '});',
      'function getBase(env) {',
      '  switch (env.VERCEL_ENV) {',
      "    case 'production':",
      "      return 'https://og-image.trpc.io';",
      "    case 'development':",
      "      return 'http://localhost:3001';",
      '  }',
      '}',
    ].join('\n'));
    const r = await run(tmp);
    assert.deepStrictEqual(localhost(r).map((c) => c.name), []);
  });

  it('NEGATIVE: a server logging the address it just bound, and a WHATWG parse base (prisma apps/lsp-playground/src/cli.ts:15, :30, :256-257)', async () => {
    write(tmp, 'src/cli.ts', [
      "const REQUEST_URL_BASE = 'http://localhost/';",
      'function pathOf(requestUrl) {',
      '  return new URL(requestUrl, REQUEST_URL_BASE).pathname;',
      '}',
      "const path2 = new URL(req.url ?? '/', 'http://localhost').pathname;",
      'httpServer.listen(PORT, () => {',
      '  const url = `http://localhost:${PORT}/`;',
      '  console.log(`Playground: ${url}`);',
      '});',
    ].join('\n'));
    const r = await run(tmp);
    assert.deepStrictEqual(localhost(r).map((c) => c.name), []);
  });

  it('POSITIVE: a bare localhost fetch target, a non-env ternary, and an unused "base" still fire at error', async () => {
    write(tmp, 'src/api.ts', [
      "const API = 'http://localhost:3000';",
      "const B = isStaging ? 'https://staging.example.com' : 'http://localhost:4000';",
      "const BASE = 'http://localhost/';",
      'export const get = (p) => fetch(API + p);',
    ].join('\n'));
    const r = await run(tmp);
    assert.deepStrictEqual(localhost(r).map((c) => c.name), [
      'hardcoded-url:localhost:src/api.ts:1',
      'hardcoded-url:localhost:src/api.ts:2',
      'hardcoded-url:localhost:src/api.ts:3',
    ]);
  });
});

// ── the one stripper: a URL is string content, so the question is WHICH kind of
// literal holds it (2026-09-05, Doctrine §4 — the private quote counter this
// replaced could not see a template continuation line or a block comment) ──
describe('HardcodedUrlModule — string, template and comment are told apart by the one stripper', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hu-strip-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a URL inside a block comment that opened on an earlier line, or in a line comment with an apostrophe before it, is not a leak; the ones in a string, a template and a template continuation line beside them are (2026-09-05)', async () => {
    write(tmp, 'src/api.ts', [
      '/* dev notes:',                                          // 1
      '   the old box was http://192.168.1.20:8080 — gone */', // 2  comment: silent
      "const N = 1; // don't point at http://localhost:5000",   // 3  the apostrophe opened a phantom string for the old counter: silent
      'const A = "http://localhost:3000";',                    // 4  string: fires
      'const B = `http://10.0.0.5:9000/api`;',                 // 5  template: fires
      'const C = `',                                           // 6
      '  preview at http://staging.example.io/x for review',   // 7  continuation line, no quote of its own: fires
      '`;',                                                    // 8
      'export const get = () => fetch(A + B + C);',
    ].join('\n'));
    const r = await run(tmp);
    const names = r.checks.filter((c) => c.passed === false).map((c) => c.name).sort();
    assert.deepStrictEqual(names, [
      'hardcoded-url:internal-tld:src/api.ts:7',
      'hardcoded-url:localhost:src/api.ts:4',
      'hardcoded-url:private-ip:src/api.ts:5',
    ]);
  });
});

describe('HardcodedUrlModule — a private IP or internal host in a test file is a fixture on record (2026-09-05)', () => {
  // The scanner's own code-scanning alerts on this PR called the
  // 169.254.169.254 in tests/ssrf.test.js "a developer's LAN address escaped
  // into committed code": it is link-local, it is the test's subject, and
  // the localhost rule already had the honest three-way wording.
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hu-fixture-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('info + "a fixture, not a leak" under tests/; error + "escaped into committed code" under src/', async () => {
    const src = 'fetch("http://169.254.169.254/latest/meta-data/");\nfetch("http://staging.example.io/x");\n';
    write(tmp, 'tests/meta.test.js', src);
    write(tmp, 'src/meta.js', src);
    const r = await run(tmp);
    const byName = (n) => r.checks.find((c) => c.name === n);
    const tIp = byName('hardcoded-url:private-ip:tests/meta.test.js:1');
    const sIp = byName('hardcoded-url:private-ip:src/meta.js:1');
    const tTld = byName('hardcoded-url:internal-tld:tests/meta.test.js:2');
    const sTld = byName('hardcoded-url:internal-tld:src/meta.js:2');
    assert.ok(tIp && sIp && tTld && sTld, r.checks.map((c) => c.name).join(', '));
    assert.strictEqual(tIp.severity, 'info');
    assert.match(tIp.message, /in a test file — a fixture, not a leak/);
    assert.strictEqual(sIp.severity, 'error');
    assert.match(sIp.message, /link-local.*escaped into committed code/);
    assert.strictEqual(tTld.severity, 'info');
    assert.match(tTld.message, /a fixture, not a leak/);
    assert.strictEqual(sTld.severity, 'warning');
    assert.match(sTld.message, /won't resolve for external users/);
  });
});
