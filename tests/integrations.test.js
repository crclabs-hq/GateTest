// ============================================================================
// PROTECTED INTEGRATION GUARD TEST
// ============================================================================
// This test fails if any protected integration artifact is removed or
// silently weakened. It is the tripwire that stops a future Claude session
// from deleting platform protection.
//
// DO NOT remove or weaken this test without Craig's explicit authorization.
// See CLAUDE.md → "PROTECTED PLATFORMS" and "THE FORBIDDEN LIST".
// ============================================================================
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

describe('Protected integration artifacts', () => {
  const requiredFiles = [
    'integrations/README.md',
    'integrations/github-actions/gatetest-gate.yml',
    'integrations/husky/pre-push',
    'integrations/scripts/install.sh',
  ];

  for (const rel of requiredFiles) {
    it(`must exist: ${rel}`, () => {
      const full = path.join(ROOT, rel);
      assert.ok(
        fs.existsSync(full),
        `Protected integration file missing: ${rel}. See CLAUDE.md → PROTECTED PLATFORMS.`,
      );
      assert.ok(fs.statSync(full).size > 0, `Protected integration file is empty: ${rel}`);
    });
  }

  it('CI workflow must not set continue-on-error on the gate step', () => {
    const wf = fs.readFileSync(
      path.join(ROOT, 'integrations/github-actions/gatetest-gate.yml'),
      'utf8',
    );
    // continue-on-error is allowed ONLY on the SARIF upload fallback,
    // never on the gate steps themselves.
    const gateStepRegex = /gatetest\.js[^\n]*\n(\s+continue-on-error:\s*true)/;
    assert.ok(
      !gateStepRegex.test(wf),
      'Gate step must not be soft-failed. Remove continue-on-error: true from the gate.',
    );
  });

  it('CI workflow must reference the GateTest repo', () => {
    const wf = fs.readFileSync(
      path.join(ROOT, 'integrations/github-actions/gatetest-gate.yml'),
      'utf8',
    );
    assert.match(
      wf,
      /crclabs-hq\/gatetest/,
      'CI workflow must clone the canonical GateTest repository.',
    );
  });

  it('pre-push hook must run the gatetest CLI', () => {
    const hook = fs.readFileSync(path.join(ROOT, 'integrations/husky/pre-push'), 'utf8');
    assert.match(hook, /gatetest\.js/, 'pre-push hook must invoke the GateTest CLI.');
  });

  it('install script must write a .gatetest.json protection marker', () => {
    const sh = fs.readFileSync(path.join(ROOT, 'integrations/scripts/install.sh'), 'utf8');
    assert.match(sh, /\.gatetest\.json/, 'install.sh must write the protection marker.');
  });

  it('CLAUDE.md must declare the PROTECTED PLATFORMS section', () => {
    const bible = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    assert.match(
      bible,
      /PROTECTED PLATFORMS/,
      'CLAUDE.md must retain the PROTECTED PLATFORMS section so every session reads it at startup.',
    );
  });

  it('CLAUDE.md must list Crontech and Gluecron as protected platforms', () => {
    const bible = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    assert.match(bible, /Crontech/i, 'Crontech must be listed in CLAUDE.md PROTECTED PLATFORMS.');
    assert.match(bible, /Gluecron/i, 'Gluecron must be listed in CLAUDE.md PROTECTED PLATFORMS.');
  });
});
