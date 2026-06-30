'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDigestEmailHtml,
  buildDigestEmailText,
  sendDigestEmail,
  escapeHtml,
} = require('../website/app/lib/digest-mailer');

// ── escapeHtml ────────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  test('escapes & < > "', () => {
    assert.equal(escapeHtml('a & <b> "c"'), 'a &amp; &lt;b&gt; &quot;c&quot;');
  });
  test('returns empty string for non-string input', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(42), '');
  });
  test('leaves safe strings unchanged', () => {
    assert.equal(escapeHtml('hello world'), 'hello world');
  });
});

// ── buildDigestEmailHtml ──────────────────────────────────────────────────────

const FULL_DIGEST = {
  repoLabel:     'acme-corp/backend',
  trend:         'improving',
  netDelta:      -12,
  scansInWindow: 5,
  topModule:     'errorSwallow',
  patterns:      [{ description: 'errorSwallow fires in 90% of scans' }],
  grade:         'B',
  score:         78,
  dashboardUrl:  'https://gatetest.ai/dashboard',
  unsubscribeUrl: 'https://gatetest.ai/account/notifications',
};

describe('buildDigestEmailHtml', () => {
  test('returns an HTML string', () => {
    const html = buildDigestEmailHtml(FULL_DIGEST);
    assert.ok(typeof html === 'string' && html.length > 100);
  });

  test('contains the repo label', () => {
    const html = buildDigestEmailHtml(FULL_DIGEST);
    assert.ok(html.includes('acme-corp/backend'));
  });

  test('contains the trend', () => {
    const html = buildDigestEmailHtml(FULL_DIGEST);
    assert.ok(html.includes('improving'));
  });

  test('shows net delta correctly for negative delta', () => {
    const html = buildDigestEmailHtml(FULL_DIGEST);
    assert.ok(html.includes('-12'));
  });

  test('shows net delta with + prefix for positive delta', () => {
    const html = buildDigestEmailHtml({ ...FULL_DIGEST, netDelta: 7 });
    assert.ok(html.includes('+7'));
  });

  test('includes top module when provided', () => {
    const html = buildDigestEmailHtml(FULL_DIGEST);
    assert.ok(html.includes('errorSwallow'));
  });

  test('includes recurring pattern description', () => {
    const html = buildDigestEmailHtml(FULL_DIGEST);
    assert.ok(html.includes('errorSwallow fires in 90%'));
  });

  test('shows grade and score', () => {
    const html = buildDigestEmailHtml(FULL_DIGEST);
    assert.ok(html.includes('>B<'));
    assert.ok(html.includes('78/100'));
  });

  test('includes dashboard link', () => {
    const html = buildDigestEmailHtml(FULL_DIGEST);
    assert.ok(html.includes('https://gatetest.ai/dashboard'));
  });

  test('includes unsubscribe link', () => {
    const html = buildDigestEmailHtml(FULL_DIGEST);
    assert.ok(html.includes('Unsubscribe'));
    assert.ok(html.includes('account/notifications'));
  });

  test('omits grade section when grade not provided', () => {
    const html = buildDigestEmailHtml({ ...FULL_DIGEST, grade: undefined, score: undefined });
    assert.ok(!html.includes('Health grade'));
  });

  test('omits top module section when not provided', () => {
    const html = buildDigestEmailHtml({ ...FULL_DIGEST, topModule: undefined });
    assert.ok(!html.includes('Top recurring module'));
  });

  test('omits patterns section when patterns is empty', () => {
    const html = buildDigestEmailHtml({ ...FULL_DIGEST, patterns: [] });
    assert.ok(!html.includes('Recurring patterns'));
  });

  test('escapes repo label to prevent XSS', () => {
    const html = buildDigestEmailHtml({ ...FULL_DIGEST, repoLabel: '<script>alert(1)</script>' });
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('works with minimal digest (no optional fields)', () => {
    const html = buildDigestEmailHtml({ repoLabel: 'my-repo', trend: 'stable', netDelta: 0, scansInWindow: 1 });
    assert.ok(html.includes('my-repo'));
    assert.ok(html.includes('stable'));
  });

  test('uses green trendColor for improving trend', () => {
    const html = buildDigestEmailHtml({ ...FULL_DIGEST, trend: 'improving' });
    assert.ok(html.includes('#22c55e'));
  });

  test('uses red trendColor for declining trend', () => {
    const html = buildDigestEmailHtml({ ...FULL_DIGEST, trend: 'declining' });
    assert.ok(html.includes('#ef4444'));
  });

  test('caps patterns at 3', () => {
    const manyPatterns = Array.from({ length: 10 }, (_, i) => ({ description: `pattern-${i}` }));
    const html = buildDigestEmailHtml({ ...FULL_DIGEST, patterns: manyPatterns });
    // Should have pattern-0, pattern-1, pattern-2 but NOT pattern-3
    assert.ok(html.includes('pattern-0'));
    assert.ok(html.includes('pattern-2'));
    assert.ok(!html.includes('pattern-3'));
  });
});

// ── buildDigestEmailText ──────────────────────────────────────────────────────

describe('buildDigestEmailText', () => {
  test('returns a plain string', () => {
    const text = buildDigestEmailText(FULL_DIGEST);
    assert.ok(typeof text === 'string');
  });

  test('contains no HTML tags', () => {
    const text = buildDigestEmailText(FULL_DIGEST);
    assert.ok(!text.includes('<'));
    assert.ok(!text.includes('>'));
  });

  test('contains repo label', () => {
    const text = buildDigestEmailText(FULL_DIGEST);
    assert.ok(text.includes('acme-corp/backend'));
  });

  test('contains trend', () => {
    const text = buildDigestEmailText(FULL_DIGEST);
    assert.ok(text.includes('improving'));
  });

  test('shows net delta with sign', () => {
    const text = buildDigestEmailText(FULL_DIGEST);
    assert.ok(text.includes('-12'));
  });

  test('includes dashboard URL as plain text', () => {
    const text = buildDigestEmailText(FULL_DIGEST);
    assert.ok(text.includes('https://gatetest.ai/dashboard'));
  });

  test('includes top module', () => {
    const text = buildDigestEmailText(FULL_DIGEST);
    assert.ok(text.includes('errorSwallow'));
  });
});

// ── sendDigestEmail ───────────────────────────────────────────────────────────

describe('sendDigestEmail', () => {
  let origKey;
  beforeEach(() => { origKey = process.env.RESEND_API_KEY; });
  afterEach(() => {
    if (origKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = origKey;
  });

  test('returns error when RESEND_API_KEY not set', async () => {
    delete process.env.RESEND_API_KEY;
    const result = await sendDigestEmail({ to: 'user@example.com', digest: FULL_DIGEST });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'RESEND_API_KEY not set');
  });

  test('returns error when to is missing', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    const result = await sendDigestEmail({ digest: FULL_DIGEST });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('to'));
  });

  test('returns error when digest is missing', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    const result = await sendDigestEmail({ to: 'user@example.com' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('digest'));
  });

  test('returns error when opts is null', async () => {
    delete process.env.RESEND_API_KEY;
    const result = await sendDigestEmail(null);
    assert.equal(result.ok, false);
  });
});
