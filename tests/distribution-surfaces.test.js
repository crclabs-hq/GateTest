// =============================================================================
// distribution-surfaces.test.js
//
// website/app/lib/distribution.ts is the ONE list of places GateTest ships
// (homepage <HomeEverywhere>, the nav). A channel on that list is a promise
// on the homepage, so every entry must point somewhere that exists:
//   - an internal href must be a route directory under website/app;
//   - an external href must be on a host we actually publish to;
//   - the VS Code identity must be the extension's own manifest, never typed.
// The "free" line and the pitch are copy, checked by the vendor-neutral and
// pricing guards; this file checks the links and the identity.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'website', 'app', 'lib', 'distribution.ts'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode-extension', 'package.json'), 'utf8'));

// A tiny TS-to-data reader: pull every `href: "..."` / href: CONSTANT and the
// constants themselves, without compiling the module.
const CONSTANTS = {};
for (const m of SRC.matchAll(/^(?:export )?const ([A-Z_]+) = "([^"]+)";/gm)) CONSTANTS[m[1]] = m[2];
const HREFS = [];
for (const m of SRC.matchAll(/href:\s*(?:"([^"]+)"|([A-Z_]+))/g)) HREFS.push(m[1] || CONSTANTS[m[2]] || m[2]);

const EXTERNAL_HOSTS = new Set([
  'marketplace.visualstudio.com',
  'www.npmjs.com',
  'github.com',
]);

describe('distribution surfaces: every listed channel points somewhere real', () => {
  it('lists at least the six channels that were live on 2026-09-16', () => {
    const ids = [...SRC.matchAll(/id:\s*"([a-z]+)"/g)].map((m) => m[1]);
    for (const id of ['vscode', 'cli', 'action', 'mcp', 'web', 'wordpress']) {
      assert.ok(ids.includes(id), `surface "${id}" is missing`);
    }
  });

  it('internal hrefs are routes that exist under website/app', () => {
    for (const href of HREFS.filter((h) => h.startsWith('/'))) {
      const dir = path.join(ROOT, 'website', 'app', href.replace(/^\//, ''));
      assert.ok(fs.existsSync(path.join(dir, 'page.tsx')), `${href} has no website/app${href}/page.tsx`);
    }
  });

  it('external hrefs stay on the hosts we publish to', () => {
    for (const href of HREFS.filter((h) => /^https?:/.test(h))) {
      const host = new URL(href).host;
      assert.ok(EXTERNAL_HOSTS.has(host), `${href} — unexpected host ${host}`);
    }
    // Templates are resolved at runtime; the VS Code URL is checked below.
    assert.ok(HREFS.includes('VSCODE_MARKETPLACE_URL') || SRC.includes('href: VSCODE_MARKETPLACE_URL'));
  });

  it('the VS Code identity constant equals the extension manifest (pinned by test — the website builds standalone)', () => {
    const m = SRC.match(/^const VSCODE_EXTENSION_ID = "([^"]+)";/m);
    assert.ok(m, 'VSCODE_EXTENSION_ID is a module-private string constant (only SURFACES and the Marketplace URL are exported)');
    assert.strictEqual(m[1], `${manifest.publisher}.${manifest.name}`, 'drifted from vscode-extension/package.json');
    assert.ok(!/from "\.\.\/\.\.\/\.\.\/vscode-extension/.test(SRC), 'no cross-tree import — the Docker image build cannot resolve it');
  });

  it('the CLI snippet uses the form that resolves on the published package', () => {
    // Bare `npx @gatetest/cli` only resolves from 1.61.1; npm serves 1.61.0.
    // Check the snippets a visitor copies, not the comments that explain why.
    const snippets = [...SRC.matchAll(/snippet:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(snippets.some((s) => /npx -p @gatetest\/cli gatetest/.test(s)), 'the CLI snippet uses -p');
    for (const s of snippets) assert.ok(!/npx @gatetest\/cli\b/.test(s), `bare npx @gatetest/cli is not on npm yet: ${s}`);
  });

  it('the module count is imported where it is rendered, never typed', () => {
    const cmp = fs.readFileSync(path.join(ROOT, 'website', 'app', 'components', 'HomeEverywhere.tsx'), 'utf8');
    assert.match(cmp, /import \{ TOTAL_MODULES \} from "@\/app\/lib\/module-count"/);
    assert.ok(!/\b1[0-9]{2}[- ]module/.test(cmp), 'a typed three-digit module count');
    assert.ok(!/\b1[0-9]{2}[- ]module/.test(SRC), 'a typed three-digit module count');
  });

  it('the nav and the homepage import from the one definition', () => {
    const nav = fs.readFileSync(path.join(ROOT, 'website', 'app', 'components', 'site-nav.ts'), 'utf8');
    assert.match(nav, /from "\.\.\/lib\/distribution"/);
    const page = fs.readFileSync(path.join(ROOT, 'website', 'app', 'page.tsx'), 'utf8');
    assert.match(page, /<HomeEverywhere \/>/);
  });
});
