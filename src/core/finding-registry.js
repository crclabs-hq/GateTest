'use strict';

/**
 * Finding registry — ONE defect is ONE finding, ranked by what matters.
 *
 * Why (2026-08-18 audit, Craig: "nailing the sore points matters most"):
 * the #1 complaint about every incumbent is noise. Ours had two shapes on
 * top of rule-level false positives:
 *   1. The same defect reported by several modules — `eval()` by security,
 *      codeQuality AND crossFileTaint (3 lines = 9 findings on NodeGoat);
 *      a secret by secrets + security:secret + a summary check (×4).
 *   2. Findings presented in module order, uncapped, with severity and
 *      confidence lost — the PR comment and hosted results were 45 flat
 *      strings, so a critical SQL injection sat under 44 style notes.
 *
 * This module is pure (no fs, no network) so it can be tested on hand-built
 * results with known answers. It never mutates counts the gate uses; it
 * annotates (`duplicateOf`) and RANKS, and reporters choose what to show.
 *
 *   normalizeFindings(results, opts)  → structured, deduped, ranked list
 *   summarizeFindings(findings)       → counts for headlines / footers
 *   annotateDuplicates(results)       → sets check.duplicateOf in place
 */

const { BLOCK_THRESHOLD, isBlockingFinding } = require('./confidence');
const { suggestLine } = require('./ignore-file');
const { toPosix } = require('./repo-path');

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

// Which module "owns" a class of defect when several report it — the one
// whose finding carries the most actionable detail. Lower index wins.
const OWNER_PRIORITY = [
  'crossFileTaint', 'security', 'secrets', 'authBypass', 'ssrf', 'redos', 'cookieSecurity', 'tlsSecurity',
  'logPii', 'python', 'ruby', 'go', 'java', 'php', 'rust', 'csharp', 'kotlin', 'swift',
  'codeQuality', 'lint', 'undefinedRef', 'accessibility', 'seo', 'visual', 'links', 'documentation',
];

// Defect CLASSES — the same class at the same file:line is the same defect
// whichever module said it. Order matters only for readability.
const CLASS_PATTERNS = [
  ['eval', /\beval\b|\bnew\s+Function\b|arbitrary code execution/i],
  ['innerhtml', /innerHTML|dangerouslySetInnerHTML|document\.write/i],
  ['secret', /secret|api[ _-]?key|password|credential|private key|token found|hardcoded/i],
  ['sqli', /sql injection|sqli\b|unsanitized .*query|string-concatenated (sql|query)/i],
  ['open-redirect', /open redirect|redirect\(req\./i],
  ['shell-exec', /command injection|shell exec|exec(Sync)? with interpolated|child_process/i],
  ['gitignore', /\.gitignore/i],
  ['console-log', /console\.(log|debug|info)/i],
  ['unused', /unused (import|variable|export)|appears unused|never used/i],
  ['missing-alt', /missing alt/i],
  ['viewport', /viewport/i],
  ['unprotected-route', /unprotected route|missing authentication|no auth/i],
  ['dead-link', /dead|broken (internal )?link|placeholder link|href="#"/i],
  ['math-random', /Math\.random/i],
];

function classify(message) {
  const m = String(message || '');
  for (const [cls, re] of CLASS_PATTERNS) if (re.test(m)) return cls;
  return null;
}

/** Strip a trailing file[:line] from a check name to get the rule key. */
function ruleKeyOf(name, file) {
  let n = String(name || '');
  if (file) {
    for (const f of [file, file.replace(/\\/g, '/'), file.replace(/\//g, '\\')]) {
      const i = n.indexOf(f);
      if (i > 0) { n = n.slice(0, i).replace(/:$/, ''); break; }
    }
  }
  // fall back: cut at the first segment that looks like a path or a number
  const segs = n.split(':');
  const out = [];
  for (const s of segs) {
    if (out.length && (/[\\/]/.test(s) || /^\d+$/.test(s) || /\.[a-z0-9]{1,5}$/i.test(s))) break;
    out.push(s);
  }
  return out.join(':') || n;
}

function normPath(p) {
  return p ? toPosix(p) : null;
}

/**
 * Flatten module results into structured findings, mark cross-module
 * duplicates, and rank: blocking first, then severity, then confidence.
 *
 * @param {Array<{module:string, checks?:Array}>} results   summary.results from the engine
 * @param {{ threshold?: number, includePassed?: boolean, modelVerdictsBlock?: boolean }} [opts]
 * @returns {Array<Finding>}
 */
function normalizeFindings(results, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : BLOCK_THRESHOLD;
  const modelVerdictsBlock = opts.modelVerdictsBlock === true;
  const findings = [];
  for (const r of results || []) {
    const mod = r.module || r.name || 'unknown';
    for (const c of r.checks || []) {
      // Suppressed (.gatetestignore / baseline) checks are out of every
      // gate count in runner.js; they must be out of the ranked view too,
      // or the host verdict built on `blocking` re-enforces what the
      // customer explicitly dismissed.
      if (!c || c.passed || c.suppressed) continue;
      const severity = (c.severity || 'error').toLowerCase();
      const file = normPath(c.file || c.filePath || (c.details && !Array.isArray(c.details) && c.details.file) || null);
      const line = Number(c.line || (c.details && !Array.isArray(c.details) && c.details.line) || 0) || null;
      const confidence = typeof c.confidence === 'number' ? c.confidence : 1;
      // verdictSource (the Fifty, move 14): set once, in runner.js
      // TestResult.addCheck — this is a read, never a second definition.
      const verdictSource = c.verdictSource || 'deterministic';
      findings.push({
        id: `${mod}:${c.name}`,
        module: mod,
        rule: ruleKeyOf(c.name, c.file),
        severity: SEVERITY_RANK[severity] === undefined ? 'info' : severity,
        confidence,
        verdictSource,
        // What a stricter policy would decide — preserved even when the
        // gate itself does not block on it (a model-judged finding by
        // default). See `isBlockingFinding` / `gate.modelVerdictsBlock`.
        wouldBlock: c.wouldBlock === true,
        blocking: severity === 'error'
          && isBlockingFinding({ severity, confidence, verdictSource }, threshold, modelVerdictsBlock),
        file,
        line,
        message: String(c.message || c.name || ''),
        suggestion: c.suggestion || c.fix || null,
        // Verified code quote (AI findings pass an evidence gate before
        // this field is populated) — reporters attach it so the reader
        // never takes an AI finding on faith (advancement #5).
        evidence: typeof c.evidence === 'string' && c.evidence ? c.evidence : null,
        // classify on the message AND the rule name — a taint sink is named
        // `taint:sink:eval` while its message talks about flows, not eval()
        class: classify(`${c.message || ''} ${c.name || ''}`),
        duplicateOf: null,
        // The exact .gatetestignore line for this one finding (move 25) —
        // computed once here so the CLI, the PR comment and the report all
        // offer the same line, and one the matcher is known to honour.
        ignoreLine: suggestLine({ module: mod, name: c.name, ruleKey: ruleKeyOf(c.name, c.file), file }),
      });
    }
  }
  markDuplicates(findings);
  return rank(findings);
}

function ownerRank(module) {
  const i = OWNER_PRIORITY.indexOf(module);
  return i === -1 ? OWNER_PRIORITY.length : i;
}

/** Same file + line + class from different modules → keep one, mark the rest. */
function markDuplicates(findings) {
  const groups = new Map();
  for (const f of findings) {
    if (!f.file || !f.line || !f.class) continue;
    const key = `${f.file}:${f.line}:${f.class}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) =>
      (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) ||
      (b.confidence - a.confidence) ||
      (ownerRank(a.module) - ownerRank(b.module)));
    const primary = group[0];
    for (const dup of group.slice(1)) {
      if (dup.module === primary.module) continue; // same module twice is its own bug, not a cross-module dup
      dup.duplicateOf = primary.id;
    }
  }
}

// Within one severity band: exploitable classes before hygiene, and a
// concrete file:line before an aggregate summary ("12 broken links").
const CLASS_WEIGHT = { sqli: 0, eval: 0, 'shell-exec': 0, secret: 1, 'open-redirect': 1, innerhtml: 1, 'unprotected-route': 1, 'math-random': 2 };
function classWeight(f) {
  if (f.class && CLASS_WEIGHT[f.class] !== undefined) return CLASS_WEIGHT[f.class];
  if (/security|taint|ssrf|redos|auth|secret|tls|cookie|pii/i.test(f.module + ':' + f.rule)) return 3;
  return 5;
}
function rank(findings) {
  return findings.slice().sort((a, b) =>
    (Number(Boolean(a.duplicateOf)) - Number(Boolean(b.duplicateOf))) ||
    (Number(b.blocking) - Number(a.blocking)) ||
    (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) ||
    (b.confidence - a.confidence) ||
    (classWeight(a) - classWeight(b)) ||
    (Number(!(a.file && a.line)) - Number(!(b.file && b.line))) ||
    (ownerRank(a.module) - ownerRank(b.module)) ||
    String(a.file || '').localeCompare(String(b.file || '')) ||
    ((a.line || 0) - (b.line || 0)));
}

/** Headline numbers for reporters. Duplicates are excluded from every count. */
function summarizeFindings(findings) {
  const s = {
    total: 0, blocking: 0, softErrors: 0, warnings: 0, info: 0,
    duplicatesCollapsed: 0, hiddenLowConfidence: 0,
    // The Fifty, move 14: model-judged findings — never in `blocking` unless
    // the gate opted in — counted separately from `softErrors` so a model
    // opinion held back by POLICY is never reported as "low confidence".
    modelJudged: 0, modelJudgedWouldBlock: 0,
  };
  for (const f of findings) {
    if (f.duplicateOf) { s.duplicatesCollapsed++; continue; }
    s.total++;
    if (f.verdictSource === 'model') {
      s.modelJudged++;
      if (f.wouldBlock) s.modelJudgedWouldBlock++;
    }
    if (f.severity === 'error') {
      if (f.blocking) s.blocking++;
      else if (f.verdictSource !== 'model') { s.softErrors++; s.hiddenLowConfidence++; }
    } else if (f.severity === 'warning') s.warnings++;
    else s.info++;
  }
  return s;
}

/**
 * In-place: stamp `duplicateOf` on the underlying checks so every reporter
 * that walks `summary.results` can hide cross-module duplicates without
 * changing the counts the gate decided on.
 */
function annotateDuplicates(results, opts = {}) {
  const findings = normalizeFindings(results, opts);
  const dupIds = new Map(findings.filter((f) => f.duplicateOf).map((f) => [f.id, f.duplicateOf]));
  let stamped = 0;
  for (const r of results || []) {
    const mod = r.module || r.name || 'unknown';
    for (const c of r.checks || []) {
      if (!c || c.passed) continue;
      const dup = dupIds.get(`${mod}:${c.name}`);
      if (dup) { c.duplicateOf = dup; stamped++; }
    }
  }
  return stamped;
}

module.exports = { normalizeFindings, summarizeFindings, annotateDuplicates, classify, ruleKeyOf, CLASS_PATTERNS };
