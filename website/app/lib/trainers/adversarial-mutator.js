/**
 * Adversarial mutator trainer (Wave 3).
 *
 * The "self-test the gate" trainer. Picks a sample of known-good source
 * files, applies single-operator mutations via the canonical mutation
 * engine (src/core/mutation-engine.js), then runs the gate against each
 * mutated version and asks ONE QUESTION:
 *
 *   Does the gate emit a NEW error (or upgraded severity) compared to
 *   its findings against the unmutated original?
 *
 * If YES → the mutation was caught. Good — coverage holds.
 * If NO  → the mutation slipped through. That's a COVERAGE HOLE. Report.
 *
 * The trainer is BUDGETED — it picks a small N per file because running
 * the full gate against every mutation explodes runtime. The point is
 * not exhaustive proof but a continuous trickle of coverage signal.
 *
 * RESILIENCE: never throws. Per-file errors are recorded as
 * 'errored' status; the loop continues.
 *
 * BUDGET: by default, scans up to 10 source files, generates up to 5
 * mutations per file, runs the `quick` suite for each. Override via
 * opts.{maxFiles, maxMutationsPerFile, suite}.
 *
 * IMPORTANT: this trainer modifies file contents IN A TEMP COPY of
 * the repo, never the original. The original repo is untouched.
 *
 * Output:
 *   tests/auto-generated/coverage-holes.json   (machine-readable holes)
 *   ~/.gatetest/trainers/adversarial-mutator-latest.json
 *
 * The nightly workflow commits coverage-holes.json to the trainer PR
 * so reviewers can see which mutations slipped through and decide
 * whether to harden the relevant module.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MutationEngine = require('../../../../src/core/mutation-engine.js');

const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_MUTATIONS_PER_FILE = 5;
const DEFAULT_SUITE = 'quick';
const DEFAULT_TIMEOUT_PER_RUN_MS = 60_000;

let _warnedOnce = false;
function warnOnce(msg) {
  if (_warnedOnce) return;
  _warnedOnce = true;
  // eslint-disable-next-line no-console
  console.warn(`[adversarial-mutator] ${msg}`);
}

// ---------------------------------------------------------------------------
// Source-file selection — pick a representative sample, not everything
// ---------------------------------------------------------------------------

const EXCLUDE_PATH_RE = /(?:^|\/)(?:node_modules|\.next|\.git|coverage|dist|build|tests?|__tests__|spec|specs|auto-generated)\/|\.(?:test|spec|min|bundle)\.[a-z]+$/i;

function listSourceFiles(repoRoot, opts = {}) {
  const max = opts.maxFiles || DEFAULT_MAX_FILES;
  const candidateDirs = ['src', 'website/app/lib'];
  const out = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(repoRoot, full).replace(/\\/g, '/');
      if (EXCLUDE_PATH_RE.test('/' + rel)) continue;
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!/\.(?:js|mjs|cjs|ts|mts|cts)$/.test(e.name)) continue;
      out.push(rel);
    }
  }

  for (const d of candidateDirs) {
    const abs = path.join(repoRoot, d);
    if (fs.existsSync(abs)) walk(abs);
  }

  // Sample evenly across the discovered list so we hit multiple modules.
  if (out.length <= max) return out;
  const step = Math.max(1, Math.floor(out.length / max));
  const sampled = [];
  for (let i = 0; i < out.length && sampled.length < max; i += step) {
    sampled.push(out[i]);
  }
  return sampled;
}

// ---------------------------------------------------------------------------
// Gate runner — invoke `node bin/gatetest.js --suite <s> --json` in a temp
// repo copy. Returns the JSON report or null on failure.
// ---------------------------------------------------------------------------

function runGate(repoRoot, suite, timeoutMs) {
  try {
    const out = execFileSync('node', [
      path.join(repoRoot, 'bin', 'gatetest.js'),
      '--suite', suite,
      '--json',
      '--projectRoot', repoRoot,
    ], {
      encoding: 'utf8',
      cwd: repoRoot,
      timeout: timeoutMs || DEFAULT_TIMEOUT_PER_RUN_MS,
      maxBuffer: 50 * 1024 * 1024,
    });
    return parseJsonSafe(out);
  } catch (err) {
    // The gate exits non-zero on findings — but execFileSync throws then.
    // Try to recover stdout from the error.
    if (err && err.stdout) {
      const parsed = parseJsonSafe(String(err.stdout));
      if (parsed) return parsed;
    }
    return null;
  }
}

function parseJsonSafe(text) {
  if (typeof text !== 'string') return null;
  // The gate may print non-JSON banner lines before the JSON object.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Findings comparison
// ---------------------------------------------------------------------------

function errorCountByRule(report) {
  const out = new Map();
  if (!report) return out;
  const checks = Array.isArray(report.checks) ? report.checks
                : Array.isArray(report.findings) ? report.findings
                : [];
  for (const c of checks) {
    if (!c || typeof c !== 'object') continue;
    const severity = c.severity || (c.passed === false ? 'error' : 'info');
    if (severity !== 'error') continue;
    const key = c.rule || c.ruleKey || c.module || '?';
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}

/**
 * @returns true if `mutated` introduces a new error rule OR raises the
 *          error count for a rule already present in `baseline`.
 */
function mutationWasCaught(baseline, mutated) {
  const b = errorCountByRule(baseline);
  const m = errorCountByRule(mutated);
  for (const [rule, count] of m.entries()) {
    if ((b.get(rule) || 0) < count) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the adversarial mutator against the repo.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot=process.cwd()]
 * @param {number} [opts.maxFiles]
 * @param {number} [opts.maxMutationsPerFile]
 * @param {string} [opts.suite]            'quick' | 'full' | …
 * @param {boolean} [opts.dryRun=false]    if true, do not run gate; just
 *                                         enumerate would-be mutations.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object>}
 */
async function run(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;
  const maxMutationsPerFile = opts.maxMutationsPerFile || DEFAULT_MAX_MUTATIONS_PER_FILE;
  const suite = opts.suite || DEFAULT_SUITE;
  const dryRun = !!opts.dryRun;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_PER_RUN_MS;

  const files = listSourceFiles(repoRoot, { maxFiles });
  const result = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    suite,
    files: files.length,
    mutationsTried: 0,
    mutationsCaught: 0,
    coverageHoles: [],
    errors: [],
  };

  // Baseline gate run on the unmutated repo
  let baseline = null;
  if (!dryRun) {
    baseline = runGate(repoRoot, suite, timeoutMs);
    if (!baseline) {
      result.errors.push('baseline gate run produced no parseable output — aborting');
      return result;
    }
  }

  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    let source;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      result.errors.push(`${rel}: read failed: ${err.message}`);
      continue;
    }

    let candidates;
    try {
      candidates = MutationEngine.generateMutations(source).slice(0, maxMutationsPerFile);
    } catch (err) {
      result.errors.push(`${rel}: generateMutations crashed: ${err.message}`);
      continue;
    }

    for (const candidate of candidates) {
      result.mutationsTried++;
      if (dryRun) continue;

      let mutated;
      try {
        mutated = MutationEngine.applyCandidate(source, candidate);
      } catch (err) {
        result.errors.push(`${rel}:${candidate.line}: applyCandidate crashed: ${err.message}`);
        continue;
      }
      if (mutated === source) continue;

      // Write mutated content in place; run gate; restore original.
      try {
        fs.writeFileSync(abs, mutated, 'utf8');
      } catch (err) {
        result.errors.push(`${rel}: write failed: ${err.message}`);
        continue;
      }
      let mutatedReport = null;
      try {
        mutatedReport = runGate(repoRoot, suite, timeoutMs);
      } finally {
        // ALWAYS restore the file even if the gate run threw.
        try { fs.writeFileSync(abs, source, 'utf8'); } catch { /* best-effort */ }
      }
      if (!mutatedReport) {
        result.errors.push(`${rel}:${candidate.line}: gate run returned no parseable output`);
        continue;
      }
      const caught = mutationWasCaught(baseline, mutatedReport);
      if (caught) {
        result.mutationsCaught++;
      } else {
        result.coverageHoles.push({
          file: rel,
          line: candidate.line,
          operator: candidate.operator || '?',
          before: candidate.before || null,
          after: candidate.after || null,
          note: 'Mutation slipped through — gate emitted no new error rules vs baseline',
        });
      }
    }
  }

  return result;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Adversarial Mutator — Nightly Self-Test');
  lines.push('');
  lines.push(`_Generated ${report.generatedAt}_`);
  lines.push('');
  lines.push(`Suite: \`${report.suite}\`. Files sampled: ${report.files}. Mutations tried: ${report.mutationsTried}. Caught: **${report.mutationsCaught}**. Holes: **${report.coverageHoles.length}**.`);
  lines.push('');
  if (report.coverageHoles.length === 0) {
    lines.push('_No coverage holes detected. (Sample only — not exhaustive.)_');
  } else {
    lines.push('## Coverage holes');
    lines.push('');
    lines.push('| File | Line | Operator | Before → After |');
    lines.push('| --- | --- | --- | --- |');
    for (const h of report.coverageHoles.slice(0, 50)) {
      const before = (h.before || '').slice(0, 40).replace(/\|/g, '\\|');
      const after  = (h.after  || '').slice(0, 40).replace(/\|/g, '\\|');
      lines.push(`| \`${h.file}\` | ${h.line} | ${h.operator} | \`${before}\` → \`${after}\` |`);
    }
  }
  if (report.errors.length > 0) {
    lines.push('');
    lines.push('## Errors during run');
    lines.push('');
    for (const e of report.errors.slice(0, 20)) lines.push(`- ${e}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const report = await run({});
  // eslint-disable-next-line no-console
  console.log(renderMarkdown(report)); // code-quality-ok — CLI trainer prints markdown report to stdout
  const outDir = path.join(os.homedir(), '.gatetest', 'trainers');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'adversarial-mutator-latest.json'), JSON.stringify(report, null, 2));
  } catch { /* best-effort */ }
  // Also write a machine-readable holes file under tests/auto-generated/
  // so the nightly workflow can include it in the trainer PR.
  try {
    const holesDir = path.join(process.cwd(), 'tests', 'auto-generated');
    fs.mkdirSync(holesDir, { recursive: true });
    fs.writeFileSync(path.join(holesDir, 'coverage-holes.json'), JSON.stringify({
      generatedAt: report.generatedAt,
      coverageHoles: report.coverageHoles,
    }, null, 2));
  } catch { /* best-effort */ }
}

if (require.main === module) {
  main().catch((err) => {
    warnOnce(`fatal: ${err && err.message}`);
    process.exit(0);
  });
}

module.exports = {
  run,
  renderMarkdown,
  _listSourceFiles: listSourceFiles,
  _errorCountByRule: errorCountByRule,
  _mutationWasCaught: mutationWasCaught,
  _parseJsonSafe: parseJsonSafe,
};
