'use strict';
/**
 * Head-to-head — the one definition of the published comparison table.
 *
 * scripts/head-to-head.js measures GateTest, Semgrep and ESLint
 * (eslint-plugin-security) on the pinned corpus in
 * reliability-corpus/real-world.json and writes website/app/data/
 * head-to-head.json. /precision renders that file. This module is what
 * both sides share, so the shape the script writes and the shape the page
 * reads cannot drift (Doctrine §4, one definition, imported):
 *
 *   validateHeadToHead(doc)   every problem with a document, [] when valid
 *   buildTable(doc)           the rendered table — columns and rows of cells
 *                             whose text is never blank. A cell for a tool
 *                             that was not run says why; a tool that is not
 *                             measured yet says so and gives the reason.
 *   orderRepos / limitRepos   the run order (Craig's priority list first) and
 *                             the `--repos <n>` cut
 *   elapsedSeconds            wall-clock from a process.hrtime.bigint() start
 *   TOOL_TIMEOUT_MS           the per-tool, per-repo time box (10 minutes)
 *
 * Pure: no I/O, so tests/head-to-head.test.js drives it with fixtures that
 * have every kind of null the script can produce.
 */

const SCHEMA_VERSION = 1;
const TOOL_TIMEOUT_MS = 10 * 60 * 1000;
const SOURCE = 'scripts/head-to-head.js';

/**
 * The workflow runs weekly (.github/workflows/head-to-head.yml, Monday
 * 05:00 UTC). Twice that cadence, plus slack for a missed Monday, is the
 * line between "the schedule hasn't landed yet" and "something is broken":
 * past this the page must say so in plain language rather than let a stale
 * table read as freshly measured (Doctrine #6).
 */
const STALE_AFTER_DAYS = 14;

/** Craig 2026-09-16: measure these first; the rest follow in manifest order. */
const PRIORITY = ['express', 'django', 'rails', 'flask', 'fastify', 'zod', 'gin', 'laravel'];

/** Tool run statuses the script writes and the table renders. */
const STATUS = Object.freeze({
  ok: 'ok',
  timedOut: 'timed out',
  failed: 'failed',
  unavailable: 'tool unavailable on this runner',
  notRun: 'not run',
  notMeasured: 'not measured',
});

const TOOL_LABELS = Object.freeze({
  gatetest: 'GateTest',
  semgrep: 'Semgrep',
  eslintSecurity: 'ESLint + eslint-plugin-security',
  sonarqube: 'SonarQube',
  codeql: 'CodeQL',
});

/** Column order of the published table. */
const TOOL_COLUMNS = ['gatetest', 'semgrep', 'eslintSecurity', 'sonarqube', 'codeql'];

const isInt = (v) => Number.isInteger(v) && v >= 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Put the priority repos first (in priority order), then everything else in
 * the order the manifest lists them. Unknown priority names are ignored.
 * @template {{name: string}} T
 * @param {T[]} repos
 * @param {string[]} [priority]
 * @returns {T[]}
 */
function orderRepos(repos, priority = PRIORITY) {
  const byName = new Map(repos.map((r) => [r.name, r]));
  const first = priority.filter((n) => byName.has(n)).map((n) => byName.get(n));
  const rest = repos.filter((r) => !priority.includes(r.name));
  return [...first, ...rest];
}

/**
 * The `--repos <n>` cut: the first n after ordering. A non-positive or
 * non-numeric n means "all".
 * @template {{name: string}} T
 * @param {T[]} repos
 * @param {number|null|undefined} n
 * @returns {T[]}
 */
function limitRepos(repos, n) {
  const ordered = orderRepos(repos);
  if (!Number.isInteger(n) || n <= 0) return ordered;
  return ordered.slice(0, n);
}

/**
 * Seconds elapsed since a process.hrtime.bigint() start, to one decimal.
 * @param {bigint} startNs
 * @param {bigint} [endNs]
 */
function elapsedSeconds(startNs, endNs = process.hrtime.bigint()) {
  const ns = Number(endNs - startNs);
  return Math.round(ns / 1e8) / 10;
}

/** Seconds as shown in a cell: "42.1 s". */
function fmtSeconds(s) {
  return `${Number(s).toFixed(1)} s`;
}

/**
 * Whole days between doc.generatedAt and now. null when generatedAt is
 * missing or unparseable (validateHeadToHead already rejects that shape;
 * this stays defensive so a bad document degrades to "no sentence" rather
 * than throwing).
 * @param {any} doc
 * @param {Date} [now]
 * @returns {number|null}
 */
function daysSinceGenerated(doc, now = new Date()) {
  const generatedAt = doc && doc.generatedAt;
  if (!isStr(generatedAt) || Number.isNaN(Date.parse(generatedAt))) return null;
  const ms = now.getTime() - Date.parse(generatedAt);
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * A plain sentence for the page when the published table is older than
 * STALE_AFTER_DAYS days, or null when it is current enough that no reader
 * warning is owed. Never a claim about *why* — the workflow's own run
 * history is the place to look for that, not typed text on the page.
 * @param {any} doc
 * @param {Date} [now]
 * @returns {string|null}
 */
function stalenessSentence(doc, now = new Date()) {
  const days = daysSinceGenerated(doc, now);
  if (days === null || days <= STALE_AFTER_DAYS) return null;
  return `Last measured ${days} days ago; the weekly run is scheduled every Monday and this page updates automatically once it lands.`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateGatetest(g, where, problems) {
  if (!g || typeof g !== 'object') { problems.push(`${where}: gatetest must be an object`); return; }
  if (!isStr(g.status)) problems.push(`${where}.gatetest.status must be a non-empty string`);
  if (!isNum(g.seconds)) problems.push(`${where}.gatetest.seconds must be a number`);
  if (g.status === STATUS.ok) {
    if (!isInt(g.blocking)) problems.push(`${where}.gatetest.blocking must be an integer`);
    if (!isInt(g.total)) problems.push(`${where}.gatetest.total must be an integer`);
    if (isInt(g.blocking) && isInt(g.total) && g.blocking > g.total) problems.push(`${where}.gatetest: blocking exceeds total`);
  }
}

function validateSemgrep(s, where, problems) {
  if (!s || typeof s !== 'object') { problems.push(`${where}: semgrep must be an object`); return; }
  if (!isStr(s.status)) problems.push(`${where}.semgrep.status must be a non-empty string`);
  if (!isNum(s.seconds)) problems.push(`${where}.semgrep.seconds must be a number`);
  if (s.status === STATUS.ok) {
    for (const k of ['error', 'warning', 'info']) {
      if (!isInt(s[k])) problems.push(`${where}.semgrep.${k} must be an integer`);
    }
    if (!Number.isInteger(s.exit)) problems.push(`${where}.semgrep.exit must be an integer exit status`);
  }
}

function validateEslint(e, where, problems) {
  if (e === null) return; // not a JS/TS repo — rendered as "not run", never blank
  if (!e || typeof e !== 'object') { problems.push(`${where}: eslintSecurity must be an object or null`); return; }
  if (!isStr(e.status)) problems.push(`${where}.eslintSecurity.status must be a non-empty string`);
  if (!isNum(e.seconds)) problems.push(`${where}.eslintSecurity.seconds must be a number`);
  if (e.status === STATUS.ok) {
    for (const k of ['error', 'warning', 'fatal']) {
      if (!isInt(e[k])) problems.push(`${where}.eslintSecurity.${k} must be an integer`);
    }
  }
}

/**
 * CodeQL, per repo. `undefined`/`null` is accepted and renders as
 * "not measured" (a document written before this column existed, or a run
 * that skipped the tool outright) — it is never required the way gatetest's
 * own result is, because a stale document must keep validating rather than
 * being treated as corrupt. When present, an "ok" row needs its
 * blocking-equivalent and total counts (never a bare zero with no numbers);
 * anything else needs a reason, so a failure can never render as silence.
 */
function validateCodeql(c, where, problems) {
  if (c === null || c === undefined) return;
  if (typeof c !== 'object') { problems.push(`${where}: codeql must be an object, null or undefined`); return; }
  if (!isStr(c.status)) problems.push(`${where}.codeql.status must be a non-empty string`);
  if (!isNum(c.seconds)) problems.push(`${where}.codeql.seconds must be a number`);
  if (c.status === STATUS.ok) {
    if (!isInt(c.blocking)) problems.push(`${where}.codeql.blocking must be an integer`);
    if (!isInt(c.total)) problems.push(`${where}.codeql.total must be an integer`);
    if (isInt(c.blocking) && isInt(c.total) && c.blocking > c.total) problems.push(`${where}.codeql: blocking exceeds total`);
  } else if (!isStr(c.reason)) {
    problems.push(`${where}.codeql: a not-measured result needs a reason`);
  }
}

/**
 * Every problem with a head-to-head document. [] means valid. Nothing here
 * is a warning: the page renders exactly what passes, so anything that
 * would render as a blank or a lie is an error.
 * @param {any} doc
 * @returns {string[]}
 */
function validateHeadToHead(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['document must be an object'];
  if (doc.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (doc.source !== SOURCE) problems.push(`source must be "${SOURCE}" — the file is generated, not typed`);
  if (!isStr(doc.generatedAt) || Number.isNaN(Date.parse(doc.generatedAt))) problems.push('generatedAt must be an ISO timestamp');
  if (!/^\d+\.\d+\.\d+/.test(String(doc.engineVersion))) problems.push('engineVersion must be a semver string');
  if (!isStr(doc.suite)) problems.push('suite must name the GateTest suite that ran');
  if (!isInt(doc.corpusSize) || doc.corpusSize < 1) problems.push('corpusSize must be the manifest length');

  const tools = doc.tools;
  if (!tools || typeof tools !== 'object') {
    problems.push('tools must be an object');
  } else {
    if (!tools.gatetest || !isStr(tools.gatetest.version)) problems.push('tools.gatetest.version is required');
    for (const t of ['semgrep', 'eslintSecurity']) {
      const v = tools[t];
      if (!v || typeof v !== 'object') { problems.push(`tools.${t} must be an object`); continue; }
      if (!(v.version === null || isStr(v.version))) problems.push(`tools.${t}.version must be a string or null`);
      if (v.version === null && !isStr(v.reason)) problems.push(`tools.${t}: a null version needs a reason`);
    }
    // SonarQube needs a running server — this script never runs it, so its
    // document-level entry is always "not measured" with a reason.
    {
      const v = tools.sonarqube;
      if (!v || typeof v !== 'object') problems.push('tools.sonarqube must be an object');
      else {
        if (v.status !== STATUS.notMeasured) problems.push(`tools.sonarqube.status must be "${STATUS.notMeasured}" until it is measured for real`);
        if (!isStr(v.reason)) problems.push('tools.sonarqube.reason must say why it is not measured');
      }
    }
    // CodeQL: version string when the CLI ran on this runner, or null with a
    // reason — the same shape as semgrep/eslintSecurity above, now that the
    // adapter can actually measure a repo. Also accepts the pre-adapter
    // shape ({status:'not measured', reason}) so a document generated before
    // this column existed keeps validating; buildTable renders both the
    // same way (Doctrine #7: generated over typed — nothing here is ever
    // hand-edited to look newer than the run that produced it).
    {
      const v = tools.codeql;
      if (!v || typeof v !== 'object') problems.push('tools.codeql must be an object');
      else if (v.status === STATUS.notMeasured) {
        if (!isStr(v.reason)) problems.push('tools.codeql.reason must say why it is not measured');
      } else {
        if (!(v.version === null || isStr(v.version))) problems.push('tools.codeql.version must be a string or null');
        if (v.version === null && !isStr(v.reason)) problems.push('tools.codeql: a null version needs a reason');
      }
    }
  }

  if (!Array.isArray(doc.repos)) {
    problems.push('repos must be an array');
    return problems;
  }
  if (doc.repos.length === 0) problems.push('repos must not be empty');
  const seen = new Set();
  doc.repos.forEach((r, i) => {
    const where = `repos[${i}]${r && r.name ? ` (${r.name})` : ''}`;
    if (!r || typeof r !== 'object') { problems.push(`${where} must be an object`); return; }
    if (!isStr(r.name)) problems.push(`${where}.name is required`);
    else if (seen.has(r.name)) problems.push(`${where}: duplicate repo`);
    seen.add(r.name);
    if (!isStr(r.url)) problems.push(`${where}.url is required`);
    if (!/^[0-9a-f]{40}$/.test(String(r.sha))) problems.push(`${where}.sha must be a full 40-hex commit`);
    if (!isStr(r.language)) problems.push(`${where}.language is required`);
    if (!isStr(r.measuredAt) || Number.isNaN(Date.parse(r.measuredAt))) problems.push(`${where}.measuredAt must be an ISO timestamp`);
    validateGatetest(r.gatetest, where, problems);
    validateSemgrep(r.semgrep, where, problems);
    if (!('eslintSecurity' in r)) problems.push(`${where}.eslintSecurity must be present (null when not a JS/TS repo)`);
    else validateEslint(r.eslintSecurity, where, problems);
    // codeql is optional (see validateCodeql) so a document written before
    // this column existed still validates; when present its shape is checked.
    if ('codeql' in r) validateCodeql(r.codeql, where, problems);
  });
  return problems;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * @typedef {{ text: string, detail?: string, kind: 'measured'|'clean'|'unavailable'|'not-measured'|'not-run'|'failed' }} Cell
 */

/** A status that is not "ok", as a cell. */
function statusCell(status, seconds) {
  if (status === STATUS.timedOut) {
    return { text: `timed out after ${fmtSeconds(seconds)}`, kind: 'failed' };
  }
  if (status === STATUS.unavailable) return { text: STATUS.unavailable, kind: 'unavailable' };
  if (typeof status === 'string' && status.startsWith(STATUS.failed)) {
    return { text: status, detail: isNum(seconds) ? fmtSeconds(seconds) : undefined, kind: 'failed' };
  }
  return { text: isStr(status) ? status : STATUS.notMeasured, kind: 'not-measured' };
}

/** @returns {Cell} */
function gatetestCell(g) {
  if (!g || typeof g !== 'object') return { text: STATUS.notMeasured, kind: 'not-measured' };
  if (g.status !== STATUS.ok) return statusCell(g.status, g.seconds);
  return {
    text: `${g.blocking} blocking / ${g.total} findings`,
    detail: fmtSeconds(g.seconds),
    kind: g.blocking === 0 ? 'clean' : 'measured',
  };
}

/** @returns {Cell} */
function semgrepCell(s) {
  if (!s || typeof s !== 'object') return { text: STATUS.notMeasured, kind: 'not-measured' };
  if (s.status !== STATUS.ok) return statusCell(s.status, s.seconds);
  // Newer rulesets also label findings CRITICAL / HIGH / MEDIUM / LOW; those
  // are counted, shown with their labels, and never folded into "error".
  const labels = Array.isArray(s.otherSeverities) && s.otherSeverities.length ? ` (${s.otherSeverities.join(', ')})` : '';
  const other = isInt(s.other) && s.other > 0 ? ` / ${s.other} other${labels}` : '';
  return {
    text: `${s.error} error / ${s.warning} warning / ${s.info} info${other}`,
    detail: fmtSeconds(s.seconds),
    kind: s.error === 0 ? 'clean' : 'measured',
  };
}

/** @returns {Cell} */
function eslintCell(e) {
  if (e === null || e === undefined) return { text: `${STATUS.notRun} — not a JavaScript/TypeScript repository`, kind: 'not-run' };
  if (typeof e !== 'object') return { text: STATUS.notMeasured, kind: 'not-measured' };
  if (e.status !== STATUS.ok) return statusCell(e.status, e.seconds);
  const fatal = isInt(e.fatal) && e.fatal > 0 ? ` / ${e.fatal} parse failures` : '';
  return {
    text: `${e.error} error / ${e.warning} warning${fatal}`,
    detail: fmtSeconds(e.seconds),
    kind: e.error === 0 ? 'clean' : 'measured',
  };
}

/** SonarQube: not measured yet, with the reason from the document. */
function notMeasuredCell(tool) {
  const reason = tool && isStr(tool.reason) ? tool.reason : 'no measurement has been run';
  return { text: `${STATUS.notMeasured} — ${reason}`, kind: 'not-measured' };
}

/**
 * @returns {Cell} CodeQL, per repo: measured blocking-equivalent / total
 * results when the adapter ran, otherwise "not measured" with the reason
 * (CLI absent, unsupported language, timeout or a failed CLI step) —
 * `undefined`/`null` (a document from before this column existed) renders
 * the same way, never a blank cell.
 */
function codeqlCell(c) {
  if (!c || typeof c !== 'object') return { text: STATUS.notMeasured, kind: 'not-measured' };
  if (c.status !== STATUS.ok) {
    const reason = isStr(c.reason) ? c.reason : 'no measurement has been run';
    return { text: `${STATUS.notMeasured} — ${reason}`, kind: 'not-measured' };
  }
  return {
    text: `${c.blocking} blocking-equivalent / ${c.total} results`,
    detail: fmtSeconds(c.seconds),
    kind: c.blocking === 0 ? 'clean' : 'measured',
  };
}

/**
 * The published table. Every cell has non-empty text; the page maps this to
 * <td>s and tests/head-to-head.test.js proves no cell can be blank.
 * @param {any} doc a document validateHeadToHead accepts
 * @returns {{ columns: Array<{key: string, label: string, version: string|null}>, rows: Array<{name: string, url: string, sha: string, language: string, cells: Cell[]}> }}
 */
function buildTable(doc) {
  const tools = (doc && doc.tools) || {};
  const columns = TOOL_COLUMNS.map((key) => ({
    key,
    label: TOOL_LABELS[key],
    version: tools[key] && isStr(tools[key].version) ? tools[key].version : null,
  }));
  const rows = ((doc && doc.repos) || []).map((r) => ({
    name: r.name,
    url: r.url,
    sha: r.sha,
    language: isStr(r.language) ? r.language : 'unknown',
    cells: [
      gatetestCell(r.gatetest),
      semgrepCell(r.semgrep),
      eslintCell(r.eslintSecurity),
      notMeasuredCell(tools.sonarqube),
      codeqlCell(r.codeql),
    ],
  }));
  return { columns, rows };
}

module.exports = {
  SCHEMA_VERSION,
  SOURCE,
  TOOL_TIMEOUT_MS,
  STALE_AFTER_DAYS,
  PRIORITY,
  STATUS,
  TOOL_LABELS,
  TOOL_COLUMNS,
  orderRepos,
  limitRepos,
  elapsedSeconds,
  fmtSeconds,
  validateHeadToHead,
  buildTable,
  daysSinceGenerated,
  stalenessSentence,
};
