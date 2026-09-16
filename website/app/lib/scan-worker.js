/**
 * Pure helpers for the Signal Bus E1 worker tick at
 * `website/app/api/scan/worker/tick/route.ts`.
 *
 * The tick's authorisation check, reclaim-stuck call, claim-next loop,
 * scan execution, and callback fire live here so they can be unit-
 * tested from `tests/scan-worker-tick.test.js` with `node --test`.
 * Nothing in here performs I/O directly — every boundary (sql,
 * scan executor, gluecron callback) is injected.
 *
 * v1 design (per E1):
 *   - Tick runs ONE job per invocation so a 60s Vercel function budget
 *     is never over-committed. The 1-minute cron drains the queue at
 *     ~60 jobs/hour steady state; inline kicks absorb bursts.
 *   - Every call reclaims stuck rows first, so a previous tick that
 *     was killed mid-scan (Vercel cold-stop) can't permanently orphan
 *     a job.
 *   - On success: markDone + callback to Gluecron.
 *   - On failure: markFailed(willRetry = attempts < MAX_ATTEMPTS). If
 *     dead, send an error callback so Gluecron doesn't wait forever.
 *   - Never throws to the caller — callers get { ok, ran?, idle?, error? }.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MAX_ATTEMPTS, isTerminalScanError } = require('./scan-queue-store');
const { timingSafeEqual } = require('crypto');

/**
 * Bounded retry for the result callback (advancement #11: "callback
 * retry"). The callback is the customer-visible half of the pipeline —
 * a commit status or Gluecron notification lost to one network blip
 * means a scan that ran perfectly looks like it never happened. Three
 * tries, linear backoff, then the caller's catch logs and moves on.
 */
async function callWithRetry(fn, { attempts = 3, delayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Continuous-tier ($49/mo) diff-size circuit breaker.
// When a push touches more than this many files, AI-fix is skipped and the
// customer is prompted to upgrade to Scan + Fix ($199) for whole-repo context.
// Enforcement point: the AI-on-push path (Known Issue #34) — when that ships
// the worker checks job.diff_files against this constant before calling Claude.
// Deterministic scans are never gated — the limit applies to AI invocations only.
const MAX_DIFF_FILES = 20;

/**
 * Validate that the request came from the Vercel cron OR from an admin.
 * Returns true if either is satisfied. `CRON_SECRET` is set in Vercel
 * dashboard; the inline kick in /api/events/push forwards the same
 * header value so kicks pass this check too.
 *
 * Fails closed when CRON_SECRET is unset — matches every other secret
 * check in this codebase (admin-auth.ts, github-events.js, stripe-webhook,
 * events-push.js, self-scan-status.js all fail closed on a missing
 * secret). Previously failed OPEN in that case ("local dev, first
 * deploy" grace period) — found during a security audit to have been
 * left on indefinitely in production, meaning this endpoint currently
 * accepts unauthenticated ticks. Deploying this fix REQUIRES CRON_SECRET
 * to already be set in the production environment, or the cron/kick path
 * stops firing entirely — see docs/ROADMAP.md.
 *
 * @param {{ cronHeader: string|null, isAdmin: boolean, env: Record<string, string|undefined> }} args
 */
function isAuthorisedTick({ cronHeader, isAdmin, env }) {
  if (isAdmin) return true;
  const expected = env.CRON_SECRET || '';
  if (!expected) return false;
  if (!cronHeader || typeof cronHeader !== 'string') return false;
  return safeEqual(cronHeader, expected);
}

/**
 * Orchestrate one worker tick. Reclaims stuck rows, claims one job,
 * runs the scan, writes result + callback.
 *
 * @param {object} args
 * @param {Function} args.sql                             Neon tagged template
 * @param {Object}   args.queueStore                      scan-queue-store module (or test double)
 * @param {Function} args.runScan                         (repoUrl, tier, { ref }) → Promise<ScanResult>
 * @param {Function} args.sendCallback                    ({ repository, sha, ref, scanResult }) → Promise<any>
 * @param {Object}   [args.continuousStore]                continuous-subscription-store module (or test double).
 *                                                          When provided, a job whose repo has an active Continuous
 *                                                          ($49/mo) subscription with AI budget remaining runs the
 *                                                          'full' (AI-inclusive) tier instead of 'deterministic', and any
 *                                                          AI spend incurred is recorded against that month's ledger.
 *                                                          Omitted entirely → identical to pre-KI-34 behaviour.
 * @param {Object}   [args.usageStore]                     usage-ledger module (or test double). When provided, every
 *                                                          completed scan is appended to the customer's usage ledger
 *                                                          (surface 'push'; ai_calls 0 for deterministic scans).
 *                                                          Best-effort — a ledger failure is one warning, never a
 *                                                          failed tick. Omitted → no ledger write.
 * @param {string}   [args.tier]                          defaults to 'deterministic' — the FULL engine with the
 *                                                          Anthropic-calling modules skipped. Until 2026-08-18 this
 *                                                          defaulted to 'quick' (4 in-memory modules on ≤50 files),
 *                                                          which made "121 modules on every push" false in production.
 */
async function runWorkerTick({
  sql,
  queueStore,
  runScan,
  sendCallback,
  continuousStore,
  usageStore,
  tier = 'deterministic',
}) {
  if (!sql || typeof sql !== 'function') {
    return { ok: false, error: 'sql tagged-template is required' };
  }
  if (!queueStore || !runScan) {
    return { ok: false, error: 'queueStore and runScan are required' };
  }

  // Reclaim first so an orphaned row can be re-picked immediately.
  let reclaimed = 0;
  try {
    reclaimed = await queueStore.reclaimStuck(sql);
  } catch (err) {
    console.error(
      '[scan-worker] reclaimStuck failed:',
      err && err.message ? err.message : err
    );
  }

  let job;
  try {
    job = await queueStore.claimNextJob(sql);
  } catch (err) {
    return {
      ok: false,
      reclaimed,
      error: err && err.message ? err.message : 'claimNextJob failed',
    };
  }

  if (!job) {
    return { ok: true, idle: true, reclaimed };
  }

  const repository = job.repository;
  // The URL carries the HOST. scan-executor only needs owner/repo from it,
  // but findActiveByRepo keys Continuous subscriptions on host/owner — so a
  // Gluecron job labelled github.com looked up the wrong host's subscription
  // and ran a paying org's pushes at the deterministic tier with their AI
  // allowance untouched. Until 2026-09-02 every job was labelled github.com.
  const hostDomain = job.host === 'github' ? 'github.com' : 'gluecron.com';
  const repoUrl = repository && repository.includes('/')
    ? `https://${hostDomain}/${repository}`
    : repository;

  // Continuous ($49/mo) budget gate (Known Issue #34). Deterministic scans
  // are always unlimited — only the AI-inclusive 'full' tier is gated, and
  // only for repos with an active subscription and remaining budget. Any
  // lookup/check failure fails CLOSED to the deterministic tier — an error
  // here must never grant unmetered AI spend.
  let scanTier = tier;
  let continuousSubscription = null;
  if (continuousStore) {
    try {
      continuousSubscription = await continuousStore.findActiveByRepo(sql, repoUrl);
    } catch (err) {
      console.error(
        '[scan-worker] continuous subscription lookup failed:',
        err && err.message ? err.message : err
      );
    }
    if (continuousSubscription) {
      try {
        const allowance = await continuousStore.checkAiAllowance(
          sql,
          continuousSubscription.stripe_subscription_id
        );
        scanTier = allowance.allowed ? 'full' : tier;
      } catch (err) {
        console.error(
          '[scan-worker] checkAiAllowance failed:',
          err && err.message ? err.message : err
        );
        scanTier = tier;
      }
    }
  }

  // Run the scan. runScan() is expected NEVER to throw; if it does we
  // treat it as a failed attempt.
  let scanResult;
  try {
    // Pass the pushed SHA so the scan describes the commit the status is
    // posted on, not whatever HEAD has moved to since the push.
    scanResult = await runScan(repoUrl, scanTier, { ref: job.sha || undefined, baseRef: job.base_sha || undefined });
  } catch (err) {
    scanResult = {
      status: 'failed',
      modules: [],
      totalModules: 0,
      completedModules: 0,
      totalIssues: 0,
      totalFixed: 0,
      duration: 0,
      error: `scan crashed: ${err && err.message ? err.message : err}`,
    };
  }

  const scanFailed =
    !scanResult || scanResult.status !== 'complete' || Boolean(scanResult.error);

  // Record any AI spend regardless of overall scan outcome — if the aiReview
  // module ran and cost money, that spend already happened at Anthropic and
  // must be metered even if some other module in the same run failed.
  if (continuousSubscription && continuousStore && scanResult && Array.isArray(scanResult.modules)) {
    const aiCostUsd = scanResult.modules.reduce((sum, m) => sum + (Number(m.costUsd) || 0), 0);
    if (aiCostUsd > 0) {
      try {
        await continuousStore.recordAiSpend(
          sql,
          continuousSubscription.stripe_subscription_id,
          aiCostUsd
        );
      } catch (err) {
        console.error(
          '[scan-worker] recordAiSpend failed:',
          err && err.message ? err.message : err
        );
      }
    }
  }

  if (!scanFailed) {
    try {
      await queueStore.markDone(job.id, scanResult, sql);
    } catch (err) {
      console.error(
        '[scan-worker] markDone failed:',
        err && err.message ? err.message : err
      );
    }

    // Usage ledger — what the customer just did, in their own meter.
    // Identity: the Continuous subscriber's e-mail (the key every surface
    // shares), else their Stripe customer, else the repo's org. Best-effort:
    // the ledger is observability, never the scan's critical path.
    if (usageStore && typeof usageStore.recordUsage === 'function') {
      try {
        const ai = usageStore.aiTotalsFromModules(scanResult.modules);
        const org = repository && repository.includes('/')
          ? `${hostDomain}/${repository.split('/')[0]}`
          : null;
        await usageStore.recordUsage(sql, {
          accountKey: usageStore.resolveAccountKey({
            email: continuousSubscription && continuousSubscription.customer_email,
            stripeCustomerId: continuousSubscription && continuousSubscription.stripe_customer_id,
            org,
          }),
          surface: 'push',
          repo: repository,
          suite: scanTier,
          tier: continuousSubscription ? 'continuous' : null,
          scanId: job.event_id || null,
          modulesRun: Array.isArray(scanResult.modules) ? scanResult.modules.length : 0,
          findingsTotal: scanResult.totalIssues,
          findingsBlocking: usageStore.countBlockingFindings(scanResult),
          aiCalls: ai.aiCalls,
          tokensIn: ai.tokensIn,
          tokensOut: ai.tokensOut,
          usdEstimated: ai.usd,
          keyOwner: 'gatetest',
        });
      } catch (err) { // error-ok — the ledger must never fail the tick; one warning, scan already done
        console.warn(
          '[scan-worker] usage ledger write failed (continuing):',
          err && err.message ? err.message : err
        );
      }
    }

    // Fire callback with the real result, retried through transient
    // failures — a lost callback makes a perfect scan look like it never
    // ran. Still never throws to the tick.
    try {
      if (sendCallback) {
        await callWithRetry(() => sendCallback({
          repository,
          sha: job.sha,
          ref: job.ref,
          pullRequestNumber: job.pull_request_number,
          host: job.host || 'gluecron',
          scanResult,
        }));
      }
    } catch (err) {
      console.error(
        '[scan-worker] sendCallback failed after retries:',
        err && err.message ? err.message : err
      );
    }

    return { ok: true, ran: job.id, reclaimed };
  }

  // Scan failed. Decide whether to retry or dead-letter.
  // job.attempts already reflects THIS attempt (claimNextJob incremented it).
  // Terminal errors (404 repo, dead credentials, empty repository) fail
  // identically on every attempt — dead-letter immediately instead of
  // burning MAX_ATTEMPTS ticks (advancement #11: terminal classification).
  const rawErrMsg =
    (scanResult && scanResult.error) ||
    `scan returned status=${scanResult && scanResult.status}`;
  const terminal = isTerminalScanError(rawErrMsg);
  const willRetry = !terminal && job.attempts < MAX_ATTEMPTS;
  const errMsg = terminal ? `[terminal] ${rawErrMsg}` : rawErrMsg;

  try {
    await queueStore.markFailed(job.id, errMsg, willRetry, sql);
  } catch (err) {
    console.error(
      '[scan-worker] markFailed failed:',
      err && err.message ? err.message : err
    );
  }

  // If this was the final attempt, notify Gluecron so it doesn't wait
  // indefinitely. The callback helper marks status='error' when
  // scanResult.error is set. Retried like the success callback — the
  // dead-letter notification is the LAST signal the customer gets.
  if (!willRetry) {
    try {
      if (sendCallback) {
        await callWithRetry(() => sendCallback({
          repository,
          sha: job.sha,
          ref: job.ref,
          pullRequestNumber: job.pull_request_number,
          host: job.host || 'gluecron',
          scanResult,
        }));
      }
    } catch (err) {
      console.error(
        '[scan-worker] dead-letter callback failed after retries:',
        err && err.message ? err.message : err
      );
    }
  }

  return {
    ok: false,
    jobId: job.id,
    attempts: job.attempts,
    willRetry,
    terminal,
    reclaimed,
    error: String(errMsg).slice(0, 500),
  };
}

module.exports = {
  isAuthorisedTick,
  runWorkerTick,
  callWithRetry,
  MAX_DIFF_FILES,
};
