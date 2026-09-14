'use strict';

// =============================================================================
// ciSecurity — upload-sarif without `actions: read` is a warning, not a gate
// =============================================================================
// gin-gonic/gin @ master, scanned 2026-09-14: the ONLY blocking finding on the
// repository was `.github/workflows/trivy-scan.yml` "lacks actions: read" for
// its `github/codeql-action/upload-sarif@v4` step, at confidence 1.0.
//
// GitHub's upload-sarif documentation requires `actions: read` only for
// PRIVATE repositories; on a public one `security-events: write` is enough and
// the upload succeeds — gin's workflow works exactly as written. A workflow
// file cannot say which kind of repository it runs in, so a blocking verdict
// was a guess. The finding stays on the report as a warning that names the
// condition. Control pairs: the gin file verbatim → one warning, nothing
// blocking; the same file with `actions: read` added → silent; the pwn-request
// error in the same module still blocks, so the module's other verdicts are
// untouched.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const CiSecurityModule = require('../src/modules/ci-security');

function makeResult() {
  return { checks: [], addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); } };
}
function run(projectRoot) {
  const mod = new CiSecurityModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}
function writeWorkflow(root, name, content) {
  const dir = path.join(root, '.github', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}
const failing = (r) => r.checks.filter((c) => !c.passed && /^ci-security:/.test(c.name));

// gin-gonic/gin .github/workflows/trivy-scan.yml, verbatim.
const GIN_TRIVY_SCAN = `name: Trivy Security Scan

on:
  push:
    branches:
      - master
  pull_request:
    branches:
      - master
  schedule:
    # Run daily at 00:00 UTC
    - cron: "0 0 * * *"
  workflow_dispatch: # Allow manual trigger

permissions:
  contents: read
  security-events: write # Required for uploading SARIF results

jobs:
  trivy-scan:
    name: Trivy Security Scan
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: Run Trivy vulnerability scanner (source code)
        uses: aquasecurity/trivy-action@v0.36.0
        with:
          scan-type: "fs"
          scan-ref: "."
          scanners: "vuln,secret,misconfig"
          format: "sarif"
          output: "trivy-results.sarif"
          severity: "CRITICAL,HIGH,MEDIUM"
          ignore-unfixed: true

      - name: Upload Trivy results to GitHub Security tab
        uses: github/codeql-action/upload-sarif@v4
        if: always()
        with:
          sarif_file: "trivy-results.sarif"

      - name: Run Trivy scanner (table output for logs)
        uses: aquasecurity/trivy-action@v0.36.0
        if: always()
        with:
          scan-type: "fs"
          scan-ref: "."
          scanners: "vuln,secret,misconfig"
          format: "table"
          severity: "CRITICAL,HIGH,MEDIUM"
          ignore-unfixed: true
          exit-code: "1"
`;

describe('ciSecurity — gin-gonic/gin trivy-scan.yml', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-gin-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('the workflow verbatim: the SARIF finding is a warning that names the private-repo condition; nothing blocks', async () => {
    writeWorkflow(tmp, 'trivy-scan.yml', GIN_TRIVY_SCAN);
    const r = await run(tmp);
    const sarif = failing(r).find((c) => c.name === 'ci-security:codeql-sarif-missing-actions-read:.github/workflows/trivy-scan.yml');
    assert.ok(sarif, 'still on the report');
    assert.strictEqual(sarif.severity, 'warning');
    assert.match(sarif.message, /PRIVATE repository/);
    assert.match(sarif.message, /public repository does not need the scope/);
    assert.match(sarif.suggestion, /If this repository is private/);
    assert.deepStrictEqual(failing(r).filter((c) => c.severity === 'error').map((c) => c.name), [],
      'gin had exactly one blocking finding and this was it');
  });

  it('CONTROL — the same workflow with `actions: read` granted is silent on this rule', async () => {
    writeWorkflow(tmp, 'trivy-scan.yml', GIN_TRIVY_SCAN.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  actions: read\n'));
    const r = await run(tmp);
    assert.ok(!failing(r).some((c) => c.name.startsWith('ci-security:codeql-sarif-missing-actions-read:')));
  });

  it('POSITIVE CONTROL — a pwn-request in the same module is still an error; the recalibration is one rule, not the module', async () => {
    writeWorkflow(tmp, 'pr.yml', `name: pr
on:
  pull_request_target:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: npm test
`);
    const r = await run(tmp);
    const pwn = failing(r).find((c) => c.name === 'ci-security:pwn-request:.github/workflows/pr.yml');
    assert.ok(pwn);
    assert.strictEqual(pwn.severity, 'error');
  });
});
