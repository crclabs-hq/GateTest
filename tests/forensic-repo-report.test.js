'use strict';

// FORENSIC ($399) — what is sold is delivered on the paid repo path.
// Audit 2026-10-02: per-finding AI diagnosis and the CTO executive summary
// only ran in /api/scan/server-fix (admin session required), and the $199
// pair review + architecture notes were gated on scan_fix only — so a $399
// buyer received less than a $199 buyer.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildForensicRepoReport, forensicReportPath } = require('../website/app/lib/forensic-repo-report');

const DIAGNOSIS = `EXPLANATION: The DROP DATABASE statement interpolates a tenant id that never passes the sanitiser, so a crafted id can drop another tenant's database.
ROOT_CAUSE: dbName() is bypassed on the drop path; the raw projectId reaches the SQL template.
RECOMMENDATION: Route every identifier through sanitiseId and quote it with the driver's identifier escaping; add a test with a hostile id.
PLATFORM_NOTES:
Postgres: use format('%I', name) on the server side`;

const SUMMARY = `HEADLINE: Two critical injection paths need fixing before the next release.

POSTURE:
- Most modules pass; risk concentrates in tenant provisioning.

TOP_3_ACTIONS:
1. Sanitise the DROP DATABASE identifier.
2. Add a hostile-id regression test.
3. Re-run the forensic scan.

WORKING_WELL:
- Secrets handling is clean.

RECOMMENDED_NEXT:
- Schedule a follow-up scan after the fixes merge.`;

const FINDINGS = [
  { detail: 'SQL injection: DROP DATABASE built from unsanitised projectId in packages/db/src/neon-provisioning.ts:149', module: 'security', severity: 'error' },
  { detail: 'Swallowed error: .catch(() => {}) on CDN purge in services/cdn/src/cache.ts:198', module: 'errorSwallow', severity: 'error' },
];

const fakeClaude = async (prompt) => (/HEADLINE|executive|CTO/i.test(prompt) ? SUMMARY : DIAGNOSIS);

describe('buildForensicRepoReport', () => {
  it('diagnoses every finding and leads with the executive summary', async () => {
    const r = await buildForensicRepoReport({ findings: FINDINGS, chains: [], hostname: 'o/r', askClaude: fakeClaude });
    assert.equal(r.ok, true);
    assert.equal(r.diagnosed, 2);
    assert.equal(r.skipped, 0);
    assert.equal(r.executiveSummary, true);
    assert.ok(r.markdown.indexOf('Two critical injection paths') < r.markdown.indexOf('dbName() is bypassed'), 'executive summary first');
  });

  it('control: no findings says so — it never invents a diagnosis', async () => {
    let calls = 0;
    const r = await buildForensicRepoReport({ findings: [], hostname: 'o/r', askClaude: async () => { calls += 1; return DIAGNOSIS; } });
    assert.equal(calls, 0);
    assert.match(r.markdown, /No error or warning findings/);
  });

  it('a failing executive summary still ships the diagnoses, marked as not generated', async () => {
    const claude = async (prompt) => { if (/HEADLINE|executive|CTO/i.test(prompt)) throw new Error('overloaded'); return DIAGNOSIS; };
    const r = await buildForensicRepoReport({ findings: FINDINGS, hostname: 'o/r', askClaude: claude });
    assert.equal(r.ok, true);
    assert.equal(r.executiveSummary, false);
    assert.match(r.markdown, /dbName\(\) is bypassed/);
  });

  it('report path sits next to the CISO report', () => {
    assert.equal(forensicReportPath('2026-10-02'), 'gatetest-reports/forensic-diagnosis-2026-10-02.md');
  });
});

describe('/api/scan/fix delivers Forensic on the paid path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'api', 'scan', 'fix', 'route.ts'), 'utf8');
  it('builds and commits the diagnosis + executive summary inside the nuclear branch', () => {
    const nuclear = src.slice(src.indexOf('if (input.tier === "nuclear") {'));
    assert.match(nuclear, /await buildForensicRepoReport\(\{/);
    assert.match(nuclear, /forensicReportPath\(\)[\s\S]{0,300}upsertFile\(/);
  });
  it('captures the findings before the CISO step can throw', () => {
    assert.ok(src.indexOf('forensicFindings = cisoFindings;') < src.indexOf('await correlateForCisoChains({'));
  });
  it('the response reports the forensic deliverable (or why it was skipped)', () => {
    assert.match(src, /forensicDiagnosis: forensicSummary/);
  });
});
