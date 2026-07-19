// ============================================================================
// VS CODE EXTENSION — map-findings.js pure-function tests
// ============================================================================
// Covers editors/vscode/lib/map-findings.js, the only piece of the VS Code
// extension testable without a real `vscode` module / Extension Host.
// extension.js (the vscode-API wiring layer) is intentionally NOT covered
// here — see editors/vscode/README.md for how to exercise it via F5.
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { mapSummaryToDiagnostics, toVscodeSeverity } = require(path.resolve(
  __dirname,
  '..',
  'editors',
  'vscode',
  'lib',
  'map-findings.js'
));

const ROOT = path.join('C:', 'proj');

function makeSummary(results) {
  return { results };
}

describe('toVscodeSeverity', () => {
  it('maps error and critical to Error', () => {
    assert.strictEqual(toVscodeSeverity('error'), 'Error');
    assert.strictEqual(toVscodeSeverity('critical'), 'Error');
    assert.strictEqual(toVscodeSeverity('ERROR'), 'Error');
  });

  it('maps warning to Warning', () => {
    assert.strictEqual(toVscodeSeverity('warning'), 'Warning');
  });

  it('maps unknown/info/undefined to Information', () => {
    assert.strictEqual(toVscodeSeverity('info'), 'Information');
    assert.strictEqual(toVscodeSeverity(undefined), 'Information');
    assert.strictEqual(toVscodeSeverity('something-else'), 'Information');
  });
});

describe('mapSummaryToDiagnostics', () => {
  it('groups checks by resolved absolute file path', () => {
    const summary = makeSummary([
      {
        module: 'secrets',
        checks: [
          { file: 'src/auth/login.js', line: 5, severity: 'error', message: 'hardcoded secret' },
        ],
      },
    ]);
    const byFile = mapSummaryToDiagnostics(summary, ROOT);
    const key = path.join(ROOT, 'src/auth/login.js');
    assert.strictEqual(byFile.size, 1);
    assert.ok(byFile.has(key));
    assert.strictEqual(byFile.get(key).length, 1);
  });

  it('converts 1-indexed GateTest lines to 0-indexed VS Code lines', () => {
    const summary = makeSummary([
      { module: 'lint', checks: [{ file: 'a.js', line: 12, severity: 'warning', message: 'x' }] },
    ]);
    const byFile = mapSummaryToDiagnostics(summary, ROOT);
    const entry = byFile.get(path.join(ROOT, 'a.js'))[0];
    assert.strictEqual(entry.line, 11);
  });

  it('falls back to line 0 when line is missing or non-numeric', () => {
    const summary = makeSummary([
      { module: 'lint', checks: [{ file: 'a.js', severity: 'warning', message: 'x' }] },
    ]);
    const byFile = mapSummaryToDiagnostics(summary, ROOT);
    assert.strictEqual(byFile.get(path.join(ROOT, 'a.js'))[0].line, 0);
  });

  it('skips passed checks', () => {
    const summary = makeSummary([
      { module: 'lint', checks: [{ file: 'a.js', line: 1, severity: 'error', passed: true, message: 'x' }] },
    ]);
    const byFile = mapSummaryToDiagnostics(summary, ROOT);
    assert.strictEqual(byFile.size, 0);
  });

  it('skips suppressed checks (.gatetestignore)', () => {
    const summary = makeSummary([
      { module: 'lint', checks: [{ file: 'a.js', line: 1, severity: 'error', suppressed: true, message: 'x' }] },
    ]);
    const byFile = mapSummaryToDiagnostics(summary, ROOT);
    assert.strictEqual(byFile.size, 0);
  });

  it('skips checks with no file (project-level findings)', () => {
    const summary = makeSummary([
      { module: 'seo', checks: [{ line: 1, severity: 'error', message: 'missing sitemap' }] },
    ]);
    const byFile = mapSummaryToDiagnostics(summary, ROOT);
    assert.strictEqual(byFile.size, 0);
  });

  it('leaves an already-absolute check.file untouched', () => {
    const absFile = path.join('D:', 'elsewhere', 'b.js');
    const summary = makeSummary([
      { module: 'lint', checks: [{ file: absFile, line: 1, severity: 'error', message: 'x' }] },
    ]);
    const byFile = mapSummaryToDiagnostics(summary, ROOT);
    assert.ok(byFile.has(absFile));
  });

  it('falls back message -> suggestion -> name -> module label, in that order', () => {
    const summary = makeSummary([
      { module: 'security', checks: [{ file: 'a.js', line: 1, severity: 'error', suggestion: 'fix it', name: 'sql-injection' }] },
    ]);
    const entry = mapSummaryToDiagnostics(summary, ROOT).get(path.join(ROOT, 'a.js'))[0];
    assert.strictEqual(entry.message, 'fix it');

    const summary2 = makeSummary([
      { module: 'security', checks: [{ file: 'a.js', line: 1, severity: 'error', name: 'sql-injection' }] },
    ]);
    const entry2 = mapSummaryToDiagnostics(summary2, ROOT).get(path.join(ROOT, 'a.js'))[0];
    assert.strictEqual(entry2.message, 'sql-injection');

    const summary3 = makeSummary([
      { module: 'security', checks: [{ file: 'a.js', line: 1, severity: 'error' }] },
    ]);
    const entry3 = mapSummaryToDiagnostics(summary3, ROOT).get(path.join(ROOT, 'a.js'))[0];
    assert.strictEqual(entry3.message, 'security finding');
  });

  it('sets source to gatetest:<module> and code to the rule name', () => {
    const summary = makeSummary([
      { module: 'security', checks: [{ file: 'a.js', line: 1, severity: 'error', name: 'sql-injection', message: 'x' }] },
    ]);
    const entry = mapSummaryToDiagnostics(summary, ROOT).get(path.join(ROOT, 'a.js'))[0];
    assert.strictEqual(entry.source, 'gatetest:security');
    assert.strictEqual(entry.ruleName, 'sql-injection');
  });

  it('accumulates multiple findings for the same file across modules', () => {
    const summary = makeSummary([
      { module: 'lint', checks: [{ file: 'a.js', line: 1, severity: 'warning', message: 'w1' }] },
      { module: 'security', checks: [{ file: 'a.js', line: 2, severity: 'error', message: 'e1' }] },
    ]);
    const byFile = mapSummaryToDiagnostics(summary, ROOT);
    assert.strictEqual(byFile.get(path.join(ROOT, 'a.js')).length, 2);
  });

  it('returns an empty map for a summary with no results', () => {
    assert.strictEqual(mapSummaryToDiagnostics(makeSummary([]), ROOT).size, 0);
    assert.strictEqual(mapSummaryToDiagnostics({}, ROOT).size, 0);
  });
});
