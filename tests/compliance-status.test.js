'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'website/app/lib/compliance-status.ts');
const ROUTE_PATH = path.join(ROOT, 'website/app/api/admin/compliance/route.ts');
const PAGE_PATH = path.join(ROOT, 'website/app/admin/compliance/page.tsx');

test('compliance-status: source file exists', () => {
  assert.ok(fs.existsSync(LIB_PATH));
});

test('compliance-status: exports buildComplianceSnapshot + listControls', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  assert.match(src, /export\s+async\s+function\s+buildComplianceSnapshot\b/);
  assert.match(src, /export\s+function\s+listControls\b/);
});

test('compliance-status: ships SOC2 + HIPAA controls', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  // SOC2 CC controls
  assert.match(src, /CC6\.1/);
  assert.match(src, /CC6\.6/);
  assert.match(src, /CC7\.2/);
  assert.match(src, /CC7\.3/);
  // HIPAA Security Rule references
  assert.match(src, /164\.312\(a\)\(1\)/);
  assert.match(src, /164\.312\(b\)/);
  assert.match(src, /164\.312\(c\)\(1\)/);
  assert.match(src, /164\.312\(e\)\(1\)/);
});

test('compliance-status: 7-year audit retention pinned in snapshot', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  assert.match(src, /auditLogYears:\s*7/);
});

test('compliance-status: verifies recent chain (200-row probe)', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  assert.match(src, /verifyRecentChain/);
  assert.match(src, /windowSize/);
});

test('compliance route: file exists, admin-only via cookie auth', () => {
  assert.ok(fs.existsSync(ROUTE_PATH));
  const src = fs.readFileSync(ROUTE_PATH, 'utf8');
  assert.match(src, /SESSION_COOKIE_NAME/);
  assert.match(src, /ADMIN_COOKIE_NAME/);
  assert.match(src, /Unauthorized/);
  assert.match(src, /buildComplianceSnapshot\(\)/);
});

test('compliance route: GET only + Node runtime', () => {
  const src = fs.readFileSync(ROUTE_PATH, 'utf8');
  assert.match(src, /export\s+async\s+function\s+GET\b/);
  assert.match(src, /export\s+const\s+runtime\s*=\s*["']nodejs["']/);
});

test('compliance dashboard page: file exists + use client', () => {
  assert.ok(fs.existsSync(PAGE_PATH));
  const src = fs.readFileSync(PAGE_PATH, 'utf8');
  const firstLine = src.split('\n').find((l) => l.trim().length > 0);
  assert.match(String(firstLine), /^"use client";?$/);
});

test('compliance dashboard page: posts to GET /api/admin/compliance, handles 401', () => {
  const src = fs.readFileSync(PAGE_PATH, 'utf8');
  assert.match(src, /["']\/api\/admin\/compliance["']/);
  assert.match(src, /status\s*===\s*401/);
  assert.match(src, /\/admin/);
});

test('compliance dashboard page: renders chain verification status', () => {
  const src = fs.readFileSync(PAGE_PATH, 'utf8');
  assert.match(src, /Hash chain intact/);
  assert.match(src, /Hash chain broken/);
});
