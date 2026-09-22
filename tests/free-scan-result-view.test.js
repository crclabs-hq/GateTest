// =============================================================================
// THE FREE SCAN'S RESULT VIEW — what a first-time visitor is told and offered.
// =============================================================================
// Walked as a first-time customer on 2026-09-22 (Repository tab →
// https://github.com/expressjs/express → "Scan my repo"), the result view:
//   - named no commit, no branch, no scan time and no report id (F2)
//   - printed per-module times with no word for what they measured (F3)
//   - offered "Fix This PR →" on every finding, signed out, on a repository
//     the visitor does not own (F4)
//   - replaced the hero in place, so back or reload threw the result away (F5)
//
// These are source assertions on the rendered page, the same shape the
// public-copy guards use: the page is a client component and the behaviour
// being pinned is which JSX is reachable, not a pure function's return.
// =============================================================================
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'website', 'app', 'playground', 'page.tsx');
const src = fs.readFileSync(PAGE, 'utf8');

describe('free-scan result view — reproducibility header (F2)', () => {
  it('renders the server-issued result header', () => {
    assert.ok(src.includes('result.resultHeader'), 'the page never renders resultHeader');
  });

  it('says the fields are missing rather than hiding the header', () => {
    assert.ok(/commit not resolved/.test(src), 'no not-checked fallback for the commit');
    assert.ok(/scan time not recorded/.test(src), 'no not-checked fallback for the scan time');
    assert.ok(/report id not issued/.test(src), 'no not-checked fallback for the report id');
  });
});

describe('free-scan result view — plausible numbers (F3)', () => {
  it('renders the server-computed scope label', () => {
    assert.ok(src.includes('result.scopeLabel'), 'the page never renders scopeLabel');
    assert.ok(src.includes('scan scope not recorded'), 'no fallback when the scope is unknown');
  });

  it('labels every duration it prints as engine time', () => {
    const durationLines = src
      .split('\n')
      .filter((l) => /duration \/ 1000|duration\/1000/.test(l));
    assert.ok(durationLines.length > 0, 'expected the page to print at least one duration');
    for (const line of durationLines) {
      assert.ok(
        /engine time/.test(line),
        `an unlabelled duration reads as a whole-repository scan: ${line.trim()}`
      );
    }
  });
});

describe('free-scan result view — the fix CTA is gated (F4)', () => {
  it('"Fix This PR" is only reachable when the viewer can push to the repo', () => {
    const idx = src.indexOf('Fix This PR');
    assert.ok(idx > 0, 'the fix CTA is gone entirely — expected it gated, not removed');
    // The guard sits in the ~600 characters before the label (the JSX
    // condition and the opening <Link>).
    const guard = src.slice(Math.max(0, idx - 700), idx);
    assert.ok(
      /viewer\?\.canFix/.test(guard),
      'the fix CTA renders without checking viewer.canFix'
    );
  });

  it('a signed-out visitor is offered sign-in, not checkout', () => {
    const idx = src.indexOf('Sign in to fix');
    assert.ok(idx > 0, 'no neutral sign-in link for signed-out visitors');
    const guard = src.slice(Math.max(0, idx - 700), idx);
    assert.ok(/viewer\?\.signedIn/.test(guard), 'the sign-in link is not gated on the session');
    assert.ok(!/\/checkout/.test(guard), 'the signed-out link points at checkout');
  });

  it('viewer state comes from the server, never from the client', () => {
    assert.ok(
      !/localStorage|document\.cookie/.test(src),
      'the page reads sign-in state client-side'
    );
  });
});

describe('free-scan result view — the result has a URL (F5)', () => {
  it('pushes a permalink to the address bar when the result renders', () => {
    assert.ok(/function pushPermalink/.test(src), 'no permalink helper');
    assert.ok(/window\.history\.replaceState/.test(src), 'the permalink is never written to the address bar');
    assert.ok(/setPermalink\(pushPermalink\(/.test(src), 'a completed scan does not get a permalink');
  });

  it('reuses the existing 48h share encoding — no second store', () => {
    assert.ok(/encodeShareData\(result\)/.test(src), 'the permalink does not use the share encoding');
    assert.ok(/SHARE_EXPIRY_MS = 48 \* 60 \* 60 \* 1000/.test(src), 'the 48h window moved');
    assert.strictEqual(
      (src.match(/\/playground\?s=/g) || []).length >= 1,
      true,
      'the permalink does not use the existing ?s= share route'
    );
  });

  it('the share button copies the same URL the address bar shows', () => {
    const idx = src.indexOf('const handleShare');
    assert.ok(idx > 0, 'handleShare is gone');
    const body = src.slice(idx, idx + 500);
    assert.ok(/permalink \|\|/.test(body), 'the share link is derived separately from the permalink');
  });
});
