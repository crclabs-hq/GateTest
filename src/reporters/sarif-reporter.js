/**
 * SARIF Reporter - Outputs results in SARIF 2.1.0 format.
 * Standard format for GitHub Security tab, VS Code, and other security tools.
 * https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */

const fs = require('fs');
const path = require('path');

// Module → CWE / OWASP / security-severity mapping. Findings emitted by
// these modules get enriched SARIF metadata that renders as filterable
// tags in the GitHub Security tab and exposes the rule's security severity
// score (used for branch-protection rule severity-threshold gating).
//
// security-severity is the GitHub-extension scoring on a 0-10 CVSS-ish
// scale. Values:
//    >= 9.0  critical    >= 7.0  high    >= 4.0  medium    < 4.0  low
// We assign conservatively — modules detecting active exploits (SSRF,
// hardcoded credentials, weak TLS) score high; modules detecting
// resilience / hygiene issues (config drift, dead code, etc.) score low.
const MODULE_SECURITY_META = {
  // Active-exploit security findings — high severity
  ssrf: {
    cwe: 'CWE-918',
    owasp: 'A10:2021',
    securitySeverity: '8.6',
    tags: ['security', 'ssrf', 'injection', 'external/cwe/cwe-918'],
  },
  secrets: {
    cwe: 'CWE-798',
    owasp: 'A07:2021',
    securitySeverity: '9.1',
    tags: ['security', 'hardcoded-credentials', 'external/cwe/cwe-798'],
  },
  secretRotation: {
    cwe: 'CWE-798',
    owasp: 'A07:2021',
    securitySeverity: '7.5',
    tags: ['security', 'credential-management', 'external/cwe/cwe-798'],
  },
  tlsSecurity: {
    cwe: 'CWE-295',
    owasp: 'A02:2021',
    securitySeverity: '8.1',
    tags: ['security', 'tls', 'mitm', 'external/cwe/cwe-295'],
  },
  cookieSecurity: {
    cwe: 'CWE-1004',
    owasp: 'A05:2021',
    securitySeverity: '6.5',
    tags: ['security', 'session', 'cookie', 'external/cwe/cwe-1004'],
  },
  webHeaders: {
    cwe: 'CWE-693',
    owasp: 'A05:2021',
    securitySeverity: '5.5',
    tags: ['security', 'headers', 'csp', 'external/cwe/cwe-693'],
  },
  redos: {
    cwe: 'CWE-1333',
    owasp: 'A05:2021',
    securitySeverity: '6.5',
    tags: ['security', 'regex', 'dos', 'external/cwe/cwe-1333'],
  },
  homoglyph: {
    cwe: 'CWE-1007',
    owasp: null,
    securitySeverity: '7.3',
    tags: ['security', 'trojan-source', 'supply-chain', 'external/cwe/cwe-1007'],
  },
  logPii: {
    cwe: 'CWE-532',
    owasp: 'A09:2021',
    securitySeverity: '5.3',
    tags: ['security', 'privacy', 'logging', 'gdpr', 'external/cwe/cwe-532'],
  },
  ciSecurity: {
    cwe: 'CWE-829',
    owasp: 'A08:2021',
    securitySeverity: '7.4',
    tags: ['security', 'supply-chain', 'ci', 'external/cwe/cwe-829'],
  },
  dependencies: {
    cwe: 'CWE-1395',
    owasp: 'A06:2021',
    securitySeverity: '6.8',
    tags: ['security', 'dependencies', 'supply-chain', 'external/cwe/cwe-1395'],
  },
  dockerfile: {
    cwe: 'CWE-250',
    owasp: 'A05:2021',
    securitySeverity: '6.3',
    tags: ['security', 'container', 'hardening', 'external/cwe/cwe-250'],
  },
  terraform: {
    cwe: 'CWE-1188',
    owasp: 'A05:2021',
    securitySeverity: '6.7',
    tags: ['security', 'iac', 'cloud', 'external/cwe/cwe-1188'],
  },
  kubernetes: {
    cwe: 'CWE-732',
    owasp: 'A01:2021',
    securitySeverity: '6.5',
    tags: ['security', 'k8s', 'permissions', 'external/cwe/cwe-732'],
  },
  promptSafety: {
    cwe: 'CWE-1426',
    owasp: null,
    securitySeverity: '7.0',
    tags: ['security', 'llm', 'prompt-injection', 'external/cwe/cwe-1426'],
  },
  hardcodedUrl: {
    cwe: 'CWE-1100',
    owasp: null,
    securitySeverity: '3.7',
    tags: ['security', 'config', 'environment', 'external/cwe/cwe-1100'],
  },
  // Code-quality findings — informational tags only, no security-severity
  undefinedRef: {
    cwe: 'CWE-628',
    owasp: null,
    securitySeverity: null,
    tags: ['reliability', 'runtime-error'],
  },
  moneyFloat: {
    cwe: 'CWE-682',
    owasp: null,
    securitySeverity: '5.0',
    tags: ['correctness', 'finance', 'rounding', 'external/cwe/cwe-682'],
  },
};

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
          // Look up CWE / OWASP / security-severity for this module so
          // GitHub Code Scanning can render the finding with proper
          // severity, filter tags, and a "View advisory" link.
          const meta = MODULE_SECURITY_META[moduleResult.module] || null;
          const properties = {
            tags: meta && Array.isArray(meta.tags) && meta.tags.length > 0
              ? meta.tags.slice()
              : [moduleResult.module],
          };
          if (meta && meta.securitySeverity) {
            // GitHub-specific extension key, recognised by the Security tab
            // for severity-threshold gating in branch protection rules.
            properties['security-severity'] = meta.securitySeverity;
          }
          if (meta && meta.cwe) {
            properties.cwe = meta.cwe;
          }
          if (meta && meta.owasp) {
            properties.owasp = meta.owasp;
          }
          const ruleEntry = {
            id: ruleId,
            name: check.name,
            shortDescription: { text: check.message || check.name },
            fullDescription: { text: check.suggestion || check.message || check.name },
            defaultConfiguration: {
              level: this._severityToSarif(check.severity),
            },
            properties,
          };
          if (check.suggestion) {
            ruleEntry.help = {
              text: check.suggestion,
              markdown: meta && meta.cwe
                ? `${check.suggestion}\n\nClassification: [${meta.cwe}](https://cwe.mitre.org/data/definitions/${meta.cwe.replace('CWE-', '')}.html)`
                : check.suggestion,
            };
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
