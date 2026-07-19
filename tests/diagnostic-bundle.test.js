'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDiagnosticBundle,
  formatDiagnosticHeader,
  summariseDiagnosticBundle,
} = require('../lib/diagnostic-bundle');

// ─── buildDiagnosticBundle ─────────────────────────────────────────────────

test('buildDiagnosticBundle returns empty bundle when nothing is passed', () => {
  const bundle = buildDiagnosticBundle();
  assert.deepEqual(bundle.sections, []);
  assert.equal(bundle.hasContent, false);
});

test('buildDiagnosticBundle returns empty bundle when only whitespace is given', () => {
  const bundle = buildDiagnosticBundle({ errorMessage: '   ', details: null });
  assert.equal(bundle.hasContent, false);
});

test('buildDiagnosticBundle captures a plain errorMessage with no details', () => {
  const bundle = buildDiagnosticBundle({ errorMessage: 'Uncaught TypeError: x is undefined' });
  assert.equal(bundle.hasContent, true);
  assert.equal(bundle.sections.length, 1);
  assert.equal(bundle.sections[0].title, 'Error');
  assert.match(bundle.sections[0].body, /Uncaught TypeError/);
});

test('buildDiagnosticBundle captures a string details payload (e.g. a stack trace)', () => {
  const stack = 'TypeError: Cannot read properties of undefined\n  at foo (app.js:12:5)\n  at bar (app.js:20:3)';
  const bundle = buildDiagnosticBundle({ errorMessage: 'Uncaught JS error', details: stack });
  assert.equal(bundle.sections.length, 2);
  assert.equal(bundle.sections[1].title, 'Captured Detail (from live detection — stack trace / network / render diff)');
  assert.match(bundle.sections[1].body, /at foo \(app\.js:12:5\)/);
});

test('buildDiagnosticBundle captures an object details payload (e.g. a grouped network failure)', () => {
  const details = { sampleUrl: 'https://cdn.example.com/font.woff2', count: 3, resourceTypes: ['font'] };
  const bundle = buildDiagnosticBundle({ errorMessage: 'cdn.example.com → net::ERR_FAILED', details });
  assert.equal(bundle.sections.length, 2);
  assert.match(bundle.sections[1].body, /cdn\.example\.com\/font\.woff2/);
  assert.match(bundle.sections[1].body, /"count": 3/);
});

test('buildDiagnosticBundle captures an array details payload (e.g. per-engine render diffs)', () => {
  const details = [
    { engine: 'firefox', error: 'timeout' },
    { engine: 'webkit', error: 'navigation failed' },
  ];
  const bundle = buildDiagnosticBundle({ details });
  assert.equal(bundle.sections.length, 1); // no errorMessage passed
  assert.match(bundle.sections[0].body, /firefox/);
  assert.match(bundle.sections[0].body, /webkit/);
});

test('buildDiagnosticBundle ignores an empty object/array details payload', () => {
  assert.equal(buildDiagnosticBundle({ errorMessage: 'x', details: {} }).sections.length, 1);
  assert.equal(buildDiagnosticBundle({ errorMessage: 'x', details: [] }).sections.length, 1);
});

test('buildDiagnosticBundle truncates an oversized details payload', () => {
  const hugeStack = 'x'.repeat(10_000);
  const bundle = buildDiagnosticBundle({ details: hugeStack });
  const bytes = Buffer.byteLength(bundle.sections[0].body, 'utf-8');
  assert.ok(bytes < 2200, `expected truncated body under ~2200 bytes, got ${bytes}`);
  assert.match(bundle.sections[0].body, /truncated/);
});

// ─── formatDiagnosticHeader ────────────────────────────────────────────────

test('formatDiagnosticHeader returns "" for an empty bundle', () => {
  assert.equal(formatDiagnosticHeader(buildDiagnosticBundle()), '');
  assert.equal(formatDiagnosticHeader(null), '');
  assert.equal(formatDiagnosticHeader(undefined), '');
});

test('formatDiagnosticHeader renders a markdown block with both sections', () => {
  const bundle = buildDiagnosticBundle({ errorMessage: 'Boom', details: 'stack trace here' });
  const header = formatDiagnosticHeader(bundle);
  assert.match(header, /## Diagnostic Bundle \(captured at detection time\)/);
  assert.match(header, /### Error\nBoom/);
  assert.match(header, /stack trace here/);
  assert.match(header, /---/);
});

// ─── summariseDiagnosticBundle ─────────────────────────────────────────────

test('summariseDiagnosticBundle reports no-content honestly', () => {
  assert.equal(summariseDiagnosticBundle(buildDiagnosticBundle()), 'diagnostic bundle: no extra detail captured');
});

test('summariseDiagnosticBundle counts captured sections', () => {
  const bundle = buildDiagnosticBundle({ errorMessage: 'Boom', details: 'stack' });
  assert.equal(summariseDiagnosticBundle(bundle), 'diagnostic bundle: 2 section(s) captured');
});
