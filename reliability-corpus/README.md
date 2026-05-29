# GateTest reliability corpus

This directory holds **continuous reliability test cases** for the
GateTest scanner. The nightly workflow runs every case here against
the latest engine and compares results to the baseline, opening a PR
when drift is detected.

## Why this exists

Craig 2026-05-29:
> "For reliability what can we test ourselves against continuously? I
> don't care if it's 5000 tests — we need to analyse."

Reliability isn't a one-time test. It's a continuous proof-of-life.
This corpus is how we earn the right to claim "most reliable scanner
on the market."

## Structure

Each case is a directory with a `manifest.json` describing what the
scan should produce. Categories:

| Category          | Target | Meaning |
| ----------------- | ------ | ------- |
| `known-good`      | code   | code that must produce **0 errors** |
| `known-bad`       | code   | code with planted vulnerabilities — must catch them |
| `oss-snapshot`    | code   | frozen-SHA reference to a real OSS repo |
| `mixed`           | code   | hand-crafted with both signal and noise |
| `url-known-good`  | url    | URL we own that must scan clean |
| `url-known-bad`   | url    | URL we own with known issues |
| `url-snapshot`    | url    | frozen public URL with known shape |

## Manifest schema

See `website/app/lib/reliability/manifest.js` for the full schema +
validator.

```json
{
  "name": "case-name",
  "category": "known-bad",
  "target": "code",
  "tier": "full",
  "description": "what this case proves",
  "expected": {
    "errors":   { "ssrf":   { "atLeast": 1 } },
    "warnings": { "lint":   { "atMost":  2 } },
    "totalErrorsAtLeast": 1
  },
  "budgets": {
    "maxDurationMs": 30000,
    "maxMemoryMb":   1024,
    "deterministic": true
  },
  "labels": ["cwe-918", "owasp-a10"],
  "source": "hand-crafted",
  "createdAt": "2026-05-29T00:00:00Z"
}
```

## Growth plan

| Phase | Target | Source |
| ----- | ------ | ------ |
| 1 (now) | 10–50 cases | hand-crafted seed |
| 2 | + 3,000 cases | CWE-bench wired in |
| 3 | + 5,000 cases | NIST SARD sampled |
| 4 | continuous growth | real customer scans, anonymised, with consent |
| 5 | + 10,000 variants | synthetic generation via Claude |

Hit 5,000 cases and we have a defensible "most reliable scanner" claim.

## How to run locally

```bash
# Once the runner CLI ships
gatetest-reliability --corpus reliability-corpus/

# Today: invoke programmatically
node -e "
  const { runSuite } = require('./website/app/lib/reliability/runner.js');
  const cases = require('./reliability-corpus/manifests.js');
  runSuite({ cases, scanner: realScanner }).then(console.log);
"
```
