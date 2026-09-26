'use strict';

/**
 * Root cause on every red run — Launch Board move 12.
 *
 * The Fifty, move 12 / complaint C21 (Playwright/Cypress threads: "debugging
 * takes longer than writing tests"). A BLOCKED verdict that doesn't say WHY,
 * WHICH COMMIT, and HOW TO REPLAY costs more than the test was worth.
 *
 * ONE classifier (Doctrine #4 — one definition, imported): `classifyRootCause`
 * is the only place that decides `why`. It reuses existing one-true-definitions
 * rather than re-deriving them:
 *   - blocking findings:      src/core/finding-triage.js (triageFindings)
 *   - blame / regression:     src/core/regression-bisector.js (git blame)
 *   - the CI replay command:  src/core/ci-run-url.js (replayCommand)
 *
 * Rule order (first match wins), per the brief:
 *   config/usage error → budget-limited → failing tests →
 *   new findings in changed files → new findings elsewhere → unknown
 *
 * `since` is only ever reported when git blame resolves an exact line —
 * never guessed. Blame calls are bounded: at most 10 findings blamed, one
 * `git blame -L n,n --porcelain` each, 5s wall-clock total (enforced inside
 * regression-bisector's `findLikelyRegressionCommit`).
 */

const { isGitRepo, findLikelyRegressionCommit } = require('./regression-bisector');
const { replayCommand: ciReplayCommand } = require('./ci-run-url');

const TIMEOUT_ERROR_RE = /timed out after \d+\s*ms/i;
const MAX_BLAME_FINDINGS = 10;
const BLAME_DEADLINE_MS = 5000;

function truncate(value, max) {
  const str = String(value || '');
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function normalisePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function toHits(findings) {
  return findings
    .map((f) => ({ file: f.check.file, line: f.check.line }))
    .filter((h) => h.file && typeof h.line === 'number' && h.line > 0);
}

/**
 * Build the `why` line for a group of blocking findings — worst finding's
 * module, how many findings share it, and whether they're diff-scoped.
 */
function describeFindings(findings, inDiff) {
  const mod = findings[0].module;
  const sameModule = findings.filter((f) => f.module === mod);
  const n = sameModule.length;
  const plural = n === 1 ? '' : 's';
  const scope = inDiff ? ' in files changed by this diff' : '';
  return {
    class: inDiff ? 'new-findings-changed' : 'new-findings',
    why: `${n} new ${mod} finding${plural}${scope}`,
    hits: toHits(findings),
  };
}

/**
 * The ONE classifier. Pure function of the data a run already produces —
 * no git, no network, no timers. Everything else in this file is plumbing
 * around this decision.
 *
 * @param {object} args
 * @param {Array} args.results               summary.results (per-module checks)
 * @param {Array} args.failedModules          summary.failedModules
 * @param {boolean} args.diffOnly             summary.diffOnly
 * @param {Array<string>|null} args.changedFiles  summary.changedFiles
 * @param {number} [args.confidenceThreshold] summary.confidenceThreshold
 * @returns {{class: string, why: string, hits: Array<{file:string,line:number}>}}
 */
function classifyRootCause({ results, failedModules, diffOnly, changedFiles, confidenceThreshold }) {
  const failed = Array.isArray(failedModules) ? failedModules : [];

  // A module lands in `failedModules` for two very different reasons
  // (src/core/runner.js `_runModule`):
  //   - it threw/crashed BEFORE producing any checks (`catch (err) { result.fail(err) }`)
  //     — a genuine config/usage error, unrelated to the customer's code.
  //   - it ran fine and simply found confident errors (`result.fail(message)`
  //     when `blockingErrorChecks.length > 0`) — that's a normal finding,
  //     already visible via `results`/checks below, NOT a config error.
  // `failedChecks` (present on every summary.failedModules entry) is the
  // one signal that tells them apart: a crash records zero checks.
  const crashed = failed.filter((f) => !Array.isArray(f.failedChecks) || f.failedChecks.length === 0);

  // Rule 1: config/usage error — a module could not run at all. A crashed
  // module (bad .gatetest.json, missing dependency, malformed invocation)
  // is a usage/config failure, not a finding about the customer's code.
  const configFailures = crashed.filter((f) => !TIMEOUT_ERROR_RE.test(f.error || ''));
  if (configFailures.length > 0) {
    const f = configFailures[0];
    return { class: 'config-error', why: `config error: ${f.module} — ${truncate(f.error, 120)}`, hits: [] };
  }

  // Rule 2: budget-limited — a module hit its wall-clock timeout
  // (src/core/runner.js `_runModuleWithTimeout`), not a real finding.
  const timeoutFailures = crashed.filter((f) => TIMEOUT_ERROR_RE.test(f.error || ''));
  if (timeoutFailures.length > 0) {
    const f = timeoutFailures[0];
    return { class: 'budget-limited', why: `budget-limited: ${f.module} — ${truncate(f.error, 120)}`, hits: [] };
  }

  // Everything past this point reasons about actual findings — the same
  // ranked, deduped, threshold-aware view the console shortlist uses.
  const { triageFindings } = require('./finding-triage');
  const { blocking } = triageFindings(results, { blockThreshold: confidenceThreshold });

  // Rule 3: failing unit tests — the unitTests module's own findings, one
  // per failing test.
  const testFindings = blocking.filter((f) => f.module === 'unitTests');
  if (testFindings.length > 0) {
    const first = testFindings[0];
    const name = (first.check && first.check.name) || 'unknown test';
    return {
      class: 'failing-tests',
      why: `unit tests: ${testFindings.length} failing, ${name}`,
      hits: toHits(testFindings),
    };
  }

  if (blocking.length > 0) {
    // Rule 4: new findings in changed files — only meaningful in diff mode.
    if (diffOnly && Array.isArray(changedFiles) && changedFiles.length > 0) {
      const changedSet = new Set(changedFiles.map(normalisePath));
      const inDiff = blocking.filter((f) => f.check.file && changedSet.has(normalisePath(f.check.file)));
      if (inDiff.length > 0) return describeFindings(inDiff, true);
    }
    // Rule 5: new findings elsewhere.
    return describeFindings(blocking, false);
  }

  // Rule 6: unknown — the gate is blocked but nothing above explains it
  // (e.g. an empty scan blocked by --strict). Never fabricate a cause.
  return { class: 'unknown', why: 'unknown — gate blocked with no classified cause', hits: [] };
}

/**
 * Resolve `since` from a classification's hits, bounded and honest:
 *   - not a git repo            -> "not a git checkout"
 *   - no findings carry a line  -> "unknown (no line)"
 *   - otherwise                 -> the commit most hits blame to
 *
 * Bounded to at most MAX_BLAME_FINDINGS `git blame` calls and
 * BLAME_DEADLINE_MS wall-clock total (enforced by findLikelyRegressionCommit).
 */
function resolveSince({ hits, projectRoot }) {
  if (!projectRoot || !isGitRepo(projectRoot)) {
    return { text: 'not a git checkout', commit: null };
  }
  if (!Array.isArray(hits) || hits.length === 0) {
    return { text: 'unknown (no line)', commit: null };
  }

  const bounded = hits.slice(0, MAX_BLAME_FINDINGS);
  const skippedByCap = hits.length - bounded.length;
  const result = findLikelyRegressionCommit({ cwd: projectRoot, hits: bounded, deadlineMs: BLAME_DEADLINE_MS });
  const skipped = skippedByCap + (result && result.skipped ? result.skipped : 0);
  const suffix = skipped > 0 ? ` — skipped (${skipped} findings)` : '';

  if (!result.ok || result.candidates.length === 0) {
    return { text: `unknown (no line)${suffix}`, commit: null };
  }

  const top = result.candidates[0];
  return {
    text: `${top.shortHash} ${top.summary || '(no subject)'}${suffix}`,
    commit: { sha: top.hash, subject: top.summary || null, author: top.author || null, date: top.date || null },
  };
}

/** The exact local command to reproduce the same run: `gatetest --suite <s> --module <m> --project <p>`. */
function localReplayCommand({ suite, moduleName, projectRoot }) {
  const parts = ['gatetest'];
  if (moduleName) parts.push('--module', moduleName);
  else parts.push('--suite', suite || 'standard');
  parts.push('--project', projectRoot || '.');
  return parts.join(' ');
}

/** CI form (`gatetest replay <run-url>`) when a run URL is resolvable, local form otherwise. */
function resolveReplay({ suite, moduleName, projectRoot, env }) {
  const ci = ciReplayCommand(env);
  return ci || localReplayCommand({ suite, moduleName, projectRoot });
}

/**
 * Build the full three-field root-cause block for a BLOCKED run. Returns
 * null for anything that isn't the caller's job to classify (the caller
 * decides whether the run was BLOCKED at all — this function assumes it was).
 */
function buildRootCause({ results, failedModules, diffOnly, changedFiles, confidenceThreshold, projectRoot, suite, moduleName, env }) {
  const classification = classifyRootCause({ results, failedModules, diffOnly, changedFiles, confidenceThreshold });
  const since = resolveSince({ hits: classification.hits, projectRoot });
  const replay = resolveReplay({ suite, moduleName, projectRoot, env });

  return {
    why: classification.why,
    since: since.commit
      ? { sha: since.commit.sha, subject: since.commit.subject, author: since.commit.author, date: since.commit.date }
      : { sha: null, subject: since.text, author: null, date: null },
    sinceText: since.text,
    replay,
  };
}

module.exports = {
  classifyRootCause,
  resolveSince,
  resolveReplay,
  localReplayCommand,
  buildRootCause,
};
