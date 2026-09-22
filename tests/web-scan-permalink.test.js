'use strict';

/**
 * Issue #648 item 3 — permalink + restore for /web (and /wp, which shares
 * <UrlScanFlow>). Reuses the exact `?s=` client-side share encoding #647
 * already shipped for the free-scan playground (see
 * tests/free-scan-result-view.test.js for the twin assertions on that
 * page) rather than inventing a second permalink mechanism.
 *
 * UrlScanFlow.tsx is a client component with no pure exported functions to
 * unit-test directly, so these are source-text contracts — the same shape
 * used by the existing free-scan-result-view.test.js / web-scan-auth.test.js
 * / web-runtime-gate.test.js for the sibling components in this family.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FLOW = path.join(ROOT, 'website', 'app', 'components', 'UrlScanFlow.tsx');
const src = fs.readFileSync(FLOW, 'utf8');

describe('UrlScanFlow — reuses #647\'s ?s= share encoding, not a second mechanism', () => {
  it('defines the same encode/decode/pushPermalink trio as the playground', () => {
    assert.match(src, /function encodeShareData/);
    assert.match(src, /function decodeShareData/);
    assert.match(src, /function pushPermalink/);
  });

  it('the encoding is the identical 48h base64url shape', () => {
    assert.match(src, /SHARE_EXPIRY_MS = 48 \* 60 \* 60 \* 1000/);
    assert.match(src, /sharedAt: Date\.now\(\)/);
    assert.match(src, /replace\(\/\\\+\/g, "-"\)\.replace\(\/\\\/\/g, "_"\)/);
  });

  it('pushes via history.replaceState, never a navigation (no reload, no lost state)', () => {
    assert.match(src, /window\.history\.replaceState/);
  });
});

describe('UrlScanFlow — reload restores the full report, not just a banner (item 3 control pair)', () => {
  it('the ?s= restore effect sets both the result and the results phase before the Stripe auto-run check', () => {
    const sIdx = src.indexOf('sp.get("s")');
    const sidIdx = src.indexOf('sp.get("session_id")');
    assert.ok(sIdx > -1 && sidIdx > -1 && sIdx < sidIdx, 'the ?s= restore must be checked before the Stripe session_id path');
    const block = src.slice(sIdx, sidIdx);
    assert.match(block, /setResult\(restored\)/);
    assert.match(block, /setPhase\("results"\)/);
    // A restored result must return early — it is a completed report to
    // render, not a scan to (re-)run.
    assert.match(block, /return;/);
  });

  it('a scan that completes live also gets a permalink, not just a shared-in one', () => {
    const idx = src.indexOf('setResult(data);');
    assert.ok(idx > -1, 'startScan\'s setResult(data) call not found');
    const after = src.slice(idx, idx + 300);
    assert.match(after, /pushPermalink\(data\)/);
  });

  it('resetting the flow (scan a different URL) clears the permalink from the address bar', () => {
    const idx = src.indexOf('function reset()');
    assert.ok(idx > -1);
    const body = src.slice(idx, idx + 700);
    assert.match(body, /window\.history\.replaceState\(\{\}, "", window\.location\.pathname\)/);
  });
});

describe('UrlScanFlow — the existing result JSX renders the grade, not-checked list, and findings unconditionally', () => {
  // These already existed before item 3 — asserting them here proves the
  // restore path (which reuses the same `result` state and "results" phase
  // as a live scan) draws the full report, not a stripped-down view.
  it('the results phase renders HealthScoreCard with notCheckedModules', () => {
    // Issue #658 items 1-2 reformatted this call onto multiple lines (added
    // notCheckedReasons/scoreChangeNote props) — match the spread + prop on
    // the surrounding JSX block rather than one exact single-line shape.
    const idx = src.indexOf('<HealthScoreCard');
    assert.ok(idx > -1, 'HealthScoreCard JSX not found');
    const block = src.slice(idx, idx + 300);
    assert.match(block, /\{\.\.\.result\.healthScore\}/);
    assert.match(block, /notCheckedModules=\{result\.notCheckedModules\}/);
  });

  it('the results phase renders the findings list, including the first finding', () => {
    assert.match(src, /result\.findings\.map\(\(f, i\) => \(/);
    assert.match(src, /<FindingRow key=\{`\$\{f\.ruleKey\}-\$\{i\}`\} finding=\{f\}/);
  });
});
