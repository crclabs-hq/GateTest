'use strict';
/**
 * Compliance evidence — the scan's findings filed under OWASP Top 10 2021
 * and CIS Controls v8, control by control (the Fifty, move 46). SOC 2 is
 * deliberately NOT emitted — see FRAMEWORKS below.
 *
 * Three-state per control, never two (Doctrine §1): a control is `pass` only
 * when a module mapped to it RAN and found nothing; `fail` when a mapped
 * module produced a blocking finding; `warn` on soft errors or warnings;
 * `not-checked` when no mapped module ran in this suite (skipped, deferred,
 * or not part of it); `no-module` when nothing in the engine maps to it at
 * all. A pass from silence is the lie this file exists to prevent.
 *
 * Modules WITHOUT an explicit mapping never feed a control. The mapping
 * table's fallback ("Insecure Design / CC8.1 / 16") exists so the CISO
 * report can place everything; an evidence pack an auditor reads must not
 * claim a lint finding proves anything about A04. Those findings are listed
 * under `attribution.unattributed` with their counts instead.
 *
 * Pure: takes the runner summary, returns data. The reporter writes files.
 */

const {
  getComplianceMapping, hasExplicitMapping, listMappedModules,
  OWASP_TOP10, CIS_CONTROLS,
} = require('./compliance-mappings');
const { isBlockingFinding } = require('./confidence');

const FRAMEWORKS = Object.freeze([
  { key: 'owasp', name: 'OWASP Top 10 2021', controls: OWASP_TOP10 },
  // SOC 2 skipped on purpose (Craig 2026-10-01): SOC 2 compliance is a future, separate product, not sold today — the soc2 mapping column is kept for it.
  { key: 'cis', name: 'CIS Controls v8', controls: CIS_CONTROLS },
]);

/** Which bucket a failed check lands in, the way the gate counted it. */
function bucketOf(check, threshold) {
  if (!check || check.passed) return null;
  if (check.suppressed) return 'suppressed';
  if (check.severity === 'error') return isBlockingFinding(check, threshold) ? 'blocking' : 'soft';
  if (check.severity === 'warning') return 'warning';
  return null; // info
}

function emptyCounts() {
  return { blocking: 0, soft: 0, warning: 0, suppressed: 0 };
}

/** Per-module tally of failed checks plus the evidence lines an auditor can follow. */
function tallyModules(results, threshold) {
  const tally = new Map();
  for (const r of results) {
    if (!r || r.status === 'skipped') continue;
    const t = { counts: emptyCounts(), evidence: [] };
    for (const c of r.checks || []) {
      const bucket = bucketOf(c, threshold);
      if (!bucket) continue;
      t.counts[bucket]++;
      if (bucket === 'blocking' || bucket === 'soft') {
        t.evidence.push({
          module: r.module, check: c.name, file: c.file || null, line: c.line || null,
          severity: bucket, confidence: typeof c.confidence === 'number' ? c.confidence : null,
        });
      }
    }
    tally.set(r.module, t);
  }
  return tally;
}

function statusFor(ranCount, counts, mappedCount) {
  if (mappedCount === 0) return 'no-module';
  if (ranCount === 0) return 'not-checked';
  if (counts.blocking > 0) return 'fail';
  if (counts.soft > 0 || counts.warning > 0) return 'warn';
  return 'pass';
}

/**
 * @param {object} summary — the runner's suite:end summary
 * @returns {{frameworks:object, attribution:object, totals:object}}
 */
function buildComplianceEvidence(summary) {
  const results = Array.isArray(summary.results) ? summary.results : [];
  const threshold = typeof summary.confidenceThreshold === 'number' ? summary.confidenceThreshold : undefined;
  const tally = tallyModules(results, threshold);
  const skipped = results.filter((r) => r && r.status === 'skipped').map((r) => r.module);
  const deferred = (summary.deferred || []).map((d) => d.module);
  const notRunReason = (m) => (skipped.includes(m) ? 'skipped' : deferred.includes(m) ? 'deferred' : 'not in this suite');

  const mapped = listMappedModules();
  const frameworks = {};
  const totals = {};
  for (const fw of FRAMEWORKS) {
    const controls = {};
    const t = { controls: 0, pass: 0, fail: 0, warn: 0, 'not-checked': 0, 'no-module': 0 };
    for (const [id, title] of Object.entries(fw.controls)) {
      const mappedHere = mapped.filter((m) => getComplianceMapping(m)[fw.key].includes(id));
      const ran = mappedHere.filter((m) => tally.has(m));
      const notRun = mappedHere.filter((m) => !tally.has(m)).map((m) => ({ module: m, reason: notRunReason(m) }));
      const counts = emptyCounts();
      const evidence = [];
      for (const m of ran) {
        const mt = tally.get(m);
        for (const k of Object.keys(counts)) counts[k] += mt.counts[k];
        evidence.push(...mt.evidence);
      }
      const status = statusFor(ran.length, counts, mappedHere.length);
      controls[id] = { title, status, modules: { ran, notRun }, findings: counts, evidence };
      t.controls++; t[status]++;
    }
    frameworks[fw.key] = { name: fw.name, controls };
    totals[fw.key] = t;
  }

  const unattributed = [];
  for (const [module, t] of tally) {
    if (hasExplicitMapping(module)) continue;
    const total = t.counts.blocking + t.counts.soft + t.counts.warning;
    if (total > 0) unattributed.push({ module, ...t.counts });
  }

  return {
    frameworks,
    totals,
    attribution: {
      explicit: [...tally.keys()].filter((m) => hasExplicitMapping(m)).sort(),
      unattributed: unattributed.sort((a, b) => (a.module < b.module ? -1 : 1)),
      notRun: { skipped, deferred },
    },
  };
}

const STATUS_LABEL = {
  pass: 'PASS', fail: 'FAIL', warn: 'WARN', 'not-checked': 'NOT CHECKED', 'no-module': 'NO MODULE',
};

/**
 * Board-readable Markdown. `meta` carries what the JSON wrapper knows:
 * version, timestamp, gateStatus, and the signature state.
 */
function renderComplianceMarkdown(evidence, meta = {}) {
  const lines = [];
  lines.push('# GateTest compliance evidence', '');
  lines.push(`Generated ${meta.timestamp || 'n/a'} by GateTest ${meta.version || ''} — gate ${meta.gateStatus || 'n/a'}.`);
  lines.push(meta.signed
    ? `Signed (HMAC-SHA256, key id ${meta.keyId}); verify with \`gatetest verify-report <json>\`.`
    : 'Unsigned — set GATETEST_REPORT_SIGNING_KEY where the scan runs to sign the JSON evidence.');
  lines.push('', 'A control is PASS only when a module mapped to it ran and found nothing. NOT CHECKED means no mapped module ran in this suite; NO MODULE means the engine has nothing mapped to it. Neither is a pass.', '');
  for (const fw of FRAMEWORKS) {
    const f = evidence.frameworks[fw.key];
    const t = evidence.totals[fw.key];
    lines.push(`## ${f.name}`, '');
    lines.push(`${t.pass} pass · ${t.fail} fail · ${t.warn} warn · ${t['not-checked']} not checked · ${t['no-module']} no module (of ${t.controls})`, '');
    lines.push('| Control | Title | Status | Checked by | Not run | Blocking | Soft | Warnings |', '|---|---|---|---|---|---|---|---|');
    for (const [id, c] of Object.entries(f.controls)) {
      const notRun = c.modules.notRun.map((n) => `${n.module} (${n.reason})`).join(', ') || '—';
      lines.push(`| ${id} | ${c.title} | ${STATUS_LABEL[c.status]} | ${c.modules.ran.join(', ') || '—'} | ${notRun} | ${c.findings.blocking} | ${c.findings.soft} | ${c.findings.warning} |`);
    }
    lines.push('');
  }
  lines.push('## Not attributed to any control', '');
  if (evidence.attribution.unattributed.length === 0) {
    lines.push('Every module that reported a finding has an explicit framework mapping.', '');
  } else {
    lines.push('These modules reported findings but have no framework mapping; they are listed, not filed under a control.', '');
    lines.push('| Module | Blocking | Soft | Warnings |', '|---|---|---|---|');
    for (const u of evidence.attribution.unattributed) lines.push(`| ${u.module} | ${u.blocking} | ${u.soft} | ${u.warning} |`);
    lines.push('');
  }
  const { skipped, deferred } = evidence.attribution.notRun;
  if (skipped.length || deferred.length) {
    lines.push('## Not run', '');
    if (skipped.length) lines.push(`Skipped: ${skipped.join(', ')}`);
    if (deferred.length) lines.push(`Deferred to another suite: ${deferred.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { buildComplianceEvidence, renderComplianceMarkdown, bucketOf };
