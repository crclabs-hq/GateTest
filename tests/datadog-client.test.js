'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchTopErrors,
  fetchErrorTraces,
  extractSourceLocation,
} = require('../website/app/lib/datadog-client');

// ─── module shape ────────────────────────────────────────────────────────────

describe('datadog-client exports', () => {
  it('exports fetchTopErrors as a function', () => {
    assert.equal(typeof fetchTopErrors, 'function');
  });

  it('exports fetchErrorTraces as a function', () => {
    assert.equal(typeof fetchErrorTraces, 'function');
  });

  it('exports extractSourceLocation as a function', () => {
    assert.equal(typeof extractSourceLocation, 'function');
  });
});

// ─── extractSourceLocation ───────────────────────────────────────────────────

describe('extractSourceLocation', () => {
  it('returns null for empty / falsy input', () => {
    assert.equal(extractSourceLocation(''), null);
    assert.equal(extractSourceLocation(null), null);
    assert.equal(extractSourceLocation(undefined), null);
  });

  it('extracts Node.js style stack frames (file:line:col)', () => {
    const stack = 'Error: bad\n    at handler (src/api/checkout.ts:42:10)';
    const loc = extractSourceLocation(stack);
    assert.equal(loc.file, 'src/api/checkout.ts');
    assert.equal(loc.line, 42);
  });

  it('extracts .js frames', () => {
    const stack = '    at handler (app/api/route.js:15:3)';
    const loc = extractSourceLocation(stack);
    assert.equal(loc.file, 'app/api/route.js');
    assert.equal(loc.line, 15);
  });

  it('extracts Python style stack frames', () => {
    const stack = '  File "src/api/route.py", line 42, in handler';
    const loc = extractSourceLocation(stack);
    assert.equal(loc.file, 'src/api/route.py');
    assert.equal(loc.line, 42);
  });

  it('returns null for plain messages with no file reference', () => {
    assert.equal(extractSourceLocation('Something went wrong'), null);
  });
});

// ─── fetchTopErrors guard ────────────────────────────────────────────────────

describe('fetchTopErrors', () => {
  it('throws when apiKey is missing', async () => {
    await assert.rejects(
      () => fetchTopErrors({ appKey: 'ak' }),
      /apiKey and appKey are required/
    );
  });

  it('throws when appKey is missing', async () => {
    await assert.rejects(
      () => fetchTopErrors({ apiKey: 'k' }),
      /apiKey and appKey are required/
    );
  });
});

// ─── fetchErrorTraces guard ──────────────────────────────────────────────────

describe('fetchErrorTraces', () => {
  it('throws when apiKey is missing', async () => {
    await assert.rejects(
      () => fetchErrorTraces({ appKey: 'ak' }),
      /apiKey and appKey are required/
    );
  });

  it('throws when appKey is missing', async () => {
    await assert.rejects(
      () => fetchErrorTraces({ apiKey: 'k' }),
      /apiKey and appKey are required/
    );
  });
});
