// =============================================================================
// deploy-contract-output-flag.test.js
//
// deployContract read the value of curl's `-o` / `--output` and wget's `-O`
// as the URL (refs #771). Two symptoms on origin/main:
//
//   `curl -fsSL -o $OUT https://host/health` in a file whose name carries a
//   health word (status.yml, health-check.sh) was recorded as a health check of
//   "$OUT" -> "/" and blocked on `deploy-contract:/`.
//
//   `curl -o /tmp/tool.tgz https://host/health` matched nothing at all, so the
//   real URL on that line was never checked against the routes.
//
// Control pair (Doctrine #3): the download-to-file idioms stay quiet, and the
// same lines against a route that does not exist still fire.
// =============================================================================

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DeployContract = require('../src/modules/deploy-contract');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gt-deploy-output-flag-'));
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

async function scan(files) {
  const tmp = makeTmp();
  write(tmp, 'src/server.js', "app.get('/health', (req, res) => res.json({ ok: true }));\n");
  for (const [rel, content] of Object.entries(files)) write(tmp, rel, content);
  const r = makeResult();
  await new DeployContract().run(r, { projectRoot: tmp });
  return {
    errors: r.checks.filter(c => !c.passed).map(c => c.name),
    passes: r.checks.filter(c => c.passed).map(c => c.name),
  };
}

describe('deployContract: the value of -o / --output / -O is a file, not the URL', () => {
  test('quiet: output flag value in a health-named workflow is not a health check of "/"', async () => {
    const { errors, passes } = await scan({
      '.github/workflows/status.yml': [
        'jobs:',
        '  probe:',
        '    steps:',
        '      - run: curl -fsSL -o $OUT https://example.test/health',
        '      - run: curl -fsSL -o ${OUT_FILE} https://example.test/health',
        '      - run: wget -O $BIN https://example.test/health',
        '      - run: wget -O localhost-probe.json https://example.test/health',
        '',
      ].join('\n'),
    });
    assert.deepEqual(errors, [], 'the flag value must not be read as a URL: ' + errors.join(', '));
    assert.ok(passes.includes('deploy-contract:/health'), 'the real URL on the line is the one checked: ' + passes.join(', '));
  });

  test('quiet: every spelling of the output flag is skipped and the real URL is seen', async () => {
    const { errors, passes } = await scan({
      'deploy.sh': [
        '#!/bin/bash',
        'curl -fsSL -o /tmp/tool.tgz https://example.test/tool.tgz',
        'wget -O /usr/local/bin/x https://example.test/x.tgz',
        'curl -o /tmp/health.json http://localhost:3000/health',
        'curl -sSo /tmp/health.json http://localhost:3000/health',
        'curl -o/tmp/health.json http://localhost:3000/health',
        'curl --output /tmp/health.json http://localhost:3000/health',
        'curl --output=/tmp/health.json http://localhost:3000/health',
        'curl -o "/tmp/health probe.json" http://localhost:3000/health',
        'wget -O /tmp/health.json http://localhost:3000/health',
        'wget -O/tmp/health.json http://localhost:3000/health',
        'wget --output-document=/tmp/health.json http://localhost:3000/health',
        '',
      ].join('\n'),
    });
    assert.deepEqual(errors, [], 'a download to a file names an existing route: ' + errors.join(', '));
    assert.ok(passes.includes('deploy-contract:/health'), 'the URL after the flag value was checked: ' + passes.join(', '));
  });

  test('fires: the same idioms against a route that does not exist', async () => {
    const { errors } = await scan({
      'deploy.sh': [
        '#!/bin/bash',
        'curl -fsSL -o /tmp/probe.json http://localhost:3000/api/health',
        'wget -O $OUT http://localhost:3000/api/ready',
        'curl -f http://localhost:3000/api/status',
        '',
      ].join('\n'),
    });
    assert.deepEqual(
      errors.sort(),
      ['deploy-contract:/api/health', 'deploy-contract:/api/ready', 'deploy-contract:/api/status'],
      'the missing routes are still named: ' + errors.join(', '),
    );
  });
});
