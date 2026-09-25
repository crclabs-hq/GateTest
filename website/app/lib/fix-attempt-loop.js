/**
 * Iterative fix-attempt loop with structured per-attempt logging.
 *
 * Phase 1 of the FIX-FIRST BUILD PLAN (see CLAUDE.md). This is the
 * foundation no competitor ships today: instead of "ask AI once, hope it
 * works," we run up to N attempts, capture every attempt's outcome, and
 * feed Claude its own previous failure so the next attempt is informed.
 *
 * Pure JS so it's directly testable under `node --test` without any
 * Next.js or TypeScript transform. The `route.ts` caller wraps the
 * Anthropic-specific bits (model, prompt, network) and hands them in as
 * injected dependencies — keeps the loop logic free of HTTP concerns.
 *
 * Outcome taxonomy (per attempt):
 *   - success         : Claude returned content that passed validation +
 *                       quality checks
 *   - validation-fail : Claude returned garbage (empty, refusal,
 *                       truncation, no-changes). Loop stops — re-asking
 *                       won't change a refusal.
 *   - quality-fail    : Claude returned plausible content but it
 *                       introduced new issues (console.log, eval, var,
 *                       etc.). Loop retries with explicit feedback about
 *                       what was introduced.
 *   - claude-error    : Network / API error talking to Claude. Loop
 *                       retries with the same input — no enrichment
 *                       needed, the content was never produced.
 *
 * Convergence guard (complaint C23 — see src/core/convergence-guard.js):
 * every quality-fail's newIssues feed a shared convergence guard as this
 * iteration's finding ids. If the SAME issue the loop just tried to fix
 * (tagged `own-fix`) comes back next attempt, the guard stops the loop
 * immediately instead of burning the rest of maxAttempts on a fix that
 * plainly did not hold. The result always carries `loop: {reason,
 * iterations, message, unresolved}` — one of the six canonical reasons,
 * with a human-readable line saying why the loop stopped.
 */
const { createConvergenceGuard, REASONS: CONVERGENCE_REASONS } = require('../../../src/core/convergence-guard');

/**
 * Run up to `maxAttempts` Claude attempts on a single file.
 *
 * @param {Object} opts
 * @param {(issues: string[]) => Promise<string>} opts.askClaude
 *        Caller-provided. Takes the (possibly enriched) issue list,
 *        returns the fixed file content. Throws on Claude API errors.
 * @param {(original: string, fixed: string) => { ok: boolean, reason?: string }} opts.validateFix
 *        Shape check: empty, no-changes, refusal markers, truncation.
 * @param {(fixed: string, filePath: string) => { clean: boolean, newIssues: string[] }} opts.verifyFixQuality
 *        Pattern scan: did the fix introduce console.log, eval, var, etc.
 * @param {string} opts.originalContent  Original file content.
 * @param {string} opts.filePath          Repo-relative file path.
 * @param {string[]} opts.issues          Initial issues to fix.
 * @param {number} [opts.maxAttempts=3]   Hard ceiling on attempts.
 * @param {() => number} [opts.now=Date.now]  Injectable clock for tests.
 * @returns {Promise<{
 *   success: boolean,
 *   fixed: string | null,
 *   attempts: Array<{
 *     attemptNumber: number,
 *     startedAt: number,
 *     durationMs: number,
 *     outcome: 'success' | 'validation-fail' | 'quality-fail' | 'claude-error',
 *     validationReason: string | null,
 *     qualityIssues: string[],
 *     claudeError: string | null,
 *   }>,
 *   finalReason: string | null,
 * }>}
 */
async function attemptFixWithRetries(opts) {
  const {
    askClaude,
    validateFix,
    verifyFixQuality,
    originalContent,
    filePath,
    issues,
    maxAttempts = 3,
    now = Date.now,
  } = opts;

  if (typeof askClaude !== 'function') throw new TypeError('askClaude must be a function');
  if (typeof validateFix !== 'function') throw new TypeError('validateFix must be a function');
  if (typeof verifyFixQuality !== 'function') throw new TypeError('verifyFixQuality must be a function');
  if (typeof originalContent !== 'string') throw new TypeError('originalContent must be a string');
  if (typeof filePath !== 'string') throw new TypeError('filePath must be a string');
  if (!Array.isArray(issues) || issues.length === 0) throw new TypeError('issues must be a non-empty array');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('maxAttempts must be a positive integer');

  const attempts = [];
  let currentIssues = issues.slice();
  let finalReason = null;
  // Real wall-clock, deliberately NOT the injectable `now` used for
  // per-attempt timing above — this loop has no time/token budget of its
  // own yet (`budgetMs` stays unset), so the guard never calls its clock,
  // and using a separate clock keeps the deterministic attempt-timing
  // tests below unaffected by the guard's construction.
  const guard = createConvergenceGuard({ maxIterations: maxAttempts });

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    const startedAt = now();
    const log = {
      attemptNumber,
      startedAt,
      durationMs: 0,
      outcome: 'claude-error',
      validationReason: null,
      qualityIssues: [],
      claudeError: null,
    };

    let fixedContent;
    try {
      fixedContent = await askClaude(currentIssues);
    } catch (err) {
      log.outcome = 'claude-error';
      log.claudeError = err && err.message ? err.message : String(err);
      log.durationMs = now() - startedAt;
      attempts.push(log);
      finalReason = `attempt ${attemptNumber}: ${log.claudeError}`;
      // Loop continues — network errors are transient. The orchestrator
      // is responsible for backing off / dropping concurrency between
      // calls; this loop just records and keeps trying within the budget.
      continue;
    }

    const validation = validateFix(originalContent, fixedContent);
    if (!validation.ok) {
      log.outcome = 'validation-fail';
      log.validationReason = validation.reason || 'unknown';
      log.durationMs = now() - startedAt;
      attempts.push(log);
      finalReason = `attempt ${attemptNumber}: validation failed (${log.validationReason})`;
      // Stop: a refusal / empty / truncated response is unlikely to fix
      // itself by re-asking with the same prompt. The orchestrator should
      // mark this file as needing human review rather than burn the
      // remaining attempts. An invalid response is a rejected fix — feed
      // the guard so the loop result carries a canonical reason too.
      guard.step({ findingIds: currentIssues, fixRejected: true });
      break;
    }

    const quality = verifyFixQuality(fixedContent, filePath);
    if (!quality.clean) {
      log.outcome = 'quality-fail';
      log.qualityIssues = quality.newIssues || [];
      log.durationMs = now() - startedAt;
      attempts.push(log);

      // The quality issues THIS attempt introduced are the finding set the
      // convergence guard tracks; `fixed` tags them so a re-flag next
      // attempt (the loop's own fix reappearing) is caught as own-fix
      // no-progress instead of burning the rest of maxAttempts on a fix
      // that plainly did not hold (complaint C23).
      const findingIds = (quality.newIssues || []).map(String);
      const guardStep = guard.step({
        findingIds,
        fixed: findingIds.map((id) => ({ id, change: `attempt ${attemptNumber} introduced: ${id}` })),
      });

      if (guardStep.done) {
        finalReason = `attempt ${attemptNumber}: ${guardStep.message}`;
        break;
      }

      finalReason = `attempt ${attemptNumber}: introduced ${quality.newIssues.length} new issue(s)`;
      // Enrich for next attempt — Claude sees its own failure and is told
      // explicitly to fix THAT in addition to the original issues. This
      // is the "loop learns" part that single-pass tools don't have.
      currentIssues = [
        ...issues,
        ...quality.newIssues.map((i) => `YOUR PREVIOUS ATTEMPT INTRODUCED: ${i} — do not introduce this again, fix it AND the original issues`),
      ];
      continue;
    }

    log.outcome = 'success';
    log.durationMs = now() - startedAt;
    attempts.push(log);
    guard.step({ findingIds: [] }); // clean fix — nothing left in scope: converged
    return {
      success: true,
      fixed: fixedContent,
      attempts,
      finalReason: null,
      loop: guard.getResult(),
    };
  }

  const guardResult = guard.getResult();
  return {
    success: false,
    fixed: null,
    attempts,
    finalReason: finalReason || `exhausted ${maxAttempts} attempts`,
    // The guard may never have been engaged (every attempt was a
    // claude-error) — fall back to max-iterations, since that is exactly
    // what happened: the retry cap was hit without resolving either way.
    loop: guardResult.reason
      ? guardResult
      : {
        reason: CONVERGENCE_REASONS.MAX_ITERATIONS,
        iterations: attempts.length,
        message: finalReason || `exhausted ${maxAttempts} attempts`,
        unresolved: [],
      },
  };
}

/**
 * Summarise an attempt history into a single line — useful for the PR
 * body and for log lines so a human reviewer can see at a glance how
 * many attempts each fix took.
 */
function summariseAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return 'no attempts';
  const last = attempts[attempts.length - 1];
  const counts = attempts.reduce((acc, a) => {
    acc[a.outcome] = (acc[a.outcome] || 0) + 1;
    return acc;
  }, {});
  const totalMs = attempts.reduce((sum, a) => sum + a.durationMs, 0);
  const breakdown = Object.entries(counts)
    .map(([outcome, n]) => `${n}× ${outcome}`)
    .join(', ');
  return `${attempts.length} attempt(s), ${totalMs}ms total, final: ${last.outcome} — ${breakdown}`;
}

module.exports = { attemptFixWithRetries, summariseAttempts };
