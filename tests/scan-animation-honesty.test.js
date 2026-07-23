/**
 * KI #61 regression: the /api/scan/status while-scanning animation must
 * show the REAL modules the paid scan runs — never an invented list, and
 * never fabricated per-module check counts.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  QUICK_ANIMATION_MODULES,
  FULL_ANIMATION_MODULES,
} = require('../website/app/lib/scan-animation-modules.js');

const { GateTestConfig } = require('../src/core/config');

test('full animation list = the engine full suite minus mutation/chaos (website skip set)', () => {
  const config = new GateTestConfig(path.resolve(__dirname, '..'));
  const realFull = config
    .getSuite('full')
    .filter((m) => m !== 'mutation' && m !== 'chaos');
  assert.deepEqual(
    FULL_ANIMATION_MODULES,
    realFull,
    'scan-animation-modules.js FULL list drifted from src/core/config.js suites.full (minus the mutation/chaos website skips, KI #55) — update the animation list'
  );
});

test('quick animation list = the 4-module quick tier', () => {
  assert.deepEqual(QUICK_ANIMATION_MODULES, ['syntax', 'lint', 'secrets', 'codeQuality']);
});

test('scan/status animation fabricates no per-module numbers', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'website', 'app', 'api', 'scan', 'status', 'route.ts'),
    'utf8'
  );
  assert.doesNotMatch(src, /5 \+ \(i \* 3\)/, 'invented check counts must not return');
  assert.doesNotMatch(src, /100 \+ \(i \* 50\)/, 'invented durations must not return');
  assert.match(src, /scan-animation-modules/, 'animation must source module names from the drift-tested list');
  assert.match(src, /estimated: true/, 'while-scanning payload must self-identify as an estimate');
});
