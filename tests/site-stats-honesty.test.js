// =============================================================================
// SITE-STATS HONESTY LOCK
// =============================================================================
// The website displays testing statistics (tests passing, module count,
// self-scan green). These MUST come from a real, regenerated measurement —
// not a hand-typed literal that drifts. This suite pins the contract:
//
//   1. website/app/data/site-stats.json exists and is well-formed.
//   2. The displayed test count is an UNDER-statement of the real count
//      (rounded down — we never claim more tests than we have).
//   3. modules.total matches the live `gatetest --list` output.
//   4. Hero.tsx actually CONSUMES the JSON (imports it + references the
//      fields) instead of hardcoding the numbers.
//
// If a future change re-hardcodes a stat in Hero.tsx, or the JSON goes
// stale relative to `--list`, this test fails — same safety-net pattern as
// marketing-claim-verification.test.js.
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STATS_PATH = path.join(ROOT, 'website', 'app', 'data', 'site-stats.json');
const HERO_PATH = path.join(ROOT, 'website', 'app', 'components', 'Hero.tsx');

describe('site-stats honesty lock', () => {
  it('site-stats.json exists and is well-formed', () => {
    assert.ok(fs.existsSync(STATS_PATH), 'website/app/data/site-stats.json must exist (run scripts/generate-site-stats.js)');
    const stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
    assert.ok(stats.tests && typeof stats.tests.passing === 'number', 'tests.passing must be a number');
    assert.ok(stats.modules && typeof stats.modules.total === 'number', 'modules.total must be a number');
    assert.ok(typeof stats.generatedAt === 'string', 'generatedAt must be present');
  });

  it('displayed test count is an under-statement of the real pass count', () => {
    const stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
    const shown = Number(String(stats.tests.displayPassing).replace(/[+,]/g, ''));
    assert.ok(Number.isFinite(shown), 'displayPassing must parse to a number');
    assert.ok(shown <= stats.tests.passing, `displayed ${shown} must be <= real ${stats.tests.passing}`);
    // Conservative claim should still be substantial (we run thousands of tests).
    assert.ok(stats.tests.passing >= 1000, 'we run thousands of tests — this should be >= 1000');
  });

  it('modules.total matches the live `gatetest --list` count', () => {
    const stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
    const out = execFileSync('node', [path.join(ROOT, 'bin', 'gatetest.js'), '--list'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const liveCount = out.split('\n').filter((l) => /^\s{2,}[a-z]/i.test(l)).length;
    assert.strictEqual(stats.modules.total, liveCount, `site-stats says ${stats.modules.total} modules, --list shows ${liveCount} — regenerate with scripts/generate-site-stats.js`);
  });

  it('Hero.tsx consumes site-stats.json instead of hardcoding the numbers', () => {
    const hero = fs.readFileSync(HERO_PATH, 'utf8');
    assert.match(hero, /site-stats\.json/, 'Hero.tsx must import the generated stats JSON');
    assert.match(hero, /displayPassing/, 'Hero.tsx must render tests.displayPassing from the JSON');
    // The old hardcoded literal must not reappear as a displayed BandStat value.
    assert.ok(!/num="5,600\+"/.test(hero), 'Hero.tsx should not hardcode the "5,600+" test count — read it from site-stats.json');
  });
});
