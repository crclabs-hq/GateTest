// =============================================================================
// deploy-rules-self-scan-2026-09-16.test.js
//
// Main's push-only Full Scan was red on three findings that were all the rules
// misreading the repo, not the repo being wrong:
//
//   deployContract         a basePath harvested from a COMMENT in
//                          deploy-contract.js's own header mounted the whole
//                          repo under /api; then every route already declared
//                          with /api was told it was "missing" the prefix; and
//                          `if curl ... /api/health; then` was recorded as a
//                          health check of "/api/health;".
//   deployScriptValidator  `body_path: /tmp/release-notes-header.md` in the
//                          release workflow was read as a Kubernetes probe.
//
// Each test is a control pair (Doctrine #3): the idiom that must stay quiet and
// the real defect beside it that must still fire.
// =============================================================================

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DeployContract = require('../src/modules/deploy-contract');
const DeployScriptValidator = require('../src/modules/deploy-script-validator');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gt-deploy-rules-'));
}

function makeResult() {
  const checks = [];
  return {
    checks,
    addCheck(n, passed, details = {}) { checks.push({ name: n, passed, ...details }); },
  };
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const NEXT_HEALTH_ROUTE = 'export async function GET() { return Response.json({ ok: true }); }\n';

describe('deployContract: base paths come from code, and routes that carry the base are not asked to add it', () => {
  test('a basePath that appears only in a comment is not a base path', async () => {
    const tmp = makeTmp();
    write(tmp, 'deploy.sh', '#!/bin/bash\ncurl -f http://localhost:3000/api/health || exit 1\n');
    write(tmp, 'src/server.ts', [
      "// Matches: app.basePath('/api'), new Hono().basePath('/api'), hono.basePath('/api')",
      "/* const legacy = new Hono().basePath('/v2'); */",
      "const url = 'https://example.test/x'; // a URL in a string keeps its // intact",
      "app.get('/api/health', (c) => c.json({ ok: true }));",
      '',
    ].join('\n'));
    const r = makeResult();
    await new DeployContract().run(r, { projectRoot: tmp });
    const errors = r.checks.filter((c) => !c.passed && c.severity === 'error').map((c) => c.name);
    assert.deepEqual(errors, [], 'a commented-out basePath must not mount the app under /api');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a real basePath in code is still detected and a URL missing it still fires (positive control)', async () => {
    const tmp = makeTmp();
    write(tmp, 'deploy.sh', '#!/bin/bash\ncurl -f http://localhost:3000/health || exit 1\n');
    write(tmp, 'src/server.ts', "const app = new Hono().basePath('/api');\napp.get('/health', (c) => c.json({ ok: true }));\n");
    const r = makeResult();
    await new DeployContract().run(r, { projectRoot: tmp });
    const errors = r.checks.filter((c) => !c.passed && c.severity === 'error').map((c) => c.name);
    assert.ok(errors.includes('deploy-contract:basepath:/health'), 'the /health route lives under /api: ' + errors.join(', '));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a URL that already carries the base is not flagged against a route declared with the base', async () => {
    const tmp = makeTmp();
    write(tmp, 'deploy.sh', '#!/bin/bash\ncurl -f http://localhost:3000/api/health || exit 1\n');
    write(tmp, 'app/api/health/route.ts', NEXT_HEALTH_ROUTE);
    // A genuine basePath elsewhere in the repo — the situation on main.
    write(tmp, 'src/other.ts', "const app = new Hono().basePath('/api');\napp.get('/ping', (c) => c.text('pong'));\n");
    const r = makeResult();
    await new DeployContract().run(r, { projectRoot: tmp });
    const errors = r.checks.filter((c) => !c.passed && c.severity === 'error').map((c) => c.name);
    assert.deepEqual(errors, [], '/api/health is declared as /api/health — there is no prefix to add');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a trailing `;` after the URL is shell syntax, not part of the path — a real miss still fires without it', async () => {
    const tmp = makeTmp();
    write(tmp, '.github/workflows/smoke.yml', [
      'jobs:',
      '  smoke:',
      '    steps:',
      '      - run: |',
      '          if curl -fsS http://127.0.0.1:3000/api/health; then echo ok; fi',
      // The rule only looks at health-shaped paths (HEALTH_WORDS), so the
      // control that must fire needs one: "status" qualifies, and no route
      // matches it.
      '          if curl -fsS http://127.0.0.1:3000/api/status-probe; then echo ok; fi',
      '          (curl -fsS http://127.0.0.1:3000/api/health) && echo ok',
      '',
    ].join('\n'));
    write(tmp, 'app/api/health/route.ts', NEXT_HEALTH_ROUTE);
    const r = makeResult();
    await new DeployContract().run(r, { projectRoot: tmp });
    const errors = r.checks.filter((c) => !c.passed && c.severity === 'error').map((c) => c.name);
    assert.deepEqual(errors, ['deploy-contract:/api/status-probe'], 'the existing route passes; the missing one is named without the semicolon');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('deployScriptValidator: `body_path:` is a file, `path:` is a probe', () => {
  test('body_path in a release workflow is not harvested as a health URL; a k8s probe path still is', async () => {
    const tmp = makeTmp();
    write(tmp, '.github/workflows/publish.yml', [
      'jobs:',
      '  release:',
      '    steps:',
      '      - uses: softprops/action-gh-release@v2',
      '        with:',
      '          body_path: /tmp/release-notes-header.md',
      '          asset-path: /dist/out.zip',
      '',
    ].join('\n'));
    write(tmp, 'k8s/deploy.yaml', 'livenessProbe:\n  httpGet:\n    path: /nope-probe\n    port: 3000\n');
    write(tmp, 'app/api/health/route.ts', NEXT_HEALTH_ROUTE);
    const r = makeResult();
    await new DeployScriptValidator().run(r, { projectRoot: tmp });
    const failing = r.checks.filter((c) => !c.passed).map((c) => c.name);
    assert.ok(!failing.some((n) => n.includes('release-notes-header')), 'body_path is not a probe: ' + failing.join(', '));
    assert.ok(!failing.some((n) => n.includes('/dist/out.zip')), 'asset-path is not a probe: ' + failing.join(', '));
    assert.ok(failing.includes('deploy-script-validator:mismatch:/nope-probe'), 'a real probe path with no route still fires: ' + failing.join(', '));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('deployScriptValidator: an upload-artifact file path is not a probe (#771 GT-09)', () => {
  // AlecRae.com .github/workflows/ci.yml:408 — `path: /tmp/e2e-api.log`
  // under `actions/upload-artifact@v4` was reported as health-check URL
  // `/tmp/e2e-api` with no matching route. The `.log` never made it into
  // the match; the `/tmp/` root was not consulted. Both now refuse it.
  test('the customer line — `path: /tmp/e2e-api.log` under upload-artifact is not harvested; a real probe beside it still is', async () => {
    const tmp = makeTmp();
    write(tmp, '.github/workflows/ci.yml', [
      'jobs:',
      '  e2e:',
      '    steps:',
      '      - name: Upload API log artifact',
      '        if: always()',
      '        uses: actions/upload-artifact@v4',
      '        with:',
      '          name: e2e-api-log',
      '          path: /tmp/e2e-api.log',
      '          if-no-files-found: ignore',
      '      - uses: actions/upload-artifact@v4',
      '        with:',
      '          path: /home/runner/work/report',
      '',
    ].join('\n'));
    write(tmp, 'k8s/deploy.yaml', 'livenessProbe:\n  httpGet:\n    path: /nope-probe\n    port: 3000\n');
    write(tmp, 'app/api/health/route.ts', NEXT_HEALTH_ROUTE);
    const r = makeResult();
    await new DeployScriptValidator().run(r, { projectRoot: tmp });
    const failing = r.checks.filter((c) => !c.passed).map((c) => c.name);
    assert.ok(!failing.some((n) => n.includes('e2e-api')), 'a .log file path is not a probe: ' + failing.join(', '));
    assert.ok(!failing.some((n) => n.includes('/home/runner')), 'a path under a filesystem root is not a probe: ' + failing.join(', '));
    assert.ok(failing.includes('deploy-script-validator:mismatch:/nope-probe'), 'a real probe path with no route still fires: ' + failing.join(', '));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a k8s probe path with a matching route stays consistent; one carrying a file extension is refused even in a manifest', async () => {
    const tmp = makeTmp();
    write(tmp, 'k8s/deploy.yaml', [
      'readinessProbe:',
      '  httpGet:',
      '    path: /api/health',
      '    port: 3000',
      'volumeMounts:',
      '  - name: cfg',
      '    path: /config/app.json',
      '',
    ].join('\n'));
    write(tmp, 'app/api/health/route.ts', NEXT_HEALTH_ROUTE);
    const r = makeResult();
    await new DeployScriptValidator().run(r, { projectRoot: tmp });
    const failing = r.checks.filter((c) => !c.passed).map((c) => c.name);
    assert.deepStrictEqual(failing, [], 'nothing should fire: ' + failing.join(', '));
    assert.ok(r.checks.some((c) => c.name === 'deploy-script-validator:consistent'), 'the /api/health probe is still harvested and matched');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('deployScriptValidator: test-fixture files are not deploy config (self-scan 2026-09-16)', () => {
  // Control pair: tests/deploy-rules-self-scan-2026-09-16.test.js:128 itself
  // writes `path: /nope-probe` as fixture YAML content for the test above —
  // isDeployFile() matches this file's own NAME by substring ("deploy"),
  // so the self-scan harvested that fixture string as a real k8s probe and
  // reported a mismatch against the app's actual routes. Same defendant as
  // secretRotation/tests-fixture noise: skip test paths via the canonical
  // definition (BaseModule._isTestPath / src/core/test-paths.js).
  test('a real k8s manifest with an unmatched probe still fires', async () => {
    const tmp = makeTmp();
    write(tmp, 'k8s/deploy.yaml', 'livenessProbe:\n  httpGet:\n    path: /nope-probe\n    port: 3000\n');
    write(tmp, 'app/api/health/route.ts', NEXT_HEALTH_ROUTE);
    const r = makeResult();
    await new DeployScriptValidator().run(r, { projectRoot: tmp });
    const failing = r.checks.filter((c) => !c.passed).map((c) => c.name);
    assert.ok(failing.includes('deploy-script-validator:mismatch:/nope-probe'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the identical probe path inside a *.test.js fixture stays quiet', async () => {
    const tmp = makeTmp();
    write(
      tmp,
      'tests/deploy-rules-fixture.test.js',
      "write(tmp, 'k8s/deploy.yaml', 'livenessProbe:\\n  httpGet:\\n    path: /nope-probe\\n    port: 3000\\n');\n",
    );
    write(tmp, 'app/api/health/route.ts', NEXT_HEALTH_ROUTE);
    const r = makeResult();
    await new DeployScriptValidator().run(r, { projectRoot: tmp });
    const failing = r.checks.filter((c) => !c.passed).map((c) => c.name);
    assert.ok(
      !failing.some((n) => n.includes('/nope-probe')),
      'a test-fixture string must not be read as a real health-check probe: ' + failing.join(', '),
    );
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
