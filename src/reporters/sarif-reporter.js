/**
 * SARIF Reporter - Outputs results in SARIF 2.1.0 format.
 * Standard format for GitHub Security tab, VS Code, and other security tools.
 * https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */

const fs = require('fs');
const path = require('path');
const { siteUrl } = require('../core/site-url');
// The SARIF driver version is shown next to every alert in GitHub Security.
// It was hardcoded at '1.1.0' while the product shipped 1.61.0 — customers
// reading their own security tab saw a version that never existed in this
// decade. Derived, never typed. (Note: the `version: '2.1.0'` below is the
// SARIF SPEC version and must stay fixed.)
const PKG_VERSION = require('../../package.json').version;
const { isBlockingFinding } = require('../core/confidence');
const { getComplianceMapping, hasExplicitMapping } = require('../core/compliance-mappings');

// Module → CWE / security-severity mapping. The OWASP category is NOT here:
// it comes from src/core/compliance-mappings.js, the one table the CISO
// report and the compliance evidence pack also read (two modules had drifted
// between the two lists — redos A05/A06, kubernetes A01/A05 — 2026-09-05).
// Findings emitted by
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
    securitySeverity: '8.6',
    tags: ['security', 'ssrf', 'injection', 'external/cwe/cwe-918'],
  },
  secrets: {
    cwe: 'CWE-798',
    securitySeverity: '9.1',
    tags: ['security', 'hardcoded-credentials', 'external/cwe/cwe-798'],
  },
  secretRotation: {
    cwe: 'CWE-798',
    securitySeverity: '7.5',
    tags: ['security', 'credential-management', 'external/cwe/cwe-798'],
  },
  tlsSecurity: {
    cwe: 'CWE-295',
    securitySeverity: '8.1',
    tags: ['security', 'tls', 'mitm', 'external/cwe/cwe-295'],
  },
  cookieSecurity: {
    cwe: 'CWE-1004',
    securitySeverity: '6.5',
    tags: ['security', 'session', 'cookie', 'external/cwe/cwe-1004'],
  },
  webHeaders: {
    cwe: 'CWE-693',
    securitySeverity: '5.5',
    tags: ['security', 'headers', 'csp', 'external/cwe/cwe-693'],
  },
  redos: {
    cwe: 'CWE-1333',
    securitySeverity: '6.5',
    tags: ['security', 'regex', 'dos', 'external/cwe/cwe-1333'],
  },
  homoglyph: {
    cwe: 'CWE-1007',
    securitySeverity: '7.3',
    tags: ['security', 'trojan-source', 'supply-chain', 'external/cwe/cwe-1007'],
  },
  logPii: {
    cwe: 'CWE-532',
    securitySeverity: '5.3',
    tags: ['security', 'privacy', 'logging', 'gdpr', 'external/cwe/cwe-532'],
  },
  ciSecurity: {
    cwe: 'CWE-829',
    securitySeverity: '7.4',
    tags: ['security', 'supply-chain', 'ci', 'external/cwe/cwe-829'],
  },
  dependencies: {
    cwe: 'CWE-1395',
    securitySeverity: '6.8',
    tags: ['security', 'dependencies', 'supply-chain', 'external/cwe/cwe-1395'],
  },
  dockerfile: {
    cwe: 'CWE-250',
    securitySeverity: '6.3',
    tags: ['security', 'container', 'hardening', 'external/cwe/cwe-250'],
  },
  terraform: {
    cwe: 'CWE-1188',
    securitySeverity: '6.7',
    tags: ['security', 'iac', 'cloud', 'external/cwe/cwe-1188'],
  },
  kubernetes: {
    cwe: 'CWE-732',
    securitySeverity: '6.5',
    tags: ['security', 'k8s', 'permissions', 'external/cwe/cwe-732'],
  },
  promptSafety: {
    cwe: 'CWE-1426',
    securitySeverity: '7.0',
    tags: ['security', 'llm', 'prompt-injection', 'external/cwe/cwe-1426'],
  },
  hardcodedUrl: {
    cwe: 'CWE-1100',
    securitySeverity: '3.7',
    tags: ['security', 'config', 'environment', 'external/cwe/cwe-1100'],
  },
  // Code-quality findings — informational tags only, no security-severity
  undefinedRef: {
    cwe: 'CWE-628',
    securitySeverity: null,
    tags: ['reliability', 'runtime-error'],
  },
  moneyFloat: {
    cwe: 'CWE-682',
    securitySeverity: '5.0',
    tags: ['correctness', 'finance', 'rounding', 'external/cwe/cwe-682'],
  },
};

// security-severity is a per-MODULE score, but a finding's severity is
// per-FINDING: the engine downgrades a credential fixture in a test tree to
// `warning`, and a low-confidence error to non-blocking "soft". Until
// 2026-09-05 the score ignored both, so a `password='hunter2'` fixture in a
// test file reached GitHub Code Scanning as a 9.1 CRITICAL and failed the PR
// check that the engine's own verdict had passed (PR #422).
//
// The finding's effective level picks the band GitHub will show — its
// thresholds are 9.0 critical / 7.0 high / 4.0 medium — and the module's
// score orders within it. An error keeps the module's score; a warning can
// be at most medium; a note at most low.
const SECURITY_SEVERITY_CAP = { error: 10, warning: 6.9, note: 3.9 };
const LEVEL_RANK = { note: 0, warning: 1, error: 2 };

function bandedSecuritySeverity(score, level) {
  const cap = SECURITY_SEVERITY_CAP[level] ?? SECURITY_SEVERITY_CAP.warning;
  return Math.min(Number(score), cap).toFixed(1);
}

/**
 * The OWASP tag GitHub shows: the mapping table's first category, for modules
 * that carry security metadata here. The table's catch-all A04 "Insecure
 * Design" (workflow-hygiene modules) is deliberately not surfaced as a
 * security tag — it would label a flaky test as an OWASP finding.
 */
function owaspFor(moduleName, meta) {
  if (!meta || !hasExplicitMapping(moduleName)) return null;
  const first = getComplianceMapping(moduleName).owasp[0];
  return first && first !== 'A04:2021' ? first : null;
}

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

    const threshold = summary.confidenceThreshold;
    // The Fifty, move 14: does a model-judged finding block on its own?
    // Read off the summary rather than re-derived here, so SARIF's
    // `blocking` always agrees with the gate that actually ran.
    const modelVerdictsBlock = summary.modelVerdictsBlock === true;

    for (const moduleResult of summary.results) {
      for (const check of moduleResult.checks) {
        if (check.passed) continue;
        // .gatetestignore / baseline suppressions are the user's decision;
        // the Security tab is their alert list, not an audit trail.
        if (check.suppressed || check.suppressReason) continue;
        // Info-level findings are notes the gate never blocks on; GitHub Code
        // Scanning turns every uploaded result into a PR review comment, so
        // uploading them re-litigates a fixture's `http://localhost` on every
        // pull request (#418, 2026-09-02; seven such threads on #458).
        // Errors and warnings still ride.
        if (check.severity === 'info') continue;

        // The level GitHub sees is the level the GATE used: an error the
        // confidence threshold made non-blocking ("soft") — or one an
        // active accepted-risk override took off the gate — is a warning.
        const effectiveSeverity = check.severity === 'error' && (check.overriddenBy || !isBlockingFinding(check, threshold))
          ? 'warning'
          : check.severity;
        const level = this._severityToSarif(effectiveSeverity);

        // Create rule if not exists
        const ruleId = `gatetest/${moduleResult.module}/${this._sanitizeRuleId(check.name)}`;
        const meta = MODULE_SECURITY_META[moduleResult.module] || null;
        if (ruleIndex.has(ruleId)) {
          // Rule already emitted from an earlier check: a later, more
          // severe finding under the same rule lifts the rule to its level.
          const existing = rules[ruleIndex.get(ruleId)];
          if (LEVEL_RANK[level] > LEVEL_RANK[existing.defaultConfiguration.level]) {
            existing.defaultConfiguration.level = level;
            if (meta && meta.securitySeverity) {
              existing.properties['security-severity'] = bandedSecuritySeverity(meta.securitySeverity, level);
            }
          }
        } else {
          ruleIndex.set(ruleId, rules.length);
          // Look up CWE / OWASP / security-severity for this module so
          // GitHub Code Scanning can render the finding with proper
          // severity, filter tags, and a "View advisory" link.
          const properties = {
            tags: meta && Array.isArray(meta.tags) && meta.tags.length > 0
              ? meta.tags.slice()
              : [moduleResult.module],
          };
          if (meta && meta.securitySeverity) {
            // GitHub-specific extension key, recognised by the Security tab
            // for severity-threshold gating in branch protection rules.
            properties['security-severity'] = bandedSecuritySeverity(meta.securitySeverity, level);
          }
          if (meta && meta.cwe) {
            properties.cwe = meta.cwe;
          }
          const owasp = owaspFor(moduleResult.module, meta);
          if (owasp) properties.owasp = owasp;
          const ruleEntry = {
            id: ruleId,
            name: check.name,
            shortDescription: { text: check.message || check.name },
            fullDescription: { text: check.suggestion || check.message || check.name },
            defaultConfiguration: {
              level,
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
          level,
          message: {
            text: check.message || check.suggestion || check.name,
          },
          properties: {
            confidence: typeof check.confidence === 'number' ? check.confidence : null,
            blocking: isBlockingFinding(check, threshold, modelVerdictsBlock) && !check.overriddenBy,
            // The Fifty, move 14: 'deterministic' | 'model' | 'mixed' — lets a
            // GitHub Security tab consumer filter model-judged alerts instead
            // of weighting them the same as a deterministic rule firing.
            verdictSource: check.verdictSource || 'deterministic',
          },
        };

        // Accepted-risk override (move 3, docs/LAUNCH_BOARD.md): rendered as
        // a SARIF suppression so GitHub Code Scanning shows it dismissed
        // WITH a reason, rather than as a live alert someone has to notice
        // is actually accepted. `kind: 'external'` — the decision was made
        // outside GitHub's own dismiss-in-UI flow, in this repo's own
        // recorded-override file/flag. Never applied to an EXPIRED override
        // — that one is meant to alarm again, which a suppression would hide.
        if (check.overriddenBy) {
          const o = check.overriddenBy;
          const who = o.by ? ` (accepted by ${o.by})` : '';
          const until = o.until ? `, until ${o.until}` : '';
          sarifResult.suppressions = [{
            kind: 'external',
            justification: `Accepted risk${who}${until}: ${o.reason}`,
          }];
        }

        // Always emit a locations array — GitHub Code Scanning rejects
        // the whole upload when even one result has no location. File-less
        // findings (config rules, repo-wide observations) get pointed at
        // the project-level marker file resolved above.
        //
        // The URI must be RFC 3986-compliant: reserved characters like `[`,
        // `]`, spaces, etc. must be percent-encoded. SolidStart / Next.js
        // dynamic-route paths (`[projectId].tsx`, `[bucket].test.ts`)
        // contain brackets that GitHub's SARIF validator rejects when
        // unencoded ("X is not a valid URI"). encodePathAsUri() encodes
        // each segment with encodeURIComponent and rejoins with `/` so
        // path separators are preserved.
        const rawFileUri = check.file || projectLevelUri;
        const fileUri = this._encodePathAsUri(rawFileUri);
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
            version: PKG_VERSION,
            informationUri: siteUrl(),
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

  // Encode a repo-relative path as a SARIF-valid URI per RFC 3986. Each
  // path segment is strictly encoded — anything NOT in RFC 3986
  // "unreserved characters" (`A-Z a-z 0-9 - . _ ~`) gets percent-encoded.
  // Path separators (`/`) are preserved by splitting first, then
  // encoding each segment, then rejoining.
  //
  // Stricter than encodeURIComponent (which leaves `! * ' ( )` unencoded).
  // SARIF + GitHub Code Scanning is fussy about what counts as a "valid
  // URI" — better to over-encode than risk a per-file validator reject.
  //
  // Examples:
  //   "src/a.ts"                       → "src/a.ts"
  //   "src/[id].tsx"                   → "src/%5Bid%5D.tsx"
  //   "src/my file.ts"                 → "src/my%20file.ts"
  //   "src/(group)/page.tsx"           → "src/%28group%29/page.tsx"
  //   "src\\windows\\path.ts"          → "src/windows/path.ts"
  _encodePathAsUri(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return rawPath || '';
    const normalised = rawPath.replace(/\\/g, '/');
    // Canonical RFC 3986 trick: encodeURIComponent handles most chars
    // correctly (including brackets and spaces) but leaves `!*'()`
    // unencoded because they're in its "unreserved" set. Strictly per
    // RFC 3986 those ARE reserved (sub-delims), so a second pass
    // percent-encodes the missed five.
    return normalised
      .split('/')
      .map((segment) =>
        encodeURIComponent(segment).replace(
          /[!*'()]/g,
          (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
        ),
      )
      .join('/');
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
        // error-ok — Filesystem hiccup — ignore and try next candidate
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
