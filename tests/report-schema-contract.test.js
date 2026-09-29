// =============================================================================
// THE REPORT SHAPE IS A CONTRACT (issue #803)
// =============================================================================
// Tallrig's admin tab parses `.gatetest/reports/gatetest-report-<ts>.json`
// hourly (`summary.checks`, `findings[]`, `results[].checks[]`); AlecRae and
// the hosted /web scan read the same file. Until now the report had no
// `schemaVersion` and nothing pinned its fields, so a rename here would have
// broken a sibling platform with no failing test on our side.
//
// This test runs the real CLI on a small fixture that produces a real
// finding, then checks the stable field set in src/core/report-schema.js.
// Removing or renaming a pinned key fails with the key's path; ADDING a key
// passes. The control pair is the same function fed reports with a key
// removed: it must fail and name the key.
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  REPORT_SCHEMA_VERSION, REPORT_CONTRACT, checkReportContract,
} = require('../src/core/report-schema');
const { GateTestRunner } = require('../src/core/runner');
const { GateTestConfig } = require('../src/core/config');
const { SarifReporter } = require('../src/reporters/sarif-reporter');
const { JunitReporter } = require('../src/reporters/junit-reporter');

const CLI = path.join(__dirname, '..', 'bin', 'gatetest.js');

let root;
let report;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-schema-contract-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fx","version":"1.0.0"}\n');
  // A hard-coded credential: the `secrets` module turns it into a real,
  // failing check with `details[]`, so `findings[]` is non-empty.
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const password = "hunter2hunter2";\n');
  // BLOCKED is expected (exit non-zero); only the written report matters.
  spawnSync(process.execPath, [CLI, '--project', root, '--module', 'secrets'], {
    env: { ...process.env, GATETEST_NO_TELEMETRY: '1', GATETEST_ADMIN: '' },
    encoding: 'utf8',
    timeout: 120000,
  });
  report = JSON.parse(fs.readFileSync(path.join(root, '.gatetest', 'reports', 'gatetest-report-latest.json'), 'utf8'));
});

after(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('report schema contract', () => {
  it('a real report carries schemaVersion 1 at the top level', () => {
    assert.strictEqual(REPORT_SCHEMA_VERSION, 1);
    assert.strictEqual(report.schemaVersion, REPORT_SCHEMA_VERSION);
  });

  it('a real report satisfies every pinned field (additions are allowed)', () => {
    const { ok, missing } = checkReportContract(report);
    assert.ok(ok, `pinned fields missing from the report: ${missing.join(', ')}`);
  });

  it('the fixture really exercised findings[] and a failed check', () => {
    assert.ok(report.findings.length > 0, 'fixture must yield at least one finding');
    const failed = report.results.flatMap((r) => r.checks).filter((c) => c.passed === false);
    assert.ok(failed.length > 0, 'fixture must yield at least one failed check');
    assert.ok(failed.some((c) => Array.isArray(c.details)), 'a failed check carries details[]');
  });

  it('the additive rule: an extra key at every level still passes', () => {
    const extended = JSON.parse(JSON.stringify(report));
    extended.newTopLevel = 1;
    extended.summary.newSummaryKey = 1;
    extended.summary.checks.newCount = 1;
    extended.findings[0].newFindingKey = 1;
    extended.results[0].newResultKey = 1;
    extended.results[0].checks[0].newCheckKey = 1;
    assert.deepStrictEqual(checkReportContract(extended), { ok: true, missing: [] });
  });

  it('every documented key appears in docs/api/report-schema.md', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'api', 'report-schema.md'), 'utf8');
    for (const [where, keys] of Object.entries(REPORT_CONTRACT)) {
      for (const k of keys) assert.ok(doc.includes('`' + k + '`'), `${where}.${k} is pinned but undocumented`);
    }
  });
});

describe('report schema contract — control pair (removal or rename must fail, naming the key)', () => {
  const clone = () => JSON.parse(JSON.stringify(report));

  it('a report missing summary.checks fails and names it', () => {
    const r = clone();
    delete r.summary.checks;
    const { ok, missing } = checkReportContract(r);
    assert.strictEqual(ok, false);
    assert.ok(missing.includes('summary.checks'), missing.join(', '));
  });

  it('a report with no schemaVersion fails', () => {
    const r = clone();
    delete r.schemaVersion;
    assert.ok(checkReportContract(r).missing.includes('$.schemaVersion'));
  });

  it('a renamed summary.checks key fails and names the old name', () => {
    const r = clone();
    r.summary.checks.blockers = r.summary.checks.blockingErrors;
    delete r.summary.checks.blockingErrors;
    assert.ok(checkReportContract(r).missing.includes('summary.checks.blockingErrors'));
  });

  it('a renamed finding key fails and names the old name', () => {
    const r = clone();
    r.findings[0].ruleId = r.findings[0].rule;
    delete r.findings[0].rule;
    assert.ok(checkReportContract(r).missing.includes('findings[0].rule'));
  });

  it('a check missing verdictSource fails and names the path', () => {
    const r = clone();
    delete r.results[0].checks[0].verdictSource;
    assert.ok(checkReportContract(r).missing.includes('results[0].checks[0].verdictSource'));
  });

  it('a failed check missing message fails; the same key on a passed check does not', () => {
    const r = clone();
    const checks = r.results.flatMap((x) => x.checks);
    const failed = checks.find((c) => c.passed === false);
    // The fixture may have no passing check; a passed clone stands in.
    const passed = checks.find((c) => c.passed === true) || (() => {
      const c = { ...failed, passed: true };
      r.results[0].checks.push(c);
      return c;
    })();
    delete passed.message;
    assert.deepStrictEqual(checkReportContract(r), { ok: true, missing: [] });
    delete failed.message;
    assert.strictEqual(checkReportContract(r).ok, false);
  });

  it('a non-report fails rather than throws', () => {
    assert.strictEqual(checkReportContract(null).ok, false);
    assert.strictEqual(checkReportContract([]).ok, false);
  });
});

describe('schemaVersion in the other report formats', () => {
  let tmpDir;
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-schema-fmt-'));
    fs.mkdirSync(path.join(tmpDir, '.gatetest', 'reports'), { recursive: true });
    const config = new GateTestConfig(tmpDir);
    const runner = new GateTestRunner(config);
    new SarifReporter(runner, config);
    new JunitReporter(runner, config);
    runner.register('mod', { async run(result) { result.addCheck('c', true); } });
    await runner.run(['mod']);
  });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('SARIF: runs[0].properties.gatetestSchemaVersion', () => {
    const sarif = JSON.parse(fs.readFileSync(path.join(tmpDir, '.gatetest', 'reports', 'gatetest-results.sarif'), 'utf8'));
    assert.strictEqual(sarif.runs[0].properties.gatetestSchemaVersion, REPORT_SCHEMA_VERSION);
  });

  it('JUnit: schemaVersion attribute on <testsuites>', () => {
    const xml = fs.readFileSync(path.join(tmpDir, '.gatetest', 'reports', 'gatetest-results.xml'), 'utf8');
    assert.match(xml, new RegExp(`<testsuites [^>]*schemaVersion="${REPORT_SCHEMA_VERSION}"`));
  });
});
