// =============================================================================
// NO HARD-CODED COLOUR LITERALS OUTSIDE THE V2 TOKEN SYSTEM (issue #686/#690)
// =============================================================================
// The v2 design system (website/app/globals.css `--v2-*` + the old
// `--background`/`--accent`/etc. tokens) exists so every colour on the site
// can flip with the theme (light / dark / system, issue #690). A literal hex
// value or an `rgb()`/`hsl()` function call baked into a page or component
// bypasses that — it renders the same in both themes, which is exactly the
// class of bug this issue's dark-mode work exists to prevent.
//
// #696 shipped the theme system and the shared v2 primitives but explicitly
// left this test for a follow-up ("Not done — the repo-wide 'no hard-coded
// colour literal outside globals.css' test #690 asks for"). This is that
// follow-up, added while doing #686 phase 2.
//
// Scope: everything under website/app EXCEPT the four files/dirs that are
// allowed to define a palette themselves:
//   - globals.css        — the token definitions (the whole point: SOMEWHERE
//                           has to spell out #0f766e once)
//   - preview/preview.css — pre-#696 file kept only as a historical shim
//   - components/v2/      — the v2 primitives read tokens via CSS vars, but
//                           the token *values* still have to live somewhere;
//                           excluded for the same reason as globals.css
//   - admin/admin.css     — issue #691's own token-definition file: the
//                           #690 contract lets the admin shell define its own
//                           `--gt-admin-*` tokens until #686 lifts the shared
//                           v2 tokens into globals.css, at which point this
//                           file collapses into a `var(--*)` reference and
//                           drops out of this exclusion in the same commit.
//                           Same reason as globals.css — a token file has to
//                           spell out its values exactly once, somewhere.
//
// A NEW literal anywhere else fails the suite. Pre-existing ones are pinned
// in SHRINKING_ALLOWLIST by their current count — the count for any listed
// file may only go DOWN over time (as pages migrate onto v2 tokens), never up.
// A file not listed must have zero matches. Most of the current allowlist is
// NOT page/theme code at all (email HTML that has to inline hex because mail
// clients ignore CSS custom properties, SVG badge bytes served to GitHub,
// OG-image PNG generation) — those are noted inline and are not part of
// issue #686's page restyle, but the test still tracks them so they cannot
// silently grow.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'website', 'app');

const EXCLUDE = [
  /^globals\.css$/,
  /^preview\/preview\.css$/,
  /^components\/v2\//,
  /^admin\/admin\.css$/,
];
const SCAN_EXT = /\.(tsx?|jsx?|css)$/;

// #rgb / #rgba / #rrggbb / #rrggbbaa, and the rgb()/rgba()/hsl()/hsla()
// function forms. `(?![0-9a-fA-F])` stops a 6-digit match from swallowing
// part of an 8-digit one, and stops matching inside a longer hex-looking run
// (a git SHA fragment, a hash id) that happens to start with 3-8 hex digits.
// `(?<!&)` on the hex branch excludes HTML numeric character references
// (`&#8212;`, the em dash used as a table's "not applicable" glyph) — those
// are text, not colour.
// `(?![\w-])`, not `(?![0-9a-fA-F])`: an anchor whose first three letters
// happen to be hex digits (`/#features` → `#fea`) is a word, not a colour.
// 2026-09-25: two such footer anchors were pinned in the allowlist as
// "literals" and the test broke the day they were retargeted.
const COLOR_RE = /(?<!&)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])|rgba?\(|hsla?\(/g;
// Non-global twin for .test() call sites — a 'g' RegExp's `lastIndex` is
// stateful across calls, which makes repeated `.test()` on different input
// strings silently skip matches. `String.prototype.match` (used for
// counting) is unaffected by this, but assert.match()/.test() are not.
const COLOR_RE_TEST = new RegExp(COLOR_RE.source);

// Shrinking allowlist: exact count of matches tolerated in that file, from
// the count the day this test was added. Lower it (or delete the entry) the
// moment a file is touched and its literals are moved to tokens — never
// raise it. `tests/no-hardcoded-color-literals.test.js` itself contains the
// pattern as data in this comment/allowlist, not as a live literal, so it is
// not in scope (it's a test file, not under website/app).
const SHRINKING_ALLOWLIST = {
  // --- Not page/theme code: bytes sent to a third party, not rendered by
  //     our own themed layout, so a CSS variable would not even apply. ---
  'lib/digest-mailer.js': 85, // outbound HTML email — mail clients ignore CSS custom properties
  'lib/badge-svg.ts': 30, // README badge SVG bytes — the badge's own fixed palette
  'lib/release-notifier.js': 15, // outbound HTML email
  'lib/ciso-report-generator.js': 11, // generated PDF/HTML report bytes, not a themed page
  'lib/auth-unavailable.ts': 8, // static HTML error page served with no Next runtime (auth misconfigured) — can't read a CSS var it never loads
  'lib/scan-grade.js': 6, // colour-by-grade values returned as JSON/SVG fill data, not JSX
  'how-it-works/opengraph-image.tsx': 15, // OG image PNG generation (Next ImageResponse) — its own fixed canvas, not a themed page
  'opengraph-image.tsx': 8, // same — the site-wide OG image generator
  'api/score/route.ts': 12, // badge/score SVG bytes served to third parties
  'api/badge/route.ts': 11,
  'api/badge/[repo]/route.ts': 11,
  'badge/[owner]/[repo]/route.ts': 4,
  'badge/page.tsx': 8, // the badge-preview grid's own fixed per-grade SVG palette (A green … F red), same category as lib/badge-svg.ts

  // --- Admin shell (website/app/admin/**) — issue #691's scope, not #686's.
  //     Left untouched here on purpose; #691 restyles admin onto the same v2
  //     tokens this branch's theme system defines. ---
  'admin/learning/page.tsx': 8,
  'admin/hn-launch/page.tsx': 2, // deliberate: inline #000/#fff, not a token gap — see the code comment at its <main> tag for why (admin.css's .gt-admin-page background loses the cascade to a plain utility class here; this page's terminal look is meant to stay black regardless of theme anyway)
  'admin/tabs/NuclearScanTab.tsx': 2,
  'admin/tabs/FixResultCard.tsx': 1,
  'admin/tabs/PlatformSiblings.tsx': 1,
  'admin/tabs/RepoScanTab.tsx': 1,
  'admin/tabs/ServerScanTab.tsx': 1,
  'admin/tabs/WatchdogPanel.tsx': 1,

  // --- Public pages/components not in this branch's #686 phase-2 scope yet,
  //     or whose remaining literal is a status-colour dot deliberately kept
  //     off the accent token (globals.css says so for /status; the same
  //     idiom appears on a few scan-progress widgets). Each will drop to 0
  //     (or leave this list) the session that page family is restyled. ---
  'components/howitworks/ArchitectureDiagram.tsx': 16, // hand-rolled SVG diagram on /how-it-works
  'scan/status/page.tsx': 11,
  'playground/page.tsx': 7,
  'components/LiveScanTerminal.tsx': 4,
  'components/HomeSelfScan.tsx': 3,
  'preview/_components/LiveRun.tsx': 2,
  'components/Hero.tsx': 1,
  'components/HeroScanTabs.tsx': 1,
  'for/typescript/page.tsx': 1,
  'layout.tsx': 1,
};

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function scopeFiles() {
  return walk(APP_DIR, [])
    .map((f) => path.relative(APP_DIR, f).replace(/\\/g, '/'))
    .filter((rel) => SCAN_EXT.test(rel))
    .filter((rel) => !EXCLUDE.some((re) => re.test(rel)))
    .sort();
}

// Comments are prose, not rendered style — and this repo's comments
// constantly reference issue/PR numbers ("#686", "#696", "#690"), which are
// indistinguishable from a 3-digit hex colour by pattern alone (every digit
// 0-9 is also a valid hex digit). Strip comment bodies before scanning, the
// same way tests/public-copy-vendor-neutral.test.js does, replacing their
// text with spaces (not deleting the lines) so reported line numbers stay
// accurate.
//
// Applies to .ts/.tsx/.jsx/.css alike: CSS's `/* ... */` block comment is the
// same syntax the block-comment regex below already matches, so a `.css`
// token file's own doc comment (admin/admin.css's issue-number references,
// #691/#690/#686) needs the same treatment as a TS docblock's. Every .css
// file currently reaching this function is in EXCLUDE (admin.css included)
// and never gets here in practice today — this is defence for the day a
// non-excluded CSS file needs scanning, not dead code for its own sake; the
// control test below exercises it directly since exclusion alone can't.
function stripComments(rel, src) {
  if (!/\.(tsx?|jsx?|css)$/.test(rel)) return src;
  return src
    // `﻿?` — a leading UTF-8 BOM (several files under website/app carry
    // one, doctrine says never strip it from the file itself) sits before
    // `^`'s first match on line 1; without tolerating it here, a file whose
    // very first line is `<BOM>/**` never matches this block-comment opener
    // at all, so its whole doc comment — issue numbers included — stays
    // unstripped and gets scanned as code (sample-report.ts, page.tsx).
    .replace(/^﻿?[ \t]*\{?\/\*[\s\S]*?\*\/\}?/gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/([;{}(,])[ \t]*\/\/[^\n]*/g, (_, pre) => pre)
    .replace(/([;{}(,])[ \t]*\/\*[\s\S]*?\*\//g, (_, pre) => pre);
}

function scannable(rel) {
  return stripComments(rel, fs.readFileSync(path.join(APP_DIR, rel), 'utf8'));
}

function countMatches(rel) {
  const matches = scannable(rel).match(COLOR_RE);
  return matches ? matches.length : 0;
}

function firstLines(rel, limit = 5) {
  const out = [];
  scannable(rel).split('\n').forEach((line, i) => {
    if (out.length >= limit) return;
    if (COLOR_RE_TEST.test(line)) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return out;
}

describe('no hard-coded colour literals outside the v2 token system', () => {
  const files = scopeFiles();

  it('the scope is populated (anti-vacuity)', () => {
    assert.ok(files.length > 100, `expected >100 scoped files under website/app, got ${files.length}`);
    assert.ok(files.includes('page.tsx'));
    assert.ok(files.includes('pricing/page.tsx'));
    assert.ok(!files.includes('globals.css'));
    assert.ok(!files.some((f) => f.startsWith('components/v2/')));
  });

  it('every file with a literal is either at zero or pinned in the shrinking allowlist', () => {
    const overages = [];
    for (const rel of files) {
      const actual = countMatches(rel);
      const allowed = SHRINKING_ALLOWLIST[rel] || 0;
      if (actual > allowed) {
        overages.push(`${rel}: ${actual} literal(s), allowlisted for ${allowed}\n    ${firstLines(rel).join('\n    ')}`);
      }
    }
    assert.deepStrictEqual(overages, [],
      `new (or increased) hard-coded colour literal(s) — use a website/app/globals.css --v2-* or legacy token instead:\n  ${overages.join('\n  ')}`);
  });

  it('the allowlist never asks for more than the file actually still has (no stale headroom that could silently regrow)', () => {
    const stale = [];
    for (const [rel, allowed] of Object.entries(SHRINKING_ALLOWLIST)) {
      const abs = path.join(APP_DIR, rel);
      if (!fs.existsSync(abs)) { stale.push(`${rel}: file no longer exists, remove its entry`); continue; }
      const actual = countMatches(rel);
      if (actual > allowed) stale.push(`${rel}: allowlist says ${allowed} but file has ${actual}`); // covered above too
      if (actual < allowed) stale.push(`${rel}: allowlist says ${allowed} but file only has ${actual} — lower the number`);
    }
    assert.deepStrictEqual(stale, [], `allowlist is out of date:\n  ${stale.join('\n  ')}`);
  });

  it('POSITIVE CONTROL: the matcher catches hex, rgb(), rgba(), hsl() and hsla()', () => {
    const cases = [
      'background: #0f766e;',
      'color: #fff',
      'style={{ background: "#ffffffcc" }}',
      'background: rgb(15, 118, 110);',
      'background: rgba(15, 118, 110, 0.5);',
      'color: hsl(174, 78%, 27%);',
      'color: hsla(174, 78%, 27%, 0.5);',
    ];
    for (const c of cases) assert.match(c, COLOR_RE_TEST, `matcher must flag: ${c}`);
  });

  it('NEGATIVE CONTROL: token references, anchors and HTML entities are not flagged', () => {
    const cases = [
      'background: var(--v2-bg-alt);',
      'color: var(--accent);',
      'className="text-[var(--v2-muted)]"',
      '<Link href="/pricing#tiers">',
      '<Link href="/#features">', // three hex-looking letters, then a word — an anchor, not #fea
      '<a href="#faq">', // same shape
      '<section id="pricing-tiers">',
      'const commit = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";', // a full 40-char SHA, not a #-prefixed literal
      '<span className="text-muted">&#8212;</span>', // HTML numeric char reference (em dash), not a colour
    ];
    for (const c of cases) {
      assert.ok(!COLOR_RE_TEST.test(c), `matcher must NOT flag: ${c}`);
    }
  });

  it('NEGATIVE CONTROL: issue/PR numbers in comments are not flagged (every digit is also a hex digit)', () => {
    // "#686", "#696", "#690" etc. are exactly 3 digits — indistinguishable
    // from a hex colour like #059 by pattern alone. This repo's comments
    // reference issue numbers constantly, so the guard strips comments
    // before scanning (see stripComments) rather than trying to out-clever
    // the regex.
    const rel = '__control__.tsx';
    const commentOnly = '// see issue #686 and PR #696, coordinated with #690\n/* also #678 */\n';
    assert.strictEqual(stripComments(rel, commentOnly).match(COLOR_RE), null,
      'a comment-only issue/PR reference must not be flagged');
    const realLiteralNearAComment = '// issue #686\nconst bg = "#059669"; // not a token\n';
    const stripped = stripComments(rel, realLiteralNearAComment);
    assert.strictEqual((stripped.match(COLOR_RE) || []).length, 1,
      'a real literal on a code line must still be flagged even next to a comment mentioning an issue number');
  });

  it('NEGATIVE CONTROL: a leading UTF-8 BOM does not stop the block-comment opener from matching', () => {
    // Several real files under website/app (sample-report.ts, page.tsx)
    // start with a BOM immediately followed by `/**` — `^` still matches at
    // offset 0 there, but the old regex required `/*` right after `^`, so
    // the BOM byte made the opener miss the comment entirely and its issue
    // number ("#678") got scanned as code. Reproduces that exact shape.
    const rel = '__control__.tsx';
    const bomDocComment = '﻿/**\n * issue #678 gap 6\n */\nexport const x = 1;\n';
    assert.strictEqual(stripComments(rel, bomDocComment).match(COLOR_RE), null,
      'a BOM-prefixed doc comment mentioning an issue number must not be flagged');
  });

  it('NEGATIVE CONTROL: a CSS file\'s own block comment is stripped the same way a TS docblock is', () => {
    // A token-definition file (admin/admin.css is the real example — in
    // EXCLUDE, so it never reaches stripComments in practice) has an issue
    // number in its header comment AND real colour literals in its :root
    // block. Both must be handled correctly: the comment's issue number
    // disappears, the real token values do not.
    const rel = '__control__.css';
    const cssWithIssueRefAndTokens =
      '/**\n * Token file — see issue #123 for the contract.\n */\n:root {\n  --accent: #0f766e;\n  --bg: #ffffff;\n}\n';
    const stripped = stripComments(rel, cssWithIssueRefAndTokens);
    assert.ok(!/#123/.test(stripped), 'an issue number in a CSS comment must be stripped');
    assert.strictEqual((stripped.match(COLOR_RE) || []).length, 2,
      'the two real colour literals inside :root must still be counted after the comment is stripped');
  });
});
