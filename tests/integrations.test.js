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
    'integrations/github-actions/ai-ci-fixer.yml',
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

  it('pre-push hook must NEVER block — always exits 0 (painkiller philosophy)', () => {
    // Craig 2026-05-29: "GateTest needs to be the fixer, not the blocker."
    // The local pre-push hook is advisory; the CI gate is the enforcement layer.
    const hook = fs.readFileSync(path.join(ROOT, 'integrations/husky/pre-push'), 'utf8');

    // The hook must NOT propagate the gate's exit code to git.
    // Forbidden pattern: `exit "$status"` or `exit $status` on the gate path.
    assert.doesNotMatch(
      hook,
      /exit\s+"?\$\{?(status|gate_status)\}?"?/,
      'pre-push hook must not exit non-zero on gate findings — it is advisory only.',
    );

    // The hook must explicitly end with `exit 0` so the contract is obvious.
    assert.match(
      hook,
      /exit\s+0\s*$/m,
      'pre-push hook must end with an explicit `exit 0` to prove the never-block contract.',
    );
  });

  it('pre-push hook recognises admin mode (silent pass on our own projects)', () => {
    const hook = fs.readFileSync(path.join(ROOT, 'integrations/husky/pre-push'), 'utf8');
    assert.match(hook, /GATETEST_ADMIN/, 'pre-push hook must honour GATETEST_ADMIN=1.');
    assert.match(hook, /crclabs-hq/, 'pre-push hook must auto-detect owner=crclabs-hq as admin.');
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

  // The AI CI-fixer template lives in arbitrary customer repos that may
  // lack package-lock.json. `cache: 'npm'` on setup-node@v4 fails fast
  // (~8s) without a lockfile — the exact failure mode that killed the
  // arena demo. The template must NEVER reintroduce this trap.
  it('AI CI-fixer template must NOT use `cache: npm` (lockfile-free safe)', () => {
    const wf = fs.readFileSync(
      path.join(ROOT, 'integrations/github-actions/ai-ci-fixer.yml'),
      'utf8',
    );
    // Scan non-comment lines only — comments may reference the trap by
    // name to explain why it's omitted. Real usage would be at the start
    // of a YAML key, e.g. `          cache: 'npm'`.
    const hasRealCacheNpm = wf
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .some((line) => /^\s*cache:\s*['"]?npm['"]?\s*$/.test(line));
    assert.ok(
      !hasRealCacheNpm,
      'AI CI-fixer template must not use cache:npm — breaks any repo without a lockfile.',
    );
  });

  it('AI CI-fixer template must clone the GateTest repo at runtime', () => {
    const wf = fs.readFileSync(
      path.join(ROOT, 'integrations/github-actions/ai-ci-fixer.yml'),
      'utf8',
    );
    assert.match(
      wf,
      /git clone[^\n]*crclabs-hq\/gatetest/,
      'AI CI-fixer template must clone GateTest at runtime so the fixer script is available.',
    );
  });

  it('AI CI-fixer template must gate on ANTHROPIC_API_KEY presence (opt-in via secret)', () => {
    const wf = fs.readFileSync(
      path.join(ROOT, 'integrations/github-actions/ai-ci-fixer.yml'),
      'utf8',
    );
    assert.match(
      wf,
      /ANTHROPIC_API_KEY/,
      'AI CI-fixer template must read ANTHROPIC_API_KEY — presence-of-key is the opt-in contract.',
    );
    assert.match(
      wf,
      /GATETEST_AI_CI_FIXER/,
      'AI CI-fixer template must honor the GATETEST_AI_CI_FIXER opt-out variable.',
    );
  });

  it('AI CI-fixer template must only run on failed workflow_run events', () => {
    const wf = fs.readFileSync(
      path.join(ROOT, 'integrations/github-actions/ai-ci-fixer.yml'),
      'utf8',
    );
    assert.match(wf, /workflow_run:/, 'AI CI-fixer template must trigger on workflow_run.');
    assert.match(
      wf,
      /conclusion\s*==\s*'failure'/,
      'AI CI-fixer template must only fire when the upstream workflow failed.',
    );
  });
});
