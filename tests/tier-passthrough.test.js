// ============================================================================
// TIER PASSTHROUGH REGRESSION TEST
// ============================================================================
// Every caller of /api/scan/fix MUST include `tier` in its JSON body.
//
// Without this, the route's `input.tier === "scan_fix"` gate at
// website/app/api/scan/fix/route.ts (architecture annotator + pair-review)
// silently degrades $199 customers to the $99 deliverable. This test is
// the tripwire that prevents regression.
//
// DO NOT delete or weaken without Craig's explicit authorization.
// See CLAUDE.md → "FIX-FIRST BUILD PLAN" Phase 2.
// ============================================================================
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Walk `src` and return every fetch("/api/scan/fix", { ... }) body literal as
// a string. Uses a brace-depth walker (NOT a regex) so nested objects in the
// fetch options (`headers: { ... }`) and JSON.stringify({ ... }) don't
// confuse the matcher. Returns the substring between the matching `{ ... }`
// of the second fetch argument — which is exactly the options-object body.
function extractFixCallBodies(src) {
  const bodies = [];
  const seenFetchAt = new Set();
  // Iterate every "/api/scan/fix" occurrence inside a fetch call.
  const marker = '/api/scan/fix';
  let cursor = 0;
  while (true) {
    const at = src.indexOf(marker, cursor);
    if (at === -1) break;
    cursor = at + marker.length;

    // Walk back to the nearest `fetch(` that opened this call.
    const before = src.lastIndexOf('fetch(', at);
    if (before === -1) continue;
    // De-dupe on fetch(-position so comments / log strings that contain
    // "/api/scan/fix" before the actual fetch line don't get double-counted.
    if (seenFetchAt.has(before)) continue;
    // Also skip if the marker is inside a comment (// or /* ... */ before it
    // on the same line) — only count markers that are part of the URL arg.
    // Cheap check: the character immediately preceding the marker (after any
    // amount of quote / whitespace) should be a quote opener of the URL.
    // Walk back from `at` to find a quote — if we hit a newline first
    // without a quote, this is a comment occurrence.
    let k = at - 1;
    while (k > before && src[k] !== '\n' && src[k] !== '"' && src[k] !== "'" && src[k] !== '`') k--;
    if (src[k] !== '"' && src[k] !== "'" && src[k] !== '`') continue;
    seenFetchAt.add(before);
    // Sanity: nothing else opened a paren after `fetch(` and before our marker
    // beyond what would still be inside the same call. The simple lastIndexOf
    // is sufficient for the call shapes used in this codebase.

    // Now find the comma that separates the URL arg from the options arg.
    // Skip past the URL string literal first.
    let i = before + 'fetch('.length;
    // Skip whitespace
    while (i < src.length && /\s/.test(src[i])) i++;
    // Skip the URL string (single, double, or backtick)
    const quote = src[i];
    if (quote !== '"' && quote !== "'" && quote !== '`') continue;
    i++;
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\') i += 2;
      else i++;
    }
    i++; // past closing quote
    // Skip to comma
    while (i < src.length && src[i] !== ',') i++;
    if (src[i] !== ',') continue;
    i++;
    // Skip whitespace
    while (i < src.length && /\s/.test(src[i])) i++;
    // Expect `{`
    if (src[i] !== '{') continue;
    // Brace-depth walk to find the matching close.
    const open = i;
    let depth = 0;
    let inStr = null; // quote char if inside string, else null
    for (; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          bodies.push(src.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return bodies;
}

const callers = [
  {
    label: 'customer scan/status page — runFix()',
    file: 'website/app/scan/status/page.tsx',
    expectedCount: 1,
  },
  {
    // AdminPanel.tsx was split (2026-07-07); the batch fix engine moved here.
    label: 'admin repo-scan tab — useAutoFix.fixIssues + retryFailedFiles',
    file: 'website/app/admin/tabs/useAutoFix.ts',
    expectedCount: 2,
  },
  {
    label: 'admin watchdog — WatchdogPanel.scanAndFix',
    file: 'website/app/admin/tabs/WatchdogPanel.tsx',
    expectedCount: 1,
  },
  {
    label: 'continuous watches tick — auto-fix',
    file: 'website/app/api/watches/tick/route.ts',
    expectedCount: 1,
  },
];

describe('tier passthrough — every /api/scan/fix caller must send tier', () => {
  for (const c of callers) {
    it(`${c.label} (${c.file}) sends tier in every fix body`, () => {
      const full = path.join(ROOT, c.file);
      assert.ok(fs.existsSync(full), `Caller file missing: ${c.file}`);
      const src = fs.readFileSync(full, 'utf8');

      const bodies = extractFixCallBodies(src);
      assert.strictEqual(
        bodies.length,
        c.expectedCount,
        `Expected ${c.expectedCount} /api/scan/fix call(s) in ${c.file}, found ${bodies.length}`,
      );

      for (const body of bodies) {
        assert.ok(
          /\btier\b/.test(body),
          `${c.file}: /api/scan/fix call missing \`tier\` in fetch body. Body: ${body.trim().slice(0, 300)}`,
        );
      }
    });
  }

  it('customer scan/status page passes the URL params.tier (with explicit "full" fallback)', () => {
    // The customer-facing path must never send `undefined` — it must
    // explicitly default to "full" when the URL has no tier param,
    // because the route's gate is a strict equality check.
    const full = path.join(ROOT, 'website/app/scan/status/page.tsx');
    const src = fs.readFileSync(full, 'utf8');
    assert.match(
      src,
      /tier:\s*params\.tier\s*\|\|\s*["']full["']/,
      'customer scan page must default tier to "full" when params.tier is empty',
    );
  });

  it('watches tick auto-fix passes explicit tier (matches the scan call)', () => {
    const full = path.join(ROOT, 'website/app/api/watches/tick/route.ts');
    const src = fs.readFileSync(full, 'utf8');
    // The scan call uses tier: "full"; the fix call must too.
    assert.match(
      src,
      /\/api\/scan\/fix[\s\S]*?tier:\s*["']full["']/,
      'watches tick fix call must pass tier: "full" to match its scan call',
    );
  });

  it('admin fix engine forwards the user-selected `tier` state variable to fix calls', () => {
    // The two admin customer-batch calls (fixIssues + retryFailedFiles in
    // tabs/useAutoFix.ts) must forward whatever tier the operator chose in
    // the UI dropdown, not a hardcoded value — otherwise admin testing of
    // $199 deliverables is impossible. (WatchdogPanel scans every repo at
    // "full" and is covered by the callers table above.)
    const full = path.join(ROOT, 'website/app/admin/tabs/useAutoFix.ts');
    const src = fs.readFileSync(full, 'utf8');
    const bodies = extractFixCallBodies(src);
    assert.strictEqual(bodies.length, 2);
    // Both should use the bare `tier` identifier (the React state).
    let pluralisedCount = 0;
    for (const body of bodies) {
      if (/\btier\b\s*[,}]/.test(body) || /,\s*tier\s*\}/.test(body)) {
        pluralisedCount++;
      }
    }
    assert.ok(
      pluralisedCount >= 2,
      `Expected ≥2 admin fix-engine calls to forward the bare \`tier\` state variable, found ${pluralisedCount}. Bodies: ${JSON.stringify(bodies.map((b) => b.trim().slice(0, 120)))}`,
    );
  });
});

describe('tier passthrough — route still gates scan_fix-only features on input.tier', () => {
  // If this test fails, the route logic was changed and the passthrough
  // mechanism needs re-verifying. Don't relax this — fix the root cause.
  const routePath = path.join(ROOT, 'website/app/api/scan/fix/route.ts');

  it('route reads input.tier', () => {
    const src = fs.readFileSync(routePath, 'utf8');
    assert.match(src, /tier\?:\s*string/, 'route should declare optional tier on input');
  });

  it('architecture annotator gated on tier === "scan_fix"', () => {
    const src = fs.readFileSync(routePath, 'utf8');
    assert.match(
      src,
      /input\.tier\s*===\s*["']scan_fix["'][\s\S]*?annotateArchitecture/,
      'architecture annotator must be gated on input.tier === "scan_fix"',
    );
  });

  it('pair-review gated on tier === "scan_fix"', () => {
    const src = fs.readFileSync(routePath, 'utf8');
    assert.match(
      src,
      /input\.tier\s*===\s*["']scan_fix["'][\s\S]*?runPairReview/,
      'pair-review must be gated on input.tier === "scan_fix"',
    );
  });

  it('route accepts tier in input shape (regression: input destructure includes tier as optional)', () => {
    // When this assertion fails, someone removed the tier field from the
    // input type. That'd silently break the gate in production.
    const src = fs.readFileSync(routePath, 'utf8');
    assert.match(
      src,
      /input\.tier\s*===\s*["']scan_fix["']/,
      'route must read input.tier — this is the gate that decides $99 vs $199 deliverable',
    );
  });
});
