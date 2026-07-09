'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CI_YML = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const HEAVY_DIR = path.join(ROOT, 'tests', 'heavy');

test('ci.yml exists', () => {
  assert.ok(fs.existsSync(CI_YML), `expected ${CI_YML}`);
});

test('ci.yml has a heavy-tests job', () => {
  const src = fs.readFileSync(CI_YML, 'utf8');
  assert.match(src, /heavy-tests:/);
});

test('ci.yml heavy-tests job has no needs: (runs in parallel)', () => {
  const src = fs.readFileSync(CI_YML, 'utf8');
  // Extract the heavy-tests job block — from 'heavy-tests:' to the next top-level job
  const start = src.indexOf('heavy-tests:');
  assert.ok(start !== -1, 'heavy-tests job not found');
  // Next top-level job starts with /^  \w/
  const after = src.slice(start);
  const nextJob = after.search(/\n  \w[^:]*:/);
  const block = nextJob === -1 ? after : after.slice(0, nextJob);
  // The job block should NOT have a 'needs:' line
  assert.doesNotMatch(block, /^\s+needs:/m, 'heavy-tests must not have needs: — it runs in parallel');
});

test('ci.yml: no continue-on-error: true on test/gate steps (Bible Forbidden #24)', () => {
  const src = fs.readFileSync(CI_YML, 'utf8');
  // continue-on-error: true is allowed ONLY on upload-sarif steps (informational artifact upload)
  // For test steps or GateTest gate steps it is FORBIDDEN.
  const lines = src.split(/\r?\n/);
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    if (/continue-on-error:\s*true/i.test(lines[i])) {
      // Look back up to 10 lines for context to determine if it's a SARIF/artifact step
      const ctx = lines.slice(Math.max(0, i - 10), i).join('\n');
      if (!/upload-sarif|upload-artifact/i.test(ctx)) {
        violations.push(`line ${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  assert.deepEqual(violations, [], `continue-on-error: true found on non-artifact step: ${violations.join(', ')}`);
});

test('tests/heavy/ directory exists and is non-empty', () => {
  assert.ok(fs.existsSync(HEAVY_DIR), 'tests/heavy/ must exist');
  const files = fs.readdirSync(HEAVY_DIR).filter(f => f.endsWith('.test.js'));
  assert.ok(files.length > 0, 'tests/heavy/ must contain at least one .test.js file');
});

test('tests/integrations.test.js is in tests/ (not moved to heavy/)', () => {
  const integPath = path.join(ROOT, 'tests', 'integrations.test.js');
  assert.ok(fs.existsSync(integPath), 'integrations.test.js must stay in tests/ — it is the tripwire that keeps protection intact (Bible Forbidden #22)');
});

test('package.json has test, test:heavy, and test:all scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test, 'package.json must have a test script');
  assert.ok(pkg.scripts['test:heavy'], 'package.json must have a test:heavy script');
  assert.ok(pkg.scripts['test:all'], 'package.json must have a test:all script');
});

test('npm test (fast suite) only runs tests/*.test.js, not tests/heavy/', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const testScript = pkg.scripts.test;
  // Must not include heavy/ in the fast test glob
  assert.doesNotMatch(testScript, /heavy/, 'npm test must not include tests/heavy/ — use npm run test:all for that');
  // Must use single-level glob tests/*.test.js
  assert.match(testScript, /tests\/\*\.test\.js/, 'npm test must use tests/*.test.js glob');
});
