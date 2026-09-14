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

  // `uses: crclabs-hq/GateTest@v1` is what the Marketplace listing, the README
  // and every customer workflow say, and the tag did not exist (2026-09-14
  // audit). The workflow moves it on every stable release.
  it('advances the moving major tag after a successful publish, for stable releases only', () => {
    const block = runBlock(publish, 'Advance the moving major tag');
    assert.ok(block, 'Advance the moving major tag step missing');
    const cond = /if: ([^\r\n]+)/.exec(block);
    assert.ok(cond, 'the tag step must be conditional');
    assert.match(cond[1], /^success\(\)/, 'must not move v1 to a release npm never got');
    assert.match(cond[1], /startsWith\(github\.ref, 'refs\/tags\/v'\)/, 'tag pushes only');
    assert.match(cond[1], /!contains\(github\.ref_name, '-'\)/, 'a pre-release must not move the major tag');
    assert.match(block, /MAJOR="\$\{GITHUB_REF_NAME%%\.\*\}"/, 'the major is derived from the release tag');
    assert.match(block, /git tag -f "\$MAJOR" "\$GITHUB_SHA"/, 'force-moves the tag to the release commit');
    assert.match(block, /git push -f origin "refs\/tags\/\$MAJOR"/, 'force-pushes the moved tag');

    const order = ['- name: npm publish\n', '- name: npm publish @gatetest/mcp-server', '- name: Advance the moving major tag']
      .map((s) => publish.replace(/\r\n/g, '\n').indexOf(s));
    assert.ok(order.every((i) => i > -1) && order[0] < order[1] && order[1] < order[2],
      'the tag moves only after BOTH npm publishes');
  });

  it('is triggered by release tags only, so the moved major tag does not re-run the publish', () => {
    const trigger = /on:\r?\n\s+push:\r?\n\s+tags:\r?\n((?:\s+(?:#[^\r\n]*|- '[^']+')\r?\n)+)/.exec(publish);
    assert.ok(trigger, 'tag trigger missing');
    const globs = [...trigger[1].matchAll(/- '([^']+)'/g)].map((m) => m[1]);
    assert.ok(globs.length > 0, 'no tag globs');
    for (const g of globs) {
      assert.notEqual(g, 'v*', "'v*' also matches the moving v1 tag and would fail the version check on every release");
      assert.match(g, /^v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+/, `${g} must require a full semver tag`);
    }
  });
});
