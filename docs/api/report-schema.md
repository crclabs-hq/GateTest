# GateTest JSON report schema

The JSON report is written to `.gatetest/reports/gatetest-report-<timestamp>.json`
(and `gatetest-report-latest.json`). Other tools parse it, so its field set is a
contract: `tests/report-schema-contract.test.js` runs the engine on a fixture
and fails if any field below is removed or renamed. Adding fields is always
allowed.

The one definition of the version and the pinned field list is
`src/core/report-schema.js`.

## Detecting the version

Read `schemaVersion` (a number) at the top level of the report. The current
version is `1`. A report without it predates this contract; treat it as
unversioned and do not rely on any field below.

The same number appears in the other formats:

- `--format json` stdout document: top-level `schemaVersion`.
- SARIF: `runs[0].properties.gatetestSchemaVersion`.
- JUnit XML: the `schemaVersion` attribute on `<testsuites>`.

## Deprecation rule

A pinned field is removed only one minor release after it appears in the
report's top-level `deprecated` array as `{ "field", "since", "removeIn" }`.
Removal or rename also bumps `schemaVersion`. Additions never bump it.
At version 1, `deprecated` is empty.

## Stable fields

### Top level

- `schemaVersion` - the report schema version (see above).
- `gatetest` - the run's identity and verdict block.
- `summary` - whole-run counts and flags.
- `results` - one entry per module that ran.
- `failures` - modules that crashed or failed outright.
- `findings` - ranked, cross-module-deduplicated findings; what to display.
- `findingSummary` - counts over `findings` (may be `null` if the registry failed).
- `overrides` - accepted-risk overrides that applied this run; never merged into `findings`.
- `deprecated` - fields scheduled for removal; empty when none.
- `provenance` - which engine, modules and policy produced this report.
- `signature` - signature over `provenance`, or an explicit "unsigned" reason.

### `gatetest`

- `version` - engine version that produced the report.
- `timestamp` - ISO timestamp of the run.
- `gateStatus` - the verdict: `PASSED` or `BLOCKED`.

### `summary`

- `duration` - whole-run time in milliseconds.
- `modules` - module counts (below).
- `checks` - check counts (below); the gate's source of truth.
- `modelVerdictsBlock` - whether model-judged findings may block this run.
- `nothingChecked` - true when no source file was found; a `PASSED` then means nothing was inspected.
- `deferred` - modules deliberately not run (suite deferral or budget).
- `budgetLimited` - true when `--budget` cut modules; the verdict covers only those that ran.
- `rootCause` - why, since which commit, and how to replay a `BLOCKED` run; `null` when passed.
- `enforcing` - false under report-only mode, where `PASSED` is advisory.
- `reportOnlyUntil` - the report-only window, or `null`.

### `summary.modules`

- `total`, `passed`, `failed`, `skipped` - module counts by outcome.

### `summary.checks`

- `total` - all checks run.
- `passed` - checks that passed.
- `failed` - checks that failed.
- `errors` - failed checks with severity error.
- `blockingErrors` - errors that block the gate.
- `blockingErrorsDeterministic` - blocking errors from deterministic rules.
- `blockingErrorsModelJudged` - blocking errors from model-judged findings.
- `softErrors` - low-confidence errors reported but not blocking.
- `modelJudged` - model-judged findings.
- `modelJudgedWouldBlock` - model-judged findings that would block under a stricter policy.
- `warnings` - failed checks with severity warning.
- `softWarnings` - warnings that are low-confidence.
- `flywheelSoftened` - warnings softened by field data.
- `demoted` - errors demoted to warnings by measured noise.
- `infoFindings` - informational findings.
- `baselined` - findings suppressed by the baseline.
- `ignoreSuppressed` - findings suppressed by ignore rules.

### `findingSummary`

- `total`, `blocking`, `softErrors`, `warnings`, `info` - counts over `findings`.
- `duplicatesCollapsed` - duplicates folded into one finding.
- `hiddenLowConfidence` - low-confidence errors held back.
- `modelJudged`, `modelJudgedWouldBlock` - model-judged counts.

### `findings[]`

- `id` - `<module>:<check name>`.
- `module` - module that raised it.
- `rule` - rule key, without file or line.
- `severity` - `error`, `warning` or `info`.
- `confidence` - 0 to 1.
- `verdictSource` - `deterministic`, `model` or `mixed`.
- `wouldBlock` - whether a stricter policy would block on it.
- `blocking` - whether it blocked the gate this run.
- `file` - repo-relative path, or `null`.
- `line` - line number, or `null`.
- `message` - human-readable description.
- `suggestion` - fix suggestion, or `null`.
- `evidence` - verified code quote, or `null`.
- `class` - defect class used for deduplication.
- `duplicateOf` - `id` of the finding this duplicates, or `null`.
- `ignoreLine` - the exact ignore line for this finding.

### `results[]`

- `module`, `status`, `duration` - module name, outcome and time in milliseconds.
- `totalChecks`, `passedChecks`, `failedChecks` - check counts for the module.
- `errors`, `blockingErrors`, `softErrors`, `warnings`, `softWarnings`, `flywheelSoftened`, `modelJudged`, `infoFindings` - the module's share of the `summary.checks` counts.
- `suppressedChecks` - checks suppressed by ignore or baseline.
- `scopedOut` - findings dropped by a narrowed (`--diff`) scan.
- `fixes`, `appliedFixes` - count and detail of fixes applied.
- `error` - the module's crash message, or `null`.
- `checks` - the module's checks (below).

### `results[].checks[]`

Every check has:

- `name` - check name.
- `passed` - true or false.
- `timestamp` - when the check was recorded.
- `severity` - `error`, `warning` or `info`.
- `verdictSource` - as on `findings[]`.

A failed check additionally has `message`, `confidence` and `wouldBlock`
(same meanings as on `findings[]`). It may have `file`, `line`, `suggestion`
and `details`. `details` is an array of per-module detail objects; its entry
shape varies by module and is not pinned.

## Not pinned

Anything not listed above (for example `provenance` internals, `rootCause`
internals, and the extra module-specific keys some checks carry) may change
without a version bump.
