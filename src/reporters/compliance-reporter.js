'use strict';
/**
 * Compliance Reporter — writes the compliance evidence pack (`--compliance`):
 * the run's findings filed under OWASP / SOC 2 / CIS control by control, the
 * raw results behind them, and the same provenance + signature every JSON
 * report carries (move 21), so `gatetest verify-report` proves the pack was
 * not edited after the scan. The tables come from src/core/compliance-
 * evidence.js; this file only writes.
 */

const fs = require('fs');
const path = require('path');
const PKG_VERSION = require('../../package.json').version;
const { buildProvenance, signatureFor } = require('../core/report-provenance');
const { buildComplianceEvidence, renderComplianceMarkdown } = require('../core/compliance-evidence');
const { resolveReportDir } = require('../core/report-paths');

class ComplianceReporter {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
    this.runner.on('suite:end', (summary) => this._onSuiteEnd(summary));
  }

  _onSuiteEnd(summary) {
    const absDir = resolveReportDir(this.config);
    fs.mkdirSync(absDir, { recursive: true });

    const evidence = buildComplianceEvidence(summary);
    const provenance = buildProvenance(summary, { projectRoot: this.config.projectRoot });
    const signature = signatureFor(provenance);
    const report = {
      gatetest: { version: PKG_VERSION, timestamp: summary.timestamp, gateStatus: summary.gateStatus, kind: 'compliance-evidence' },
      ...evidence,
      // The raw findings the tables were built from — `verify-report`
      // recomputes the provenance digest over these.
      results: summary.results,
      provenance,
      signature,
    };
    const markdown = renderComplianceMarkdown(evidence, {
      version: PKG_VERSION,
      timestamp: summary.timestamp,
      gateStatus: summary.gateStatus,
      signed: Boolean(signature && signature.signature),
      keyId: signature && signature.keyId,
    });

    const stamp = String(summary.timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
    const jsonPath = path.join(absDir, `gatetest-compliance-${stamp}.json`);
    const mdPath = path.join(absDir, `gatetest-compliance-${stamp}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(mdPath, markdown);
    fs.writeFileSync(path.join(absDir, 'gatetest-compliance-latest.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(absDir, 'gatetest-compliance-latest.md'), markdown);
    this.lastPaths = { json: jsonPath, markdown: mdPath };

    if (!this.config._silent) {
      const t = evidence.totals;
      const line = (k) => `${t[k].pass} pass / ${t[k].fail} fail / ${t[k].warn} warn / ${t[k]['not-checked']} not checked`;
      console.log(`\n  [GateTest] Compliance evidence: ${path.relative(this.config.projectRoot, mdPath)}`);
      console.log(`  OWASP ${line('owasp')} · SOC 2 ${line('soc2')} · CIS ${line('cis')}${signature && signature.signature ? ' · signed' : ' · unsigned'}`);
    }
  }
}

module.exports = { ComplianceReporter };
