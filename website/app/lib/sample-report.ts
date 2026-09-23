/**
 * The one "sample full report" link (issue #678 gap 6): a buyer should be
 * able to see what a full scan actually finds before paying for one,
 * without us fabricating a demo.
 *
 * There is no dedicated report-viewer page for a single repository today,
 * and building one is out of scope for this fix. What already exists,
 * real and current, is GitHub's own Code Scanning view of the SARIF this
 * repository's "Full Scan" CI job (`.github/workflows/ci.yml`, category
 * "gatetest") uploads on every push to main — the same findings a paying
 * customer's own report would contain, for our own repository, updated
 * automatically. One definition, imported, so the two places that link to
 * it (the pricing page and the free-scan result page) cannot disagree.
 */
export const SAMPLE_REPORT_URL =
  "https://github.com/crclabs-hq/GateTest/security/code-scanning?query=is%3Aopen+category%3Agatetest";
