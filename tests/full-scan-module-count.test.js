'use strict';

// FULL SCAN MODULE COUNT — Craig 2026-10-01: "fix the full scan 122 modules
// wording". The hosted $99 Full Scan (and Scan + Fix) runs the engine's
// `full` suite — 89 modules today — not all 122 the engine registers:
// live-site and WordPress modules need a deployed site, mutation needs a CI
// runner, and the five live probes are dormant. Selling it as "all 122" was
// false. These tests pin the number to the engine and forbid the old claim.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'website', 'app');
const { DEFAULT_CONFIG } = require(path.join(ROOT, 'src', 'core', 'config.js'));
const siteStats = require(path.join(APP, 'data', 'site-stats.json'));
const FULL = DEFAULT_CONFIG.suites.full.length;
const TOTAL = siteStats.modules.total;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(full);
  }
  return out;
}

describe('the Full Scan count is generated from the engine', () => {
  it('site-stats.json suites.full equals the engine full suite, and is less than the engine total (control)', () => {
    assert.equal(siteStats.suites.full, FULL, 'regenerate with scripts/generate-site-stats.js');
    assert.ok(FULL < TOTAL, `control: the full suite (${FULL}) is a subset of the ${TOTAL}-module engine`);
  });

  it('the website imports FULL_SCAN_MODULES from the one definition', () => {
    const src = fs.readFileSync(path.join(APP, 'lib', 'module-count.ts'), 'utf8');
    assert.match(src, /export const FULL_SCAN_MODULES: number = siteStats\.suites\.full;/);
  });

  it('static copy that types the number (README, Marketplace listing, CLAUDE.md) matches it', () => {
    const files = ['README.md', 'integrations/marketplace/listing.md', 'CLAUDE.md'];
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const typed = [...text.matchAll(/\b(\d{2,3}) of the (?:engine's )?(\d{3})\b|\b(\d{2,3})-module repository suite\b/g)];
      assert.ok(typed.length >= 1, `${f}: control — the Full Scan count is stated`);
      for (const m of typed) {
        const n = Number(m[1] || m[3]);
        assert.equal(n, FULL, `${f}: "${m[0]}" must say ${FULL} (engine full suite)`);
        if (m[2]) assert.equal(Number(m[2]), TOTAL, `${f}: "${m[0]}" total must be ${TOTAL}`);
      }
    }
  });
});

describe('no shipped copy sells the Full Scan as every module', () => {
  // "$99 for all 122 modules", "All 122 modules — …", "Full 122-Module Engine
  // Suite", "Every applicable module of the 122-module engine" (reads as all
  // 122) — and the same with ${TOTAL_MODULES} / {TOTAL_MODULES}.
  const N = String.raw`(?:122|\$?\{TOTAL_MODULES\})`;
  const FORBIDDEN = [
    new RegExp(String.raw`\ball ${N} modules\b`, 'i'),
    new RegExp(String.raw`\bFull ${N}-Module (?:Engine )?(?:Suite|scans?)\b`, 'i'),
    new RegExp(String.raw`\bfull ${N}-module (?:deep )?scans?\b`, 'i'),
    new RegExp(String.raw`\bEvery applicable module of the ${N}-module engine\b`, 'i'),
  ];

  it('control: the patterns catch the old claims', () => {
    for (const old of ['$99 for all ${TOTAL_MODULES} modules', 'All 122 modules — security', '`Full ${TOTAL_MODULES}-Module Engine Suite`',
      'Every applicable module of the 122-module engine', 'Full 122-module deep scan']) {
      assert.ok(FORBIDDEN.some((re) => re.test(old)), `not caught: ${old}`);
    }
    // Describing the engine itself stays true: the MCP server and the CLI do ship all of it.
    assert.ok(!FORBIDDEN.some((re) => re.test('The full ${TOTAL_MODULES}-module GateTest engine inside Cursor')));
  });

  it('website copy, README and the Marketplace listing never say it', () => {
    const files = [...walk(APP), path.join(ROOT, 'README.md'), path.join(ROOT, 'integrations', 'marketplace', 'listing.md')];
    const hits = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments are not copy
        // "See all 122 modules" / "Browse all N modules" link to the catalogue — a true statement about the engine.
        if (/\b(See|Browse) all\b/i.test(line)) return;
        if (FORBIDDEN.some((re) => re.test(line))) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    assert.deepEqual(hits, [], 'the hosted Full Scan runs FULL_SCAN_MODULES, not every module the engine has');
  });
});
