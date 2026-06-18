'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// We test the orchestrator with a mock callAnthropic injected via
// the ai-fix-engine's module cache. This keeps tests hermetic (no real
// Anthropic calls) while exercising the full fix-attempt-loop +
// syntax-gate + test-gen + pr-composer pipeline.

describe('cli-fix-orchestrator', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-orch-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports runFixOrchestration', () => {
    const { runFixOrchestration } = require('../src/core/cli-fix-orchestrator');
    assert.equal(typeof runFixOrchestration, 'function');
  });

  it('returns no fixes for findings with no file', async () => {
    const { runFixOrchestration } = require('../src/core/cli-fix-orchestrator');
    const findings = [
      { moduleName: 'ciSecurity', checkName: 'missing-timeout', message: 'No timeout set', severity: 'warning' },
    ];
    const result = await runFixOrchestration(findings, tmpDir, 'dummy-key');
    assert.equal(result.accepted.length, 0);
    assert.equal(result.allFixes.length, 0);
    assert.equal(typeof result.prBody, 'string');
  });

  it('skips a file that does not exist', async () => {
    const { runFixOrchestration } = require('../src/core/cli-fix-orchestrator');
    const findings = [
      { file: 'nonexistent.js', moduleName: 'lint', checkName: 'no-console', message: 'no console.log', severity: 'error' },
    ];
    const result = await runFixOrchestration(findings, tmpDir, 'dummy-key');
    assert.equal(result.accepted.length, 0);
    assert.ok(result.errorStrings.some((e) => e.includes('nonexistent.js')));
  });

  it('skips files that are too large', async () => {
    const bigFile = path.join(tmpDir, 'big.js');
    fs.writeFileSync(bigFile, 'x'.repeat(121_000));
    const { runFixOrchestration } = require('../src/core/cli-fix-orchestrator');
    const findings = [
      { file: 'big.js', moduleName: 'lint', checkName: 'no-console', message: 'console.log found', severity: 'error' },
    ];
    const result = await runFixOrchestration(findings, tmpDir, 'dummy-key');
    assert.equal(result.accepted.length, 0);
    assert.ok(result.errorStrings.some((e) => e.includes('big.js') && e.includes('too large')));
  });

  it('returns a well-formed prBody string even with no fixes', async () => {
    const { runFixOrchestration } = require('../src/core/cli-fix-orchestrator');
    const result = await runFixOrchestration([], tmpDir, 'dummy-key');
    assert.equal(typeof result.prBody, 'string');
    assert.ok(result.prBody.includes('GateTest'));
  });

  it('groups multiple findings on the same file into one entry', async () => {
    const sourceFile = path.join(tmpDir, 'multi.js');
    const originalCode = 'const x = eval("1"); console.log(x);\n';
    fs.writeFileSync(sourceFile, originalCode);

    let capturedPromptIssues = null;
    const mockCallAnthropic = async (_key, _model, _system, prompt) => {
      capturedPromptIssues = prompt;
      // Return unchanged — will be rejected by validateFix "no changes made"
      return originalCode;
    };

    const { runFixOrchestration } = require('../src/core/cli-fix-orchestrator');
    const findings = [
      { file: 'multi.js', moduleName: 'security', checkName: 'no-eval', message: 'eval() found', severity: 'error' },
      { file: 'multi.js', moduleName: 'quality', checkName: 'no-console', message: 'console.log found', severity: 'warning' },
    ];
    const result = await runFixOrchestration(findings, tmpDir, 'test-key', { _callAnthropic: mockCallAnthropic });
    // Both issues should have been batched in one prompt
    assert.ok(capturedPromptIssues !== null, 'Claude was called');
    assert.ok(capturedPromptIssues.includes('eval()'), 'prompt includes first issue');
    assert.ok(capturedPromptIssues.includes('console.log'), 'prompt includes second issue');
    // No accepted fix (unchanged response = "no changes made")
    assert.equal(result.accepted.length, 0);
  });

  it('produces a fix when Claude returns changed content', async () => {
    const sourceFile = path.join(tmpDir, 'fixable.js');
    fs.writeFileSync(sourceFile, 'function greet() {\n  console.log("hello");\n}\nmodule.exports = { greet };\n');

    const mockCallAnthropic = async (_key, _model, _system, prompt) => {
      if (prompt.includes('ISSUES TO FIX')) {
        // Return a version with console.log replaced (valid JS)
        return 'function greet() {\n  process.stderr.write("hello\\n");\n}\nmodule.exports = { greet };\n';
      }
      // Test generation call — return SKIP
      return 'SKIP';
    };

    const { runFixOrchestration } = require('../src/core/cli-fix-orchestrator');
    const findings = [
      { file: 'fixable.js', moduleName: 'quality', checkName: 'no-console', message: 'console.log found at line 2', severity: 'error' },
    ];
    const result = await runFixOrchestration(findings, tmpDir, 'test-key', { _callAnthropic: mockCallAnthropic });
    assert.equal(result.accepted.length, 1, 'one fix accepted');
    assert.equal(result.accepted[0].file, 'fixable.js');
    assert.ok(result.accepted[0].fixed.includes('process.stderr.write'));
    assert.ok(result.prBody.includes('GateTest Auto-Fix Report'));
  });

  it('syntax gate rejects a JS fix with broken syntax', async () => {
    const sourceFile = path.join(tmpDir, 'broken.js');
    fs.writeFileSync(sourceFile, 'const x = 1;\n');

    const mockCallAnthropic = async () => 'const x = 1; {{{ broken syntax\n';

    const { runFixOrchestration } = require('../src/core/cli-fix-orchestrator');
    const findings = [
      { file: 'broken.js', moduleName: 'lint', checkName: 'test', message: 'test', severity: 'error' },
    ];
    const result = await runFixOrchestration(findings, tmpDir, 'test-key', { _callAnthropic: mockCallAnthropic });
    // Fix should be rejected by the syntax gate
    assert.equal(result.accepted.length, 0, 'syntax-invalid fix should be rejected');
    assert.ok(result.errorStrings.some((e) => e.includes('syntax gate')));
  });

  it('result contains all expected shape fields', async () => {
    const { runFixOrchestration } = require('../src/core/cli-fix-orchestrator');
    const result = await runFixOrchestration([], tmpDir, 'dummy-key');
    assert.ok(Array.isArray(result.accepted));
    assert.ok(Array.isArray(result.testFiles));
    assert.ok(Array.isArray(result.allFixes));
    assert.ok(Array.isArray(result.errorStrings));
    assert.equal(typeof result.attemptHistoryByFile, 'object');
    assert.equal(typeof result.syntaxGate, 'object');
    assert.equal(typeof result.testGenResult, 'object');
    assert.equal(typeof result.prBody, 'string');
  });
});
