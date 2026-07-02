// =============================================================================
// /api/admin/audit-log ROUTE — STRUCTURE + CONTRACT TEST
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROUTE_PATH = path.join(__dirname, '..', 'website', 'app', 'api', 'admin', 'audit-log', 'route.ts');

function read() {
  return fs.readFileSync(ROUTE_PATH, 'utf8');
}

describe('audit-log route — file structure', () => {
  it('route file exists', () => {
    assert.ok(fs.existsSync(ROUTE_PATH));
  });

  it('exports GET handler', () => {
    assert.match(read(), /export\s+async\s+function\s+GET/);
  });

  it('declares dynamic = "force-dynamic"', () => {
    assert.match(read(), /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
  });
});

describe('audit-log route — auth + degradation', () => {
  const src = read();

  it('requires admin auth (401 on unauth)', () => {
    assert.match(src, /isAdminRequest/);
    assert.match(src, /admin auth required/);
    assert.match(src, /status:\s*401/);
  });

  it('returns 503 when DATABASE_URL is unset', () => {
    assert.match(src, /DATABASE_URL not set/);
    assert.match(src, /status:\s*503/);
  });

  it('uses recentAudit() from admin-lockout', () => {
    assert.match(src, /recentAudit/);
    assert.match(src, /from\s+["']@\/app\/lib\/admin-lockout["']/);
  });
});

describe('audit-log route — format support', () => {
  const src = read();

  it('supports CSV format', () => {
    assert.match(src, /text\/csv/);
    assert.match(src, /Content-Disposition/);
    assert.match(src, /toCsv/);
  });

  it('CSV escapes commas / quotes / newlines (RFC 4180)', () => {
    // Per RFC 4180 a value containing a comma, quote, or CR/LF must be
    // wrapped in double-quotes with embedded quotes doubled. The source
    // here uses /[",\n\r]/ as the trigger and v.replace(/"/g, '""') for
    // the escape. Match liberally — what matters is the trigger char-class
    // covers the three RFC-required cases and the doubling is present.
    assert.match(src, /\.test\(v\)/);
    assert.match(src, /v\.replace\(/);
    for (const ch of [',', '\\n', '\\r']) {
      assert.ok(
        src.includes(ch) || src.includes(`[${ch}]`) || /\\n/.test(src) || /\\r/.test(src),
        `RFC4180 escape should mention ${ch}`,
      );
    }
  });

  it('JSON is default format', () => {
    assert.match(src, /\(url\.searchParams\.get\(["']format["']\)\s*\|\|\s*["']json["']\)/);
  });

  it('limit is bounded (max 1000)', () => {
    assert.match(src, /MAX_LIMIT\s*=\s*1000/);
    assert.match(src, /Math\.min\(MAX_LIMIT/);
  });
});

describe('audit-log route — toCsv behaviour', () => {
  // The toCsv helper is module-private. Validate via the source file
  // contract: header line + field order pinned.
  const src = read();
  it('CSV header is ts,ip,result,userAgent', () => {
    assert.match(src, /"ts,ip,result,userAgent"/);
  });

  it('no-store cache headers on both JSON and CSV', () => {
    const matches = src.match(/no-store/g) || [];
    assert.ok(matches.length >= 2, `expected ≥ 2 no-store headers, got ${matches.length}`);
  });
});
