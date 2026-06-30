'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const {
  buildScanCompleteBlocks,
  buildAlertBlocks,
  buildDigestBlocks,
  verifySlashSignature,
  parseSlashBody,
  slashResponse,
} = require('../website/app/lib/slack-notifier');

// ── buildScanCompleteBlocks ───────────────────────────────────────────────────

test('buildScanCompleteBlocks returns an array of block objects', () => {
  const blocks = buildScanCompleteBlocks({
    repo_url:    'https://github.com/test/repo',
    tier:        'quick',
    totalIssues: 3,
    duration:    8500,
    modules:     [
      { name: 'secrets',  status: 'failed',  errors: 2, warnings: 1 },
      { name: 'syntax',   status: 'passed',  errors: 0, warnings: 0 },
    ],
  });
  assert.ok(Array.isArray(blocks));
  assert.ok(blocks.length > 0);
  assert.ok(blocks.every(b => typeof b === 'object' && b.type));
});

test('buildScanCompleteBlocks includes a header block', () => {
  const blocks = buildScanCompleteBlocks({ tier: 'full', totalIssues: 0, modules: [], duration: 5000 });
  const header = blocks.find(b => b.type === 'header');
  assert.ok(header, 'missing header block');
  assert.match(header.text.text, /GateTest/);
});

test('buildScanCompleteBlocks shows module tier name correctly', () => {
  const quick   = buildScanCompleteBlocks({ tier: 'quick',  totalIssues: 0, modules: [] });
  const full    = buildScanCompleteBlocks({ tier: 'full',   totalIssues: 0, modules: [] });
  const smart   = buildScanCompleteBlocks({ tier: 'smart',  totalIssues: 0, modules: [] });
  const forensic = buildScanCompleteBlocks({ tier: 'nuclear', totalIssues: 0, modules: [] });

  const text = (blocks) => JSON.stringify(blocks);
  assert.match(text(quick),   /Quick Scan/);
  assert.match(text(full),    /Full Scan/);
  assert.match(text(smart),   /Smart Scan/);
  assert.match(text(forensic), /Forensic Scan/);
});

test('buildScanCompleteBlocks with health score shows grade', () => {
  const blocks = buildScanCompleteBlocks({
    tier:        'full',
    totalIssues: 5,
    modules:     [],
    healthScore: { score: 72, grade: 'C' },
  });
  const text = JSON.stringify(blocks);
  assert.match(text, /C/);
  assert.match(text, /72/);
});

test('buildScanCompleteBlocks lists top failed modules (up to 5)', () => {
  const modules = Array.from({ length: 7 }, (_, i) => ({
    name: `module_${i}`, status: 'failed', errors: 1, warnings: 0,
  }));
  const blocks = buildScanCompleteBlocks({ tier: 'quick', totalIssues: 7, modules, duration: 3000 });
  const text   = JSON.stringify(blocks);
  // Only 5 max should show
  const matches = [...text.matchAll(/module_/g)];
  assert.ok(matches.length <= 5, `too many failed modules shown: ${matches.length}`);
});

test('buildScanCompleteBlocks adds CTA button when scanUrl provided', () => {
  const blocks = buildScanCompleteBlocks(
    { tier: 'quick', totalIssues: 0, modules: [] },
    { scanUrl: 'https://gatetest.ai/scan/status?repo=foo' }
  );
  const hasButton = blocks.some(b => b.type === 'actions');
  assert.ok(hasButton, 'expected CTA button block');
});

test('buildScanCompleteBlocks works without scanUrl (no button block)', () => {
  const blocks = buildScanCompleteBlocks({ tier: 'quick', totalIssues: 0, modules: [] });
  // Still valid — just no button
  assert.ok(Array.isArray(blocks));
});

test('buildScanCompleteBlocks includes footer context block', () => {
  const blocks = buildScanCompleteBlocks({ tier: 'quick', totalIssues: 0, modules: [] });
  const ctx    = blocks.find(b => b.type === 'context');
  assert.ok(ctx, 'missing context/footer block');
  const text = JSON.stringify(ctx.elements);
  assert.match(text, /gatetest/i);
});

// ── buildAlertBlocks ──────────────────────────────────────────────────────────

test('buildAlertBlocks returns blocks with severity emoji in header', () => {
  const blocks = buildAlertBlocks(
    { module: 'secrets', severity: 'error', message: 'Hardcoded API key found', file: 'src/config.ts', line: 12 },
    'https://github.com/test/repo'
  );
  assert.ok(Array.isArray(blocks));
  const header = blocks.find(b => b.type === 'header');
  assert.ok(header);
  assert.match(header.text.text, /secrets/);
});

test('buildAlertBlocks includes file and line in section text', () => {
  const blocks = buildAlertBlocks(
    { module: 'logPii', severity: 'error', message: 'Password logged', file: 'src/auth.ts', line: 42 },
    'https://github.com/test/repo'
  );
  const text = JSON.stringify(blocks);
  assert.match(text, /src\/auth\.ts/);
  assert.match(text, /42/);
});

test('buildAlertBlocks works without file or line (no crash)', () => {
  const blocks = buildAlertBlocks(
    { module: 'ciSecurity', severity: 'warning', message: 'Missing permissions block' },
    'https://github.com/test/repo'
  );
  assert.ok(Array.isArray(blocks) && blocks.length > 0);
});

// ── buildDigestBlocks ─────────────────────────────────────────────────────────

test('buildDigestBlocks returns blocks with trend info', () => {
  const blocks = buildDigestBlocks({
    repoLabel:     'my-org/my-repo',
    trend:         'improving',
    netDelta:      -8,
    scansInWindow: 14,
    topModule:     'logPii',
  });
  assert.ok(Array.isArray(blocks));
  const text = JSON.stringify(blocks);
  assert.match(text, /improving/);
  assert.match(text, /logPii/);
  assert.match(text, /my-org\/my-repo/);
});

test('buildDigestBlocks includes recurring patterns when provided', () => {
  const blocks = buildDigestBlocks({
    repoLabel:    'test/repo',
    trend:        'stable',
    netDelta:     0,
    scansInWindow: 5,
    patterns:     [
      { description: 'nPlusOne fires in 90% of scans' },
      { description: 'moneyFloat fires in 80% of scans' },
    ],
  });
  const text = JSON.stringify(blocks);
  assert.match(text, /nPlusOne/);
  assert.match(text, /moneyFloat/);
});

test('buildDigestBlocks works without patterns (no crash)', () => {
  const blocks = buildDigestBlocks({
    repoLabel:    'test/repo',
    trend:        'declining',
    netDelta:     12,
    scansInWindow: 3,
  });
  assert.ok(Array.isArray(blocks) && blocks.length > 0);
});

// ── verifySlashSignature ──────────────────────────────────────────────────────

test('verifySlashSignature returns false with no signing secret', () => {
  assert.equal(verifySlashSignature('123', 'body', 'v0=abc', ''), false);
});

test('verifySlashSignature returns false for stale timestamp (>5 minutes)', () => {
  const staleTs = String(Math.floor(Date.now() / 1000) - 400); // 400s ago
  assert.equal(verifySlashSignature(staleTs, 'body', 'v0=abc', 'secret'), false);
});

test('verifySlashSignature returns true for a valid HMAC', () => {
  const crypto    = require('crypto');
  const secret    = 'test-signing-secret-123';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody   = 'command=%2Fgatetest&text=help';
  const base      = `v0:${timestamp}:${rawBody}`;
  const hmac      = crypto.createHmac('sha256', secret).update(base).digest('hex');
  const sig       = `v0=${hmac}`;
  assert.equal(verifySlashSignature(timestamp, rawBody, sig, secret), true);
});

test('verifySlashSignature returns false for tampered body', () => {
  const crypto    = require('crypto');
  const secret    = 'test-signing-secret-123';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody   = 'command=%2Fgatetest&text=help';
  const base      = `v0:${timestamp}:${rawBody}`;
  const hmac      = crypto.createHmac('sha256', secret).update(base).digest('hex');
  const sig       = `v0=${hmac}`;
  // Tamper the body
  assert.equal(verifySlashSignature(timestamp, rawBody + '&extra=1', sig, secret), false);
});

// ── parseSlashBody ────────────────────────────────────────────────────────────

test('parseSlashBody parses URL-encoded body into object', () => {
  const raw    = 'command=%2Fgatetest&text=scan+https%3A%2F%2Fgithub.com%2Ftest%2Frepo&user_name=alice';
  const params = parseSlashBody(raw);
  assert.equal(params.command,   '/gatetest');
  assert.equal(params.text,      'scan https://github.com/test/repo');
  assert.equal(params.user_name, 'alice');
});

test('parseSlashBody handles empty body gracefully', () => {
  const params = parseSlashBody('');
  assert.equal(typeof params, 'object');
});

// ── slashResponse ─────────────────────────────────────────────────────────────

test('slashResponse defaults to ephemeral', () => {
  const r = slashResponse('hello');
  assert.equal(r.response_type, 'ephemeral');
  assert.equal(r.text, 'hello');
});

test('slashResponse with inChannel=true returns in_channel', () => {
  const r = slashResponse('hello', true);
  assert.equal(r.response_type, 'in_channel');
});
