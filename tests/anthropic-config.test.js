/**
 * KI #78 — one place that decides the Anthropic endpoint and API version.
 *
 * Before this, `anthropic-version: '2023-06-01'` was hardcoded at 21 call
 * sites and the host at 23, so bumping the API version meant editing 21
 * files and there was no way to point GateTest at a gateway, proxy or
 * Bedrock/Vertex front-end at all.
 *
 * This migration is deliberately ALL-OR-NOTHING, and the ratchet at the
 * bottom is the important part of this file: a half migration is WORSE than
 * none, because an operator who sets ANTHROPIC_BASE_URL for egress control
 * or data residency would have some traffic routed through their gateway and
 * the rest sent straight to api.anthropic.com without any signal.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'core', 'anthropic-config.js');
const WEB = path.join(ROOT, 'website', 'app', 'lib', 'anthropic-config.js');

function load(env = {}) {
  const saved = {};
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_VERSION']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  delete require.cache[require.resolve(SRC)];
  const mod = require(SRC);
  return { mod, restore: () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve(SRC)];
  } };
}

let restore = null;
afterEach(() => { if (restore) { restore(); restore = null; } });

describe('anthropic-config — defaults preserve today\'s behaviour exactly', () => {
  it('unset env resolves to the real API', () => {
    const { mod, restore: r } = load(); restore = r;
    assert.strictEqual(mod.baseUrl(), 'https://api.anthropic.com');
    assert.strictEqual(mod.apiUrl(), 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(mod.apiVersion(), '2023-06-01');
    assert.deepStrictEqual(mod.endpoint(), {
      hostname: 'api.anthropic.com', port: 443, protocol: 'https:', prefix: '',
    });
    assert.strictEqual(mod.apiPath(), '/v1/messages');
  });

  it('headers carry the version and key', () => {
    const { mod, restore: r } = load(); restore = r;
    assert.deepStrictEqual(mod.headers('sk-ant-x'), {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'sk-ant-x',
    });
  });
});

describe('anthropic-config — overrides', () => {
  it('a plain proxy host replaces the origin', () => {
    const { mod, restore: r } = load({ ANTHROPIC_BASE_URL: 'https://llm.corp.example' }); restore = r;
    assert.strictEqual(mod.apiUrl(), 'https://llm.corp.example/v1/messages');
    assert.strictEqual(mod.endpoint().hostname, 'llm.corp.example');
  });

  it('a gateway path prefix is preserved on BOTH the fetch and https paths', () => {
    // The easy bug here is honouring the prefix in apiUrl() but not apiPath(),
    // which would split traffic by call mechanism.
    const { mod, restore: r } = load({ ANTHROPIC_BASE_URL: 'https://gw.corp.example/anthropic' }); restore = r;
    assert.strictEqual(mod.apiUrl(), 'https://gw.corp.example/anthropic/v1/messages');
    assert.strictEqual(mod.apiPath(), '/anthropic/v1/messages');
    assert.strictEqual(mod.endpoint().prefix, '/anthropic');
  });

  it('a trailing slash does not double up', () => {
    const { mod, restore: r } = load({ ANTHROPIC_BASE_URL: 'https://gw.corp.example/anthropic/' }); restore = r;
    assert.strictEqual(mod.apiUrl(), 'https://gw.corp.example/anthropic/v1/messages');
  });

  it('a non-default port is carried through', () => {
    const { mod, restore: r } = load({ ANTHROPIC_BASE_URL: 'https://gw.corp.example:8443' }); restore = r;
    assert.strictEqual(mod.endpoint().port, 8443);
  });

  it('the API version is overridable on its own', () => {
    const { mod, restore: r } = load({ ANTHROPIC_VERSION: '2026-01-01' }); restore = r;
    assert.strictEqual(mod.apiVersion(), '2026-01-01');
    assert.strictEqual(mod.headers('k')['anthropic-version'], '2026-01-01');
    assert.strictEqual(mod.baseUrl(), 'https://api.anthropic.com', 'version override must not touch the host');
  });
});

describe('anthropic-config — a bad override FAILS LOUDLY', () => {
  // Falling back to api.anthropic.com would silently defeat the reason
  // someone set this: egress control, audit, data residency. A typo must
  // not quietly ship prompts to the vendor.
  it('a malformed URL throws rather than falling back', () => {
    const { mod, restore: r } = load({ ANTHROPIC_BASE_URL: 'not a url' }); restore = r;
    assert.throws(() => mod.baseUrl(), /not a valid URL/);
    assert.throws(() => mod.apiUrl(), /not a valid URL/);
    assert.throws(() => mod.endpoint(), /not a valid URL/);
  });

  it('plain http is rejected with a reason', () => {
    const { mod, restore: r } = load({ ANTHROPIC_BASE_URL: 'http://localhost:8080' }); restore = r;
    assert.throws(() => mod.baseUrl(), /must use https/);
  });

  it('an empty value is treated as unset, not as an error', () => {
    const { mod, restore: r } = load({ ANTHROPIC_BASE_URL: '   ' }); restore = r;
    assert.strictEqual(mod.baseUrl(), 'https://api.anthropic.com');
  });
});

describe('anthropic-config — twins agree', () => {
  it('both twins export the same surface', () => {
    const a = require(SRC);
    const b = require(WEB);
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort());
    assert.strictEqual(a.DEFAULT_BASE_URL, b.DEFAULT_BASE_URL);
    assert.strictEqual(a.DEFAULT_VERSION, b.DEFAULT_VERSION);
  });

  it('the twins are byte-identical apart from the header comment', () => {
    const strip = (s) => s.replace(/^[\s\S]*?\*\/\s*/, '');
    assert.strictEqual(strip(fs.readFileSync(SRC, 'utf8')), strip(fs.readFileSync(WEB, 'utf8')));
  });
});

describe('KI #78 — the migration is complete (all-or-nothing ratchet)', () => {
  const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.claude', '.gatetest', 'reliability-corpus', 'benchmarks', 'tests', 'docs']);
  // Legitimate remaining mentions: the config modules define the default, and
  // next.config.ts lists the host in a browser CSP (server-side calls are not
  // CSP-governed, so a custom base URL needs no CSP entry).
  const ALLOWED = new Set([
    'src/core/anthropic-config.js',
    'website/app/lib/anthropic-config.js',
    'website/next.config.ts',
  ]);

  function walk(dir, hits) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, hits); continue; }
      if (!/\.(js|ts|tsx|mjs|cjs)$/.test(e.name)) continue;
      const rel = path.relative(ROOT, p).replace(/\\/g, '/');
      if (ALLOWED.has(rel)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (/['"`]api\.anthropic\.com/.test(src)) hits.push(`${rel} (host literal)`);
      if (/['"]anthropic-version['"]\s*:\s*['"][\d-]+['"]/.test(src)) hits.push(`${rel} (version literal)`);
    }
  }

  it('no call site hardcodes the Anthropic host or API version', () => {
    const hits = [];
    walk(ROOT, hits);
    assert.deepStrictEqual(
      hits,
      [],
      'route it through anthropic-config — a partial migration silently splits traffic '
      + 'between a configured gateway and the real API',
    );
  });

  it('no https.request site left a literal port that would override the config', () => {
    const hits = [];
    const scan = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { scan(p); continue; }
        if (!/\.(js|ts|mjs|cjs)$/.test(e.name)) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (/port:\s*anthropicEndpoint\(\)\.port,\s*\n\s*port:\s*\d+/.test(src)) {
          hits.push(path.relative(ROOT, p));
        }
      }
    };
    scan(ROOT);
    assert.deepStrictEqual(hits, [], 'a duplicate port key means the literal wins and the gateway port is ignored');
  });
});
