'use strict';

/**
 * Forensic ($399) repo deliverable: per-finding AI diagnosis + the CTO
 * executive summary, committed to the fix PR next to the CISO report.
 *
 * Audit 2026-10-02: checkout sells Forensic as "real AI diagnosis on every
 * finding … and a CTO-readable executive summary report", but both only ran
 * in /api/scan/server-fix, which requires an ADMIN session — no paying
 * customer could reach them. The paid repo path (/api/scan/fix, payment
 * verified by Stripe) now builds them with the same libraries.
 *
 * Fail-soft by contract: the fixes already shipped, so a Claude failure here
 * returns { ok:false, reason } for the PR advisory, never throws.
 */

const { diagnoseFindings, renderDiagnosesReport } = require('./nuclear-diagnoser');
const { composeExecutiveSummary, renderExecutiveSummary } = require('./executive-summary');

function forensicReportPath(scanDate) {
  const d = scanDate || new Date().toISOString().slice(0, 10);
  return `gatetest-reports/forensic-diagnosis-${d}.md`;
}

/**
 * @param {object} opts
 * @param {Array<{detail:string,module?:string,severity?:string}>} opts.findings
 * @param {Array<{title:string,severity:string,impact:string}>} [opts.chains]
 * @param {string} opts.hostname   owner/repo
 * @param {(prompt:string)=>Promise<string>} opts.askClaude
 */
async function buildForensicRepoReport({ findings, chains = [], hostname, askClaude }) {
  const list = Array.isArray(findings) ? findings : [];
  if (list.length === 0) {
    return {
      ok: true,
      diagnosed: 0,
      skipped: 0,
      executiveSummary: false,
      markdown: '## GateTest Forensic Diagnosis Report\n\nNo error or warning findings to diagnose. All scanned modules passed.\n',
    };
  }
  let diag;
  try {
    diag = await diagnoseFindings({ findings: list, hostname, askClaudeForDiagnosis: askClaude });
  } catch (err) {
    return { ok: false, reason: `diagnosis failed: ${err && err.message ? err.message : String(err)}` };
  }
  let exec;
  try {
    exec = await composeExecutiveSummary({ topFindings: list.slice(0, 10), chains, hostname, askClaudeForSummary: askClaude });
  } catch (err) {
    exec = { ok: false, sections: null, reason: err && err.message ? err.message : 'executive summary failed' };
  }
  const diagnosed = diag.diagnoses.filter((d) => d.ok).length;
  return {
    ok: true,
    diagnosed,
    skipped: diag.diagnoses.length - diagnosed,
    executiveSummary: Boolean(exec && exec.ok),
    summary: diag.summary,
    // Executive first (the CTO read), then the technical detail.
    markdown: `${renderExecutiveSummary(exec, { hostname })}\n\n${renderDiagnosesReport(diag.diagnoses, diag.summary)}\n`,
  };
}

module.exports = { buildForensicRepoReport, forensicReportPath };
