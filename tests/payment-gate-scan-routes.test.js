'use strict';

/**
 * Payment-gate regression tripwire for /api/scan/run and /api/scan/fix.
 *
 * Found 2026-07-20: both routes ran real paid work (including AI fix-PR
 * generation on scan/fix) for non-admin callers with NO server-side proof
 * of payment — sessionId was optional, and a lookup failure on scan/run
 * silently fell through to running the scan anyway. Fixed to REQUIRE a
 * sessionId, verify it against a real Stripe payment_intent with
 * status === "succeeded", and fail closed (reject, never proceed) on any
 * verification error.
 *
 * These routes import `next/server`, so they can't be `require()`-d
 * directly outside the Next.js build (confirmed: throws resolving
 * next/server). Source-text assertions are the established pattern this
 * codebase already uses for the same reason — see tests/tier-passthrough.test.js.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const scanRunSrc = read('website/app/api/scan/run/route.ts');
const scanFixSrc = read('website/app/api/scan/fix/route.ts');
const statusPageSrc = read('website/app/scan/status/page.tsx');

describe('scan/run payment gate', () => {
  test('non-admin requests without a sessionId are rejected, not run', () => {
    assert.match(
      scanRunSrc,
      /if\s*\(!isAdmin\)\s*\{\s*if\s*\(!sessionId\)\s*\{/,
      'scan/run must check `if (!isAdmin) { if (!sessionId) { ... reject ... } }` — sessionId must be required for non-admin, not merely optional'
    );
  });

  test('missing sessionId returns 402, not a silent pass-through', () => {
    // The reject branch for missing sessionId must return before scanRepo() ever runs.
    const idx = scanRunSrc.indexOf('if (!sessionId) {');
    assert.ok(idx !== -1, 'could not find the missing-sessionId branch');
    const nearby = scanRunSrc.slice(idx, idx + 300);
    assert.match(nearby, /status:\s*402/, 'missing sessionId should reject with 402, not run the scan');
  });

  test('payment_intent status is checked for "succeeded" before proceeding', () => {
    assert.match(
      scanRunSrc,
      /pi\.status\s*!==\s*["']succeeded["']/,
      'scan/run must verify the payment_intent actually succeeded, not just that one exists'
    );
  });

  test('a Stripe lookup failure rejects the request (fails closed), not falls through to running the scan', () => {
    // The catch block around the payment-verification try must return an
    // error response, not merely log and continue.
    const tryBlockMatch = scanRunSrc.match(
      /if\s*\(!isAdmin\)\s*\{[\s\S]*?\}\s*catch\s*\(err\)\s*\{([\s\S]{0,400}?)\n\s*\}\s*\n\s*\}/
    );
    assert.ok(tryBlockMatch, 'could not find the payment-verification try/catch block');
    assert.match(
      tryBlockMatch[1],
      /return\s+NextResponse\.json/,
      'a Stripe lookup error must return a rejection response, not fall through to scanRepo()'
    );
  });

  test('scanRepo() is only called after the payment-verification block, never before it', () => {
    const gateIdx = scanRunSrc.indexOf('if (!isAdmin) {');
    const scanRepoCallIdx = scanRunSrc.indexOf('result = await scanRepo(');
    assert.ok(gateIdx !== -1, 'payment gate not found');
    assert.ok(scanRepoCallIdx !== -1, 'scanRepo() call not found');
    assert.ok(gateIdx < scanRepoCallIdx, 'payment gate must run before scanRepo()');
  });

  test('admin requests still bypass Stripe entirely (documented, deliberate)', () => {
    assert.match(
      scanRunSrc,
      /Admin (?:bypass|requests)[\s\S]{0,80}Stripe/i,
      'admin bypass should still be documented — admins never touch billing'
    );
  });
});

describe('scan/fix payment gate', () => {
  test('sessionId is declared on the input type', () => {
    assert.match(
      scanFixSrc,
      /sessionId\?:\s*string/,
      'scan/fix input type must declare sessionId — it was completely absent before the 2026-07-20 fix'
    );
  });

  test('non-admin requests are gated through verifyFixPayment before any other work', () => {
    assert.match(
      scanFixSrc,
      /const isAdmin = isAdminRequest\(req\);\s*\n\s*if\s*\(!isAdmin\)\s*\{\s*\n\s*const paymentCheck = await verifyFixPayment\(input\.sessionId\);/,
      'scan/fix must call verifyFixPayment(input.sessionId) for non-admin requests'
    );
  });

  test('a failed payment check returns the rejection response instead of continuing', () => {
    assert.match(
      scanFixSrc,
      /if\s*\(!paymentCheck\.ok\)\s*\{\s*return paymentCheck\.response;\s*\}/,
      'a failed payment check must return immediately, not fall through to the fix loop'
    );
  });

  test('verifyFixPayment requires a sessionId and rejects with 402 when absent', () => {
    const fnMatch = scanFixSrc.match(/async function verifyFixPayment\([\s\S]*?\n\}/);
    assert.ok(fnMatch, 'verifyFixPayment function not found');
    assert.match(fnMatch[0], /if\s*\(!sessionId\)\s*\{/, 'must check for a missing sessionId');
    assert.match(fnMatch[0], /status:\s*402/, 'missing/invalid/unpaid session must reject with 402');
  });

  test('verifyFixPayment checks payment_intent status === "succeeded"', () => {
    const fnMatch = scanFixSrc.match(/async function verifyFixPayment\([\s\S]*?\n\}/);
    assert.ok(fnMatch);
    assert.match(fnMatch[0], /pi\.status\s*!==\s*["']succeeded["']/);
  });

  test('a Stripe lookup error in verifyFixPayment rejects rather than allowing the fix to run', () => {
    const fnMatch = scanFixSrc.match(/async function verifyFixPayment\([\s\S]*?\n\}/);
    assert.ok(fnMatch);
    assert.match(
      fnMatch[0],
      /catch\s*\(err\)\s*\{[\s\S]{0,250}?ok:\s*false/,
      'a lookup error must resolve to { ok: false, ... }, not silently allow the request through'
    );
  });

  test('the paid tier from Stripe overrides the client-supplied tier (prevents claiming a higher tier than paid for)', () => {
    assert.match(
      scanFixSrc,
      /paymentCheck\.paidTier\s*&&\s*paymentCheck\.paidTier\s*!==\s*input\.tier/,
    );
    assert.match(scanFixSrc, /input\.tier\s*=\s*paymentCheck\.paidTier;/);
  });
});

describe('frontend wiring — scan/status/page.tsx sends sessionId to scan/fix', () => {
  test('runFix() includes sessionId in the /api/scan/fix request body', () => {
    // Find the fetch("/api/scan/fix", ...) call and check its body includes sessionId.
    const idx = statusPageSrc.indexOf('fetch("/api/scan/fix"');
    assert.ok(idx !== -1, 'could not find the /api/scan/fix fetch call');
    const nearby = statusPageSrc.slice(idx, idx + 600);
    assert.match(
      nearby,
      /sessionId:\s*params\.id/,
      'runFix() must send sessionId (previously omitted entirely, silently relying on the route not checking payment)'
    );
  });
});
