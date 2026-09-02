// =============================================================================
// WEBSITE CLAIMS — numbers and names the site publishes must be the engine's.
// =============================================================================
// The 2026-09-02 audit found nine live contradictions that no test guarded:
// suite sizes typed as 41/45/88 (engine: 42/46/89), "24 tools" typed in three
// places, the `opus` alias described as Opus 4.8 (code maps it to Opus 5),
// Opus 5 missing from the model picker, "120 Modules" hiding from the
// module-count guard behind a case-sensitive prefilter. Each class gets a
// guard here. The rule is the Bible's: never type a number, read it.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const siteStats = require('../website/app/data/site-stats.json');
const { DEFAULT_CONFIG } = require('../src/core/config');
const { ALLOWED_FIX_MODELS } = require('../src/core/engine-models');

const SKIP_DIRS = new Set(['node_modules', '.next', 'data', 'scans']);
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (/\.(tsx?|jsx?|mjs|cjs|md|mdx)$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}
const SITE_FILES = walk(path.join(ROOT, 'website', 'app'));

describe('site-stats — the generated numbers equal the engine', () => {
  it('suite sizes equal DEFAULT_CONFIG.suites', () => {
    for (const [name, mods] of Object.entries(DEFAULT_CONFIG.suites)) {
      assert.strictEqual(siteStats.suites[name], mods.length, `site-stats.suites.${name} is stale — run scripts/generate-site-stats.js --no-tests`);
    }
  });
  it('the MCP tool count equals the tools registered by bin/gatetest-mcp.mjs', () => {
    const src = read('bin/gatetest-mcp.mjs');
    const start = src.indexOf('const TOOLS');
    const end = src.indexOf('\n];', start);
    const names = new Set([...src.slice(start, end).matchAll(/^\s*name:\s*['"]([a-z_]+)['"]/gm)].map((m) => m[1]));
    assert.ok(names.size > 10, 'anti-vacuity: the TOOLS array must parse');
    assert.strictEqual(siteStats.mcpTools.count, names.size, 'site-stats.mcpTools is stale — run scripts/generate-site-stats.js --no-tests');
    assert.deepStrictEqual(siteStats.mcpTools.names, [...names].sort());
  });
  it('the MCP catalogue on the website lists exactly the server tools', () => {
    const catalogue = read('website/app/mcp/tools-data.ts');
    const listed = new Set([...catalogue.matchAll(/name:\s*"([a-z_]+)/g)].map((m) => m[1]));
    for (const n of siteStats.mcpTools.names) assert.ok(listed.has(n), `server tool ${n} is missing from website/app/mcp/tools-data.ts`);
    for (const n of listed) assert.ok(siteStats.mcpTools.names.includes(n), `catalogue lists ${n}, which the server does not register`);
  });
});

describe('website copy — no hand-typed suite sizes or tool counts', () => {
  const suiteSizes = Object.values(siteStats.suites);
  it('no "<N>-module quick/standard/full/nuclear" literal outside the generated data', () => {
    const offenders = [];
    for (const f of SITE_FILES) {
      const rel = path.relative(ROOT, f);
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\b(\d{2,3})[\s-]module\s+(quick|standard|full|nuclear|smart)\b/gi)) {
        offenders.push(`${rel}: "${m[0]}"`);
      }
    }
    assert.deepStrictEqual(offenders, [], 'derive suite sizes from site-stats.json (see mcp/tools-data.ts)');
  });
  it('no hand-typed MCP tool count in shipped copy', () => {
    const offenders = [];
    for (const f of SITE_FILES) {
      const rel = path.relative(ROOT, f);
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\b(1[5-9]|[2-4]\d)\s+(?:MCP\s+)?tools\b(?!\+)/g)) {
        offenders.push(`${rel}: "${m[0]}"`);
      }
    }
    assert.deepStrictEqual(offenders, [], 'import TOOL_COUNT from mcp/tools-data (or mcpTools.count from site-stats.json)');
  });
  it('anti-vacuity: the suite-size regex finds the derived template in tools-data', () => {
    assert.ok(suiteSizes.length >= 4);
    assert.match(read('website/app/mcp/tools-data.ts'), /\$\{QUICK_SUITE_MODULES\}-module quick/);
  });
});

describe('website copy — model names match the engine allow-list', () => {
  const display = { 'claude-sonnet-5': 'Sonnet 5', 'claude-opus-5': 'Opus 5', 'claude-opus-4-8': 'Opus 4.8', 'claude-fable-5': 'Fable 5' };
  it('every allowed model id has a display name in this test (keep in sync when the allow-list changes)', () => {
    assert.deepStrictEqual(Object.keys(display).sort(), Object.keys(ALLOWED_FIX_MODELS).sort());
  });
  it('the home model picker lists every allowed model by id', () => {
    const src = read('website/app/components/HomeModelChoice.tsx');
    for (const id of Object.keys(ALLOWED_FIX_MODELS)) {
      assert.ok(src.includes(`id: "${id}"`), `HomeModelChoice.tsx does not list ${id}`);
      assert.ok(src.includes(`name: "${display[id]}"`), `HomeModelChoice.tsx names ${id} something other than "${display[id]}"`);
    }
  });
  it('the MCP FAQ describes each alias with the model it actually resolves to', () => {
    const src = read('website/app/mcp/page.tsx');
    const faq = src.split('\n').find((l) => /Which AI model runs my fixes/.test(l) ? false : /\bsonnet \(/.test(l));
    assert.ok(faq, 'the model FAQ answer must be present');
    for (const [id, meta] of Object.entries(ALLOWED_FIX_MODELS)) {
      const alias = meta.aliases[0];
      const m = faq.match(new RegExp(`\\b${alias.replace(/[.-]/g, '\\$&')} \\(([^)—]+)`));
      assert.ok(m, `FAQ does not describe the "${alias}" alias`);
      assert.ok(m[1].includes(display[id]), `alias "${alias}" is described as "${m[1].trim()}" but resolves to ${display[id]}`);
    }
  });
});

describe('module-count guard — the prefilter cannot hide a claim from CLAIM_RE', () => {
  it('the prefilter in tests/module-count-sync.test.js is case-insensitive and allows intervening words', () => {
    const src = read('tests/module-count-sync.test.js');
    const pre = src.match(/if \(!(\/[^\n]+\/i)\.test\(src\)\) continue;/);
    assert.ok(pre, 'prefilter must be the shared shape');
    const re = new RegExp(pre[1].slice(1, -2), 'i');
    assert.ok(re.test('See All 120 Modules'));
    assert.ok(re.test('120 scanning modules'));
    assert.ok(re.test('120 AI-powered scanning modules'));
  });
});
