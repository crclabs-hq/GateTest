'use strict';

// SEO MODULE — behavioural tests with positive AND negative controls.
//
// 2026-08-18 false-positive audit: seo produced 446 blocking errors across
// 9 real repos, 59/69 of them on server-template fragments (Thymeleaf /
// Jinja / swig partials, layouts, includes) that carry no <html>/<head> of
// their own, plus "no sitemap" on libraries that are not websites. The
// module now checks FULL DOCUMENTS only and asks for sitemap/robots only
// where a deployable site exists. The positive control below plants a real
// broken page and asserts the rules still fire — without it, tightening the
// filter until the repo goes quiet is indistinguishable from the rule working.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SeoModule = require('../src/modules/seo');

function makeResult() {
  const checks = [];
  return { checks, addCheck(id, passed, meta) { checks.push({ id, passed, meta: meta || {} }); } };
}
function makeConfig(projectRoot) {
  return { projectRoot, getModuleConfig() { return {}; }, get() { return null; } };
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
async function runOn(root) {
  const result = makeResult();
  await new SeoModule().run(result, makeConfig(root));
  return result.checks;
}
const failing = (checks) => checks.filter((c) => !c.passed);
const FULL_PAGE_NO_META = '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>a</h1><h1>b</h1></body></html>';

describe('SeoModule — baseline shape', () => {
  it('exposes the expected BaseModule shape', () => {
    const mod = new SeoModule();
    assert.equal(typeof mod.name, 'string');
    assert.equal(typeof mod.run, 'function');
  });
});

describe('SeoModule — full documents only', () => {
  let root;
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-seo-')); });
  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('POSITIVE CONTROL: a real page missing title/description still fails', async () => {
    write(root, 'index.html', FULL_PAGE_NO_META);
    const bad = failing(await runOn(root));
    assert.ok(bad.some((c) => c.id === 'seo:title:index.html'), 'missing <title> must fire');
    assert.ok(bad.some((c) => c.id === 'seo:description:index.html'), 'missing description must fire');
    assert.ok(bad.some((c) => c.id === 'seo:h1-multiple:index.html'), 'multiple h1 must fire');
  });

  it('a Thymeleaf/Jinja fragment with no <html>/<head> is skipped, not failed', async () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-seo-frag-'));
    try {
      write(r, 'src/main/resources/templates/fragments/layout.html', '<div th:fragment="nav"><ul><li>x</li></ul></div>');
      write(r, 'app/templates/_footer.html', '<footer>{{ year }}</footer>');
      const checks = await runOn(r);
      assert.equal(failing(checks).length, 0, `fragments produced findings: ${JSON.stringify(failing(checks).map((c) => c.id))}`);
      assert.ok(checks.some((c) => c.id === 'seo:fragments' && c.passed), 'skipped fragments are reported once as info');
    } finally { fs.rmSync(r, { recursive: true, force: true }); }
  });

  it('a child template that extends a layout inherits its head and is skipped', () => {
    assert.equal(SeoModule.isFullDocument('web/page.html', '{% extends "base.html" %}<html><head></head><body></body></html>'), false);
    assert.equal(SeoModule.isFullDocument('web/page.html', '<html><head><title>x</title></head><body></body></html>'), true);
  });

  it('files under templates/, views/, fixtures/, tests/ or examples/ are never pages', () => {
    for (const p of ['templates/a.html', 'app/views/b.html', 'tests/fixtures/c.html', 'examples/d.html', 'docs_src/e.html']) {
      assert.equal(SeoModule.isFullDocument(p, '<html><head></head><body></body></html>'), false, p);
    }
  });
});

describe('SeoModule — sitemap/robots only for deployable sites', () => {
  it('a library with no HTML pages is not told it lacks a sitemap or robots.txt', async () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-seo-lib-'));
    try {
      write(r, 'lib/index.js', 'module.exports = 1;\n');
      write(r, 'test/fixtures/page.html', '<html><head></head><body></body></html>');
      const checks = await runOn(r);
      assert.ok(!checks.some((c) => c.id === 'seo:sitemap' && !c.passed), 'sitemap must not fire on a library');
      assert.ok(!checks.some((c) => c.id === 'seo:robots-txt' && !c.passed), 'robots must not fire on a library');
      assert.ok(checks.some((c) => c.id === 'seo:site-files' && c.passed));
    } finally { fs.rmSync(r, { recursive: true, force: true }); }
  });

  it('a real site without sitemap/robots gets a WARNING (not a gate-blocking error)', async () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-seo-site-'));
    try {
      write(r, 'index.html', '<html><head><title>Home</title><meta name="description" content="A perfectly described page for testing purposes here."></head><body><h1>Hi</h1></body></html>');
      const checks = await runOn(r);
      const sitemap = checks.find((c) => c.id === 'seo:sitemap');
      const robots = checks.find((c) => c.id === 'seo:robots-txt');
      assert.ok(sitemap && !sitemap.passed && sitemap.meta.severity === 'warning');
      assert.ok(robots && !robots.passed && robots.meta.severity === 'warning');
    } finally { fs.rmSync(r, { recursive: true, force: true }); }
  });

  it('a Next.js app dir counts as a website even before any HTML is emitted', () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-seo-next-'));
    try {
      write(r, 'app/layout.tsx', 'export default function L({children}){return children}');
      assert.equal(SeoModule.looksLikeWebsite(r), true);
    } finally { fs.rmSync(r, { recursive: true, force: true }); }
  });
});

describe('SeoModule — a SPA shell is not scored', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-seo-spa-')); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  it('Angular index.html produces no seo findings; a content page still does', async () => {
    write(tmp, 'src/index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App</title></head><body><app-root></app-root></body></html>\n');
    write(tmp, 'public/about.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About</title></head><body><main><p>About us and what we do here, at some length so it is a page.</p></main></body></html>\n');
    const checks = await runOn(tmp);
    const failed = failing(checks).filter((c) => /^seo:/.test(c.id)).map((c) => c.id);
    assert.ok(!failed.some((n) => n.includes('src/index.html')), `shell scored: ${failed.join(', ')}`);
    assert.ok(failed.some((n) => n.includes('about.html')), 'positive control: the content page is still scored');
  });
});

// ── severity: share cards, canonical and structured data do not block a build ──
//
// prisma apps/lsp-playground/index.html — a Monaco editor page served by a
// local CLI — took 9 blocking errors for og:/twitter:/canonical/JSON-LD.
// Those describe how a page is SHARED; the page's own identity (title,
// description, h1) stays at error.
describe('SEO — Open Graph / Twitter / canonical / structured-data absence is a warning; title, description and h1 remain errors', () => {
  it('splits severity by what the metadata is for', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-seo-sev-'));
    try {
      write(root, 'apps/lsp-playground/index.html', [
        '<!doctype html>',
        '<html lang="en">',
        '  <head>',
        '    <meta charset="utf-8" />',
        '    <title>PSL Playground</title>',
        '  </head>',
        '  <body>',
        '    <div id="header"><span>PSL Playground — live diagnostics from <code>prisma lsp</code></span></div>',
        '    <div id="editor"></div>',
        '    <script type="module" src="/src/client/main.ts"></script>',
        '  </body>',
        '</html>',
      ].join('\n'));
      const result = makeResult();
      await new SeoModule().run(result, makeConfig(root));
      const failed = result.checks.filter((c) => !c.passed && c.id.includes('lsp-playground'));
      const sev = (prefix) => failed.filter((c) => c.id.startsWith(prefix)).map((c) => c.meta.severity || 'error');
      for (const p of ['seo:og:', 'seo:twitter:', 'seo:canonical:', 'seo:structured-data:']) {
        assert.ok(sev(p).length > 0, `${p} must still be reported`);
        assert.ok(sev(p).every((s) => s === 'warning'), `${p} must be a warning: ${sev(p)}`);
      }
      assert.deepEqual(sev('seo:description:'), ['error']);
      assert.deepEqual(sev('seo:h1-missing:'), ['error']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

// ── KI #106: looksLikeWebsite decides from a marker list that lacked most
// frameworks. Each new marker is a positive control; a plain library, a
// Vite/Svelte LIBRARY (config without an app tree) and a bare config.toml
// are the negatives — the sitemap/robots warnings must not return to
// express/flask/gin-shaped repos. Root-only by design: the sitemap/robots
// probes are root-relative, so a docs site in a subfolder is not a marker.
describe('SeoModule — looksLikeWebsite recognises every deployable-site framework', () => {
  const withRoot = (files, fn) => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-seo-mk-'));
    try {
      for (const f of files) {
        if (f.endsWith('/')) fs.mkdirSync(path.join(r, f), { recursive: true });
        else write(r, f, f.endsWith('.json') ? '{}' : '// config\n');
      }
      return fn(r);
    } finally { fs.rmSync(r, { recursive: true, force: true }); }
  };
  const SITES = {
    'Remix app/root.tsx': ['app/root.tsx'],
    'Remix remix.config.js': ['remix.config.js'],
    'Angular angular.json': ['angular.json', 'src/index.html'],
    'Vite with src/index.html': ['vite.config.ts', 'src/index.html'],
    'Vite with web/index.html': ['vite.config.mjs', 'web/index.html'],
    'SvelteKit svelte.config.js + src/routes': ['svelte.config.js', 'src/routes/'],
    'Astro astro.config.mjs': ['astro.config.mjs'],
    'Astro astro.config.ts': ['astro.config.ts'],
    'Nuxt nuxt.config.ts': ['nuxt.config.ts'],
    'Gatsby gatsby-config.ts': ['gatsby-config.ts'],
    'Docusaurus docusaurus.config.ts': ['docusaurus.config.ts'],
    'Hugo hugo.toml': ['hugo.toml'],
    'Hugo config.toml + content/': ['config.toml', 'content/'],
    'Jekyll _config.yml': ['_config.yml'],
    'Eleventy .eleventy.js': ['.eleventy.js'],
    'Eleventy eleventy.config.cjs': ['eleventy.config.cjs'],
  };
  for (const [label, files] of Object.entries(SITES)) {
    it(`POSITIVE: ${label}`, () => withRoot(files, (r) => assert.equal(SeoModule.looksLikeWebsite(r), true)));
  }
  const NOT_SITES = {
    'a plain library (README.md + src/)': ['README.md', 'src/index.js'],
    'a Vite library (vite.config without an entry document)': ['vite.config.ts', 'src/index.ts'],
    'a Svelte component library (svelte.config without src/routes)': ['svelte.config.js', 'src/lib/Button.svelte'],
    'a bare config.toml (Rust/tool config, not Hugo)': ['config.toml', 'src/main.rs'],
    'a docs site in a subfolder of a library': ['README.md', 'src/index.js', 'docs/astro.config.mjs', 'website/docusaurus.config.js'],
  };
  for (const [label, files] of Object.entries(NOT_SITES)) {
    it(`NEGATIVE: ${label}`, () => withRoot(files, (r) => assert.equal(SeoModule.looksLikeWebsite(r), false)));
  }

  it('an Angular workspace is asked for sitemap/robots even though its only page is a SPA shell; src/robots.txt satisfies robots', async () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-seo-ng-'));
    try {
      write(r, 'angular.json', '{}');
      write(r, 'src/index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App</title></head><body><app-root></app-root></body></html>\n');
      write(r, 'src/robots.txt', 'User-agent: *\n');
      const checks = await runOn(r);
      assert.ok(checks.some((c) => c.id === 'seo:sitemap' && !c.passed && c.meta.severity === 'warning'), 'sitemap warning fires');
      assert.ok(checks.some((c) => c.id === 'seo:robots-txt' && c.passed), 'src/robots.txt is found');
    } finally { fs.rmSync(r, { recursive: true, force: true }); }
  });

  it('a build-time declaration counts: @astrojs/sitemap in astro.config, Docusaurus always, Hugo enableRobotsTXT; an Astro config without it still warns', async () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-seo-gen-'));
    try {
      write(r, 'astro.config.mjs', "import sitemap from '@astrojs/sitemap';\nexport default { integrations: [sitemap()] };\n");
      let checks = await runOn(r);
      assert.ok(checks.some((c) => c.id === 'seo:sitemap' && c.passed), 'integration satisfies sitemap');
      assert.ok(checks.some((c) => c.id === 'seo:robots-txt' && !c.passed), 'robots still warns');
      fs.writeFileSync(path.join(r, 'astro.config.mjs'), 'export default {};\n');
      checks = await runOn(r);
      assert.ok(checks.some((c) => c.id === 'seo:sitemap' && !c.passed), 'negative: no integration, sitemap warns');
    } finally { fs.rmSync(r, { recursive: true, force: true }); }
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-seo-docu-'));
    try {
      write(d, 'docusaurus.config.ts', 'export default { title: "x" };\n');
      assert.equal(SeoModule.generatedAtBuild(d, 'sitemap'), true);
      assert.equal(SeoModule.generatedAtBuild(d, 'robots'), false);
      write(d, 'hugo.toml', 'baseURL = "https://x"\nenableRobotsTXT = true\n');
      assert.equal(SeoModule.generatedAtBuild(d, 'robots'), true);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

// ============================================================================
// #653 — <title lang="en">/multi-line <title>/meta description with attributes
// in between were all reported "missing" by bare-tag regexes. 12 of 26 lost
// grade points on tallrig.com were exactly this false positive. seo.js now
// reads both through src/core/html-extract.js (matchTitleTag /
// matchMetaDescriptionTag) — the same one definition #641/#646 fixed for the
// crawler.
// ============================================================================
describe('SeoModule — <title>/meta description with attributes is not "missing" (#653)', () => {
  let root;
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-seo-653-')); });
  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('CONTROL — a <title lang="en"> tag is read, not reported missing', async () => {
    write(root, 'lang-title.html',
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<title lang="en">Tallrig — Automated Quality Gate</title>' +
      '<meta name="description" content="A description long enough to pass."></head>' +
      '<body><h1>Home</h1></body></html>');
    const checks = await runOn(root);
    const bad = failing(checks);
    assert.ok(!bad.some((c) => c.id === 'seo:title:lang-title.html'), 'a <title lang="en"> must not be reported missing');
    assert.ok(checks.some((c) => c.id === 'seo:title:lang-title.html' && c.passed), 'title check must pass');
  });

  it('CONTROL — a multi-line <title> is read, not reported missing', async () => {
    write(root, 'multiline-title.html',
      '<!doctype html><html><head><meta charset="utf-8">\n' +
      '<title>\n  Tallrig — Automated Quality Gate\n</title>\n' +
      '<meta name="description" content="A description long enough to pass.">' +
      '</head><body><h1>Home</h1></body></html>');
    const checks = await runOn(root);
    const bad = failing(checks);
    assert.ok(!bad.some((c) => c.id === 'seo:title:multiline-title.html'), 'a multi-line <title> must not be reported missing');
    assert.ok(checks.some((c) => c.id === 'seo:title:multiline-title.html' && c.passed), 'title check must pass');
  });

  it('POSITIVE CONTROL — a <title> that only exists inside an <svg> still counts as missing', async () => {
    write(root, 'svg-only-title.html',
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="description" content="A description long enough to pass.">' +
      '</head><body><svg viewBox="0 0 10 10"><title>Icon</title></svg><h1>Home</h1></body></html>');
    const checks = await runOn(root);
    const bad = failing(checks);
    assert.ok(bad.some((c) => c.id === 'seo:title:svg-only-title.html'), 'an svg-only <title> must still be reported missing');
  });

  it('CONTROL — a meta description with an attribute BETWEEN name and content is read, either order', async () => {
    write(root, 'meta-attrs.html',
      '<!doctype html><html><head><meta charset="utf-8"><title>Home</title>' +
      '<meta name="description" lang="en" content="A description long enough to pass, with an attribute in between.">' +
      '</head><body><h1>Home</h1></body></html>');
    write(root, 'meta-attrs-reversed.html',
      '<!doctype html><html><head><meta charset="utf-8"><title>Home</title>' +
      '<meta content="A description long enough to pass, with an attribute after content." lang="en" name="description">' +
      '</head><body><h1>Home</h1></body></html>');
    const checks = await runOn(root);
    const bad = failing(checks);
    assert.ok(!bad.some((c) => c.id === 'seo:description:meta-attrs.html'), 'name ... lang ... content must not be reported missing');
    assert.ok(!bad.some((c) => c.id === 'seo:description:meta-attrs-reversed.html'), 'content ... lang ... name must not be reported missing');
  });

  it('a fixture reproducing the tallrig.com false positive now passes both checks', async () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-seo-653-tallrig-'));
    try {
      write(r, 'index.html',
        '<!doctype html><html lang="en"><head>\n' +
        '<meta charset="utf-8">\n' +
        '<title data-sm="00000001">\n  Tallrig — Automated Quality Gate\n</title>\n' +
        '<meta name="description" data-sm="00000002" content="Automated quality gating for every push, catching regressions before they ship.">\n' +
        '</head><body><h1>Tallrig</h1></body></html>');
      const checks = await runOn(r);
      const bad = failing(checks);
      assert.ok(!bad.some((c) => c.id === 'seo:title:index.html'), 'title must not be reported missing');
      assert.ok(!bad.some((c) => c.id === 'seo:description:index.html'), 'description must not be reported missing');
    } finally { fs.rmSync(r, { recursive: true, force: true }); }
  });
});
