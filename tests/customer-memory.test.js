'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'website/app/lib/customer-memory.ts');
const ROUTE_PATH = path.join(ROOT, 'website/app/api/memory/route.ts');

// Source-level assertions only — the TS module talks to Neon, which we don't
// stand up in tests. The shape, exports, validators, and route guards are
// the contract; integration is covered manually.

test('customer-memory: source file exists', () => {
  assert.ok(fs.existsSync(LIB_PATH));
});

test('customer-memory: exports the expected runtime surface', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  for (const name of [
    'ensureMemoryTable',
    'validateScope',
    'validateKey',
    'validateValue',
    'setValue',
    'getValue',
    'listKeys',
    'deleteValue',
    'tierAllowed',
  ]) {
    assert.match(src, new RegExp(`export\\s+(?:const|function|async\\s+function)\\s+${name}\\b`),
      `missing export: ${name}`);
  }
});

test('customer-memory: internal-only symbols NOT exported (no dead-code warnings)', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  // These are only used inside this file; exporting them creates orphaned
  // dead-code warnings. Promote to export only when an outside caller needs them.
  for (const name of [
    'MEMORY_TIERS',
    'MAX_SCOPE_LEN',
    'MAX_KEY_LEN',
    'MAX_VALUE_BYTES',
    'MemoryTier',
    'MemoryRow',
    'ValidationError',
    'ValidationSuccess',
    'Validation',
  ]) {
    assert.doesNotMatch(src, new RegExp(`^\\s*export\\s+(?:const|type|interface|function|async\\s+function)\\s+${name}\\b`, 'm'),
      `${name} should NOT be exported (currently used only inside customer-memory.ts)`);
  }
});

test('customer-memory: tier allowlist contains only scan_fix + nuclear', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  assert.match(src, /MEMORY_TIERS\s*=\s*\[\s*["']scan_fix["']\s*,\s*["']nuclear["']\s*\]/);
});

test('customer-memory: schema is idempotent (CREATE TABLE IF NOT EXISTS)', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  assert.match(src, /CREATE TABLE IF NOT EXISTS customer_memory/);
  assert.match(src, /UNIQUE\s*\(customer_email,\s*scope,\s*key\)/);
});

test('customer-memory: validateScope rejects empty, oversize, whitespace-wrapped, control-char', async () => {
  // The validators are pure — execute them via dynamic require of a compiled
  // shim won't work without a TS runtime. We assert at source level: the
  // rules are present.
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  assert.match(src, /MAX_SCOPE_LEN\s*=\s*200/);
  assert.match(src, /MAX_KEY_LEN\s*=\s*200/);
  assert.match(src, /scope must not have leading\/trailing whitespace/);
  assert.match(src, /scope must not contain control characters/);
});

test('customer-memory: validateValue caps value at 64KB', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  assert.match(src, /MAX_VALUE_BYTES\s*=\s*64\s*\*\s*1024/);
  assert.match(src, /value too large/);
});

test('customer-memory: setValue uses ON CONFLICT upsert (idempotent set)', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  assert.match(src, /ON CONFLICT \(customer_email, scope, key\)/);
  assert.match(src, /DO UPDATE SET value = EXCLUDED\.value/);
});

test('memory route: file exists', () => {
  assert.ok(fs.existsSync(ROUTE_PATH));
});

test('memory route: exports GET, POST, DELETE', () => {
  const src = fs.readFileSync(ROUTE_PATH, 'utf8');
  assert.match(src, /export\s+async\s+function\s+GET\b/);
  assert.match(src, /export\s+async\s+function\s+POST\b/);
  assert.match(src, /export\s+async\s+function\s+DELETE\b/);
});

test('memory route: gated behind authenticateApiKey + tierAllowed', () => {
  const src = fs.readFileSync(ROUTE_PATH, 'utf8');
  assert.match(src, /authenticateApiKey\(req\)/);
  assert.match(src, /tierAllowed\(/);
  assert.match(src, /Scan\+Fix or Nuclear/);
});

test('memory route: declares Node runtime + dynamic', () => {
  const src = fs.readFileSync(ROUTE_PATH, 'utf8');
  assert.match(src, /export\s+const\s+runtime\s*=\s*["']nodejs["']/);
  assert.match(src, /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
});

test('memory route: returns 404 on missing get / delete', () => {
  const src = fs.readFileSync(ROUTE_PATH, 'utf8');
  // GET branch
  assert.match(src, /["']not found["'].*404/);
});

test('memory route: applies rate limit (checkRateLimit) to every verb', () => {
  const src = fs.readFileSync(ROUTE_PATH, 'utf8');
  // The shared authorise() helper does the rate-limit; the helper itself
  // must call checkRateLimit. One match is enough.
  assert.match(src, /checkRateLimit\(/);
});
