// =============================================================================
// NO UNBUILT PRODUCT IS CLAIMED — SOC 2 compliance output and penetration
// testing are not things GateTest provides today.
// =============================================================================
// Ruling (Craig, 2026-10-01): "the pen testing and the soc2 compliant scan are
// two separate new features which will be added later once gatetest scan &
// repair tool is earning money. we need to keep the website completely honest
// and up to date… we arent fully coded for these two products so we wouldnt
// be selling it — that's false."
//
// Scope: shipped customer-facing copy — every source file under website/app,
// README.md and the GitHub Marketplace listing. Comment lines in JS/TS (`//`,
// `/*`, ` *`) are not rendered and are skipped; everything else is copy.
//
// A line mentioning SOC 2 / SOC2 / pen test / pentest / penetration test fails
// unless it is in ALLOWLIST below, which is per file and names the exact line
// text it admits and WHY that context is honest (a "we do not hold / do not
// do" disclaimer, an admin-only page, a "not available" label). An allowlist
// entry that no longer matches anything fails too, so the list cannot rot
// into a blanket pass.
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const CLAIM_RE = /\bSOC[\s-]?2\b|\bpen[\s-]?test|\bpenetration[\s-]?test/i;

const ROOTS = ['website/app'];
const EXTRA_FILES = ['README.md', 'integrations/marketplace/listing.md'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.mdx', '.txt']);
const SKIP_DIRS = new Set(['node_modules', '.next']);

// Whole paths that are not customer-facing copy at all.
const EXCLUDED_PATHS = [
  {
    prefix: 'website/app/lib/pentest/',
    reason: 'dormant probe code for the future penetration-testing product; no route or tier calls it',
  },
  {
    prefix: 'website/app/admin/compliance/',
    reason: "admin-only page about GateTest's OWN internal controls (SOC 2 / HIPAA readiness inventory), never shown to customers",
  },
  {
    prefix: 'website/app/lib/compliance-status.ts',
    reason: "admin-only data for /admin/compliance — GateTest's own internal control inventory",
  },
];

// file → [{ includes, reason, transient? }]. `includes` is a substring of the
// offending line. `transient` entries are owned by another change and may
// disappear without this test failing on a stale entry.
const ALLOWLIST = {
  'website/app/trust/trust-content.ts': [
    { includes: 'Claim a certification we do not hold. There is no SOC 2, ISO 27001 or penetration-test report today', reason: 'trust page: states we hold NO SOC 2 / pen-test report' },
  ],
  'website/app/trust/trust-content-2.ts': [
    { includes: '**We hold no third-party certification today.** There is no SOC 2 report', reason: 'trust page: states we hold NO SOC 2 report and NO independent pen-test report' },
    { includes: '**No third-party certification.** No SOC 2, ISO 27001 or independent penetration test', reason: 'trust page: restates the absence of any certification' },
  ],
  'website/app/legal/terms/terms-content.ts': [
    { includes: 'probe, stress-test, or penetration-test the Service itself without our prior written permission', reason: 'terms: forbids customers pen-testing GateTest itself' },
  ],
  'website/app/legal/terms/terms-content-2.ts': [
    { includes: 'does not replace, code review, testing, professional security assessment, penetration testing, and compliance audit', reason: 'terms disclaimer: GateTest does not replace pen testing' },
  ],
  'website/app/regulation/catalog.ts': [
    { includes: 'Penetration testing (Req. 11.4) — human red-team work.', reason: 'PCI DSS outOfScopeForGateTest list: pen testing is human work GateTest does NOT do' },
  ],
  'website/app/lib/chat-system-prompt.js': [
    { includes: '- No SOC2 / HIPAA certification yet.', reason: 'support bot "what we don\'t have" list: no SOC 2 certification' },
    { includes: '- No penetration testing and no SOC 2 compliance scan or SOC 2 mapping in', reason: 'support bot is told neither product exists and never to offer them' },
  ],
  'website/app/lib/hn-reply-assistant/drafter.js': [
    { includes: 'Penetration testing and SOC 2 compliance scanning are separate future products — not built, not sold today.', reason: 'honest-limitations line fed to the HN reply drafter' },
  ],
  'website/app/for/[country]/page.tsx': [
    { includes: 'not a compliance auditor, and it offers no SOC 2 compliance scan and no penetration testing', reason: 'honest-limitations disclaimer on every country page' },
  ],
  'website/app/glossary/glossary-catalog.ts': [
    { includes: 'they do not send attack payloads — GateTest does not run penetration tests.', reason: 'DAST glossary entry states GateTest does NOT pen test' },
  ],
  'website/app/components/howitworks/modules-data.ts': [
    { includes: 'id: "pen-test",', reason: 'stable category id / URL anchor (#pen-test), not copy' },
    { includes: 'Not available — reserved for a future penetration-testing product. No GateTest scan or tier runs these probes today.', reason: 'dormant probe category labelled NOT available' },
    { includes: 'comingSoon: { reason: "Not available — reserved for a future penetration-testing product; no scan runs these probes." }', reason: 'dormant probe category labelled NOT available (rendered on module pages)' },
  ],
  'website/app/components/HomeModuleBreakdown.tsx': [
    { includes: '"pen-test": "', reason: 'icon map keyed by the category id, not copy' },
  ],
  'website/app/modules/[slug]/page.tsx': [
    { includes: 'Want to hear if the penetration-testing product launches?', reason: 'only rendered for the NOT-available category; says the product has not launched' },
  ],
  'website/app/lib/notify-store.js': [
    { includes: "const VALID_TOPICS = new Set(['pentest']);", reason: 'topic id for the "Penetration Testing — coming soon" notify-me list; stores emails, sells nothing' },
  ],
  'website/app/lib/mcp-remote-modules.json': [
    { includes: '(Pen Test tier — requires authorization)', transient: true, reason: 'GENERATED from src/modules descriptions by scripts/generate-mcp-remote-modules.js; the engine copy is corrected in a separate change (src/ is outside this one). Delete this entry once regenerated.' },
  ],
};

function isCommentLine(file, line) {
  if (!/\.(m?[jt]sx?|cjs)$/.test(file)) return false;
  const t = line.trim();
  // `*` only as a block-comment continuation (" * text", " */"), never a
  // markdown "**bold**" line inside a string.
  return t.startsWith('//') || t.startsWith('/*') || /^\*(\s|\/|$)/.test(t);
}

function excludedReason(rel) {
  const hit = EXCLUDED_PATHS.find((e) => rel === e.prefix || rel.startsWith(e.prefix));
  return hit ? hit.reason : null;
}

function walk(dirRel, out) {
  const abs = path.join(ROOT, dirRel);
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const rel = `${dirRel}/${ent.name}`;
    if (ent.isDirectory()) walk(rel, out);
    else if (EXTENSIONS.has(path.extname(ent.name))) out.push(rel);
  }
  return out;
}

function collectFiles() {
  const files = [];
  for (const r of ROOTS) walk(r, files);
  for (const f of EXTRA_FILES) if (fs.existsSync(path.join(ROOT, f))) files.push(f);
  return files.filter((f) => !excludedReason(f));
}

/**
 * Scan `text` as if it were `rel`. Returns { violations, used } where `used`
 * is the set of allowlist entries that admitted a line.
 */
function scanText(rel, text, allowlist = ALLOWLIST) {
  const violations = [];
  const used = new Set();
  const entries = allowlist[rel] || [];
  text.split('\n').forEach((line, i) => {
    if (!CLAIM_RE.test(line)) return;
    if (isCommentLine(rel, line)) return;
    const entry = entries.find((e) => line.includes(e.includes));
    if (entry) { used.add(entry); return; }
    violations.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
  });
  return { violations, used };
}

describe('no unbuilt product (SOC 2 compliance output, penetration testing) is claimed', () => {
  const files = collectFiles();

  it('scans a real surface — the guard is not vacuous', () => {
    assert.ok(files.length > 200, `expected hundreds of copy files, found ${files.length}`);
    assert.ok(files.includes('README.md'));
    assert.ok(files.includes('website/app/lib/checkout-tiers.ts'));
  });

  it('every allowlist and exclusion entry has a reason', () => {
    for (const [file, entries] of Object.entries(ALLOWLIST)) {
      for (const e of entries) {
        assert.ok(e.includes && e.includes.length > 10, `${file}: allowlist entry needs a specific line substring`);
        assert.ok(e.reason && e.reason.length > 10, `${file}: allowlist entry "${e.includes}" needs a reason`);
      }
    }
    for (const e of EXCLUDED_PATHS) assert.ok(e.reason && e.reason.length > 10, `${e.prefix} needs a reason`);
  });

  it('no customer-facing line claims SOC 2 output or penetration testing outside the honest allowlist', () => {
    const violations = [];
    const used = new Set();
    for (const rel of files) {
      const r = scanText(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      violations.push(...r.violations);
      r.used.forEach((e) => used.add(e));
    }
    assert.deepEqual(
      violations, [],
      'These lines mention SOC 2 or penetration testing. Neither is a product GateTest sells\n'
      + '(Craig 2026-10-01). Remove the claim, or — only if the line says we do NOT provide it —\n'
      + 'add it to ALLOWLIST with a reason.\n' + violations.join('\n'),
    );

    const stale = [];
    for (const [file, entries] of Object.entries(ALLOWLIST)) {
      for (const e of entries) if (!e.transient && !used.has(e)) stale.push(`${file}: "${e.includes}"`);
    }
    assert.deepEqual(stale, [], `allowlist entries that match nothing (remove them):\n${stale.join('\n')}`);
  });

  it('positive control: a planted claim is caught, even in a file that has allowlisted lines', () => {
    const planted = [
      'Forensic tier: board-ready CISO report (OWASP / SOC2 / CIS v8 / 30-60-90)',
      'Upgrade to the Pen Test tier for live probes.',
      'We run a full penetration test on every scan.',
      'Get SOC 2 audit-ready with one scan.',
    ];
    for (const claim of planted) {
      const r = scanText('website/app/trust/trust-content.ts', `export const x = "${claim}";`);
      assert.equal(r.violations.length, 1, `planted claim was not caught: ${claim}`);
    }
    // And the same honest line is NOT admitted in a file it was not allowlisted for.
    const honest = '**We hold no third-party certification today.** There is no SOC 2 report, no ISO 27001 certificate';
    assert.equal(scanText('website/app/trust/trust-content-2.ts', `{ p: "${honest}" },`).violations.length, 0);
    assert.equal(scanText('website/app/lib/checkout-tiers.ts', `{ p: "${honest}" },`).violations.length, 1);
    // A "**bold**" line inside a string is copy, not a comment.
    assert.equal(scanText('website/app/lib/checkout-tiers.ts', '**SOC 2 ready** in one scan').violations.length, 1);
  });

  it('the Forensic tier copy maps to OWASP Top 10 and CIS Controls v8 only', () => {
    const tiers = fs.readFileSync(path.join(ROOT, 'website/app/lib/checkout-tiers.ts'), 'utf8');
    assert.match(tiers, /findings mapped to OWASP Top 10 and CIS Controls v8, with a 30\/60\/90-day remediation plan/);
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /findings mapped to OWASP Top 10 and CIS Controls v8, with a 30\/60\/90-day remediation plan/);
  });
});
