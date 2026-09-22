'use strict';

/**
 * THE free-scan grade — one definition, imported.
 *
 * Before this file (measured 2026-09-22 against expressjs/express), the free
 * repo scan graded on "how many modules came back failed" and then subtracted
 * 3 points per finding regardless of severity:
 *
 *     base    = passed / total * 100          // 2 of 4 modules → 50
 *     penalty = min(50, findings * 3)         // 71 warnings    → 50
 *     score   = 0  →  Grade F
 *
 * Every one of those 71 findings was a WARNING (a legacy `var`, a console.log
 * in `examples/*.js`). Nothing in that repository blocks a release, the gate
 * would have passed it, and the homepage precision table says so — but the
 * free scan told a first-time reader "Grade F, 0/100". Two surfaces, two
 * answers, and the wrong one was the one a stranger saw first.
 *
 * The rule here is the gate's rule (gate-verdict.js): only ERROR-severity
 * findings block. Warnings are counted, shown, and named — they cost a small,
 * capped amount that can never on its own push a result out of the
 * non-failing band. One blocking finding always does.
 *
 *   0 errors, any number of warnings  →  score >= 80  →  B or better
 *   1 error,  no warnings             →  score == 70  →  C
 *
 * Pure. Deterministic. No I/O. The letter scale is health-score.js's
 * scoreToGrade so the free scan, the badge and the paid report cannot drift.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scoreToGrade } = require('./health-score');

/**
 * Severity per quick-tier module. The module envelope carries plain strings
 * in `details`, so there is no per-finding severity at this layer; assigning
 * a defensible severity per module beats fabricating per-line precision.
 *
 * secrets / syntax stop a release — error (blocking).
 * lint / codeQuality are real findings that do not stop a release — warning.
 */
const SEVERITY_BY_MODULE = Object.freeze({
  secrets: 'error',
  syntax: 'error',
  lint: 'warning',
  codeQuality: 'warning',
});

/** A module we have not classified is a warning, never a blocker. */
const DEFAULT_MODULE_SEVERITY = 'warning';

/** First blocking finding costs this; it alone drops the result below B. */
const BLOCKING_FIRST_PENALTY = 30;
/** Each additional blocking finding. */
const BLOCKING_EXTRA_PENALTY = 8;
/** Warnings can never cost more than this in total — the reason 71 warnings
 *  cannot produce an F. 100 - 20 = 80, which is inside the B band. */
const WARNING_PENALTY_CAP = 20;
/** log10 scale: 1 warning ≈ 2, 10 ≈ 8, 71 ≈ 15, 1000+ ≈ 20 (capped). */
const WARNING_PENALTY_SCALE = 8;

/** Lowest score that still counts as a non-failing result (scoreToGrade's B). */
const NON_FAILING_SCORE = 75;

const GRADE_COLORS = Object.freeze({
  A: '#22c55e',
  B: '#0d9488',
  C: '#eab308',
  D: '#f97316',
  F: '#ef4444',
});
/** Used when nothing was checked — grey, never a green tick (Doctrine #6). */
const NOT_CHECKED_COLOR = '#6b7280';

/** @param {string} name */
function severityForModule(name) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_BY_MODULE, name)
    ? SEVERITY_BY_MODULE[name]
    : DEFAULT_MODULE_SEVERITY;
}

/** @param {unknown} n */
function nonNegInt(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Split a module list's findings into blocking / warning / info counts.
 * @param {Array<{name?:string, status?:string, issues?:number}>} modules
 */
function countFindingsBySeverity(modules) {
  const out = { blocking: 0, warnings: 0, info: 0, total: 0 };
  const list = Array.isArray(modules) ? modules : [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const issues = nonNegInt(m.issues);
    if (issues === 0) continue;
    const severity = severityForModule(String(m.name || ''));
    if (severity === 'error') out.blocking += issues;
    else if (severity === 'info') out.info += issues;
    else out.warnings += issues;
  }
  out.total = out.blocking + out.warnings + out.info;
  return out;
}

/** @param {number} warnings */
function warningPenalty(warnings) {
  if (warnings <= 0) return 0;
  return Math.min(WARNING_PENALTY_CAP, Math.round(Math.log10(1 + warnings) * WARNING_PENALTY_SCALE));
}

/** @param {number} blocking */
function blockingPenalty(blocking) {
  if (blocking <= 0) return 0;
  return BLOCKING_FIRST_PENALTY + (blocking - 1) * BLOCKING_EXTRA_PENALTY;
}

/**
 * "0 blocking · 71 warnings" — both numbers, always, so a reader never has to
 * work out which of them produced the grade.
 * @param {{blocking:number, warnings:number, info:number}} counts
 */
function formatFindingCounts(counts) {
  const parts = [
    `${counts.blocking} blocking`,
    `${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`,
  ];
  if (counts.info > 0) parts.push(`${counts.info} info`);
  return parts.join(' · ');
}

/**
 * @param {Array<{name?:string, status?:string, issues?:number}>} modules
 * @returns {{
 *   score: number|null,
 *   grade: string,
 *   gradeColor: string,
 *   blocking: number,
 *   warnings: number,
 *   info: number,
 *   total: number,
 *   notChecked: boolean,
 *   countLabel: string,
 *   summary: string,
 * }}
 */
function computeScanGrade(modules) {
  const list = Array.isArray(modules) ? modules : [];
  const ran = list.filter((m) => m && typeof m === 'object' && m.status && m.status !== 'skipped');
  const counts = countFindingsBySeverity(ran);
  const countLabel = formatFindingCounts(counts);

  // Doctrine #1's third state. No module produced a result, so there is no
  // grade — say so rather than printing an F nobody earned.
  if (ran.length === 0) {
    return {
      score: null,
      grade: '—',
      gradeColor: NOT_CHECKED_COLOR,
      blocking: 0,
      warnings: 0,
      info: 0,
      total: 0,
      notChecked: true,
      countLabel,
      summary: 'Not checked — no module produced a result.',
    };
  }

  const score = Math.max(
    0,
    Math.min(100, 100 - blockingPenalty(counts.blocking) - warningPenalty(counts.warnings))
  );
  const grade = scoreToGrade(score);

  let summary;
  if (counts.blocking > 0) {
    summary = `Grade ${grade} — ${counts.blocking} blocking finding${counts.blocking === 1 ? '' : 's'} set the grade. ${counts.warnings} warning${counts.warnings === 1 ? '' : 's'} counted but not blocking.`;
  } else if (counts.warnings > 0) {
    summary = `Grade ${grade} — no blocking findings. ${counts.warnings} warning${counts.warnings === 1 ? '' : 's'} counted; warnings alone do not fail the gate.`;
  } else {
    summary = `Grade ${grade} — no findings from the modules that ran.`;
  }

  return {
    score,
    grade,
    gradeColor: GRADE_COLORS[grade] || NOT_CHECKED_COLOR,
    blocking: counts.blocking,
    warnings: counts.warnings,
    info: counts.info,
    total: counts.total,
    notChecked: false,
    countLabel,
    summary,
  };
}

/** Where the bytes came from, in the reader's words. Never "clone". */
const SOURCE_LABELS = Object.freeze({
  archive: 'default-branch archive read over HTTPS (no clone)',
  'archive-anonymous': 'public default-branch archive read over HTTPS (no clone)',
  'gitlab-archive': 'public default-branch archive read over HTTPS (no clone)',
  api: 'default-branch tree read via the GitHub API (no clone)',
});

/** @param {number|null|undefined} ms */
function seconds(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)}s` : null;
}

/**
 * One sentence saying what the free scan actually did, so a 0.1s number is
 * never read as a full-repository clone-and-build.
 *
 * @param {{
 *   filesAnalysed?: number|null,
 *   filesInRepo?: number|null,
 *   source?: string|null,
 *   truncated?: boolean,
 *   engineMs?: number|null,
 *   fetchMs?: number|null,
 * }} scope
 */
function describeScanScope(scope) {
  const s = scope || {};
  const analysed = nonNegInt(s.filesAnalysed);
  const inRepo = nonNegInt(s.filesInRepo);
  const sourceLabel = (s.source && SOURCE_LABELS[s.source]) || 'default-branch read over HTTPS (no clone)';

  const filePart = inRepo > 0
    ? `scanned ${analysed.toLocaleString('en-US')} of ${inRepo.toLocaleString('en-US')} files`
    : `scanned ${analysed.toLocaleString('en-US')} file${analysed === 1 ? '' : 's'}`;

  const parts = [`${filePart} from the ${sourceLabel}`];
  const fetchS = seconds(s.fetchMs);
  const engineS = seconds(s.engineMs);
  if (fetchS) parts.push(`${fetchS} fetch`);
  if (engineS) parts.push(`${engineS} engine time`);
  if (s.truncated) parts.push('file cap reached — findings in the remaining files are not reported');
  return parts.join(' · ');
}

/**
 * `expressjs/express @ 4f1e2ab (main) · scanned <ISO> · report scn_…`
 *
 * A sha we did not resolve says so. Nothing here is derived from a guess.
 *
 * @param {{ repoSlug?: string, commitSha?: string|null, branch?: string|null,
 *           scannedAt?: string|null, scanId?: string|null }} meta
 */
function formatResultHeader(meta) {
  const m = meta || {};
  const slug = m.repoSlug || 'unknown repository';
  const sha = typeof m.commitSha === 'string' && /^[0-9a-f]{7,40}$/i.test(m.commitSha)
    ? m.commitSha.slice(0, 7)
    : null;
  const head = sha
    ? `${slug} @ ${sha}${m.branch ? ` (${m.branch})` : ''}`
    : `${slug} @ commit not resolved${m.branch ? ` (${m.branch})` : ''}`;
  const parts = [head];
  parts.push(m.scannedAt ? `scanned ${m.scannedAt}` : 'scan time not recorded');
  parts.push(m.scanId ? `report ${m.scanId}` : 'report id not issued');
  return parts.join(' · ');
}

module.exports = {
  SEVERITY_BY_MODULE,
  DEFAULT_MODULE_SEVERITY,
  BLOCKING_FIRST_PENALTY,
  BLOCKING_EXTRA_PENALTY,
  WARNING_PENALTY_CAP,
  WARNING_PENALTY_SCALE,
  NON_FAILING_SCORE,
  GRADE_COLORS,
  NOT_CHECKED_COLOR,
  SOURCE_LABELS,
  severityForModule,
  countFindingsBySeverity,
  warningPenalty,
  blockingPenalty,
  formatFindingCounts,
  computeScanGrade,
  describeScanScope,
  formatResultHeader,
};
