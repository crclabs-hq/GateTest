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

// =============================================================================
// Issue #662 — a Tallrig re-walk found the headline duration still off an
// independent stopwatch by 9-11% on three separate runs even after N3/#655
// moved the server timer to handler entry: TLS/proxy time before the request
// reaches Node, and transfer + render time after the response leaves it, are
// both invisible to any server-side clock. The fix stops calling the server
// number the whole story — it's relabelled "server time" — and adds a real
// browser stopwatch (click to render) that matches the customer's own
// stopwatch by construction, carried through the share payload as `clientMs`
// so a restored link shows the original browser number rather than a
// recomputed one.
// =============================================================================
describe('free-scan result view — server time is honestly labelled, the browser number rides beside it (issue #662)', () => {
  it('the page renders the shared formatter\'s combined headline, and the formatter composes "on the server ... in your browser"', () => {
    assert.ok(
      /resultTiming\.combined/.test(src),
      'the page never reads resultTiming.combined — it cannot show the browser number'
    );
    const gradeSrc = fs.readFileSync(path.join(ROOT, 'website', 'app', 'lib', 'scan-grade.js'), 'utf8');
    assert.ok(
      /on the server, \$\{clientHeadline\} in your browser/.test(gradeSrc),
      'the one shared duration formatter never composes the "on the server ... in your browser" copy'
    );
  });

  it('falls back to the server-time label alone when there is no browser measurement (an old share link)', () => {
    assert.ok(
      /resultTiming\.combined\s*\?\?\s*`\$\{resultTiming\.headline\} \$\{resultTiming\.headlineLabel\}`/.test(src),
      'the page does not fall back from the combined headline to the plain headline+label pair'
    );
  });

  it('never calls the headline "wall clock" any more — issue #662 renamed it "server time" because no server clock sees TLS/proxy or transfer/render time', () => {
    const gradeSrc = fs.readFileSync(path.join(ROOT, 'website', 'app', 'lib', 'scan-grade.js'), 'utf8');
    assert.ok(
      !/headlineLabel:\s*'wall clock'/.test(gradeSrc),
      'the shared formatter still hardcodes the retired "wall clock" label'
    );
    assert.ok(
      /headlineLabel:\s*'server time'/.test(gradeSrc),
      'the shared formatter never labels the headline "server time"'
    );
  });

  it('ScanResult declares an optional clientMs field carried alongside the server fields', () => {
    const idx = src.indexOf('interface ScanResult');
    assert.ok(idx > 0, 'ScanResult interface is gone');
    const body = src.slice(idx, src.indexOf('\n}', idx));
    assert.ok(/clientMs\?:\s*number \| null/.test(body), 'ScanResult has no optional clientMs field');
  });

  it('the browser stopwatch is a real performance.now() measurement, not a copy of the server number', () => {
    assert.ok(/performance\.now\(\)/.test(src), 'the page never calls performance.now()');
    assert.ok(/clientScanStartRef/.test(src), 'no ref tracks when the scan actually started in the browser');
    // The measurement must be taken independently of wallMs/duration — i.e.
    // it is its own performance.now() delta, not `result.duration` renamed.
    const clientMsAssignIdx = src.indexOf('const clientMs = Math.round(performance.now()');
    assert.ok(clientMsAssignIdx > 0, 'clientMs is not computed from a performance.now() delta');
  });

  it('a completed scan stamps clientMs onto the payload before setResult/pushPermalink, so the permalink and the share link both carry it', () => {
    const stampIdx = src.indexOf('completed = { ...completed, clientMs }');
    assert.ok(stampIdx > 0, 'clientMs is never merged onto the completed scan payload');
    const setResultIdx = src.indexOf('setResult(completed)');
    const pushPermalinkIdx = src.indexOf('pushPermalink(completed)');
    assert.ok(stampIdx < setResultIdx, 'clientMs is stamped on after setResult, so the rendered result would lag one update behind');
    assert.ok(stampIdx < pushPermalinkIdx, 'clientMs is stamped on after the permalink is pushed, so a fresh reload would lose it');
  });

  it('a restored share link never fabricates a clientMs for a pre-#662 result', () => {
    // decodeShareData parses whatever JSON was encoded and returns it as-is —
    // no field is synthesized on restore, so an old link (encoded before this
    // fix) comes back with clientMs simply absent, not a guessed value.
    const idx = src.indexOf('function decodeShareData');
    assert.ok(idx > 0, 'decodeShareData is gone');
    const body = src.slice(idx, idx + 500);
    assert.ok(!/clientMs\s*[:=]/.test(body), 'decodeShareData synthesizes a clientMs instead of reading whatever was encoded');
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

  // Root cause (found 2026-09-22, Tallrig re-walk): the restore effect sets
  // `result` and `isSharedView` correctly from `?s=`, but the render gate on
  // the whole terminal+results block was `scanning || lines.length > 0` —
  // neither of which a restored permalink ever sets, since no scan runs and
  // no terminal lines are appended. Only the "Viewing a saved result" banner
  // (outside that gate) rendered; the grade, findings and everything else
  // were unreachable. This pins the gate open for a restored `result` too.
  it('the results panel is reachable for a restored permalink, not gated on scanning/lines alone', () => {
    const gateIdx = src.indexOf('Terminal + Results');
    assert.ok(gateIdx > 0, 'the terminal+results section marker is gone');
    const gate = src.slice(gateIdx, gateIdx + 900);
    assert.match(
      gate,
      /\{\(scanning \|\| lines\.length > 0 \|\| result\) && \(/,
      'the results block still gates on scanning/lines alone — a permalink restore never sets either, so the panel stays unreachable'
    );
  });

  it('the initial-state feature cards do not render underneath a restored result', () => {
    const idx = src.indexOf('Initial state');
    assert.ok(idx > 0, 'the initial-state section marker is gone');
    const body = src.slice(idx, idx + 500);
    assert.match(
      body,
      /\{!scanning && lines\.length === 0 && !result && \(/,
      'the generic feature cards can render alongside a restored result'
    );
  });
});
