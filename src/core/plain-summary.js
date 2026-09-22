'use strict';
/**
 * The plain-English recap the CLI prints after a scan — what happened and the
 * ONE next command. Written for someone who has never used GateTest: no
 * jargon, no second wall of findings (the reporter already printed those).
 *
 * Lives in src/core rather than inline in bin/gatetest.js so the copy can be
 * asserted by tests without running a scan. The first-contact case is the one
 * that decides adoption (Fifty, move 23): a team turns the gate on against a
 * mature repo, the full scan blocks on years of backlog they did not write,
 * and the recap has to say "gatetest --baseline" before anything else — or
 * they conclude the tool cries wolf and switch it off. A diff-scoped run or a
 * repo that already carries a baseline never gets that hint: there the
 * blocking findings ARE new code.
 */

const fs = require('fs');
const { baselinePath } = require('./baseline');

const ANSI = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m', off: '\x1b[0m' };
const PLAIN = { g: '', y: '', r: '', b: '', bold: '', dim: '', off: '' };

/**
 * Was this scan narrowed to changed files? True for --diff and for --pr /
 * --since (incremental), in which case a blocking finding is in code the
 * author just wrote and a baseline would hide exactly what the gate exists
 * to catch.
 */
function isDiffScoped(summary) {
  return summary.diffOnly === true || (summary.incremental !== null && summary.incremental !== undefined);
}

/**
 * Everything the recap needs beyond the summary: whether the repo already
 * carries a baseline (a file check, so bin stays thin and the lines function
 * stays pure).
 */
function plainSummaryContext(summary, projectRoot) {
  let hasBaseline = false;
  try { hasBaseline = fs.existsSync(baselinePath(projectRoot)); } catch { hasBaseline = false; } // error-ok
  return { hasBaseline, diffScoped: isDiffScoped(summary) };
}

/**
 * Build the recap as an array of lines. `ctx` is what plainSummaryContext
 * returns; `color: false` drops the ANSI codes (tests, and non-TTY output).
 */
function plainSummaryLines(summary, ctx = {}, { color = true } = {}) {
  const c = color ? ANSI : PLAIN;
  const checks = summary.checks || {};
  const blocking = checks.blockingErrors || 0;
  const soft = checks.softErrors || 0;
  const warnings = checks.warnings || 0;
  const baselined = checks.baselined || 0;
  const ignoreSuppressed = checks.ignoreSuppressed || 0;
  const lines = [];

  lines.push(`  ${c.dim}${'─'.repeat(52)}${c.off}`);

  // Baseline transparency — never let grandfathered findings look like a
  // clean bill of health.
  if (baselined > 0) {
    lines.push(`  ${c.dim}${baselined} pre-existing finding(s) baselined — not blocking. Refresh: gatetest --baseline${c.off}`);
  }

  // Ignore-suppression transparency (issue #657): a customer whose
  // `.gatetest.json` `ignore` key or `.gatetestignore` silenced findings
  // needs to see it actually took, combined across both sources (one
  // matcher, Doctrine #4 — see src/core/ignore-file.js).
  if (ignoreSuppressed > 0) {
    lines.push(`  ${c.dim}${ignoreSuppressed} findings suppressed by ignore (config + .gatetestignore)${c.off}`);
  }

  // An empty scan is not a clean one. No source file under the root means
  // every module passed by default; say that INSTEAD of "You're good", and
  // under --strict (the gate is BLOCKED with zero findings) say why.
  if (summary.nothingChecked) {
    const where = summary.projectRoot || 'the project root';
    lines.push(`  ${c.y}${c.bold}⚠ Nothing was checked.${c.off} No source files found under ${where}.`);
    if (summary.gateStatus === 'PASSED') {
      lines.push(`  ${c.dim}The gate passed by default, not by inspection. Check the --project path; pass --strict to make an empty scan fail.${c.off}`, '');
    } else {
      lines.push(`  ${c.r}${c.bold}✗ Blocked under --strict:${c.off} an empty scan enforces nothing. Check the --project path.`, '');
    }
    return lines;
  }

  if (summary.gateStatus === 'PASSED') {
    lines.push(`  ${c.g}${c.bold}✓ You're good.${c.off} Nothing${baselined > 0 ? ' NEW' : ''} is blocking this commit.`);
    if (soft || warnings) {
      lines.push(`  ${c.dim}${soft + warnings} low-priority note(s) noted — worth a look, but not blockers.${c.off}`);
    }
    lines.push(`  ${c.dim}Next: commit with confidence.${c.off}`, '');
    return lines;
  }

  // BLOCKED
  const issueWord = blocking === 1 ? 'issue is' : 'issues are';
  lines.push(`  ${c.r}${c.bold}✗ ${blocking} ${issueWord} blocking this commit.${c.off}`);
  if (soft) lines.push(`  ${c.dim}(+${soft} low-confidence finding(s) shown but NOT blocking.)${c.off}`);
  lines.push('');
  lines.push(`  ${c.bold}What now?${c.off} Pick one:`);

  // First contact with an existing codebase: a full scan, no baseline yet,
  // and it blocked. The backlog is not this commit's fault; say so first.
  if (blocking > 0 && !ctx.diffScoped && !ctx.hasBaseline) {
    lines.push(`    ${c.b}gatetest --baseline${c.off}    ${c.dim}— turning the gate on for an existing repo? Grandfather ${blocking === 1 ? 'it' : `these ${blocking}`} as today's debt;${c.off}`);
    lines.push(`    ${c.dim}                         commit .gatetest/baseline.json and from then on only NEW findings block${c.off}`);
  }
  lines.push(`    ${c.b}gatetest fix --apply${c.off}   ${c.dim}— let AI fix them, then review the diff (needs ANTHROPIC_API_KEY)${c.off}`);
  lines.push(`    ${c.b}gatetest --noise${c.off}       ${c.dim}— if these look like false alarms, see which modules are noisy${c.off}`);
  lines.push(`    ${c.dim}add a line to ${c.off}${c.bold}.gatetestignore${c.off}${c.dim} — permanently silence a check you've judged safe${c.off}`);
  lines.push('');
  return lines;
}

module.exports = { plainSummaryLines, plainSummaryContext, isDiffScoped };
