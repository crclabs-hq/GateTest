// =============================================================================
// /api/finding/dismiss — ROUTE SHAPE TEST
// =============================================================================
// Verifies the route file's import shape + handler signature. The actual
// DB-write path is integration-tested at deploy time (requires DATABASE_URL).
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROUTE_PATH = path.join(__dirname, '..', 'website', 'app', 'api', 'finding', 'dismiss', 'route.ts');
const STORE_PATH = path.join(__dirname, '..', 'website', 'app', 'lib', 'finding-feedback-store.ts');

describe('finding/dismiss route — file structure', () => {
  it('route file exists', () => {
    assert.ok(fs.existsSync(ROUTE_PATH));
  });

  it('store file exists', () => {
    assert.ok(fs.existsSync(STORE_PATH));
  });

  it('route exports POST handler', () => {
    const src = fs.readFileSync(ROUTE_PATH, 'utf8');
    assert.match(src, /export\s+async\s+function\s+POST/);
  });

  it('route imports recordDismissal from store', () => {
    const src = fs.readFileSync(ROUTE_PATH, 'utf8');
    assert.match(src, /recordDismissal/);
    assert.match(src, /from\s+["']@\/app\/lib\/finding-feedback-store["']/);
  });

  it('route validates required `rule` field', () => {
    const src = fs.readFileSync(ROUTE_PATH, 'utf8');
    assert.match(src, /missing required field: rule/);
  });

  it('route returns 503 when persistence unavailable', () => {
    const src = fs.readFileSync(ROUTE_PATH, 'utf8');
    // Source matches either `? 503 : 400` or `status: 503`.
    assert.match(src, /503/);
    assert.match(src, /persistence unavailable/);
  });

  it('route validates reason against VALID_REASONS', () => {
    const src = fs.readFileSync(ROUTE_PATH, 'utf8');
    assert.match(src, /invalid reason/);
  });

  it('route caps comment at 500 chars', () => {
    const src = fs.readFileSync(ROUTE_PATH, 'utf8');
    assert.match(src, /comment too long/);
    assert.match(src, /500/);
  });
});

describe('finding-feedback-store — shape', () => {
  it('store declares finding_dismissals schema', () => {
    const src = fs.readFileSync(STORE_PATH, 'utf8');
    assert.match(src, /CREATE TABLE IF NOT EXISTS finding_dismissals/);
  });

  it('store exports recordDismissal + statsByRule', () => {
    const src = fs.readFileSync(STORE_PATH, 'utf8');
    assert.match(src, /export\s+async\s+function\s+recordDismissal/);
    assert.match(src, /export\s+async\s+function\s+statsByRule/);
    assert.match(src, /export\s+function\s+clientIp/);
  });

  it('store has documented VALID_REASONS set', () => {
    const src = fs.readFileSync(STORE_PATH, 'utf8');
    assert.match(src, /VALID_REASONS = new Set/);
    for (const r of ['false-positive', 'intended', 'wont-fix', 'test-only', 'deprecated', 'other']) {
      assert.match(src, new RegExp('"' + r + '"'));
    }
  });

  it('store sanitises long strings via clamp()', () => {
    const src = fs.readFileSync(STORE_PATH, 'utf8');
    assert.match(src, /MAX_COMMENT_LEN/);
    assert.match(src, /MAX_RULE_LEN/);
  });
});
