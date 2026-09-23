const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const AccessibilityModule = require('../src/modules/accessibility');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

describe('AccessibilityModule — baseline shape', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-a11y-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('exposes the expected BaseModule shape', () => {
    const mod = new AccessibilityModule();
    assert.strictEqual(typeof mod.name, 'string');
    assert.ok(mod.name.length > 0);
    assert.strictEqual(typeof mod.description, 'string');
    assert.ok(mod.description.length > 0);
    assert.strictEqual(typeof mod.run, 'function');
  });

  it('runs without throwing on an empty project root', async () => {
    const mod = new AccessibilityModule();
    const result = makeResult();
    await assert.doesNotReject(mod.run(result, { projectRoot: tmp }));
  });
});

describe('AccessibilityModule — fragment / primitive / AAA precision (2026-08-18 audit)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-a11y-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const w = (rel, c) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
  const run = async () => { const r = makeResult(); await new AccessibilityModule().run(r, { projectRoot: tmp, getModuleConfig() { return {}; }, get() { return null; } }); return r.checks.filter((c) => !c.passed); };

  it('html-lang / landmark-main do not fire on a template fragment that has no <head>', async () => {
    w('templates/fragments/nav.html', '<html xmlns:th="http://www.thymeleaf.org"><body><nav th:fragment="nav">x</nav></body></html>');
    const f = await run();
    assert.ok(!f.some((c) => /a11y:(html-lang|landmark-main):/.test(c.name)), JSON.stringify(f.map((c) => c.name)));
  });

  it('POSITIVE: a full document without lang / main still fires', async () => {
    w('index.html', '<html><head><title>t</title></head><body><div>hi</div></body></html>');
    const f = await run();
    assert.ok(f.some((c) => c.name === 'a11y:html-lang:index.html'), JSON.stringify(f.map((c) => c.name)));
    assert.ok(f.some((c) => c.name === 'a11y:landmark-main:index.html'));
  });

  it('a SPA shell is not told it lacks <main>/<h1> (the app renders those) — but html-lang is still its own', async () => {
    // CleanArchitecture src/Web/ClientApp/src/index.html (2026-09-05): the
    // Angular shell produced landmark-main + heading findings for a body
    // that is `<app-root>Loading...</app-root>`.
    w('src/index.html', '<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body><app-root>Loading...</app-root></body></html>');
    const f = await run();
    const names = f.map((c) => c.name);
    assert.ok(!names.some((n) => /a11y:(landmark-main|heading|h1)[^:]*:src\/index\.html/.test(n)), JSON.stringify(names));
    assert.ok(names.includes('a11y:html-lang:src/index.html'), 'POSITIVE: a shell without lang still fires — the <head> and <html> are the shell\'s: ' + JSON.stringify(names));
  });

  it('a UI-kit primitive input (components/ui/input.tsx) and a commented-out <input> are not "unlabelled"', async () => {
    w('components/ui/input.tsx', 'export const Input = (props) => <input className="x" {...props} />;');
    w('pages/form.html', '<html><head></head><body><main><!-- <input type="text"> --><label for="q">Q</label><input id="q" type="text"></main></body></html>');
    const f = await run();
    assert.ok(!f.some((c) => c.name.startsWith('a11y:input-label:')), JSON.stringify(f.map((c) => c.name)));
  });

  // ── img-alt: a JSX tag split across expression boundaries ───────────────
  //
  // `<img\b([^>]*?)>` stops at the first `>`, which is not always the img's own.
  // The badge page renders a copy-paste HTML snippet whose <img> is broken over
  // three JSX children, so the first `>` reached belongs to the <span> in the
  // middle and the alt (present, one line further down) was never seen.
  // The module must not report an alt it never got to look at.

  it('NEGATIVE: an <img> split across JSX expressions (alt on a later line) does not fire', async () => {
    w('app/badge/page.tsx', [
      'export default function P() {',
      '  return (',
      '    <code>',
      '      {`<a href="https://gatetest.io/playground"><img src="https://gatetest.io/api/badge?repo=`}',
      '      <span className="text-emerald-400">owner/repo</span>',
      '      {`" alt="GateTest"></a>`}',
      '    </code>',
      '  );',
      '}',
    ].join('\n'));
    const f = await run();
    assert.ok(!f.some((c) => c.name.startsWith('a11y:img-alt:')), JSON.stringify(f.map((c) => c.name)));
  });

  it('POSITIVE: a genuinely alt-less <img> still fires — in HTML and in JSX', async () => {
    w('bare.html', '<html lang="en"><head><title>t</title></head><body><main><img src="hero.png"></main></body></html>');
    w('app/card.tsx', 'export const C = () => <div><img src="/logo.png" width={40} /></div>;');
    const f = await run();
    const names = f.map((c) => c.name);
    assert.ok(names.includes('a11y:img-alt:bare.html'), JSON.stringify(names));
    assert.ok(names.some((n) => n.startsWith('a11y:img-alt:') && n.includes('card.tsx')), JSON.stringify(names));
  });

  it('POSITIVE: an alt-less <img> immediately followed by another tag still fires', async () => {
    // Guards the fix itself: the skip must trigger only when the `<` lands
    // INSIDE the attributes (an unterminated tag), never when the img closes
    // normally and a sibling element follows.
    w('sibling.html', '<html lang="en"><head><title>t</title></head><body><main><img src="a.png"><span>caption</span></main></body></html>');
    const f = await run();
    assert.ok(f.some((c) => c.name === 'a11y:img-alt:sibling.html'), JSON.stringify(f.map((c) => c.name)));
  });

  // ── input-label: the playground search box ──────────────────────────────

  it('POSITIVE: a placeholder-only <input> is unlabelled; NEGATIVE: an sr-only <label htmlFor> labels it', async () => {
    w('app/before.tsx', [
      'export const F = () => (',
      '  <form>',
      '    <input type="url" value={url} onChange={(e) => setUrl(e.target.value)}',
      '      placeholder="https://github.com/owner/repo" className="flex-1" />',
      '  </form>',
      ');',
    ].join('\n'));
    w('app/after.tsx', [
      'export const F = () => (',
      '  <form>',
      '    <label className="sr-only" htmlFor="playground-repo-url">GitHub repository URL to scan</label>',
      '    <input id="playground-repo-url" type="url" value={url}',
      '      onChange={(e) => setUrl(e.target.value)}',
      '      placeholder="https://github.com/owner/repo" className="flex-1" />',
      '  </form>',
      ');',
    ].join('\n'));
    const f = await run();
    const names = f.map((c) => c.name);
    assert.ok(names.some((n) => n.startsWith('a11y:input-label:') && n.includes('before.tsx')), JSON.stringify(names));
    assert.ok(!names.some((n) => n.startsWith('a11y:input-label:') && n.includes('after.tsx')), JSON.stringify(names));
  });

  it('a 4.5–7:1 contrast (passes AA, fails AAA) is a warning; below 4.5:1 stays an error', async () => {
    w('styles/a.css', '.aa { color: #767676; background-color: #ffffff; }\n.bad { color: #aaaaaa; background-color: #ffffff; }');
    const f = await run();
    const contrast = f.filter((c) => c.name.startsWith('a11y:contrast-static:'));
    assert.ok(contrast.length >= 2, JSON.stringify(f.map((c) => c.name)));
    const aa = contrast.find((c) => c.selector === '.aa');
    const bad = contrast.find((c) => c.selector === '.bad');
    assert.strictEqual(aa && aa.severity, 'warning');
    assert.ok(bad && bad.severity !== 'warning');
  });
});

// ── what is NOT a page, and what a focus rule actually says (trpc, prisma — 2026-09-05) ──
describe('AccessibilityModule — image renderers and focus rules', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-a11y-og-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const w = (rel, c) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), c); };
  const run = async () => {
    const r = makeResult();
    await new AccessibilityModule().run(r, { projectRoot: tmp, getModuleConfig() { return {}; }, get() { return null; } });
    return r.checks.filter((c) => !c.passed);
  };

  it('NEGATIVE: an <img> inside `new ImageResponse(…)` is rasterised to a PNG, not read (trpc www/og-image/pages/api/_ref/vercel.tsx:34)', async () => {
    w('www/og-image/pages/api/_ref/vercel.tsx', [
      "import { ImageResponse } from '@vercel/og';",
      'export default function handler() {',
      '  return new ImageResponse(',
      '    <div tw="flex">',
      '      <img',
      '        src={`${process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "http://localhost:3000"}/pattern.svg`}',
      '        tw="absolute"',
      '      />',
      '    </div>,',
      '  );',
      '}',
    ].join('\n'));
    const f = await run();
    assert.ok(!f.some((c) => c.name.startsWith('a11y:')), JSON.stringify(f.map((c) => c.name)));
    assert.strictEqual(AccessibilityModule.isImageRenderer('return new ImageResponse(<div/>)'), true);
    assert.strictEqual(AccessibilityModule.isImageRenderer('export default () => <img src="x" />'), false);
  });

  it('POSITIVE: the OG-image PLAYGROUND page beside it is a page and its alt-less <img> still fires (trpc www/og-image/pages/index.tsx:33)', async () => {
    w('www/og-image/pages/index.tsx', [
      'export default function Index() {',
      '  return (',
      '    <main>',
      '      <h1>Playground for OG Image Generation</h1>',
      '      <img src={`/api/landing?random=${nonce}`} />',
      '    </main>',
      '  );',
      '}',
    ].join('\n'));
    const f = await run();
    assert.ok(f.some((c) => c.name === 'a11y:img-alt:www/og-image/pages/index.tsx'), JSON.stringify(f.map((c) => c.name)));
  });

  it('NEGATIVE: `outline: none` on a rule with no :focus (trpc www/src/css/custom.css:125-131) is not a removed focus outline', async () => {
    w('www/src/css/custom.css', [
      "[aria-describedby='footnote-label'] {",
      '  counter-increment: footnotes; /* 1 */',
      '  text-decoration: none; /* 2 */',
      '  color: inherit; /* 2 */',
      '  cursor: default; /* 2 */',
      '  outline: none; /* 2 */',
      '}',
      "[aria-describedby='footnote-label']:focus::after {",
      '  outline: thin dotted;',
      '  outline-offset: 2px;',
      '}',
    ].join('\n'));
    const f = await run();
    assert.ok(!f.some((c) => c.name.startsWith('a11y:focus-outline:')), JSON.stringify(f.map((c) => c.name)));
  });

  it('NEGATIVE: a :focus rule that swaps the outline for a border + box-shadow (prisma examples/prisma-8-postgis-demo/app/globals.css:359-363) provides its alternative', async () => {
    w('app/globals.css', [
      'input[type="number"]:focus {',
      '  outline: none;',
      '  border-color: var(--color-stroke-orm);',
      '  box-shadow: 0 0 0 3px var(--color-background-orm-strong);',
      '}',
    ].join('\n'));
    const f = await run();
    assert.ok(!f.some((c) => c.name.startsWith('a11y:focus-outline:')), JSON.stringify(f.map((c) => c.name)));
  });

  it('POSITIVE: a :focus rule that only removes the outline still fires — `none` and `0`', async () => {
    w('app/a.css', 'button:focus {\n  outline: none;\n}\n');
    w('app/b.css', 'a:focus { outline: 0; color: red; }\n');
    const f = await run();
    const names = f.filter((c) => c.name.startsWith('a11y:focus-outline:')).map((c) => c.name).sort();
    assert.deepStrictEqual(names, ['a11y:focus-outline:app/a.css', 'a11y:focus-outline:app/b.css']);
  });

  it('NEGATIVE: a :focus-visible anywhere in the file is the modern teardown and exempts it', async () => {
    w('app/c.css', 'button:focus { outline: none; }\nbutton:focus-visible { outline: 2px solid; }\n');
    const f = await run();
    assert.ok(!f.some((c) => c.name.startsWith('a11y:focus-outline:')), JSON.stringify(f.map((c) => c.name)));
  });
});

describe('AccessibilityModule — html-lang masking (issue #707)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-a11y-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const w = (rel, c) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
  const run = async () => { const r = makeResult(); await new AccessibilityModule().run(r, { projectRoot: tmp, getModuleConfig() { return {}; }, get() { return null; } }); return r.checks.filter((c) => !c.passed); };

  it('NEGATIVE: a literal "<html" / "<head" inside a JSDoc comment and a template-literal string does not fire (issue #707: ThemeToggle.tsx)', async () => {
    w('components/ThemeToggle.tsx', [
      '/**',
      ' * Stamps `data-theme` on <html> and is persisted so it survives a reload.',
      ' * Rendered as the first thing in <head> via a pre-hydration script.',
      ' */',
      "const THEME_INIT_SCRIPT = `document.documentElement.setAttribute('data-theme', t)`;",
      "const sel = document.querySelector('html');",
      'export function ThemeToggle() { return <div>toggle</div>; }',
    ].join('\n'));
    const f = await run();
    assert.ok(!f.some((c) => c.name.startsWith('a11y:html-lang:')), JSON.stringify(f.map((c) => c.name)));
  });

  it('POSITIVE: a layout with a real <html> and no lang still fires', async () => {
    w('app/layout.tsx', 'export default function RootLayout({ children }) { return (<html><head><title>t</title></head><body>{children}</body></html>); }');
    const f = await run();
    assert.ok(f.some((c) => c.name === 'a11y:html-lang:app/layout.tsx'), JSON.stringify(f.map((c) => c.name)));
  });

  it('NEGATIVE: the same layout with lang="en" on the real <html> does not fire', async () => {
    w('app/layout.tsx', 'export default function RootLayout({ children }) { return (<html lang="en"><head><title>t</title></head><body>{children}</body></html>); }');
    const f = await run();
    assert.ok(!f.some((c) => c.name.startsWith('a11y:html-lang:')), JSON.stringify(f.map((c) => c.name)));
  });
});
