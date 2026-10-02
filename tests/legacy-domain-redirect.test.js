'use strict';

// LEGACY DOMAIN REDIRECT — gatetest.ai was re-registered by Craig at
// name.com on 2026-10-02 (expires 2028-10-02). Badge URLs on it sit in
// customers' READMEs we can never edit, so every path on it (and on www.)
// must permanently redirect to the same path on the canonical origin.
// The redirect rules are read from the real next.config.ts, not restated.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const web = require(path.join(ROOT, 'website', 'app', 'lib', 'site-url.js'));

function loadNextConfig() {
  const ts = require(path.join(ROOT, 'website', 'node_modules', 'typescript'));
  const file = path.join(ROOT, 'website', 'next.config.ts');
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const mod = { exports: {} };
  const req = (id) => (id === './app/lib/site-url.js' ? web : require(id.startsWith('.') ? path.join(ROOT, 'website', id) : id));
  // import.meta.dirname is ESM-only; the config uses it for the repo root.
  const body = outputText.replace(/import\.meta\.dirname/g, JSON.stringify(path.join(ROOT, 'website')));
  new Function('require', 'module', 'exports', body)(req, mod, mod.exports);
  return mod.exports.default || mod.exports;
}

describe('legacy domains redirect permanently to the canonical origin', () => {
  it('gatetest.ai is the one legacy host, and it is not the canonical one', () => {
    assert.deepEqual([...web.LEGACY_SITE_HOSTS], ['gatetest.ai']);
    assert.ok(!web.LEGACY_SITE_HOSTS.includes(new URL(web.DEFAULT_SITE_URL).host));
  });

  it('apex and www of every legacy host get a permanent, path-preserving redirect', async () => {
    const config = loadNextConfig();
    const rules = await config.redirects();
    const canonical = new URL(process.env.NEXT_PUBLIC_BASE_URL || web.DEFAULT_SITE_URL).origin;
    for (const legacy of web.LEGACY_SITE_HOSTS) {
      for (const host of [legacy, `www.${legacy}`]) {
        const rule = rules.find((r) => (r.has || []).some((h) => h.type === 'host' && h.value === host));
        assert.ok(rule, `no redirect for ${host}`);
        assert.equal(rule.source, '/:path*', `${host}: every path`);
        assert.equal(rule.destination, `${canonical}/:path*`, `${host}: same path on ${canonical}`);
        assert.equal(rule.permanent, true, `${host}: permanent`);
      }
    }
  });

  it('control: the canonical host itself is never redirected (no loop)', async () => {
    const rules = await loadNextConfig().redirects();
    const canonicalHost = new URL(process.env.NEXT_PUBLIC_BASE_URL || web.DEFAULT_SITE_URL).host;
    assert.ok(!rules.some((r) => (r.has || []).some((h) => h.type === 'host' && h.value === canonicalHost)));
  });
});
