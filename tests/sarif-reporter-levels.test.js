// SARIF carries what the gate would act on: errors and warnings. Info-level
// nits and .gatetestignore suppressions are omitted — GitHub Code Scanning
// posts every uploaded result as a PR review comment (PR #418, 2026-09-02).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { SarifReporter } = require('../src/reporters/sarif-reporter');

function summaryWith(checks) {
  return { results: [{ module: 'hardcodedUrl', checks }], summary: { duration: 1 } };
}
function results(reporter, summary) {
  const sarif = reporter._buildSarif(summary);
  return sarif.runs[0].results;
}

describe('sarif — levels that ride', () => {
  const runner = { on() {}, projectRoot: process.cwd() };
  const reporter = new SarifReporter(runner, { projectRoot: process.cwd() });
  it('omits info-level and suppressed findings, keeps errors and warnings', () => {
    const r = results(reporter, summaryWith([
      { name: 'hardcoded-url:localhost:tests/x.test.js:1', passed: false, severity: 'info', message: 'nit', file: 'tests/x.test.js', line: 1 },
      { name: 'hardcoded-url:localhost:src/y.js:2', passed: false, severity: 'warning', message: 'warn', file: 'src/y.js', line: 2 },
      { name: 'hardcoded-url:localhost:src/z.js:3', passed: false, severity: 'error', message: 'err', file: 'src/z.js', line: 3 },
      { name: 'hardcoded-url:localhost:src/w.js:4', passed: false, severity: 'error', message: 'muted', file: 'src/w.js', line: 4, suppressReason: 'gatetestignore' },
      { name: 'hardcoded-url:ok', passed: true },
    ]));
    assert.deepStrictEqual(r.map((x) => x.level).sort(), ['error', 'warning']);
  });
});

// Accepted-risk overrides (move 3, docs/LAUNCH_BOARD.md) render as SARIF
// suppressions — GitHub Code Scanning then shows the alert dismissed WITH a
// reason, instead of a live alert nobody can see was actually accepted.
describe('sarif — accepted-risk overrides render as suppressions', () => {
  const runner = { on() {}, projectRoot: process.cwd() };
  const reporter = new SarifReporter(runner, { projectRoot: process.cwd() });

  it('an active override adds a `suppressions` block with kind external and the reason', () => {
    const r = results(reporter, summaryWith([
      {
        name: 'hardcoded-url:localhost:src/z.js:3', passed: false, severity: 'error',
        message: 'err', file: 'src/z.js', line: 3,
        overriddenBy: { id: 'hardcodedUrl:localhost', reason: 'internal tool, not exposed', by: 'craig', until: '2099-01-01' },
      },
    ]));
    assert.equal(r.length, 1);
    assert.deepStrictEqual(r[0].suppressions, [{
      kind: 'external',
      justification: 'Accepted risk (accepted by craig), until 2099-01-01: internal tool, not exposed',
    }]);
    assert.equal(r[0].properties.blocking, false, 'overridden finding is never reported blocking');
  });

  it('an EXPIRED override carries no suppression — it is a live alert again', () => {
    const r = results(reporter, summaryWith([
      {
        name: 'hardcoded-url:localhost:src/z.js:3', passed: false, severity: 'error',
        message: 'err [accepted-risk override by craig expired 2020-01-01 — now blocking]', file: 'src/z.js', line: 3,
        expiredOverride: { id: 'hardcodedUrl:localhost', reason: 'was fine', by: 'craig', until: '2020-01-01' },
      },
    ]));
    assert.equal(r.length, 1);
    assert.equal(r[0].suppressions, undefined);
    assert.equal(r[0].level, 'error');
  });
});
