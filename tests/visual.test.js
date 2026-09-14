'use strict';

// VISUAL MODULE — behavioural tests with positive AND negative controls for
// the false-positive classes measured 2026-08-18 (93 blocking errors on 9
// real repos: viewport on fragments/framework layouts, "no fallback" on
// `var(--x)`/`inherit`, duplicate-token on compiled Bootstrap).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VisualModule = require('../src/modules/visual');

function makeResult() {
  const checks = [];
  return { checks, addCheck(id, passed, meta) { checks.push({ id, passed, meta: meta || {} }); } };
}
async function scan(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-visual-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const result = makeResult();
    await new VisualModule().run(result, { projectRoot: root, getModuleConfig() { return {}; }, get() { return null; } });
    return result.checks.filter((c) => !c.passed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const ids = (f) => f.map((c) => c.id);

describe('VisualModule — baseline shape', () => {
  it('exposes the expected BaseModule shape', () => {
    const mod = new VisualModule();
    assert.equal(typeof mod.name, 'string');
    assert.equal(typeof mod.run, 'function');
  });
});

describe('VisualModule — viewport', () => {
  it('POSITIVE: a full HTML document without a viewport meta fails', async () => {
    const f = await scan({ 'index.html': '<html><head><title>x</title></head><body></body></html>' });
    assert.ok(ids(f).includes('visual:viewport:index.html'), ids(f).join());
  });
  it('POSITIVE: a SPA shell (Angular <app-root>) without a viewport meta still fails — the shell OWNS its <head>', async () => {
    // The body is rendered at runtime; the <head> is not. A shell missing the
    // viewport tag renders the whole application at desktop width on mobile.
    const f = await scan({ 'src/index.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App</title></head><body><app-root></app-root></body></html>' });
    assert.ok(ids(f).includes('visual:viewport:src/index.html'), ids(f).join());
  });
  it('NEGATIVE: a fragment (no <head>) and a Next.js layout.tsx (framework injects viewport) are silent', async () => {
    const f = await scan({
      'templates/nav.html': '<div th:fragment="nav"><html-ish></div>',
      'app/layout.tsx': 'export default function RootLayout({children}){ return <html lang="en"><body>{children}</body></html>; }',
    });
    assert.ok(!ids(f).some((i) => i.startsWith('visual:viewport:')), ids(f).join());
  });
});

describe('VisualModule — font fallback', () => {
  it('POSITIVE: a lone web font with no generic fallback warns', async () => {
    const f = await scan({ 'styles/a.css': 'body { font-family: "Inter"; }' });
    const hit = f.find((c) => c.id === 'styles/a.css' || c.id.startsWith('visual:font-fallback:'));
    assert.ok(hit, ids(f).join());
    assert.equal(hit.meta.severity, 'warning', 'a missing fallback is not a gate-blocking defect');
  });
  it('NEGATIVE: var(--token), inherit and -apple-system stacks are not "fonts without fallback"', async () => {
    const f = await scan({ 'styles/b.css': 'body{font-family: var(--bs-body-font-family);} code{font-family: inherit;} h1{font-family: -apple-system;}' });
    assert.ok(!ids(f).some((i) => i.startsWith('visual:font-fallback:')), ids(f).join());
  });
});

describe('VisualModule — duplicate design tokens', () => {
  it('NEGATIVE: compiled Bootstrap re-declaring --bs-* per component is scoping, not inconsistency', async () => {
    const css = ['.btn{--bs-btn-color:#fff;}', '.btn-primary{--bs-btn-color:#000;}', '.card{--bs-btn-color:#111;}', '.nav{--bs-btn-color:#222;}', '.x{--bs-btn-color:#333;}'].join('\n');
    const f = await scan({ 'static/css/bootstrap.min.css': css, 'src/theme.css': css });
    assert.ok(!ids(f).some((i) => i.startsWith('visual:duplicate-token:')), ids(f).join());
  });
  it('POSITIVE: the same token declared in more than three separate hand-written files is reported (as info)', async () => {
    const files = {};
    for (let i = 0; i < 5; i++) files[`src/part${i}.css`] = `:root{--brand:#0${i}0;}`;
    const f = await scan(files);
    const hit = f.find((c) => c.id === 'visual:duplicate-token:--brand');
    assert.ok(hit, ids(f).join());
    assert.equal(hit.meta.severity, 'info');
  });
});

// ── print-styles ──────────────────────────────────────────────────────────
//
// The rule means "you targeted the `screen` media type, so you owe the `print`
// one". It was implemented as three raw substring tests over the whole file,
// and fired on this repo's own website/app/globals.css — a file whose ONLY
// occurrence of "screen" is the word "screenshot" inside a CSS comment, and
// which has no `@media screen` query at all. The same naive matching meant the
// word "sprint" anywhere in a file would silence the rule for real.
describe('VisualModule — print styles', () => {
  it('NEGATIVE: the word "screenshot" in a comment is not a `screen` media query', async () => {
    const css = [
      '/* Browser-window frame for the product screenshot — a captured screenshot. */',
      '@media (max-width: 767px) { .hero { font-size: 2rem; } }',
      '@media (prefers-reduced-motion: reduce) { * { animation: none; } }',
    ].join('\n');
    const f = await scan({ 'app/globals.css': css });
    assert.ok(!ids(f).includes('visual:print-styles:app/globals.css'), ids(f).join());
    assert.ok(!ids(f).some((i) => i.startsWith('visual:print-styles:')), ids(f).join());
  });

  it('POSITIVE: a real `@media screen` query with no print stylesheet still fires', async () => {
    const css = '@media screen and (min-width: 900px) { .grid { display: grid; } }';
    const f = await scan({ 'src/layout.css': css });
    assert.ok(ids(f).some((i) => i.startsWith('visual:print-styles:')), ids(f).join());
  });

  it('NEGATIVE: `@media screen` alongside `@media print` (or an @page rule) is satisfied', async () => {
    const withPrint = '@media screen { .a { color: red; } }\n@media print { .nav { display: none; } }';
    assert.ok(!ids(await scan({ 'src/a.css': withPrint })).some((i) => i.startsWith('visual:print-styles:')));
    const withPage = '@media screen { .a { color: red; } }\n@page { margin: 1cm; }';
    assert.ok(!ids(await scan({ 'src/b.css': withPage })).some((i) => i.startsWith('visual:print-styles:')));
  });

  it('POSITIVE: the word "print" outside a media prelude does NOT silence the rule', async () => {
    // "sprint"/"footprint" in a comment or a class name used to satisfy
    // `content.includes('print')` and suppress a genuine finding.
    const css = '/* sprint-2 layout, small footprint */\n.blueprint { color: #000; }\n@media screen { .a { color: red; } }';
    const f = await scan({ 'src/c.css': css });
    assert.ok(ids(f).some((i) => i.startsWith('visual:print-styles:')), ids(f).join());
  });
});

// ── severities (corpus6, 2026-09-05) ─────────────────────────────────────
//
// trpc/trpc was gated on `visual:print-styles:www/src/css/custom.css` — a docs
// site with two `@media only screen` breakpoints and no print sheet. Not
// having a print stylesheet is not a defect a user hits. The only visual rule
// that stays an error is `viewport` on a full document, which is NodeGoat's
// one blocking visual finding and the recall floor.
describe('VisualModule — severities: only viewport on a full document blocks', () => {
  it('NEGATIVE: trpc www/src/css/custom.css — screen breakpoints, no print sheet — is info, still reported', async () => {
    const css = [
      '@media only screen and (min-width: 997px) {', // verbatim, custom.css:183
      '  .navbar__items { gap: 1rem; }',
      '}',
      '@media only screen and (min-width: 1496px) {', // verbatim, custom.css:189
      '  .container { max-width: 1400px; }',
      '}',
    ].join('\n');
    const f = await scan({ 'www/src/css/custom.css': css });
    const hit = f.find((c) => c.id.startsWith('visual:print-styles:'));
    assert.ok(hit, 'still reported — downgraded, not hidden: ' + ids(f).join());
    assert.equal(hit.meta.severity, 'info');
  });

  it('NEGATIVE: z-index: 99999 is a stacking smell — warning, still reported', async () => {
    const f = await scan({ 'src/modal.css': '.modal { z-index: 99999; }' });
    const hit = f.find((c) => c.id.startsWith('visual:z-index:'));
    assert.ok(hit, ids(f).join());
    assert.equal(hit.meta.severity, 'warning');
  });

  it('POSITIVE: OWASP NodeGoat app/views/error-template.html — a full document with no viewport — stays an error', async () => {
    // Verbatim shape of the recall floor's one blocking visual finding.
    const html = '<!doctype HTML>\n<html>\n\n<head>\n    <title>Internal Error</title>\n</head>\n\n<body>\n\n    Oops..\n    <br>{{error}}\n</body>\n</html>\n';
    const f = await scan({ 'app/views/error-template.html': html });
    const hit = f.find((c) => c.id.startsWith('visual:viewport:'));
    assert.ok(hit, ids(f).join());
    assert.equal(hit.meta.severity, undefined, 'undefined = module default (error)');
  });
});
