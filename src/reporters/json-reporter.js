/**
 * JSON Reporter - Produces machine-readable reports for CI/CD integration.
 */

const fs = require('fs');
const path = require('path');
// Tool version, grouped with the run's timestamp and gateStatus. It read
// '1.0.0' regardless of what actually ran. Nothing consumes this field
// (consumers read gateStatus/timestamp) and no schema version is documented,
// so deriving it makes it meaningful rather than decorative.
const PKG_VERSION = require('../../package.json').version;
const { buildProvenance, signatureFor } = require('../core/report-provenance');

class JsonReporter {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
    this._attach();
  }

  _attach() {
    this.runner.on('suite:end', (summary) => this._onSuiteEnd(summary));
  }

  _onSuiteEnd(summary) {
    const reportDir = this.config.get('reporting.outputDir') || '.gatetest/reports';
    const absDir = path.resolve(this.config.projectRoot, reportDir);

    if (!fs.existsSync(absDir)) {
      fs.mkdirSync(absDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `gatetest-report-${timestamp}.json`;
    const filepath = path.join(absDir, filename);

    const report = {
      gatetest: {
        version: PKG_VERSION,
        timestamp: summary.timestamp,
        gateStatus: summary.gateStatus,
      },
      summary: {
        duration: summary.duration,
        modules: summary.modules,
        checks: summary.checks,
        // True when no source file was found under the root: every module
        // passed by default. A consumer reading `gateStatus: PASSED` must be
        // able to tell an inspected repo from an empty directory.
        nothingChecked: summary.nothingChecked === true,
      },
      results: summary.results,
      failures: summary.failedModules,
      // Ranked, cross-module-deduped view (src/core/finding-registry.js).
      // Counts in `summary.checks` are the gate's truth; this is what to
      // SHOW — consumers should render `findings` and mention
      // `findingSummary.duplicatesCollapsed` / `.hiddenLowConfidence`.
      findings: Array.isArray(summary.findings) ? summary.findings : [],
      findingSummary: summary.findingSummary || null,
    };
    // Provenance + signature (move 21): which engine, which modules ran,
    // what was skipped, deferred or suppressed, and a digest of the
    // findings — signed with GATETEST_REPORT_SIGNING_KEY when set, and
    // explicitly unsigned otherwise. `gatetest verify-report <file>` checks
    // both the signature and that the findings match the digest.
    report.provenance = buildProvenance(summary, { projectRoot: this.config.projectRoot });
    report.signature = signatureFor(report.provenance);

    fs.writeFileSync(filepath, JSON.stringify(report, null, 2));

    // Also write a "latest" symlink / copy
    const latestPath = path.join(absDir, 'gatetest-report-latest.json');
    fs.writeFileSync(latestPath, JSON.stringify(report, null, 2));
  }
}

module.exports = { JsonReporter };
