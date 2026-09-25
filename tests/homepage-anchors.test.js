/**
 * Every `/#anchor` link on the site must land on an element the home page
 * actually renders.
 *
 * 2026-09-25: the v2 home page promoted in #719 dropped `id="pricing"`. Twenty-
 * five links across checkout/cancel, quickstart, blog, glossary, the module
 * pages and llms.txt pointed at `/#pricing` and scrolled to nothing, and the
 * production readiness probe went red on `surface/` for a day before anyone
 * read it. The footer's `/#features` and two compare pages' `/#modules` had
 * been dead since the same swap. Quality Bar #4: no dead anchors.
 *
 * One definition of "what the home page renders": `website/app/page.tsx` plus
 * every local component it imports, one level deep — the same files Next
 * builds `/` from.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'website', 'app');
const HOME = path.join(APP, 'page.tsx');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^﻿/, '');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Resolve a relative import from `from` to a source file on disk, or null. */
function resolveLocalImport(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`,
    path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The ids the home page renders: its own file plus its local component imports. */
function homePageIds(homeFile) {
  const files = [homeFile];
  const src = read(homeFile);
  for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
    const resolved = resolveLocalImport(homeFile, m[1]);
    if (resolved && !/\.json$/.test(resolved)) files.push(resolved);
  }
  const ids = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/\bid=["']([A-Za-z][\w-]*)["']/g)) ids.add(m[1]);
  }
  return ids;
}

/** Every `/#anchor` href in the app, with the file that carries it. */
function homeAnchorLinks(appDir) {
  const links = [];
  for (const f of walk(appDir)) {
    for (const m of read(f).matchAll(/href=\{?["'`]\/#([A-Za-z][\w-]*)["'`]/g)) {
      links.push({ anchor: m[1], file: path.relative(appDir, f) });
    }
  }
  return links;
}

describe('home page anchors', () => {
  const ids = homePageIds(HOME);
  const links = homeAnchorLinks(APP);

  it('the site links to at least one home-page anchor (the check has something to check)', () => {
    assert.ok(links.length > 0, 'no /#anchor links found under website/app — did the pattern rot?');
  });

  it('the home page still renders the pricing section the rest of the site links to', () => {
    assert.ok(ids.has('pricing'), 'website/app/page.tsx (or a component it imports) has no id="pricing"');
  });

  it('every /#anchor link across the app resolves to an id the home page renders', () => {
    const dead = links.filter((l) => !ids.has(l.anchor));
    assert.deepStrictEqual(
      dead, [],
      `dead home-page anchors (rendered ids: ${[...ids].sort().join(', ')}):\n` +
      dead.map((d) => `  /#${d.anchor}  in ${d.file}`).join('\n'),
    );
  });

  it('control: a link to an anchor the home page does not render is reported as dead', () => {
    const fake = { anchor: 'no-such-section-2026', file: 'control' };
    assert.ok(!ids.has(fake.anchor));
    const dead = [...links, fake].filter((l) => !ids.has(l.anchor));
    assert.ok(dead.some((d) => d.anchor === fake.anchor), 'the checker did not flag a planted dead anchor');
  });
});
