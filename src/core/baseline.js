'use strict';
/**
 * Repo-wide baseline — "only fail on NEW issues" (Known Issue #66).
 *
 * The classic SAST adoption killer: a team turns the scanner on against a
 * mature repo and eats years of backlog on day one. Diff-scoped scans
 * (--diff/--pr) cover changed files, but nothing let a team run the FULL
 * suite repo-wide and still only block on regressions.
 *
 * `gatetest --baseline` snapshots every current unsuppressed finding into a
 * committable file (.gatetest/baseline.json). Subsequent runs mark any
 * finding whose fingerprint is in the snapshot as suppressed
 * (suppressReason: 'baseline') — same pathway as .gatetestignore, so
 * baselined findings are excluded from the gate decision and every count,
 * but stay visible and auditable. Fixing a baselined finding is free;
 * REINTRODUCING one after it disappears re-blocks only when the baseline
 * is refreshed (documented behaviour — refresh on green).
 *
 * Fingerprints are deliberately human-readable plaintext (module::check::file
 * with volatile line/column segments stripped) — the file is meant to be
 * committed and reviewed in a PR, and "what exactly did we grandfather?"
 * should be answerable by reading it.
 */

const fs = require('fs');
const path = require('path');
const { repoRelative, toPosix } = require('./repo-path');

const BASELINE_DIR = '.gatetest';
const BASELINE_FILENAME = 'baseline.json';

function baselinePath(projectRoot) {
  return path.join(projectRoot || process.cwd(), BASELINE_DIR, BASELINE_FILENAME);
}

/**
 * Stable identity for a finding across runs and unrelated edits.
 *
 * Check names often embed positions (`hardcoded-url:localhost:src/x.ts:12`)
 * that shift on every edit above the finding — pure-number segments and
 * trailing :line:col pairs are stripped so the fingerprint survives them.
 * File paths are normalized to forward-slash, repo-relative, lowercase.
 */
function fingerprint(moduleName, checkName, filePath, projectRoot) {
  const normName = String(checkName || '')
    .toLowerCase()
    .split(':')
    .map((seg) => seg.trim())
    .filter((seg) => !/^\d+$/.test(seg))
    .join(':');

  let file = String(filePath || '');
  if (file && projectRoot) {
    const rel = repoRelative(projectRoot, file);
    if (rel && !rel.startsWith('..')) file = rel;
  }
  const normFile = toPosix(file).toLowerCase();

  return `${String(moduleName || '').toLowerCase()}::${normName}::${normFile}`;
}

/**
 * How many individual findings a check represents. Modules that aggregate
 * per file (secrets, broken links, ...) put the instance list in
 * `details`; a check without one counts as a single finding. Count-aware
 * baselines exist because per-file aggregation would otherwise mask a NEW
 * secret added to a file that already had one baselined.
 */
function instanceCount(check) {
  return Array.isArray(check && check.details) && check.details.length > 0
    ? check.details.length
    : 1;
}

/**
 * Capture a baseline from runner results.
 * @param {Array<{module: string, checks: Array}>} results — TestResult-shaped
 * @param {string} projectRoot
 * @returns {{ path: string, count: number }}
 */
function capture(results, projectRoot) {
  const fingerprints = {};
  let count = 0;
  for (const r of results || []) {
    for (const c of r.checks || []) {
      if (c.passed) continue;
      if (c.suppressed) continue; // already silenced via .gatetestignore
      const sev = c.severity || 'error';
      if (sev !== 'error' && sev !== 'warning') continue;
      const fp = fingerprint(r.module, c.name, c.file || c.filePath, projectRoot);
      if (!fingerprints[fp]) {
        fingerprints[fp] = { severity: sev, count: instanceCount(c) };
        count += 1;
      } else {
        fingerprints[fp].count += instanceCount(c);
      }
    }
  }

  const payload = {
    version: 1,
    tool: 'gatetest',
    capturedAt: new Date().toISOString(),
    note:
      'Pre-existing findings grandfathered by `gatetest --baseline`. Later runs ' +
      'only fail on NEW findings. Commit this file. Refresh with `gatetest --baseline` ' +
      'after paying down debt; delete it to see everything again.',
    count,
    fingerprints,
  };

  const outPath = baselinePath(projectRoot);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
  return { path: outPath, count };
}

/**
 * Load the baseline into a matcher. Absent/corrupt file → inert matcher.
 *
 * `has` is count-aware, and it is aware across the WHOLE RUN — not per call.
 * That distinction is the entire feature.
 *
 * A fingerprint is `module::rule::file` with numeric segments stripped, so line
 * numbers do not un-grandfather a finding when code moves. The consequence is
 * that every finding of the same rule in the same file shares ONE fingerprint.
 *
 * So there are two shapes a module can report in, and a correct baseline has to
 * handle both:
 *
 *   - aggregating modules (secrets, broken links) emit ONE check carrying N
 *     instances in `details`, so `currentCount` is N.
 *   - most modules (errorSwallow, ...) emit ONE CHECK PER FINDING, so
 *     `currentCount` is 1 every time and N checks share the fingerprint.
 *
 * The first version compared `currentCount <= allowed` per call, which only ever
 * caught the first shape. In the second, two empty catches in a baselined file
 * each asked `1 <= 1` independently and both were grandfathered — so a baselined
 * file became a permanent dumping ground for new findings of an already-baselined
 * rule, which is the exact failure "clean as you code" exists to prevent, in the
 * files most likely to be edited. Measured before the fix: adding a second empty
 * catch to a baselined file kept the gate green and the run reported "7
 * pre-existing finding(s) baselined" against a baseline recording 6.
 *
 * Now the matcher tallies what each fingerprint has already claimed and stops
 * grandfathering once the baselined allowance is spent. With 1 baselined and 2
 * present, exactly one blocks.
 *
 * WHICH one blocks is arbitrary — it is whichever the runner happens to offer
 * second. That is acceptable and worth stating plainly: the count is what
 * carries meaning ("you added one"), not the identity, and the developer's next
 * step is the same either way — fix it or re-run `--baseline` deliberately.
 *
 * STATEFUL: one matcher instance expects at most one `has()` call per finding
 * per run. `load()` again for a fresh tally.
 *
 * @returns {{ has: (module, checkName, filePath, currentCount?) => boolean,
 *             isEmpty: boolean, count: number, capturedAt: string|null }}
 */
function load(projectRoot) {
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(baselinePath(projectRoot), 'utf-8'));
  } catch {
    return { has: () => false, isEmpty: true, count: 0, capturedAt: null };
  }
  const fingerprints = (data && typeof data.fingerprints === 'object' && data.fingerprints) || {};
  const keys = Object.keys(fingerprints);

  // fingerprint -> instances already grandfathered in this run.
  const claimed = new Map();

  return {
    has: (moduleName, checkName, filePath, currentCount = 1) => {
      const key = fingerprint(moduleName, checkName, filePath, projectRoot);
      const entry = fingerprints[key];
      if (!entry) return false;

      const allowed = typeof entry.count === 'number' && entry.count > 0 ? entry.count : 1;
      const already = claimed.get(key) || 0;
      const wanted = Number.isFinite(currentCount) && currentCount > 0 ? currentCount : 1;

      // Does not fit in what remains of the allowance → this one is NEW.
      // Deliberately does not consume on refusal: a later, smaller check for the
      // same fingerprint can still legitimately fit.
      if (already + wanted > allowed) return false;

      claimed.set(key, already + wanted);
      return true;
    },
    isEmpty: keys.length === 0,
    count: keys.length,
    capturedAt: (data && data.capturedAt) || null,
  };
}

module.exports = { fingerprint, instanceCount, capture, load, baselinePath, BASELINE_FILENAME };
