'use strict';
/**
 * Collect every actionable finding from a scan summary, in the shape
 * `runFixBatch` consumes ({ file, message, moduleName, checkName, severity }).
 * One definition (doctrine §4), shared by `gatetest --auto-pr` and
 * `gatetest fix --apply` (bin/gatetest.js) — pulled out of the CLI entrypoint
 * so it can be imported by tests too (bin/gatetest.js calls main() at import
 * and cannot be require()'d safely).
 *
 * A failing-test finding (module `unitTests`, check `unit-tests:run`, with
 * `details.failures[]` — see src/modules/unit-tests.js) is special-cased:
 * `extractFileFromCheck` would resolve `file` to the TEST file, but the fix
 * belongs in the implementation the test imports, never the test itself
 * (THE-FIFTY move 8). `resolveImplementationFiles` (src/core/failing-test-
 * target.js, built on the one import-graph, doctrine §4) finds it. When it
 * resolves to nothing, that is reported as manual review, not silently
 * dropped (doctrine #1 — "not checked" is a real state).
 */

const { extractFileFromCheck } = require('./parse-finding');
const { resolveImplementationFiles } = require('./failing-test-target');

/**
 * @param {object} summary — a GateTest scan summary ({ results: [...] })
 * @param {string} projectRoot
 * @returns {{fixable: object[], needsManualReview: object[]}}
 */
function collectFixableFindings(summary, projectRoot) {
  const fixable = [];
  const needsManualReview = [];
  for (const moduleResult of summary.results || []) {
    for (const check of moduleResult.checks || []) {
      if (check.passed) continue;
      if (check.severity !== 'error' && check.severity !== 'warning') continue;
      const moduleName = moduleResult.module || moduleResult.name || 'unknown';
      const isFailingTest = moduleName === 'unitTests'
        && check.name === 'unit-tests:run'
        && Array.isArray(check.details?.failures)
        && check.details.failures.length > 0;

      if (isFailingTest) {
        const testFile = check.file || check.details?.file || null;
        const failures = check.details.failures;
        const primary = failures[0];
        const impls = testFile ? resolveImplementationFiles(testFile, projectRoot) : [];
        if (impls.length === 0) {
          needsManualReview.push({
            moduleName,
            checkName: check.name,
            file: null,
            message: `failing test "${primary.name}" — could not resolve an implementation file from ${testFile || 'the test'}'s imports`,
            severity: check.severity,
          });
          continue;
        }
        for (const implFile of impls) {
          fixable.push({
            moduleName,
            checkName: check.name,
            file: implFile,
            line: null,
            message: `failing test "${primary.name}" — ${primary.message}`,
            severity: check.severity,
            kind: 'failing-test',
            testFile,
            failures,
          });
        }
        continue;
      }

      const checkWithModule = { ...check, module: moduleName };
      const { file, line } = extractFileFromCheck(checkWithModule);
      const entry = {
        moduleName,
        checkName: check.name || 'unnamed-check',
        file,
        line,
        message: check.message || check.details?.message || check.name || '',
        severity: check.severity,
      };
      if (file) fixable.push(entry);
      else needsManualReview.push(entry);
    }
  }
  return { fixable, needsManualReview };
}

module.exports = { collectFixableFindings };
