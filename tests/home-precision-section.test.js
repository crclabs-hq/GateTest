'use strict';

// The homepage's precision section (2026-09-05, Craig: "make it a marketing
// machine — showcase"). Guards: it is rendered, it reaches /precision from
// the primary nav, and every number it shows comes from precision.json —
// the repos it names in prose must be in the corpus, so the copy cannot
// outlive the measurement (doctrine §7).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('homepage precision + honesty sections', () => {
  it('the homepage renders HomePrecision directly after the hero, and HomeHonest', () => {
    const page = read('website/app/page.tsx');
    assert.match(page, /<Hero \/>\s*<HomePrecision \/>/);
    assert.match(page, /<HomeHonest \/>/);
  });

  it('Precision is a primary nav link', () => {
    // The nav moved out of Navbar.tsx into the one site shell's link table
    // (site-nav.ts, 2026-09-11); this test kept reading the old file and CI
    // on main went red for two days without anyone touching precision.
    const nav = read('website/app/components/site-nav.ts');
    assert.match(nav, /label:\s*"Precision",\s*href:\s*"\/precision"/);
  });

  it('every repository named in the section prose is in the corpus, and no count is typed by hand', () => {
    const src = read('website/app/components/HomePrecision.tsx');
    const corpus = JSON.parse(read('website/app/data/precision.json')).repos.map((r) => r.name.toLowerCase());
    for (const name of ['express', 'django']) {
      assert.ok(src.toLowerCase().includes(name), `${name} is named in the copy`);
      assert.ok(corpus.includes(name), `${name} must be in precision.json while the copy names it`);
    }
    // JSX text must not carry a typed count of repositories or findings:
    // "20 repositories", "twenty repos", "0 blocking" in prose all rot.
    const jsxText = src.replace(/\{[^}]*\}/g, '').replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(jsxText, /\b(\d{1,3}|twenty|sixteen|eleven)\s+(real\s+)?(repositor|repos\b|blocking)/i, 'counts come from precision.json, not prose');
  });
});

// Craig, 2026-09-05: "Yes let's do it" — the hero leads with the precision
// claim. The repository count in it must be read from precision.json.
describe('homepage hero — the precision thesis', () => {
  it('leads with the claim and reads the corpus size from precision.json', () => {
    const hero = read('website/app/components/Hero.tsx');
    assert.match(hero, /Fails on the diff, not the backlog\./);
    assert.match(hero, /import precision from "\.\.\/data\/precision\.json"/);
    assert.match(hero, /measured nightly on \{CORPUS_SIZE\} pinned third-party/);
  });
});
