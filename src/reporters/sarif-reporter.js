/**
 * SARIF Reporter - Outputs results in SARIF 2.1.0 format.
 * Standard format for GitHub Security tab, VS Code, and other security tools.
 * https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */

const fs = require('fs');
const path = require('path');

class SarifReporter {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
    this._attach();
  }

  _attach() {
    this.runner.on('suite:end', (summary) => this._onSuiteEnd(summary));
  }

  _onSuiteEnd(summary) {
    const sarif = this._buildSarif(summary);
    const reportDir = path.join(this.config.projectRoot, '.gatetest', 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const outputPath = path.join(reportDir, 'gatetest-results.sarif');
    fs.writeFileSync(outputPath, JSON.stringify(sarif, null, 2));
  }

  _buildSarif(summary) {
    const rules = [];
    const results = [];
    const ruleIndex = new Map();

    // Project-level fallback URI for findings with no specific file:line
    // anchor (config-level rules, repo-wide observations like "no .nvmrc",
    // "PR size exceeded"). GitHub Code Scanning rejects the entire SARIF
    // upload when ANY result is missing a `locations` array — error from
    // the CI log: "locationFromSarifResult: expected at least one location".
    // Resolve once at the project root so file-less findings still ride.
    const projectLevelUri = this._resolveProjectLevelUri();

    for (const moduleResult of summary.results) {
      for (const check of moduleResult.checks) {
        if (check.passed) continue;

        // Create rule if not exists
        const ruleId = `gatetest/${moduleResult.module}/${this._sanitizeRuleId(check.name)}`;
        if (!ruleIndex.has(ruleId)) {
          ruleIndex.set(ruleId, rules.length);
          const ruleEntry = {
            id: ruleId,
            name: check.name,
            shortDescription: { text: check.message || check.name },
            fullDescription: { text: check.suggestion || check.message || check.name },
            defaultConfiguration: {
              level: this._severityToSarif(check.severity),
            },
            properties: {
              tags: [moduleResult.module],
            },
          };
          if (check.suggestion) {
            ruleEntry.help = { text: check.suggestion };
          }
          rules.push(ruleEntry);
        }

        // Create result
        const sarifResult = {
          ruleId,
          ruleIndex: ruleIndex.get(ruleId),
          level: this._severityToSarif(check.severity),
          message: {
            text: check.message || check.suggestion || check.name,
          },
        };

        // Always emit a locations array — GitHub Code Scanning rejects
        // the whole upload when even one result has no location. File-less
        // findings (config rules, repo-wide observations) get pointed at
        // the project-level marker file resolved above.
        const fileUri = check.file || projectLevelUri;
        const startLine = check.file ? (parseInt(check.line) || 1) : 1;
        sarifResult.locations = [{
          physicalLocation: {
            artifactLocation: {
              uri: fileUri,
              uriBaseId: '%SRCROOT%',
            },
            region: {
              startLine,
              startColumn: 1,
            },
          },
        }];

        results.push(sarifResult);
      }
    }

    return {
      $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [{
        tool: {
          driver: {
            name: 'GateTest',
            version: '1.1.0',
            informationUri: 'https://gatetest.ai',
            rules,
          },
        },
        results,
        invocations: [{
          executionSuccessful: summary.gateStatus === 'PASSED',
          startTimeUtc: summary.timestamp,
        }],
      }],
    };
  }

  // Pick a stable repo-root file to point file-less findings at. Try
  // canonical project markers in priority order; fall back to a synthetic
  // marker URI (still a valid SARIF artifactLocation per spec — GitHub
  // only requires the URI string to be present, not that the file exists).
  _resolveProjectLevelUri() {
    const candidates = ['package.json', 'README.md', 'README', '.gitignore', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
    for (const name of candidates) {
      try {
        if (fs.existsSync(path.join(this.config.projectRoot, name))) {
          return name;
        }
      } catch {
        // Filesystem hiccup — ignore and try next candidate
      }
    }
    return '.gatetest-project';
  }

  _severityToSarif(severity) {
    switch (severity) {
      case 'error': return 'error';
      case 'warning': return 'warning';
      case 'info': return 'note';
      default: return 'warning';
    }
  }

  _sanitizeRuleId(name) {
    return name.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/-+/g, '-');
  }
}

module.exports = { SarifReporter };
