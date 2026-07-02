'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveEngineEntry, candidatePaths } = require('../website/app/lib/engine-entry-resolver.js');

test('resolveEngineEntry finds the real src/index.js from a direct node require (test-suite context)', () => {
  const resolved = resolveEngineEntry();
  assert.ok(fs.existsSync(resolved), `resolved path does not exist: ${resolved}`);
  assert.equal(path.resolve(resolved), path.resolve(__dirname, '..', 'src', 'index.js'));
});

test('candidatePaths includes both a __dirname-relative and a process.cwd()-relative option', () => {
  const candidates = candidatePaths();
  assert.ok(candidates.length >= 2, 'must try more than one anchor — no single anchor works in every runtime context');
  // __dirname-relative candidate is relative to engine-entry-resolver.js's
  // OWN location (website/app/lib/), not this test file's.
  const resolverDir = path.dirname(require.resolve('../website/app/lib/engine-entry-resolver.js'));
  const dirnameRelative = path.join(resolverDir, '..', '..', '..', 'src', 'index.js');
  assert.ok(
    candidates.some((c) => path.resolve(c) === path.resolve(dirnameRelative)),
    'must include a __dirname-relative candidate (correct for direct node require / tests)'
  );
  const cwdRelative = path.join(process.cwd(), '..', 'src', 'index.js');
  assert.ok(
    candidates.some((c) => path.resolve(c) === path.resolve(cwdRelative)),
    'must include a process.cwd()-relative candidate (correct for the bundled Next.js server runtime)'
  );
});

test('resolveEngineEntry throws a clear, actionable error when no candidate exists', () => {
  const realExistsSync = fs.existsSync;
  fs.existsSync = () => false;
  try {
    assert.throws(() => resolveEngineEntry(), /GateTest CLI engine entry not found/);
  } finally {
    fs.existsSync = realExistsSync;
  }
});
