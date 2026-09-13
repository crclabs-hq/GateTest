'use strict';

// =============================================================================
// PUBLISH WORKFLOW — the tag-triggered npm publish must run the suite the
// way ci.yml does, and must not announce a release it did not publish.
// =============================================================================
// 2026-09-13, tag v1.61.0: publish.yml installed only the root package, so
// cross-fix-syntax-gate could not load `typescript` (a website devDependency),
// three checkTsSyntax tests failed, `npm publish` was skipped — and the
// "Create GitHub Release" step, guarded only by `!cancelled()`, still
// published a public v1.61.0 release for a version the registry never got.
// The same suite is green in ci.yml, which installs the workspaces and the
// website first. These pins keep the two workflows' test environments equal
// and keep the release behind a successful publish.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('publish.yml runs the suite in the same environment as ci.yml', () => {
  const publish = read('.github/workflows/publish.yml');
  const ci = read('.github/workflows/ci.yml');

  it('installs the workspaces and the website before the test suite, like ci.yml Test + Build', () => {
    for (const step of ['run: bash scripts/install-workspaces.sh', 'run: cd website && npm ci']) {
      assert.ok(ci.includes(step), `ci.yml lost its "${step}" step — update this test with the new shape, not by dropping the pin`);
      assert.ok(publish.includes(step), `publish.yml must ${step} before running tests`);
    }
    const order = (s) => ['run: cd website && npm ci', 'run: node scripts/run-tests.js'].map((m) => s.indexOf(m));
    const [install, tests] = order(publish);
    assert.ok(install > -1 && tests > -1 && install < tests, 'website deps must be installed BEFORE the suite runs');
  });

  it('the GitHub Release is created only after a successful publish', () => {
    const m = /- name: Create GitHub Release\r?\n\s+if: ([^\r\n]+)/.exec(publish);
    assert.ok(m, 'Create GitHub Release step missing');
    assert.match(m[1], /^success\(\)/, 'the release must be gated on success(), not merely !cancelled()');
  });
});
