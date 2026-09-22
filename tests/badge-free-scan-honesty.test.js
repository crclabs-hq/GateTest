// =============================================================================
// Issue #651 (N2 partial, Tallrig re-walk 2 on #647) — the badge's "no scan
// on record" copy
// =============================================================================
// /badge/:owner/:repo answered "not scanned yet" for a repo the free scan at
// /playground had just graded. That happened because playground scans have
// nowhere server-side to persist to: the `?s=` permalink in
// website/app/playground/page.tsx encodes the whole result CLIENT-SIDE
// (base64 JSON — see encodeShareData there) and neither
// website/app/api/playground/scan/route.ts nor its /stream sibling writes a
// row anywhere. There is no free-scan store the badge route could read even
// if it wanted to — this test pins that fact so a future session does not
// "fix" the badge by inventing a read path to a store that doesn't exist.
//
// The chosen fix is the honest copy change: the badge no longer claims the
// repo was "not scanned yet" (false for a repo the customer just watched get
// graded) — it says a free scan doesn't produce a badge and names what does.
//
// Two things are pinned:
//   1. The route source truly has no read path into a free-scan store (the
//      premise for the copy-only fix — if this ever changes, this test's
//      first assertion should be revisited, not silently left green).
//   2. The rendered "no scan on record" badge's own text/tooltip.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BADGE_ROUTE = 'website/app/badge/[owner]/[repo]/route.ts';
const PLAYGROUND_SCAN_ROUTE = 'website/app/api/playground/scan/route.ts';
const PLAYGROUND_STREAM_ROUTE = 'website/app/api/playground/scan/stream/route.ts';

describe('premise: playground/free scans have no server-side store', () => {
  it('neither playground scan route writes to the DB', () => {
    for (const rel of [PLAYGROUND_SCAN_ROUTE, PLAYGROUND_STREAM_ROUTE]) {
      const src = read(rel);
      assert.doesNotMatch(src, /getDb\(/, `${rel} must not persist a free scan (no store for the badge to read)`);
    }
  });

  it('the share/permalink mechanism encodes the result client-side, not server-side', () => {
    const src = read('website/app/playground/page.tsx');
    assert.match(src, /function encodeShareData/, 'expected the client-side share encoder to still exist');
    assert.match(src, /btoa\(encodeURIComponent\(JSON\.stringify\(payload\)\)\)/, 'share data must be encoded into the URL, not posted to a store');
  });
});

describe('/playground page — the badge gap is disclosed next to the share link (issue #651 follow-up)', () => {
  const src = read('website/app/playground/page.tsx');

  it('carries a one-sentence note, next to the share button, that a free scan does not update a badge', () => {
    // Anchored to the same "Share results" button block, not just anywhere
    // on the page — the reviewer asked for it "next to the share link".
    const shareButtonIdx = src.indexOf('Share results (link works for 48h)');
    assert.notStrictEqual(shareButtonIdx, -1, 'share button copy not found — did it move or reword?');
    const nearby = src.slice(shareButtonIdx, shareButtonIdx + 1200);

    assert.match(
      nearby,
      /doesn&apos;t update a badge — an account scan does\./,
      'expected a one-sentence, badge-matching note ("needs account scan") near the share button',
    );
  });

  it('the note links to the same place the badge tooltip points (siteUrl(\'/playground\'))', () => {
    const shareButtonIdx = src.indexOf('Share results (link works for 48h)');
    const nearby = src.slice(shareButtonIdx, shareButtonIdx + 1200);
    assert.match(nearby, /<Link href="\/playground"/, 'the note should link to /playground, matching the badge route\'s siteUrl(\'/playground\') destination');

    const badgeRouteSrc = read('website/app/badge/[owner]/[repo]/route.ts');
    assert.match(badgeRouteSrc, /siteUrl\('\/playground'\)/, 'premise: the badge tooltip must still point at /playground for this to match');
  });

  it('stays vendor-neutral (no AI vendor or model name)', () => {
    const shareButtonIdx = src.indexOf('Share results (link works for 48h)');
    const nearby = src.slice(shareButtonIdx, shareButtonIdx + 1200);
    assert.doesNotMatch(nearby, /claude|anthropic|gpt|openai/i, 'the badge-gap note must not name a vendor or model');
  });
});

describe('/badge/:owner/:repo — honest copy when there is no account scan on record', () => {
  const src = read(BADGE_ROUTE);

  it('no longer claims the repo was "not scanned yet"', () => {
    assert.doesNotMatch(src, /not scanned yet/i, 'that phrasing reads as false for a repo the free scan just graded');
  });

  it('names the free-scan gap and points at an account scan', () => {
    assert.match(src, /free scan[\s\S]*?does not appear on a badge/i);
    assert.match(src, /account scan/i);
    assert.match(src, /siteUrl\('\/playground'\)/);
  });

  it('the no-scan badge helper is used for every "nothing to show" path (missing params, empty result, DB error)', () => {
    const calls = src.match(/needsAccountScanBadge\(/g) || [];
    assert.strictEqual(calls.length, 4, `expected the definition plus 3 call sites, got ${calls.length} occurrences`);
  });
});

const TS_COMPILER_PATH = path.join(ROOT, 'website/node_modules/typescript/lib/typescript.js');

/**
 * The badge helper itself is TypeScript inside a Next route (same situation
 * as tests/score-badge-semantics.test.js). Rather than hand-strip TS syntax
 * (parameter types, `as` casts) with regexes — fragile the moment the
 * signature grows — this transpiles the two small source files with the
 * `typescript` package already vendored under website/node_modules (same
 * technique as tests/gluecron-client-resolve-sha.test.js), then extracts the
 * plain-JS functions by brace-balancing and evaluates them with their one
 * real dependency (renderBadge, which needsAccountScanBadge calls) and
 * siteUrl stubbed — so this proves the actual shipped string, not a
 * reimplementation of it.
 */
function loadNeedsAccountScanBadge() {
  assert.ok(fs.existsSync(TS_COMPILER_PATH), `typescript compiler not found at ${TS_COMPILER_PATH} — recreate the website/node_modules junction first`);
  const ts = require(TS_COMPILER_PATH);
  const toJs = (tsSrc) =>
    ts.transpileModule(tsSrc, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;

  const badgeSvgJs = toJs(read('website/app/lib/badge-svg.ts'));
  const escapeXmlSrc = extractFunction(badgeSvgJs, 'function escapeXml');
  const renderBadgeSrc = extractFunction(badgeSvgJs, 'function renderBadge');

  const routeJs = toJs(read(BADGE_ROUTE));
  const helperSrc = extractFunction(routeJs, 'function needsAccountScanBadge');

  // The transpiled route calls its imports as `(0, badge_svg_1.renderBadge)(...)`
  // / `(0, site_url_1.siteUrl)(...)` (TS's commonjs emit for named imports) —
  // those exact aliases are what needs to be in scope, wrapping the real
  // renderBadge/escapeXml so this proves the actual rendered string.
  const wiring = `
    ${escapeXmlSrc}
    ${renderBadgeSrc}
    const badge_svg_1 = { renderBadge: renderBadge };
    const site_url_1 = { siteUrl: function (p) { return 'https://gatetest.io' + (p || ''); } };
  `;

  // eslint-disable-next-line no-new-func
  return new Function(`${wiring}\n${helperSrc}\nreturn needsAccountScanBadge;`)();
}

/** Extract one top-level function's full text by brace-balancing from its `function` keyword. Expects plain JS (post-TS-transpile) input. */
function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `${marker} not found — was it renamed?`);
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end !== -1, `could not find the end of ${marker}`);
  return src.slice(start, end);
}

describe('needsAccountScanBadge() — rendered output', () => {
  const needsAccountScanBadge = loadNeedsAccountScanBadge();
  const svg = needsAccountScanBadge('someowner', 'somerepo');

  it('renders an SVG badge, not an error', () => {
    assert.match(svg, /^<svg /);
  });

  it('never says the repo was not scanned', () => {
    assert.doesNotMatch(svg, /not scanned yet/i);
  });

  it('names the free-scan gap and the account-scan path, with the playground link', () => {
    assert.match(svg, /free scan/i);
    assert.match(svg, /account scan/i);
    assert.match(svg, /https:\/\/gatetest\.io\/playground/);
  });

  it('mentions the actual owner/repo', () => {
    assert.match(svg, /someowner\/somerepo/);
  });
});
