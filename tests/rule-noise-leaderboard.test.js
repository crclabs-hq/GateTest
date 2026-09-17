'use strict';

// The rule-noise leaderboard's surfaces (the Fifty, move 07): the page, the
// API route, and the links that make them reachable — all reading the one
// aggregator, none typing a number.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8');

test('/noise renders the aggregator over the store and has honest empty states', () => {
  const page = read('website/app/noise/page.tsx');
  assert.match(page, /readRuleNoiseRows/);
  assert.match(page, /import \{ aggregateRuleNoise \} from "\.\.\/lib\/rule-noise"/);
  assert.match(page, /Not available/);
  assert.match(page, /No data yet/);
  assert.match(page, /export const revalidate = 3600/);
  assert.doesNotMatch(page, /\b\d{2,}% of rules\b/, 'no hand-typed statistic');
});

test('GET /api/telemetry/noise degrades to 503 without persistence', () => {
  const route = read('website/app/api/telemetry/noise/route.ts');
  assert.match(route, /status: 503/);
  assert.match(route, /aggregateRuleNoise/);
});

test('GET /api/noise (the Fifty, move 08): worst-first table, sampleSize/candidate, three-state status', () => {
  const route = read('website/app/api/noise/route.ts');
  assert.match(route, /noisePublication/);
  assert.match(route, /MIN_FINDINGS_FLOOR/);
  // 503 ledger-unavailable — never an empty 200 that could read as "no noisy rules".
  assert.match(route, /status: 503/);
  assert.match(route, /"ledger-unavailable"/);
  assert.match(route, /"not-enough-data"/);
  assert.match(route, /"ok"/);
});

test('the leaderboard is reachable from the footer and from /precision', () => {
  assert.match(read('website/app/components/Footer.tsx'), /href="\/noise"/);
  assert.match(read('website/app/precision/page.tsx'), /href="\/noise"/);
});

test('the store persists and reads the rules column', () => {
  const store = read('website/app/lib/scan-telemetry-store.ts');
  assert.match(store, /ADD COLUMN IF NOT EXISTS rules JSONB/);
  assert.match(store, /export async function readRuleNoiseRows/);
  assert.match(store, /JSON\.stringify\(r\.rules \|\| \[\]\)/);
});
