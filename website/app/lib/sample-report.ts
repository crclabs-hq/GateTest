/**
 * The one "sample full report" link (issue #678 gap 6): a buyer should be
 * able to see what a full scan actually finds before paying for one,
 * without us fabricating a demo.
 *
 * Until 2026-09-26 this pointed at GitHub's Code Scanning view of the SARIF
 * this repository's "Full Scan" CI job uploads. Code scanning IS enabled and
 * the upload runs on every push to main — but GitHub answers that page with
 * a 404 to anyone not signed in with access to the repository, so the
 * outside first-hour crawl (finding GT-06) saw a dead link on /pricing. The
 * link now goes to the CI workflow's run list for main, which GitHub serves
 * to anyone (measured 200 anonymous the same day); the latest run's "GateTest
 * Full Scan" job holds the console report. One definition, imported, so the
 * places that link to it cannot disagree.
 */
export const SAMPLE_REPORT_URL =
  "https://github.com/crclabs-hq/GateTest/actions/workflows/ci.yml?query=branch%3Amain";
