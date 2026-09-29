/**
 * The JSON report's schema version and stable-field contract (issue #803).
 *
 * Tallrig's admin tab, AlecRae and the hosted /web scan parse the report
 * GateTest writes to `.gatetest/reports/gatetest-report-<ts>.json`
 * (`summary.checks`, `findings[]`, `results[].checks[]`). Nothing pinned that
 * shape, so a rename here could silently break a sibling platform.
 *
 * ONE definition, imported everywhere: the JSON reporter, `--json` output,
 * the SARIF and JUnit envelopes, and `tests/report-schema-contract.test.js`
 * all read `REPORT_SCHEMA_VERSION` and `REPORT_CONTRACT` from here.
 *
 * The rule (docs/api/report-schema.md): adding a field never bumps the
 * version. Removing or renaming a pinned field is a breaking change — it needs
 * a `deprecated` entry in the report for one minor release first, then a
 * `schemaVersion` bump.
 */

const REPORT_SCHEMA_VERSION = 1;

// Entries the report currently marks deprecated: `{ field, since, removeIn }`.
// Empty on purpose — nothing is deprecated at schema version 1. A field that
// leaves REPORT_CONTRACT must first appear here for one minor release.
const REPORT_DEPRECATED = [];

// Keys present on EVERY report / object of that kind. The `(failed)` entry is
// checked only on failed checks (confidence is scored only for failing
// error/warning checks).
const REPORT_CONTRACT = {
  top: [
    'schemaVersion', 'gatetest', 'summary', 'results', 'failures', 'findings',
    'findingSummary', 'overrides', 'deprecated', 'provenance', 'signature',
  ],
  gatetest: ['version', 'timestamp', 'gateStatus'],
  summary: [
    'duration', 'modules', 'checks', 'modelVerdictsBlock', 'nothingChecked',
    'deferred', 'budgetLimited', 'rootCause', 'enforcing', 'reportOnlyUntil',
  ],
  'summary.modules': ['total', 'passed', 'failed', 'skipped'],
  'summary.checks': [
    'total', 'passed', 'failed', 'errors', 'blockingErrors',
    'blockingErrorsDeterministic', 'blockingErrorsModelJudged', 'softErrors',
    'modelJudged', 'modelJudgedWouldBlock', 'warnings', 'softWarnings',
    'flywheelSoftened', 'demoted', 'infoFindings', 'baselined',
    'ignoreSuppressed',
  ],
  findingSummary: [
    'total', 'blocking', 'softErrors', 'warnings', 'info',
    'duplicatesCollapsed', 'hiddenLowConfidence', 'modelJudged',
    'modelJudgedWouldBlock',
  ],
  'findings[]': [
    'id', 'module', 'rule', 'severity', 'confidence', 'verdictSource',
    'wouldBlock', 'blocking', 'file', 'line', 'message', 'suggestion',
    'evidence', 'class', 'duplicateOf', 'ignoreLine',
  ],
  'results[]': [
    'module', 'status', 'duration', 'totalChecks', 'passedChecks',
    'failedChecks', 'errors', 'blockingErrors', 'softErrors', 'warnings',
    'softWarnings', 'flywheelSoftened', 'modelJudged', 'infoFindings',
    'suppressedChecks', 'scopedOut', 'fixes', 'checks', 'appliedFixes', 'error',
  ],
  'results[].checks[]': ['name', 'passed', 'timestamp', 'severity', 'verdictSource'],
  'results[].checks[] (failed)': ['message', 'confidence', 'wouldBlock'],
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Check a parsed report against the contract. Extra keys are fine; a missing
 * pinned key is reported by its full path so the failure names what went.
 *
 * @param {object} report a parsed gatetest-report-*.json
 * @returns {{ ok: boolean, missing: string[] }}
 */
function checkReportContract(report) {
  const missing = [];
  const need = (obj, keys, where) => {
    if (!isObject(obj)) { missing.push(`${where} (not an object)`); return; }
    for (const k of keys) if (!(k in obj)) missing.push(`${where}.${k}`);
  };
  const C = REPORT_CONTRACT;

  need(report, C.top, '$');
  if (!isObject(report)) return { ok: false, missing };
  if (typeof report.schemaVersion !== 'number') missing.push('$.schemaVersion (not a number)');
  need(report.gatetest, C.gatetest, 'gatetest');
  need(report.summary, C.summary, 'summary');
  if (isObject(report.summary)) {
    need(report.summary.modules, C['summary.modules'], 'summary.modules');
    need(report.summary.checks, C['summary.checks'], 'summary.checks');
  }
  if (report.findingSummary !== null) need(report.findingSummary, C.findingSummary, 'findingSummary');

  for (const [key, list] of [['findings', C['findings[]']], ['results', C['results[]']]]) {
    if (!Array.isArray(report[key])) { if (key in report) missing.push(`${key} (not an array)`); continue; }
    report[key].forEach((item, i) => need(item, list, `${key}[${i}]`));
  }
  if (Array.isArray(report.results)) {
    report.results.forEach((r, i) => {
      if (!isObject(r) || !Array.isArray(r.checks)) return;
      r.checks.forEach((c, j) => {
        const where = `results[${i}].checks[${j}]`;
        need(c, C['results[].checks[]'], where);
        if (isObject(c) && c.passed === false) need(c, C['results[].checks[] (failed)'], where);
        if (isObject(c) && 'details' in c && !Array.isArray(c.details) && !isObject(c.details)) {
          missing.push(`${where}.details (not an array or object)`);
        }
      });
    });
  }
  return { ok: missing.length === 0, missing };
}

module.exports = { REPORT_SCHEMA_VERSION, REPORT_DEPRECATED, REPORT_CONTRACT, checkReportContract };
