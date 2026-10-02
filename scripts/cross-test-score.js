#!/usr/bin/env node
'use strict';

/**
 * Cross-test score — GateTest graded against a platform's own bug corpus.
 *
 * Tallrig publishes TALLRIG_BUG_CORPUS.json (gluecron.com/ccantynz/tallrig,
 * docs/cross-test/): real defects with the code before and after each fix and
 * a concrete `howToDetect`. The audit of 2026-10-02 measured 4 caught /
 * 2 partial / 11 missed on the first 17; this script makes that number
 * repeatable and makes it only go up (docs/cross-test/README.md in Tallrig).
 *
 * THE CORPUS IS NEVER COMMITTED HERE. This repository is public and the
 * corpus holds open, live vulnerabilities in a private product. Pass it by
 * path (`--corpus`) from a private checkout; the published record is the
 * aggregate only (`--summary-only`).
 *
 * Snippet mode (the only mode until GateTest can check out the corpus
 * revisions): each entry's vulnerableSnippet / fixSnippet is written at its
 * real repo path (`// ... path:line` separators start a new file), scanned
 * with the full suite, and graded by Tallrig's rules:
 *   caught   a finding in the entry's files whose rule maps to the class
 *            (CLASS_RULES) and that is gone on the fixed snippet
 *   partial  a finding in those files that is gone on the fix but whose rule
 *            does not map to the class (a generic catch)
 *   missed   nothing, or only findings that survive the fix (noise)
 * Open entries have no fix: mapped finding → caught, any finding → partial.
 * Findings from modules that judge a file as a whole (CONTEXT_MODULES) are
 * ignored: a 25-line fragment is not a program, so "unused export" or
 * "parse error" on it says nothing about the defect.
 *
 * Usage:
 *   node scripts/cross-test-score.js --corpus /path/TALLRIG_BUG_CORPUS.json [--out results.json] [--summary-only] [--only ID,ID]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GATETEST = path.join(ROOT, 'bin', 'gatetest.js');

// Modules whose verdict is about a whole file or project, not a defect in it.
const CONTEXT_MODULES = new Set([
  'syntax', 'lint', 'deadCode', 'documentation', 'deployReadiness', 'secrets:gitignore',
  'undefinedRef', 'importCycle', 'spineHealth', 'fileSize', 'memory', 'aiHallucination',
]);

// class → GateTest rules that name it. A finding whose `module` or `ruleId`
// starts with one of these counts as a catch of that class. Grows with every
// detector built against the corpus; never shrinks (a release that catches
// less than the last one fails — Tallrig's rule).
const CLASS_RULES = {
  'swallowed-destructive-failure': ['errorSwallow', 'error-swallow'],
  'secret-in-url-query': ['url-credential', 'urlCredential'],
  'env-name-leak-in-error': ['error-detail-leak', 'errorDetailLeak'],
  'csp-eval-dependency': ['csp-eval-conflict'],
  'weak-kdf-shared-secret': ['weak-kdf', 'weakKdf'],
  'vendor-text-leak': ['upstream-error-leak'],
  'insecure-default-plan-tier': ['insecure-default-tier'],
  'lockfile-manifest-drift': ['peer-meta-drift'],
  'ambient-credential-fallback': ['ambient-credential-fallback'],
};

const SEP_RE = /^\s*(?:\/\/|--|#)\s*\.\.\.\s*([^\s:]+\.[\w]+):(\d+)\s*$/;

// A JSON snippet cut from inside the root object (`  "dependencies": {…`)
// is not a document; put the root brace back so the file parses the way the
// real one does. Only when the fragment does not already parse.
function parsesAsJson(text) {
  try { JSON.parse(text); return true; } catch { return false; }
}

function rebuildFragment(file, content) {
  if (!/\.json$/.test(file) || parsesAsJson(content)) return content;
  const wrapped = `{\n${content}`;
  return parsesAsJson(wrapped) ? wrapped : content;
}

/** Split a snippet into files at its `// ... path:line` separators. Pure. */
function splitSnippet(snippet, primaryFile) {
  const files = new Map();
  let current = primaryFile;
  for (const line of String(snippet || '').split(/\r?\n/)) {
    const m = SEP_RE.exec(line);
    if (m) { current = m[1]; if (!files.has(current)) files.set(current, []); continue; }
    if (!files.has(current)) files.set(current, []);
    files.get(current).push(line);
  }
  return [...files.entries()]
    .filter(([, lines]) => lines.some((l) => l.trim()))
    .map(([file, lines]) => ({ file, content: rebuildFragment(file, `${lines.join('\n')}\n`) }));
}

function relevant(issues, files) {
  const want = new Set(files);
  return (issues || []).filter((i) => i.file && want.has(i.file) && !CONTEXT_MODULES.has(i.module));
}

function identity(i) {
  // A finding's identity across the two scans: rule + file, not line (the
  // fixed snippet moves lines). Doctrine §4: one definition of identity —
  // this one is local to the harness because snippet line numbers are not
  // real line numbers.
  return `${i.module}|${i.ruleId}|${i.file}`;
}

function mapsToClass(issue, cls) {
  const keys = CLASS_RULES[cls] || [];
  const segments = [issue.module, ...String(issue.ruleId || '').split(':')].map(String);
  return keys.some((k) => segments.some((seg) => seg.startsWith(k)));
}

/** Grade one entry from the two scans' issues. Pure. */
function grade(entry, vulnIssues, fixedIssues, files) {
  const vuln = relevant(vulnIssues, files);
  if (entry.status === 'open' || fixedIssues == null) {
    const hit = vuln.find((i) => mapsToClass(i, entry.class));
    if (hit) return { grade: 'caught', rule: hit.ruleId || hit.module };
    if (vuln.length) return { grade: 'partial', rule: vuln[0].ruleId || vuln[0].module };
    return { grade: 'missed' };
  }
  const survived = new Set(relevant(fixedIssues, files).map(identity));
  const gone = vuln.filter((i) => !survived.has(identity(i)));
  const mapped = gone.find((i) => mapsToClass(i, entry.class));
  if (mapped) return { grade: 'caught', rule: mapped.ruleId || mapped.module };
  if (gone.length) return { grade: 'partial', rule: gone[0].ruleId || gone[0].module };
  return { grade: 'missed', noise: vuln.length };
}

function scanFiles(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-xtest-'));
  try {
    for (const f of files) {
      const abs = path.join(dir, f.file);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content);
    }
    const res = spawnSync(process.execPath, [GATETEST, 'scan', '--suite', 'full', '--project', dir, '--json'], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, GATETEST_NO_TELEMETRY: '1' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    });
    const report = JSON.parse(res.stdout);
    return report.issues || [];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function score(results) {
  const scored = results.filter((r) => r.status !== 'withdrawn');
  const rate = (list) => (list.length ? (list.filter((r) => r.grade === 'caught').length + 0.5 * list.filter((r) => r.grade === 'partial').length) / list.length : null);
  const bySeverity = {};
  for (const sev of ['P0', 'P1', 'P2', 'P3']) bySeverity[sev] = rate(scored.filter((r) => r.severity === sev));
  return {
    scored: scored.length,
    caught: scored.filter((r) => r.grade === 'caught').length,
    partial: scored.filter((r) => r.grade === 'partial').length,
    missed: scored.filter((r) => r.grade === 'missed').length,
    catchRate: rate(scored),
    bySeverity,
  };
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const corpusPath = arg('--corpus');
  if (!corpusPath) { process.stderr.write('usage: cross-test-score.js --corpus <TALLRIG_BUG_CORPUS.json> [--out file] [--summary-only] [--only ID,ID]\n'); return 64; }
  const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')).filter((e) => !only || only.has(e.id));
  const results = [];
  for (const e of corpus) {
    const vulnFiles = splitSnippet(e.vulnerableSnippet, e.file);
    const fixFiles = e.fixSnippet ? splitSnippet(e.fixSnippet, e.file) : null;
    const files = [...new Set([...vulnFiles, ...(fixFiles || [])].map((f) => f.file))];
    const vulnIssues = scanFiles(vulnFiles);
    const fixedIssues = fixFiles && e.status !== 'open' ? scanFiles(fixFiles) : null;
    const g = grade(e, vulnIssues, fixedIssues, files);
    results.push({ id: e.id, class: e.class, severity: e.severity, status: e.status, ...g });
    if (!argv.includes('--summary-only')) {
      process.stdout.write(`${e.id} ${e.class} ${e.severity} ${g.grade.padEnd(7)}${g.rule ? ` rule=${g.rule}` : ''}${g.noise ? ` (noise ${g.noise})` : ''}\n`);
    }
  }
  const summary = { mode: 'snippet', engine: require('../package.json').version, at: new Date().toISOString(), ...score(results) };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  const out = arg('--out');
  if (out) fs.writeFileSync(out, `${JSON.stringify({ summary, results }, null, 2)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { splitSnippet, grade, score };
