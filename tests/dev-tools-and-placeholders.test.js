'use strict';

// DR-6 (issue #842, DavenRoe cross-test): two "ships" lies.
//
//   1. secrets reported `secret_key: str = "change-me-in-production"`
//      (backend/app/core/config.py) as a committed secret — the app refuses
//      to boot with it. The placeholder shape list knew `changeme` but not
//      the hyphenated form; it now lives in src/core/env-placeholder.js, one
//      definition with the present-but-fake env detector.
//   2. hardcodedUrl said "localhost leaks break every non-developer machine
//      the moment this ships" about frontend/scripts/doctor.mjs, and
//      dataIntegrity reported the token frontend/scripts/inspect.mjs seeds
//      into its own Playwright context. Both are `npm run doctor` /
//      `npm run inspect` tools that never ship. The decision is now
//      src/core/operator-cli.js, shared by both modules and logPii.
//
// Each quiet case sits beside the positive control that must keep firing.
// Against origin/main the quiet cases FAIL (the placeholder fires; the
// scripts/ URL is an error; the scripts/ localStorage line fires) and the
// positive controls pass — that asymmetry is the proof the fix is not a mute.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SecretsModule = require('../src/modules/secrets');
const HardcodedUrlModule = require('../src/modules/hardcoded-url');
const DataIntegrityModule = require('../src/modules/data-integrity');
const { isOperatorCliFile } = require('../src/core/operator-cli');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

async function scanWith(Module, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dr6-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const result = makeResult();
    await new Module().run(result, { projectRoot: root });
    return result.checks.filter((c) => !c.passed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('secrets — a placeholder is not a secret; a high-entropy value in the same assignment is (DR-6)', () => {
  it('QUIET: `change-me-in-production` (DavenRoe config.py:12 and :153 shapes)', async () => {
    // The baseline finding was config.py:153 `_PLACEHOLDER_SECRET = "change-me-in-production"`
    // (the report carried no line; the issue guessed line 12). Both shapes here.
    const found = await scanWith(SecretsModule, {
      'backend/app/core/config.py': [
        'class Settings(BaseSettings):',
        '    secret_key: str = "change-me-in-production"',
        '_PLACEHOLDER_SECRET = "change-me-in-production"',
        '    jwt_secret: str = "replace_me"',
        '    api_key: str = "your-api-key-here"',
        '    webhook_secret: str = "<paste-webhook-secret>"',
        '',
      ].join('\n'),
    });
    assert.deepEqual(found.filter((c) => /^secrets:backend\//.test(c.name)).map((c) => c.name), [], JSON.stringify(found));
  });

  it('FIRES: the same assignment with a real-looking value', async () => {
    const found = await scanWith(SecretsModule, {
      'backend/app/core/config.py': [
        '_PLACEHOLDER_SECRET = "k9F2vQ7xL1mR4pT8wZ3cB6nJ0hY5dG2s"',
        '',
      ].join('\n'),
    });
    assert.ok(found.some((c) => c.name === 'secrets:backend/app/core/config.py'), JSON.stringify(found));
  });
});

describe('operator-cli — what is a dev-only tool (DR-6 "ships")', () => {
  it('scripts/, bin/, cli/ and a shebang file are tools; src/ is not', () => {
    assert.equal(isOperatorCliFile('frontend/scripts/doctor.mjs', ''), true);
    assert.equal(isOperatorCliFile('bin/rotate.js', ''), true);
    assert.equal(isOperatorCliFile('src/pages/Bills.jsx', ''), false);
    assert.equal(isOperatorCliFile('tasks/run.js', '#!/usr/bin/env node\n'), true);
    assert.equal(isOperatorCliFile('subscripts/report.js', ''), false, 'no scripts SEGMENT');
  });

  it('a scripts/ under a static-asset root is browser code the server serves — it SHIPS', () => {
    assert.equal(isOperatorCliFile('public/scripts/app.js', ''), false);
    assert.equal(isOperatorCliFile('static/scripts/main.js', '#!/usr/bin/env node\n'), false);
  });

  it('tools/ and dev/ count only when package.json scripts name them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dr6-tools-'));
    try {
      fs.mkdirSync(path.join(root, 'frontend', 'tools'), { recursive: true });
      fs.mkdirSync(path.join(root, 'frontend', 'src', 'tools'), { recursive: true });
      fs.writeFileSync(path.join(root, 'frontend', 'package.json'), JSON.stringify({
        name: 'fe', scripts: { doctor: 'node tools/doctor.mjs' },
      }));
      assert.equal(isOperatorCliFile('frontend/tools/doctor.mjs', '', root), true, 'named by "doctor": "node tools/doctor.mjs"');
      assert.equal(isOperatorCliFile('frontend/src/tools/weather.ts', '', root), false, 'the script names tools/, not src/tools/ — an agent tool module ships');
      // Cache is per directory for the process; a fresh directory proves the negative.
      fs.mkdirSync(path.join(root, 'other', 'tools'), { recursive: true });
      fs.writeFileSync(path.join(root, 'other', 'package.json'), JSON.stringify({ name: 'o', scripts: { build: 'vite build' } }));
      assert.equal(isOperatorCliFile('other/tools/agent.ts', '', root), false, 'no package.json evidence: shipped code');
      assert.equal(isOperatorCliFile('other/tools/agent.ts', ''), false, 'no project root: no evidence');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('hardcodedUrl — a dev-only tool is on record, never "the moment this ships" (DR-6)', () => {
  const LINE = "const BASE = 'http://localhost:4173';\n";

  it('QUIET (info): frontend/scripts/doctor.mjs', async () => {
    const found = await scanWith(HardcodedUrlModule, { 'frontend/scripts/doctor.mjs': LINE, 'frontend/package.json': '{"name":"fe","scripts":{"doctor":"node scripts/doctor.mjs"}}' });
    const hit = found.find((c) => c.name === 'hardcoded-url:localhost:frontend/scripts/doctor.mjs:1');
    assert.ok(hit, JSON.stringify(found));
    assert.equal(hit.severity, 'info');
    assert.match(hit.message, /dev-only tool/);
    assert.doesNotMatch(hit.message, /ships/);
  });

  it('FIRES (error): the same line in frontend/src/lib/api.js, and in a shipped public/scripts/ file', async () => {
    const found = await scanWith(HardcodedUrlModule, { 'frontend/src/lib/api.js': LINE, 'public/scripts/app.js': LINE });
    for (const rel of ['frontend/src/lib/api.js', 'public/scripts/app.js']) {
      const hit = found.find((c) => c.name === `hardcoded-url:localhost:${rel}:1`);
      assert.ok(hit, `${rel}: ${JSON.stringify(found)}`);
      assert.equal(hit.severity, 'error', rel);
      assert.match(hit.message, /the moment this ships/);
    }
  });
});

describe('dataIntegrity — a dev tool seeding its own browser context is not shipped PII (DR-6)', () => {
  const LINE = "localStorage.setItem('davenroe_token', 'mock-jwt-token');\n";

  it('QUIET: frontend/scripts/inspect.mjs', async () => {
    const found = await scanWith(DataIntegrityModule, { 'frontend/scripts/inspect.mjs': LINE, 'package.json': '{"name":"t"}' });
    assert.deepEqual(found.filter((c) => c.name.startsWith('data:pii')).map((c) => c.name), []);
  });

  it('FIRES: frontend/src/contexts/AuthContext.jsx', async () => {
    const found = await scanWith(DataIntegrityModule, { 'frontend/src/contexts/AuthContext.jsx': LINE, 'package.json': '{"name":"t"}' });
    assert.deepEqual(found.filter((c) => c.name.startsWith('data:pii')).map((c) => c.name), [
      'data:pii:Sensitive data in localStorage:frontend/src/contexts/AuthContext.jsx',
    ]);
  });
});
