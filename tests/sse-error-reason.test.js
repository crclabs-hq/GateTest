'use strict';
/**
 * A failed scan must show the server's reason, not "Scan errored mid-stream".
 * Behavioural test of the shared extractor plus a structural pin that both
 * scan pages route their `error` event through it.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sseErrorReason, FALLBACK } = require('../website/app/components/sse-error-reason.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('sseErrorReason', () => {
  it('returns the server reason from { error }', () => {
    assert.strictEqual(sseErrorReason({ error: 'repository not found or private' }), 'repository not found or private');
  });
  it('understands { message }, nested error.message and bare strings', () => {
    assert.strictEqual(sseErrorReason({ message: 'Database not configured' }), 'Database not configured');
    assert.strictEqual(sseErrorReason({ error: { message: 'rate limited' } }), 'rate limited');
    assert.strictEqual(sseErrorReason('boom'), 'boom');
  });
  it('falls back when nothing usable is sent', () => {
    for (const d of [undefined, null, {}, { error: '' }, { error: '   ' }, 42, []]) {
      assert.strictEqual(sseErrorReason(d), FALLBACK);
    }
  });
  it('strips control characters and caps length; keeps markup as inert text', () => {
    assert.strictEqual(sseErrorReason({ error: 'a\nb\u0000c' }), 'a b c');
    assert.ok(sseErrorReason({ error: 'x'.repeat(5000) }).length <= 300);
    assert.strictEqual(sseErrorReason({ error: '<img src=x onerror=1>' }), '<img src=x onerror=1>');
  });
});

describe('scan pages use the extractor', () => {
  for (const f of ['website/app/playground/page.tsx', 'website/app/components/UrlScanFlow.tsx']) {
    it(`${f} no longer hard-codes d?.error || fallback`, () => {
      const src = read(f);
      assert.match(src, /sseErrorReason\(data\)/);
      assert.doesNotMatch(src, /d\?\.error \|\| "Scan errored mid-stream"/);
    });
  }
});
