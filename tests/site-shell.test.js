/**
 * Every public page wears the same shell.
 *
 * On 2026-09-10 the site had three different navigation bars and two colour
 * themes because the root layout rendered no header or footer and 45 of 70
 * pages hand-rolled their own, most in a hard-coded dark palette. This test
 * pins the fix: chrome comes from app/layout.tsx once, pages never render a
 * navbar or footer of their own, page files never hard-code a page-level dark
 * background, and any three-digit number sitting next to the word "modules"
 * is the live registry count.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'website', 'app');
const read = (p) => fs.readFileSync(p, 'utf8');

function pages(dir = APP, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'admin' || e.name === 'api') continue;
      pages(p, out);
    } else if (e.name === 'page.tsx') out.push(p);
  }
  return out;
}

const PAGES = pages();
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

describe('site shell', () => {
  it('scans a realistic number of public pages', () => {
    assert.ok(PAGES.length >= 60, `only ${PAGES.length} pages found`);
  });

  it('the root layout renders the header and footer once', () => {
    const layout = read(path.join(APP, 'layout.tsx'));
    assert.match(layout, /<SiteHeader \/>/);
    assert.match(layout, /<SiteFooter \/>/);
  });

  it('no public page imports or renders its own Navbar / Footer', () => {
    const bad = [];
    for (const p of PAGES) {
      const src = read(p);
      if (/import\s+Navbar\s+from|<Navbar\b|import\s+Footer\s+from|<Footer\b/.test(src)) bad.push(rel(p));
    }
    assert.deepStrictEqual(bad, [], `\n${bad.length} offender(s):\n${bad.join('\n')}`);
  });

  it('no public page hand-rolls a <nav> or <header> (the shell owns navigation)', () => {
    const bad = [];
    for (const p of PAGES) {
      const src = read(p);
      // In-page tables of contents are allowed when labelled as such.
      const navs = src.match(/<nav\b[^>]*>/g) || [];
      const offenders = navs.filter((n) => !/aria-label="(Contents|Table of contents|On this page|Breadcrumb|Pagination)"/i.test(n));
      if (offenders.length || /<header\b/.test(src)) bad.push(rel(p));
    }
    assert.deepStrictEqual(bad, [], `\n${bad.length} offender(s):\n${bad.join('\n')}`);
  });

  it('no public page hard-codes a dark page background (use tokens; dark panels use bg-panel)', () => {
    const bad = [];
    const re = /\b(bg-\[#(0|1)[0-9a-f]{5}\]|bg-black\b|bg-(zinc|slate|neutral|gray|stone)-9\d\d|min-h-screen[^"']*bg-\[#)/;
    for (const p of PAGES) {
      const src = read(p);
      const m = src.match(re);
      if (m) bad.push(`${rel(p)}: ${m[0]}`);
    }
    assert.deepStrictEqual(bad, [], `\n${bad.length} offender(s):\n${bad.join('\n')}`);
  });

  it('every three-digit number next to the word "modules" is the live registry count', () => {
    const live = String(Object.keys(require(path.join(ROOT, 'src', 'core', 'registry')).BUILT_IN_MODULES).length);
    const bad = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'admin' && e.name !== 'api' && e.name !== 'data') walk(p); continue; }
        if (!/\.(tsx?|jsx?)$/.test(e.name)) continue;
        const lines = read(p).split(/\r?\n/);
        lines.forEach((line, i) => {
          if (!/modules?\b/i.test(line)) return;
          for (const m of line.matchAll(/["'`>](\d{3})["'`<]/g)) {
            // Dated measurements (the Hall of Scans, the changelog) record the
            // count that was true when the scan ran — never rewritten.
            if (m[1] !== live && !/scans\/page\.tsx|changelog/.test(rel(p))) bad.push(`${rel(p)}:${i + 1}: ${m[1]}`);
          }
        });
      }
    };
    walk(APP);
    assert.deepStrictEqual(bad, [], `\n${bad.length} offender(s):\n${bad.join('\n')}`);
  });
});
