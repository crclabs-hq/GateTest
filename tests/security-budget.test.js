// =============================================================================
// SECURITY MODULE — soft file-scan time budget (move 1, launch-board,
// 2026-09-25; pattern follows #650's typescript-strict:budget in
// src/modules/syntax.js).
// =============================================================================
// `security` joined the `standard` suite in this move. Its six file-scanning
// checks (source patterns, SQL injection, weak hashing, prototype pollution,
// path traversal, secret scan) each walk every source file independently, so
// on a very large tree their combined cost can approach the runner's
// per-module wall-clock timeout (DEFAULT_MODULE_TIMEOUT_MS,
// src/core/runner.js) — which throws and fails the WHOLE module, reporting
// nothing it had already found. This is the soft internal deadline that
// stops early instead: never a fake pass (silently skipping and reporting
// "0 issues"), never a false block (the hard timeout crashing the module).
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SecurityModule = require('../src/modules/security');

function makeResult() {
  const checks = [];
  return {
    checks,
    addCheck(rule, passed, meta = {}) {
      checks.push({ rule, passed, severity: meta.severity || (passed ? 'info' : 'error'), ...meta });
    },
    errors() { return this.checks.filter((c) => !c.passed && c.severity === 'error'); },
  };
}

function withTmp(prefix, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('security module — file-scan time budget', () => {
  it('an already-exhausted budget is a soft, non-blocking note — never a false block', () => withTmp('gt-secbudget-', async (tmp) => {
    fs.writeFileSync(path.join(tmp, 'app.js'), 'console.log("hello");\n');
    const mod = new SecurityModule();
    const result = makeResult();
    // Negative timeBudgetMs = already expired before the first file-scanning
    // check runs, forcing every one of the six to be skipped deterministically.
    const config = { projectRoot: tmp, getModuleConfig: (name) => (name === 'security' ? { fileScanTimeBudgetMs: -1 } : {}) };
    await mod.run(result, config);

    const budgetCheck = result.checks.find((c) => c.rule === 'security:budget');
    assert.ok(budgetCheck, 'an exhausted budget must be disclosed as security:budget');
    assert.strictEqual(budgetCheck.passed, true, 'a budget cut must never block the gate');
    assert.strictEqual(budgetCheck.severity, 'info', 'a budget cut is informational, not an error');
    assert.match(budgetCheck.message, /budget cut after 0\/6 checks/, 'must say exactly how many of the six checks ran');
    for (const label of ['source patterns', 'SQL injection', 'weak password hashing', 'prototype pollution', 'path traversal', 'secret scan']) {
      assert.ok(budgetCheck.message.includes(label), `skipped checks must be named: missing "${label}"`);
    }
    // Never a fake pass: the three scans that normally print a clean-summary
    // check ("Scanned N files", "no known plaintext secrets", etc.) must not
    // print anything at all when they were skipped by budget — a bare
    // "clean" from a check that never ran would be exactly the fake pass
    // this mechanism exists to prevent.
    for (const rule of ['security:source-scan', 'security:sql-injection-scan', 'security:secrets-scan']) {
      assert.ok(!result.checks.some((c) => c.rule === rule), `"${rule}" must not report anything when its scan was skipped by budget`);
    }
    // Never a false block either: the module as a whole must not error out.
    assert.strictEqual(result.errors().filter((c) => c.rule === 'security:budget').length, 0);
  }));

  it('a generous budget (the default) runs every file-scanning check — no false negative from an over-eager cut', () => withTmp('gt-secbudget-ok-', async (tmp) => {
    fs.writeFileSync(path.join(tmp, 'app.js'), 'console.log("hello");\n');
    const mod = new SecurityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    assert.ok(!result.checks.some((c) => c.rule === 'security:budget'), 'a small test tree must finish well inside the default budget — no budget note expected');
  }));
});
