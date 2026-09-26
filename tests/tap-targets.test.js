'use strict';

/**
 * GT-07 (outside reviewer, unauthenticated crawl of gatetest.io at 390x844,
 * 2026-09-26): mobile tap targets fail WCAG 2.5.8. Nav and footer links
 * measured 19px tall, /testing PR links 14px, the theme toggle 42x24, a
 * median of 48 undersized text targets per page (max 390 on /changelog).
 *
 * The fix lives at the source — the shared chrome (Navbar.tsx, Footer.tsx),
 * the theme toggle (ThemeToggle.tsx), and the two hand-rolled list rows
 * (/testing's CycleRow, /changelog's EntryRow + ModuleChip) — not per page.
 * This test reads those five files as text and asserts every interactive
 * element they render carries an explicit min-height or min-width utility
 * class (min-h-6, min-h-11, min-w-6, min-w-11, or a fixed h-11/w-11 box), so
 * the hit area is verifiable from source rather than implied by padding and
 * line-height arithmetic that can silently regress.
 *
 * Control pair: `isSized()` below is the probe every assertion in this file
 * runs through. Before trusting it against real source, the first describe
 * block proves it actually discriminates — a fixture string carrying the
 * class passes, a fixture string identical to the pre-fix Footer.tsx
 * className (the real offending line, word for word) fails. A probe that
 * reports silence needs its own positive control first (Doctrine #3).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'website', 'app');
const read = (p) => fs.readFileSync(p, 'utf8');

// 24px (min-h-6 / min-w-6) is the WCAG 2.5.8 minimum; 44px (min-h-11 /
// min-w-11, or a fixed h-11/w-11 box like the hamburger button) is the AAA
// target this repo aims for on the primary mobile nav and the theme toggle.
// Deliberately narrow so it does not match unrelated sizing like h-6 icons
// or h-16 header bars.
const SIZED_RE = /\b(min-h-(?:6|11)|min-w-(?:6|11))\b/;
const FIXED_BOX_RE = /\bw-11\b[^"'`]*\bh-11\b|\bh-11\b[^"'`]*\bw-11\b/;

function isSized(classAttr) {
  return SIZED_RE.test(classAttr) || FIXED_BOX_RE.test(classAttr);
}

describe('tap-targets helper — control pair', () => {
  it('positive control: a className carrying min-h-6 is sized', () => {
    assert.equal(isSized('inline-flex items-center min-h-6 text-sm text-muted'), true);
  });

  it('positive control: a fixed w-11 h-11 box is sized', () => {
    assert.equal(isSized('inline-flex items-center justify-center w-11 h-11 rounded-lg'), true);
  });

  it('negative control: the real pre-fix Footer.tsx className is NOT sized', () => {
    // This is the exact className GT-07's 19px footer links carried before
    // this fix (still verified live against the file below in a moment).
    assert.equal(isSized('text-sm text-muted hover:text-foreground transition-colors'), false);
  });

  it('negative control: the real pre-fix /testing PR link className is NOT sized', () => {
    assert.equal(isSized('text-accent hover:underline font-mono text-xs break-words'), false);
  });
});

describe('Navbar.tsx — shared chrome', () => {
  const file = path.join(APP, 'components', 'Navbar.tsx');
  const src = read(file);

  it('LINK (desktop group toggles, top nav links, sign-in) is sized', () => {
    const m = src.match(/const LINK = "([^"]+)";/);
    assert.ok(m, 'LINK constant not found in Navbar.tsx');
    assert.equal(isSized(m[1]), true, `LINK = "${m[1]}"`);
  });

  it('ItemLink (desktop dropdown items + phone drawer group items) is sized to 44px', () => {
    const m = src.match(/const cls = `([^`]+)`;/);
    assert.ok(m, 'ItemLink cls template not found in Navbar.tsx');
    assert.match(m[1], /min-h-11/, `cls = "${m[1]}"`);
  });

  it('desktop Install GitHub App / Scan free buttons are sized', () => {
    assert.match(src, /className="inline-flex items-center min-h-6 px-3\.5 py-2[^"]*"/);
    assert.match(src, /className="btn-cta inline-flex items-center min-h-6 px-4 py-2[^"]*"/);
  });

  it('the phone hamburger button is a fixed 44x44 box', () => {
    assert.match(src, /w-11 h-11 -mr-2/);
  });

  it('phone drawer bottom nav links (Docs, Pricing) are sized to 44px', () => {
    assert.match(src, /flex items-center min-h-11 px-3 py-3 font-medium \$\{pathname/);
  });

  it('phone drawer sign-in link is sized to 44px', () => {
    assert.match(src, /className="flex items-center min-h-11 px-3 py-3 font-medium text-foreground"/);
  });

  it('phone drawer Install / Scan free buttons are sized to 44px', () => {
    const count = (src.match(/flex items-center justify-center min-h-11 text-center px-4 py-3/g) || []).length;
    assert.equal(count, 2, 'expected the drawer Install and Scan-free buttons both sized');
  });
});

describe('ThemeToggle.tsx — theme toggle', () => {
  const file = path.join(APP, 'components', 'ThemeToggle.tsx');
  const src = read(file);

  it('each radio button is 44x44 below md, and shrinks back only at md and up', () => {
    assert.match(
      src,
      /min-h-11 min-w-11 md:min-h-0 md:min-w-0/,
      'ThemeToggle button className missing the responsive 44x44 sizing'
    );
  });
});

describe('Footer.tsx — footer link list', () => {
  const file = path.join(APP, 'components', 'Footer.tsx');
  const src = read(file);

  it('every footer link carries the sized className, and none of the old bare className survives', () => {
    const sizedCount = (src.match(/inline-flex items-center min-h-6 text-sm text-muted hover:text-foreground transition-colors/g) || []).length;
    const bareCount = (src.match(/(?<!inline-flex items-center min-h-6 )text-sm text-muted hover:text-foreground transition-colors/g) || []).length;
    assert.ok(sizedCount >= 30, `expected at least 30 sized footer links, found ${sizedCount}`);
    assert.equal(bareCount, 0, `${bareCount} footer link(s) still missing the sized className`);
  });
});

describe('/testing page.tsx — CycleRow PR links', () => {
  const file = path.join(APP, 'testing', 'page.tsx');
  const src = read(file);

  it('both the bug-injection PR link and the fix PR link are sized', () => {
    const count = (src.match(/inline-flex items-center min-h-6 text-accent hover:underline font-mono text-xs break-words/g) || []).length;
    assert.equal(count, 2, `expected 2 sized PR links in CycleRow, found ${count}`);
  });
});

describe('/changelog page.tsx — EntryRow + ModuleChip list', () => {
  const file = path.join(APP, 'changelog', 'page.tsx');
  const src = read(file);

  it('ModuleChip is sized', () => {
    const m = src.match(/const cls = "([^"]+)";/);
    assert.ok(m, 'ModuleChip cls not found in changelog/page.tsx');
    assert.equal(isSized(m[1]), true, `cls = "${m[1]}"`);
  });

  it('the PR link and the commit sha link in each entry are sized', () => {
    const count = (src.match(/inline-flex items-center min-h-6 hover:text-accent transition-colors/g) || []).length;
    assert.equal(count, 2, `expected 2 sized links in EntryRow (PR + commit), found ${count}`);
  });
});
