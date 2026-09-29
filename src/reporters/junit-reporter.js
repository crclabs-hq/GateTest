/**
 * JUnit XML Reporter - Outputs results in JUnit XML format.
 * Standard format for CI/CD systems: Jenkins, GitHub Actions, GitLab CI, CircleCI.
 */

const fs = require('fs');
const path = require('path');
const { REPORT_SCHEMA_VERSION } = require('../core/report-schema');

class JunitReporter {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
    this._attach();
  }

  _attach() {
    this.runner.on('suite:end', (summary) => this._onSuiteEnd(summary));
  }

  _onSuiteEnd(summary) {
    const xml = this._buildXml(summary);
    const reportDir = path.join(this.config.projectRoot, '.gatetest', 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const outputPath = path.join(reportDir, 'gatetest-results.xml');
    fs.writeFileSync(outputPath, xml);
  }

  _buildXml(summary) {
    const lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');

    const totalTests = summary.checks.total;
    const failures = summary.checks.errors;
    const warnings = summary.checks.warnings;
    const duration = (summary.duration / 1000).toFixed(3);

    lines.push(`<testsuites name="GateTest" tests="${totalTests}" failures="${failures}" ` +
      `warnings="${warnings}" time="${duration}" timestamp="${summary.timestamp}" ` +
      `schemaVersion="${REPORT_SCHEMA_VERSION}">`);

    for (const moduleResult of summary.results) {
      const modTests = moduleResult.checks.length;
      const modFailures = moduleResult.errors || 0;
      const modDuration = ((moduleResult.duration || 0) / 1000).toFixed(3);

      lines.push(`  <testsuite name="${this._esc(moduleResult.module)}" tests="${modTests}" ` +
        `failures="${modFailures}" time="${modDuration}">`);

      for (const check of moduleResult.checks) {
        const checkDuration = '0.001';
        lines.push(`    <testcase name="${this._esc(check.name)}" ` +
          `classname="gatetest.${this._esc(moduleResult.module)}" time="${checkDuration}">`);

        if (!check.passed) {
          const tag = check.severity === 'warning' ? 'system-out' : 'failure';
          if (tag === 'failure') {
            const message = check.message || check.suggestion || 'Check failed';
            const details = [];
            if (check.file) details.push(`File: ${check.file}:${check.line || ''}`);
            if (check.expected !== undefined) details.push(`Expected: ${check.expected}`);
            if (check.actual !== undefined) details.push(`Actual: ${check.actual}`);
            if (check.suggestion) details.push(`Fix: ${check.suggestion}`);

            lines.push(`      <failure message="${this._esc(message)}" type="${check.severity || 'error'}">`);
            lines.push(`${this._esc(details.join('\n'))}`);
            lines.push('      </failure>');
          } else {
            lines.push(`      <system-out>${this._esc(check.message || 'Warning')}</system-out>`);
          }
        }

        lines.push('    </testcase>');
      }

      lines.push('  </testsuite>');
    }

    lines.push('</testsuites>');
    return lines.join('\n');
  }

  _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

module.exports = { JunitReporter };
