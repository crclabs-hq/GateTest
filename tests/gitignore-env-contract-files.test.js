'use strict';
// Control pair for the 2026-09-26 dogfood red: after issue #767 (scan honours
// .gitignore) landed, a repo whose .gitignore says `.env*` — this one does —
// lost its own `.env.example` from the scan, so the env-vars rule reported
// every documented variable as "missing from .env.example". Contract files
// are never secrets and stay in scope; `.env` itself stays ignored.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getScanIgnoreMatcher, clearScanIgnoreMatcherCache, isEnvContractFile } = require('../src/core/gitignore');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-env-contract-'));
fs.writeFileSync(path.join(root, '.gitignore'), '.env*\nbuild/\n');
for (const f of ['.env', '.env.example', '.env.local.example', '.env.sample', '.env.template']) {
  fs.writeFileSync(path.join(root, f), 'KEY=\n');
}
after(() => { clearScanIgnoreMatcherCache(); fs.rmSync(root, { recursive: true, force: true }); });

describe('gitignore — env contract files stay in scope', () => {
  const ignored = getScanIgnoreMatcher(root);
  it('POSITIVE: .env.example, .env.local.example, .env.sample, .env.template are scanned despite `.env*`', () => {
    for (const f of ['.env.example', '.env.local.example', '.env.sample', '.env.template']) {
      assert.strictEqual(ignored(f, false), false, `${f} must not be ignored`);
      assert.strictEqual(isEnvContractFile(`apps/web/${f}`), true);
    }
  });
  it('NEGATIVE: .env (real values) and build output are still ignored', () => {
    assert.strictEqual(ignored('.env', false), true);
    assert.strictEqual(ignored('build/out.js', false), true);
    assert.strictEqual(isEnvContractFile('.env'), false);
    assert.strictEqual(isEnvContractFile('.env.production'), false);
  });
});
