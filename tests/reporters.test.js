const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { GateTestRunner, TestResult } = require('../src/core/runner');
const { GateTestConfig } = require('../src/core/config');
const { SarifReporter } = require('../src/reporters/sarif-reporter');
const { JunitReporter } = require('../src/reporters/junit-reporter');

describe('SarifReporter', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-sarif-'));
    fs.mkdirSync(path.join(tmpDir, '.gatetest', 'reports'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should generate valid SARIF 2.1.0 output', async () => {
    const config = new GateTestConfig(tmpDir);
    const runner = new GateTestRunner(config);
    new SarifReporter(runner, config);

    runner.register('test-mod', {
      async run(result) {
        result.addCheck('pass-check', true);
        result.addCheck('fail-check', false, {
          severity: 'error',
          file: 'src/index.js',
          line: 42,
          message: 'Found a bug',
          suggestion: 'Fix the bug',
        });
        result.addCheck('warn-check', false, {
          severity: 'warning',
          message: 'Minor issue',
        });
      },
    });

    await runner.run(['test-mod']);

    const sarifPath = path.join(tmpDir, '.gatetest', 'reports', 'gatetest-results.sarif');
    assert.ok(fs.existsSync(sarifPath), 'SARIF file should exist');

    const sarif = JSON.parse(fs.readFileSync(sarifPath, 'utf-8'));
    assert.strictEqual(sarif.version, '2.1.0');
    assert.strictEqual(sarif.runs.length, 1);
    assert.strictEqual(sarif.runs[0].tool.driver.name, 'GateTest');
    assert.ok(sarif.runs[0].results.length >= 2, 'Should have at least 2 results (failures)');

    // Check that error levels are mapped correctly
    const errorResult = sarif.runs[0].results.find(r => r.level === 'error');
    assert.ok(errorResult, 'Should have an error-level result');

    const warningResult = sarif.runs[0].results.find(r => r.level === 'warning');
    assert.ok(warningResult, 'Should have a warning-level result');
  });

  it('should include file locations in SARIF', async () => {
    const config = new GateTestConfig(tmpDir);
    const runner = new GateTestRunner(config);
    new SarifReporter(runner, config);

    runner.register('loc-mod', {
      async run(result) {
        result.addCheck('located', false, {
          severity: 'error',
          file: 'src/main.js',
          line: 10,
          message: 'Issue here',
        });
      },
    });

    await runner.run(['loc-mod']);

    const sarif = JSON.parse(fs.readFileSync(
      path.join(tmpDir, '.gatetest', 'reports', 'gatetest-results.sarif'), 'utf-8'
    ));

    const result = sarif.runs[0].results[0];
    assert.ok(result.locations, 'Should have locations');
    assert.strictEqual(result.locations[0].physicalLocation.artifactLocation.uri, 'src/main.js');
    assert.strictEqual(result.locations[0].physicalLocation.region.startLine, 10);
  });

  // Regression: GitHub Code Scanning rejected SARIF uploads with
  // "locationFromSarifResult: expected at least one location" when any
  // single result was missing a `locations` array. File-less findings
  // (config-rule violations, repo-wide observations like prSize) must
  // still emit a locations entry — fall back to a project-level URI.
  it('emits locations for findings with no file (uses project-level fallback)', async () => {
    // Seed a package.json so the project-level resolver picks it
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "x"}');
    const config = new GateTestConfig(tmpDir);
    const runner = new GateTestRunner(config);
    new SarifReporter(runner, config);

    runner.register('config-mod', {
      async run(result) {
        result.addCheck('repo-wide-issue', false, {
          severity: 'error',
          message: 'PR exceeds 1000-line ceiling',
          // intentionally no file / line — this is the bug shape
        });
        result.addCheck('also-no-file', false, {
          severity: 'warning',
          message: 'Another config-level finding',
        });
      },
    });

    await runner.run(['config-mod']);

    const sarif = JSON.parse(fs.readFileSync(
      path.join(tmpDir, '.gatetest', 'reports', 'gatetest-results.sarif'), 'utf-8'
    ));

    // Every result MUST have a non-empty locations array — this is what
    // GitHub Code Scanning validates. Asserting it as an invariant
    // prevents the bug from coming back.
    for (const result of sarif.runs[0].results) {
      assert.ok(Array.isArray(result.locations) && result.locations.length > 0,
        `result "${result.ruleId}" missing locations`);
      assert.ok(result.locations[0].physicalLocation.artifactLocation.uri,
        `result "${result.ruleId}" missing artifactLocation.uri`);
    }

    // And specifically: the project-level URI should be package.json
    // (first canonical marker that exists in the project root)
    assert.strictEqual(
      sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
      'package.json'
    );
  });

  // Tier B #6 — enriched metadata: CWE / OWASP / security-severity tags
  // on security-module findings so GitHub Code Scanning renders the
  // findings with proper severity classification + filter tags. Without
  // these properties, all SARIF findings appear as undifferentiated
  // "warning" / "error" — no severity-threshold gating, no CWE lookup,
  // no "external/cwe/cwe-918" filter on the Security tab.
  it('enriches security-module rules with CWE / OWASP / security-severity', async () => {
    const config = new GateTestConfig(tmpDir);
    const runner = new GateTestRunner(config);
    new SarifReporter(runner, config);

    runner.register('ssrf', {
      async run(result) {
        result.addCheck('ssrf-user-input-to-fetch', false, {
          severity: 'error',
          file: 'src/api.ts',
          line: 12,
          message: 'User input handed to fetch() with no validation',
          suggestion: 'Validate URL hostname against an allowlist',
        });
      },
    });

    await runner.run(['ssrf']);

    const sarif = JSON.parse(fs.readFileSync(
      path.join(tmpDir, '.gatetest', 'reports', 'gatetest-results.sarif'), 'utf-8'
    ));

    const rule = sarif.runs[0].tool.driver.rules[0];
    assert.ok(rule.properties);
    assert.strictEqual(rule.properties.cwe, 'CWE-918', 'SSRF must carry CWE-918');
    assert.strictEqual(rule.properties.owasp, 'A10:2021', 'SSRF must carry OWASP A10:2021');
    assert.strictEqual(rule.properties['security-severity'], '8.6',
      'security-severity is required for GitHub branch-protection severity-threshold gating');
    assert.ok(rule.properties.tags.includes('external/cwe/cwe-918'),
      'tags must include external/cwe/<id> so GitHub Security tab filters work');
    assert.ok(rule.properties.tags.includes('ssrf'));
    assert.ok(rule.help.markdown.includes('cwe.mitre.org'),
      'help.markdown must link to the MITRE CWE entry');
  });

  it('does not add security metadata to non-security modules', async () => {
    const config = new GateTestConfig(tmpDir);
    const runner = new GateTestRunner(config);
    new SarifReporter(runner, config);

    runner.register('flakyTests', {
      async run(result) {
        result.addCheck('committed-only', false, {
          severity: 'warning',
          file: 'tests/foo.test.js',
          line: 5,
          message: 'committed .only',
        });
      },
    });

    await runner.run(['flakyTests']);

    const sarif = JSON.parse(fs.readFileSync(
      path.join(tmpDir, '.gatetest', 'reports', 'gatetest-results.sarif'), 'utf-8'
    ));
    const rule = sarif.runs[0].tool.driver.rules[0];
    // No CWE / OWASP — flakyTests isn't in the mapping
    assert.strictEqual(rule.properties.cwe, undefined);
    assert.strictEqual(rule.properties.owasp, undefined);
    assert.strictEqual(rule.properties['security-severity'], undefined);
    // Fallback tag is the module name
    assert.ok(rule.properties.tags.includes('flakyTests'));
  });

  // Regression: Crontech's GateTest scan failed on 2026-05-25 with
  // "'apps/web/src/routes/dashboard/compute/sites/[projectId].tsx' is
  // not a valid URI" when uploading SARIF to GitHub Code Scanning.
  // Files with `[...]` segments (SolidStart / Next.js dynamic routes)
  // need percent-encoding per RFC 3986. Unencoded brackets fail
  // GitHub's CodeQL upload validator.
  it('percent-encodes bracketed dynamic-route file paths (Crontech regression)', async () => {
    const config = new GateTestConfig(tmpDir);
    const runner = new GateTestRunner(config);
    new SarifReporter(runner, config);

    runner.register('mod', {
      async run(result) {
        result.addCheck('bracket-path', false, {
          severity: 'error',
          file: 'apps/web/src/routes/dashboard/compute/sites/[projectId].tsx',
          line: 12,
          message: 'finding in a dynamic route',
        });
        result.addCheck('space-path', false, {
          severity: 'warning',
          file: 'docs/my notes.md',
          line: 1,
          message: 'finding in a path with spaces',
        });
        result.addCheck('parens-path', false, {
          severity: 'warning',
          file: 'app/(marketing)/page.tsx',
          line: 1,
          message: 'finding in a Next.js route group',
        });
      },
    });

    await runner.run(['mod']);

    const sarif = JSON.parse(fs.readFileSync(
      path.join(tmpDir, '.gatetest', 'reports', 'gatetest-results.sarif'), 'utf-8'
    ));

    const uris = sarif.runs[0].results.map(
      (r) => r.locations[0].physicalLocation.artifactLocation.uri
    );
    assert.ok(
      uris.includes('apps/web/src/routes/dashboard/compute/sites/%5BprojectId%5D.tsx'),
      `bracketed segment must be encoded — got URIs: ${JSON.stringify(uris)}`,
    );
    assert.ok(
      uris.includes('docs/my%20notes.md'),
      'spaces in path segments must be encoded as %20',
    );
    assert.ok(
      uris.includes('app/%28marketing%29/page.tsx'),
      'route-group parentheses must be encoded',
    );
    // All URIs must NOT contain raw brackets / spaces / parens — those
    // are exactly what GitHub Code Scanning rejects.
    for (const uri of uris) {
      assert.doesNotMatch(uri, /[\[\]() ]/, `URI "${uri}" contains unencoded reserved char`);
    }
  });

  it('does not double-encode safe characters in normal paths', async () => {
    const config = new GateTestConfig(tmpDir);
    const runner = new GateTestRunner(config);
    new SarifReporter(runner, config);
    runner.register('m', {
      async run(result) {
        result.addCheck('x', false, { severity: 'error', file: 'src/main.ts', line: 1, message: 'x' });
      },
    });
    await runner.run(['m']);
    const sarif = JSON.parse(fs.readFileSync(
      path.join(tmpDir, '.gatetest', 'reports', 'gatetest-results.sarif'), 'utf-8'
    ));
    assert.strictEqual(
      sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
      'src/main.ts',
      'plain ASCII path must round-trip unchanged',
    );
  });

  it('falls back to synthetic marker URI when no project files present', async () => {
    // tmpDir starts empty — none of the canonical markers exist
    const config = new GateTestConfig(tmpDir);
    const runner = new GateTestRunner(config);
    new SarifReporter(runner, config);

    runner.register('empty-repo-mod', {
      async run(result) {
        result.addCheck('no-anchor', false, {
          severity: 'error',
          message: 'Project-level finding',
        });
      },
    });

    await runner.run(['empty-repo-mod']);

    const sarif = JSON.parse(fs.readFileSync(
      path.join(tmpDir, '.gatetest', 'reports', 'gatetest-results.sarif'), 'utf-8'
    ));

    const r = sarif.runs[0].results[0];
    assert.ok(r.locations && r.locations.length > 0, 'must still emit a location');
    assert.strictEqual(r.locations[0].physicalLocation.artifactLocation.uri, '.gatetest-project');
  });
});

describe('JunitReporter', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-junit-'));
    fs.mkdirSync(path.join(tmpDir, '.gatetest', 'reports'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should generate valid JUnit XML', async () => {
    const config = new GateTestConfig(tmpDir);
    const runner = new GateTestRunner(config);
    new JunitReporter(runner, config);

    runner.register('junit-mod', {
      async run(result) {
        result.addCheck('pass', true);
        result.addCheck('fail', false, {
          severity: 'error',
          message: 'Something broke',
          file: 'test.js',
          suggestion: 'Fix it',
        });
      },
    });

    await runner.run(['junit-mod']);

    const xmlPath = path.join(tmpDir, '.gatetest', 'reports', 'gatetest-results.xml');
    assert.ok(fs.existsSync(xmlPath), 'JUnit XML file should exist');

    const xml = fs.readFileSync(xmlPath, 'utf-8');
    assert.ok(xml.startsWith('<?xml'), 'Should start with XML declaration');
    assert.ok(xml.includes('<testsuites'), 'Should have testsuites element');
    assert.ok(xml.includes('<testsuite'), 'Should have testsuite element');
    assert.ok(xml.includes('<testcase'), 'Should have testcase elements');
    assert.ok(xml.includes('<failure'), 'Should have failure element');
    assert.ok(xml.includes('Something broke'), 'Should include error message');
  });

  it('should escape XML special characters', async () => {
    const config = new GateTestConfig(tmpDir);
    const runner = new GateTestRunner(config);
    new JunitReporter(runner, config);

    runner.register('escape-mod', {
      async run(result) {
        result.addCheck('xml-chars', false, {
          severity: 'error',
          message: 'Value < 5 && > 0 with "quotes"',
        });
      },
    });

    await runner.run(['escape-mod']);

    const xml = fs.readFileSync(
      path.join(tmpDir, '.gatetest', 'reports', 'gatetest-results.xml'), 'utf-8'
    );
    assert.ok(xml.includes('&lt;'), 'Should escape <');
    assert.ok(xml.includes('&amp;'), 'Should escape &');
    assert.ok(xml.includes('&quot;'), 'Should escape "');
  });
});

// The level GitHub sees must be the level the GATE used. On PR #422
// (2026-09-05) a `password='hunter2'` fixture in a test file — which the
// engine had already downgraded to `warning` — reached Code Scanning with
// the secrets module's flat 9.1 score, was shown as CRITICAL, and failed
// the PR check that the engine's own verdict had passed.
describe('SarifReporter — effective severity, not module severity', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-sarif-eff-'));
    fs.mkdirSync(path.join(tmpDir, '.gatetest', 'reports'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  async function emit(moduleName, checks, runnerOptions = {}) {
    const config = new GateTestConfig(tmpDir);
    const runner = new GateTestRunner(config, runnerOptions);
    new SarifReporter(runner, config);
    runner.register(moduleName, {
      async run(result) {
        for (const [name, details, mutate] of checks) {
          result.addCheck(name, false, details);
          if (mutate) mutate(result.checks[result.checks.length - 1]);
        }
      },
    });
    await runner.run([moduleName]);
    return JSON.parse(fs.readFileSync(
      path.join(tmpDir, '.gatetest', 'reports', 'gatetest-results.sarif'), 'utf-8',
    ));
  }

  it('a warning from a security module is at most MEDIUM, an error keeps the module score', async () => {
    const sarif = await emit('secrets', [
      ['secrets:tests/fixture.test.js', { severity: 'warning', file: 'tests/fixture.test.js', line: 1, message: '1 potential secret(s) found' }],
      ['secrets:src/config.js', { severity: 'error', file: 'src/config.js', line: 4, message: '1 potential secret(s) found' }],
    ]);
    const rules = Object.fromEntries(sarif.runs[0].tool.driver.rules.map((r) => [r.name, r]));
    assert.strictEqual(rules['secrets:tests/fixture.test.js'].properties['security-severity'], '6.9',
      'a test-tree fixture the engine downgraded must not render as critical');
    assert.strictEqual(rules['secrets:tests/fixture.test.js'].defaultConfiguration.level, 'warning');
    assert.strictEqual(rules['secrets:src/config.js'].properties['security-severity'], '9.1');
    assert.strictEqual(rules['secrets:src/config.js'].defaultConfiguration.level, 'error');
  });

  it('an error below the confidence threshold ("soft") is a warning to GitHub too', async () => {
    const sarif = await emit('ssrf', [
      ['ssrf:soft', { severity: 'error', file: 'src/a.js', line: 1, message: 'maybe', confidence: 0.5 }],
      ['ssrf:confident', { severity: 'error', file: 'src/b.js', line: 1, message: 'surely', confidence: 0.99 }],
    ], { confidenceThreshold: 0.95 });
    const byName = Object.fromEntries(sarif.runs[0].tool.driver.rules.map((r) => [r.name, r]));
    const results = Object.fromEntries(sarif.runs[0].results.map((r) => [r.ruleId, r]));
    assert.strictEqual(byName['ssrf:soft'].defaultConfiguration.level, 'warning');
    assert.strictEqual(byName['ssrf:soft'].properties['security-severity'], '6.9');
    assert.strictEqual(results['gatetest/ssrf/ssrf-soft'].level, 'warning');
    assert.strictEqual(results['gatetest/ssrf/ssrf-soft'].properties.blocking, false);
    assert.strictEqual(results['gatetest/ssrf/ssrf-soft'].properties.confidence, 0.5);
    assert.strictEqual(byName['ssrf:confident'].defaultConfiguration.level, 'error');
    assert.strictEqual(byName['ssrf:confident'].properties['security-severity'], '8.6');
    assert.strictEqual(results['gatetest/ssrf/ssrf-confident'].properties.blocking, true);
  });

  it('a later, more severe finding under the same rule lifts the rule', async () => {
    const sarif = await emit('secrets', [
      ['secrets:same', { severity: 'warning', file: 'tests/x.test.js', line: 1, message: 'fixture' }],
      ['secrets:same', { severity: 'error', file: 'src/x.js', line: 1, message: 'real' }],
    ]);
    const rule = sarif.runs[0].tool.driver.rules.find((r) => r.name === 'secrets:same');
    assert.strictEqual(rule.defaultConfiguration.level, 'error');
    assert.strictEqual(rule.properties['security-severity'], '9.1');
    assert.strictEqual(sarif.runs[0].tool.driver.rules.length, 1, 'one rule, not two');
  });

  it('suppressed findings (.gatetestignore / baseline) are not uploaded as alerts', async () => {
    const sarif = await emit('ssrf', [
      ['ssrf:ignored', { severity: 'error', file: 'src/a.js', line: 1, message: 'ignored' },
        (c) => { c.suppressed = true; c.suppressReason = 'gatetestignore'; }],
      ['ssrf:live', { severity: 'error', file: 'src/b.js', line: 1, message: 'live' }],
    ]);
    assert.deepStrictEqual(sarif.runs[0].results.map((r) => r.ruleId), ['gatetest/ssrf/ssrf-live']);
  });
});

describe('ComplianceReporter — the evidence pack is signed and verifiable (the Fifty, move 46)', () => {
  const { ComplianceReporter } = require('../src/reporters/compliance-reporter');
  const { verifyReport } = require('../src/core/report-provenance');
  let tmpDir;
  const KEY = 'test-signing-key';
  let savedKey;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-compliance-'));
    savedKey = process.env.GATETEST_REPORT_SIGNING_KEY;
    process.env.GATETEST_REPORT_SIGNING_KEY = KEY;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.GATETEST_REPORT_SIGNING_KEY; else process.env.GATETEST_REPORT_SIGNING_KEY = savedKey;
  });

  it('writes JSON + Markdown, files the finding under its controls, and verify-report accepts the JSON', async () => {
    const config = new GateTestConfig(tmpDir);
    config._silent = true;
    const runner = new GateTestRunner(config);
    const reporter = new ComplianceReporter(runner, config);
    runner.register('ssrf', {
      async run(result) {
        result.addCheck('ssrf-user-input-to-fetch', false, { severity: 'error', file: 'src/api.ts', line: 12, message: 'User input handed to fetch()' });
      },
    });
    await runner.run(['ssrf']);

    const dir = path.join(tmpDir, '.gatetest', 'reports');
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'gatetest-compliance-latest.json'), 'utf-8'));
    assert.strictEqual(report.gatetest.kind, 'compliance-evidence');
    assert.strictEqual(report.frameworks.owasp.controls['A10:2021'].status, 'fail');
    assert.deepStrictEqual(report.frameworks.owasp.controls['A10:2021'].modules.ran, ['ssrf']);
    assert.ok(Array.isArray(report.results), 'the raw results ride along for the digest');
    assert.strictEqual(report.signature.keyId.length > 0, true);
    assert.deepStrictEqual(verifyReport(report, KEY), { ok: true, reason: 'signature and findings digest verified' });

    report.results[0].checks[0].message = 'edited after the fact';
    assert.strictEqual(verifyReport(report, KEY).ok, false, 'an edited finding must fail verification');

    const md = fs.readFileSync(reporter.lastPaths.markdown, 'utf-8');
    assert.match(md, /A10:2021 \| Server-Side Request Forgery \(SSRF\) \| FAIL \| ssrf/);
    assert.match(md, /Signed \(HMAC-SHA256/);
    assert.match(md, /NOT CHECKED/, 'one module cannot have checked the other nine categories');
  });

  it('the console line and the written pack name OWASP and CIS, never SOC 2 (Craig 2026-10-01)', async () => {
    const config = new GateTestConfig(tmpDir);
    const runner = new GateTestRunner(config);
    const reporter = new ComplianceReporter(runner, config);
    runner.register('ssrf', {
      async run(result) {
        result.addCheck('ssrf-user-input-to-fetch', false, { severity: 'error', file: 'src/api.ts', line: 12, message: 'User input handed to fetch()' });
      },
    });
    const logged = [];
    const orig = console.log;
    console.log = (...a) => { logged.push(a.join(' ')); };
    try { await runner.run(['ssrf']); } finally { console.log = orig; }

    const line = logged.find((l) => /OWASP .* pass \//.test(l));
    assert.ok(line, `compliance console line printed: ${JSON.stringify(logged)}`);
    assert.match(line, /OWASP \d+ pass \/ \d+ fail \/ \d+ warn \/ \d+ not checked · CIS \d+ pass/);
    assert.doesNotMatch(line, /SOC ?2/i);

    const md = fs.readFileSync(reporter.lastPaths.markdown, 'utf-8');
    assert.match(md, /## OWASP Top 10 2021/);
    assert.match(md, /## CIS Controls v8/);
    assert.doesNotMatch(md, /SOC ?2|Trust Services/i);
    const json = fs.readFileSync(reporter.lastPaths.json, 'utf-8');
    assert.deepStrictEqual(Object.keys(JSON.parse(json).frameworks).sort(), ['cis', 'owasp']);
    assert.doesNotMatch(json.replace(/"results":[\s\S]*$/, ''), /SOC ?2|Trust Services/i);
  });
});
