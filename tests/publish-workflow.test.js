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

/** The `run: |` block of the named step, up to the next step. */
function runBlock(yaml, stepName) {
  const start = yaml.indexOf(`- name: ${stepName}\n`) >= 0
    ? yaml.indexOf(`- name: ${stepName}\n`)
    : yaml.indexOf(`- name: ${stepName}\r\n`);
  if (start < 0) return null;
  const rest = yaml.slice(start + stepName.length + 8);
  const next = rest.search(/\r?\n\s*- name: /);
  return next < 0 ? rest : rest.slice(0, next);
}

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

  it('publishes @gatetest/mcp-server from the same run, idempotently, with provenance', () => {
    // Craig, 2026-09-13: "the mcp should have been included absolutely." The
    // MCP package is a thin proxy to @gatetest/cli and pins its range, so a
    // CLI release without it leaves `npx @gatetest/mcp-server` on old code.
    const mcp = runBlock(publish, 'npm publish @gatetest/mcp-server');
    assert.ok(mcp, 'mcp-server publish step missing');
    assert.match(mcp, /working-directory: packages\/mcp-server/);
    assert.match(mcp, /npm view "\$PKG@\$VER" version/, 'must skip a version the registry already has');
    assert.match(mcp, /npm publish --access public --provenance/);

    const cli = runBlock(publish, 'npm publish');
    assert.ok(cli, 'CLI publish step missing');
    assert.match(cli, /npm view "\$PKG@\$VER" version/, 'the CLI publish must be idempotent too, so a dispatch re-run can ship only what is missing');
  });

  it('the MCP package depends on a CLI range that includes the version being released', () => {
    const cliVersion = JSON.parse(read('package.json')).version;
    const mcp = JSON.parse(read('packages/mcp-server/package.json'));
    const range = mcp.dependencies['@gatetest/cli'];
    const floor = range.replace(/^[\^~]/, '');
    const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] - y[i]; } return 0; };
    assert.ok(cmp(cliVersion, floor) >= 0, `@gatetest/mcp-server pins ${range} but the CLI is ${cliVersion}`);
    assert.equal(cliVersion.split('.')[0], floor.split('.')[0], 'same major, or the proxy resolves a different CLI');
  });

  it('the GitHub Release is created only after a successful publish', () => {
    const m = /- name: Create GitHub Release\r?\n\s+if: ([^\r\n]+)/.exec(publish);
    assert.ok(m, 'Create GitHub Release step missing');
    assert.match(m[1], /^success\(\)/, 'the release must be gated on success(), not merely !cancelled()');
  });
});
