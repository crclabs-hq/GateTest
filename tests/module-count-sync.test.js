/**
 * The website must never advertise a module count the engine does not have.
 *
 * Craig's strict rule, 2026-07-30: "all changes must reflect on the website at
 * the same time." This is that rule as a test, because the rule had already been
 * broken once within an hour of being needed — module #121 (`spineHealth`)
 * shipped while 231 claims across 104 files still sold 120, and I had filed that
 * gap as a Craig decision rather than work.
 *
 * A remembered convention decays. A failing test does not.
 *
 * ── What counts as a claim ───────────────────────────────────────────────────
 * Three-digit "N modules" on a SHIPPED customer-facing surface. Every part of
 * that is load-bearing, and the first draft of this test got each one wrong:
 *
 *   - Three digits only. Small numbers are tier counts that legitimately differ
 *     — the Quick tier really is 4 modules.
 *   - "modules", never "checks". A check is a single assertion; the demo
 *     terminal output on the homepage shows "183 checks" and "847/847 checks",
 *     which are not module counts and never were.
 *   - Shipped surfaces only. `docs/` is largely dated internal record —
 *     competitive sweeps, merge audits, launch runbooks — where "102 modules
 *     load" is a true statement about 2026-05. Only the customer-facing docs
 *     (API reference, MCP setup, install guide) are policed.
 *   - Lower bounds and approximations are exempt. `assert.ok(n >= 100)` and
 *     "~100 modules" are deliberately loose so they do not break on every
 *     module addition. Flagging them would train people to delete the guard.
 *
 * The first draft flagged 50 lines, of which ~35 were none of the above. A noisy
 * guard gets deleted, which is worse than no guard.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

/** The single source of truth: what the registry actually exposes. */
function liveModuleCount() {
  const { BUILT_IN_MODULES } = require('../src/core/registry');
  return Object.keys(BUILT_IN_MODULES).length;
}

/**
 * Shipped, customer-facing surfaces. An allowlist rather than "everything minus
 * exclusions", because `docs/` is mostly dated internal record and policing it
 * produces noise about statements that were true when written.
 */
const SURFACES = [
  'website/app/',
  'website/public/',
  'packages/',
  'editors/',
  'integrations/',
  'lib/',
  'server.json',
  'package.json',
  'README.md',
  // Customer-facing documentation, named individually.
  'docs/api/',
  'docs/MCP-SETUP.md',
  'docs/CLAUDE_DISTRIBUTION.md',
  'docs/marketplace/install-guide.md',
];

/**
 * Surfaces that RECORD a past measurement rather than describe the product.
 * Rewriting these to today's count falsifies evidence — the same distinction the
 * .ai -> .io domain sweep drew for docs/HISTORY.md.
 */
const EVIDENCE = [
  'website/app/scans/page.tsx',   // dated scan results: "120-module engine", 2026-07-12
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'coverage', '.gatetest', 'dist', 'build']);
const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.json', '.md', '.txt']);

// Three digits, "modules" only — never "checks", which is a different unit.
// Up to three descriptive words may sit between the number and "modules"
// ("120 AI-powered modules", "See All 120 Modules", "120 scanning modules")
// — the 2026-08-18 audit found 26 stale claims of exactly that shape which
// the tighter form let through. Case-insensitive for headings.
const CLAIM_RE = /\b(\d{3})[\s-](?:[A-Za-z][A-Za-z+-]*[\s-]){0,3}modules?\b/gi;

/** Lower bounds and approximations are deliberately loose, not stale. */
const LOOSE_RE = /(>=|≥|~|at least|no fewer|minimum|was\s+\d)/i;

const norm = (p) => p.split(path.sep).join('/');
const onSurface = (rel) => SURFACES.some((s) => (s.endsWith('/') ? rel.startsWith(s) : rel === s));
const isEvidence = (rel) => EVIDENCE.some((e) => (e.endsWith('/') ? rel.startsWith(e) : rel === e));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** Every three-digit module-count claim in shipped copy, with its location. */
function collectClaims() {
  const claims = [];
  for (const full of walk(REPO)) {
    const rel = norm(path.relative(REPO, full));
    if (!onSurface(rel) || isEvidence(rel)) continue;

    let src;
    try { src = fs.readFileSync(full, 'utf8'); } catch { continue; } // error-ok
    // The prefilter must be at least as loose as CLAIM_RE. It used to be a
    // case-sensitive, no-intervening-word regex, so a file whose only stale
    // claim was "See All 120 Modules" (for/nodejs) was skipped whole-file
    // while this suite reported green (2026-09-02 audit).
    if (!/\d{3}[\s-](?:[A-Za-z][A-Za-z+-]*[\s-]){0,3}modules?/i.test(src)) continue;

    src.split(/\r?\n/).forEach((line, i) => {
      if (LOOSE_RE.test(line)) return;
      for (const m of line.matchAll(CLAIM_RE)) {
        claims.push({ rel, line: i + 1, claimed: Number(m[1]), text: line.trim().slice(0, 120) });
      }
    });
  }
  return claims;
}

describe('module count — the website must match the engine', () => {
  const expected = liveModuleCount();

  it('the registry exposes a plausible module count', () => {
    assert.ok(expected > 100, `expected 100+ modules, registry has ${expected}`);
  });

  it('every three-digit module-count claim equals the live count', () => {
    const wrong = collectClaims().filter((c) => c.claimed !== expected);
    assert.deepStrictEqual(
      wrong.map((c) => `${c.rel}:${c.line} claims ${c.claimed} (live: ${expected}) — ${c.text}`),
      [],
      `Stale module counts. Craig's rule: the website changes in the SAME commit as the engine.\n`
      + `Fix the copy, or add the file to EVIDENCE in this test if it records a dated measurement.`,
    );
  });

  it('the generated site stats agree with the registry', () => {
    // site-stats.json is produced by scripts/generate-site-stats.js from a real
    // `gatetest --list`. If it disagrees, the generator has not been re-run.
    const stats = require('../website/app/data/site-stats.json');
    assert.strictEqual(
      stats.modules.total, expected,
      'site-stats.json is stale — re-run `node scripts/generate-site-stats.js`',
    );
  });

  it('the website module catalogue lists every registry module', () => {
    // THE GAP THIS FILE HAD (found 2026-08-06). Every check above policed
    // literal "N modules" strings. But the website's canonical count is
    // COMPUTED — `TOTAL_MODULES` in module-count.ts calls `totalModuleCount()`
    // over the catalogue in modules-data.ts. spineHealth shipped as module 121
    // on 2026-07-30 and was never added to that catalogue, so the computed
    // count stayed 120 while the hardcoded strings were all updated to 121.
    //
    // Result: the live homepage rendered "All 120 modules in a single gate"
    // and "121 modules in the gate" on the SAME PAGE, and every literal-string
    // check passed. A number the site derives is exactly as capable of going
    // stale as one it hardcodes.
    const { BUILT_IN_MODULES } = require('../src/core/registry');
    const catalogue = fs.readFileSync(
      path.join(REPO, 'website/app/components/howitworks/modules-data.ts'), 'utf8',
    );
    const missing = Object.keys(BUILT_IN_MODULES)
      .filter((name) => !new RegExp(`name:\\s*["']${name}["']`).test(catalogue));

    assert.deepStrictEqual(
      missing, [],
      'Modules in the engine but absent from website/app/components/howitworks/modules-data.ts.\n'
      + 'That catalogue is what TOTAL_MODULES counts, so a missing entry makes the whole site\n'
      + 'advertise a number lower than the engine ships — while every hardcoded string looks correct.',
    );
  });

  it('the computed website total equals the registry total', () => {
    // Belt to the braces above: catches a duplicate or malformed entry that
    // leaves the names present but the count wrong.
    const { BUILT_IN_MODULES } = require('../src/core/registry');
    const catalogue = fs.readFileSync(
      path.join(REPO, 'website/app/components/howitworks/modules-data.ts'), 'utf8',
    );
    const entries = [...catalogue.matchAll(/name:\s*["']([a-zA-Z][a-zA-Z0-9]*)["']/g)].map((m) => m[1]);
    const unique = new Set(entries);
    assert.strictEqual(entries.length, unique.size,
      `duplicate module entries in the catalogue: ${entries.filter((e, i) => entries.indexOf(e) !== i).join(', ')}`);
    assert.strictEqual(
      unique.size, Object.keys(BUILT_IN_MODULES).length,
      'the catalogue TOTAL_MODULES counts disagrees with the registry',
    );
  });

  it('finds claims at all — the guard is not vacuous', () => {
    // Without this, deleting every mention of the count from the site would make
    // the test above pass trivially, which is the unfalsifiable-assertion trap.
    assert.ok(collectClaims().length > 20,
      'expected the site to state the module count in many places; found almost none');
  });
});
