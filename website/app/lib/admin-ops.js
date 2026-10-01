/**
 * Live-operations snapshot for the admin console (GET /api/admin/ops).
 *
 * Owner, 2026-10-01: "we need better hands on with our product and better
 * monitoring, real hands on admin not something that looks mock up." Every
 * number below was already computed server-side and never shown:
 *
 *   queue       — scan-queue-store.js getQueueStats (status counts + age of
 *                 the oldest waiting job)
 *   latency     — launch-metrics.js getLaunchMetrics over the last 24h
 *                 (p95 claim wait, p95 push-to-result, status counts)
 *   deadLetters — the last ten dead scan_queue rows; each one is a customer
 *                 who saw nothing
 *   deploy      — pull-deploy-status.js readLastPullDeploy (the box's own
 *                 status file, written every 5-minute tick)
 *   spend       — server-spend-guard.js checkServerSpend (the one definition
 *                 of the GATETEST_DAILY_API_BUDGET_USD ceiling) +
 *                 usage-ledger.js summarizeUsage for the 7-day series
 *
 * Every section carries its own `state` — "ok" | "warn" | "fail" |
 * "not_checked" — and a one-line `reason` (Doctrine #1: three states, the
 * third printed). Sections are read independently and in parallel, each
 * under its own ceiling: a throw or a hang in one becomes that section's
 * not_checked + reason and never blanks the others. A failed read is never
 * reported as zeros.
 *
 * Every source is injected, so the builder is unit-tested with fakes
 * (tests/admin-ops.test.js); `defaultDeps()` wires the real modules.
 */

'use strict';

const STATE_RANK = { ok: 0, not_checked: 1, warn: 2, fail: 3 };

// Thresholds. The queue worker ticks every 2 minutes and the pull-deploy
// timer every 5 (scripts/deploy/systemd/gatetest-{tick,pull-deploy}.timer),
// so each ceiling is several missed ticks, not one slow one.
const QUEUE_OLDEST_WARN_S = 10 * 60;
const QUEUE_OLDEST_FAIL_S = 30 * 60;
const P95_TOTAL_WARN_S = 10 * 60;
const P95_TOTAL_FAIL_S = 30 * 60;
const DEPLOY_SILENT_WARN_S = 20 * 60;
const SPEND_WARN_PCT = 80;
const SECTION_TIMEOUT_MS = 4000;
const DAY_MS = 24 * 60 * 60 * 1000;

function errMessage(err) {
  return err && err.message ? String(err.message) : String(err || 'unknown error');
}

function notChecked(reason) {
  return { state: 'not_checked', reason };
}

/** Pick the worst of several {state, reason} findings; ok only when all are ok. */
function worst(findings, okReason) {
  const bad = findings.filter((f) => f.state !== 'ok');
  if (bad.length === 0) return { state: 'ok', reason: okReason };
  const state = bad.reduce((acc, f) => (STATE_RANK[f.state] > STATE_RANK[acc] ? f.state : acc), 'ok');
  return { state, reason: bad.map((f) => f.reason).join('; ') };
}

function ageText(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return 'unknown';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 90) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function missingTable(err) {
  return /does not exist/i.test(errMessage(err));
}

/** Run one section reader under a ceiling; a throw or hang becomes not_checked. */
async function guarded(name, fn, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => {
        // Not unref'd: the finally below always clears it, and an unref'd
        // ceiling would let the process exit before a hung read is reported.
        timer = setTimeout(() => resolve(notChecked(`${name} read timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    const msg = errMessage(err);
    return notChecked(missingTable(err) ? `${name}: table missing on this database (${msg})` : `${name} read failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── queue ───────────────────────────────────────────────────────────────────

async function readQueue({ sql, sqlReason, getQueueStats }) {
  if (!sql) return notChecked(sqlReason);
  const s = await getQueueStats(sql);
  const queue = {
    queued: s.queued,
    running: s.running,
    done: s.done,
    dead: s.dead,
    oldestQueuedAgeSec: s.oldest_queued_age_s ?? null,
  };
  const findings = [];
  const oldest = queue.oldestQueuedAgeSec;
  if (oldest != null && oldest > QUEUE_OLDEST_FAIL_S) {
    findings.push({ state: 'fail', reason: `oldest queued job has waited ${ageText(oldest)} — the worker is not picking up` });
  } else if (oldest != null && oldest > QUEUE_OLDEST_WARN_S) {
    findings.push({ state: 'warn', reason: `oldest queued job has waited ${ageText(oldest)}` });
  }
  if (queue.dead > 0) {
    findings.push({ state: 'warn', reason: `${queue.dead} dead letter(s) on record` });
  }
  const okReason = queue.queued > 0
    ? `${queue.queued} queued, ${queue.running} running; oldest waiting ${ageText(oldest)}`
    : `nothing waiting; ${queue.running} running, ${queue.done} done all time`;
  return { ...queue, ...worst(findings, okReason) };
}

// ── latency (last 24h) ──────────────────────────────────────────────────────

function sumPipeline(byDay) {
  const out = { queued: 0, running: 0, done: 0, dead: 0 };
  for (const day of Object.values(byDay || {})) {
    for (const k of Object.keys(out)) out[k] += Number(day[k]) || 0;
  }
  return out;
}

async function readLatency({ sql, sqlReason, getLaunchMetrics }) {
  if (!sql) return notChecked(sqlReason);
  const m = await getLaunchMetrics(sql, { days: 1 });
  const lat = m && m.latency;
  if (!lat || lat.error) {
    throw new Error(lat && lat.error ? lat.error : 'latency section missing');
  }
  const last24h = m.pipeline && !m.pipeline.error ? sumPipeline(m.pipeline) : null;
  const body = {
    p95WaitSec: lat.queue_wait_s ? lat.queue_wait_s.p95 : null,
    p95TotalSec: lat.push_to_result_s ? lat.push_to_result_s.p95 : null,
    avgTotalSec: lat.push_to_result_s ? lat.push_to_result_s.avg : null,
    completed24h: lat.completed || 0,
    last24h,
    last24hReason: last24h ? null : `status counts not read: ${m.pipeline && m.pipeline.error ? m.pipeline.error : 'missing'}`,
  };
  if (body.completed24h === 0) {
    return { ...body, ...notChecked('no scan completed in the last 24h — nothing to measure') };
  }
  const p95 = body.p95TotalSec;
  const findings = [];
  if (p95 != null && p95 > P95_TOTAL_FAIL_S) findings.push({ state: 'fail', reason: `p95 push-to-result ${ageText(p95)} (ceiling ${ageText(P95_TOTAL_FAIL_S)})` });
  else if (p95 != null && p95 > P95_TOTAL_WARN_S) findings.push({ state: 'warn', reason: `p95 push-to-result ${ageText(p95)}` });
  return {
    ...body,
    ...worst(findings, `${body.completed24h} completed in 24h; p95 wait ${ageText(body.p95WaitSec)}, p95 total ${ageText(p95)}`),
  };
}

// ── dead letters ────────────────────────────────────────────────────────────

async function readDeadLetters({ sql, sqlReason }) {
  if (!sql) return notChecked(sqlReason);
  const counts = await sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(completed_at, created_at) > NOW() - INTERVAL '24 hours')::int AS last24h
    FROM scan_queue WHERE status = 'dead'`;
  const rows = await sql`
    SELECT id, repository, last_error, COALESCE(completed_at, created_at)::text AS at
    FROM scan_queue WHERE status = 'dead'
    ORDER BY id DESC LIMIT 10`;
  const c = Array.isArray(counts) && counts[0] ? counts[0] : {};
  const recent = (Array.isArray(rows) ? rows : []).map((r) => {
    const raw = String(r.last_error || '');
    return {
      id: r.id != null ? String(r.id) : null,
      repo: r.repository || null,
      terminal: raw.startsWith('[terminal]'),
      reason: raw.replace(/^\[terminal\]\s*/, '').slice(0, 200) || 'no error recorded',
      at: r.at || null,
    };
  });
  // Row counts (::int in SQL) — parsed as integers, never as floats.
  const total = Number.parseInt(c.total, 10) || 0;
  const last24h = Number.parseInt(c.last24h, 10) || 0;
  let verdict;
  if (last24h > 0) verdict = { state: 'fail', reason: `${last24h} scan(s) died in the last 24h — each is a customer who saw nothing` };
  else if (total > 0) verdict = { state: 'warn', reason: `none in 24h; ${total} older dead letter(s) on record` };
  else verdict = { state: 'ok', reason: 'no dead letters' };
  return { total, last24h, recent, ...verdict };
}

// ── deploy (the box's pull-deploy status file) ──────────────────────────────

async function readDeploy({ readLastPullDeploy, now }) {
  const d = readLastPullDeploy();
  if (!d || d.result === 'unknown') {
    return notChecked(`${(d && d.reason) || 'no status'} — the file is written by the pull-deploy timer on the production box`);
  }
  const body = {
    result: d.result,
    detail: d.reason || '',
    at: d.at || null,
    from: d.from || null,
    to: d.to || null,
    consecutiveFailures: d.consecutiveFailures ?? null,
    firstFailedAt: d.firstFailedAt || null,
  };
  const ageS = body.at ? Math.max(0, Math.floor((now.getTime() - Date.parse(body.at)) / 1000)) : null;
  const findings = [];
  if (body.result === 'failed' || (body.consecutiveFailures != null && body.consecutiveFailures > 0)) {
    const n = body.consecutiveFailures != null ? body.consecutiveFailures : 1;
    const since = body.firstFailedAt ? ` since ${body.firstFailedAt}` : '';
    findings.push({ state: 'fail', reason: `${n} consecutive failed deploy(s)${since}: ${body.detail || 'no reason recorded'}` });
  }
  if (ageS != null && Number.isFinite(ageS) && ageS > DEPLOY_SILENT_WARN_S) {
    findings.push({ state: 'warn', reason: `box last reported ${ageText(ageS)} ago (timer runs every 5 min)` });
  }
  const okReason = `${body.result} ${ageText(ageS)} ago${body.to ? ` at ${String(body.to).slice(0, 7)}` : ''}`;
  return { ...body, ...worst(findings, okReason) };
}

// ── AI spend (server key, the metered ceiling) ──────────────────────────────

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function readSpend({ sql, sqlReason, checkServerSpend, summarizeUsage, serverAccountKey, now }) {
  const guard = await checkServerSpend({ sql: sql || undefined, now });
  const ceilingUsd = guard.ceilingMicros != null ? guard.ceilingMicros / 1e6 : null;
  const noCeiling = guard.reason === 'not-configured';
  const noCeilingReason = 'no ceiling set — GATETEST_DAILY_API_BUDGET_USD unset';

  if (!sql) {
    return {
      ceilingUsd,
      ...notChecked(`${sqlReason} — today's spend is unreadable${noCeiling ? `; ${noCeilingReason}` : ''}`),
    };
  }

  const from = new Date(startOfUtcDay(now).getTime() - 6 * DAY_MS);
  const summary = await summarizeUsage(sql, serverAccountKey, { from, to: now });
  const last7d = (summary.series || []).map((d) => ({
    day: d.day,
    usd: Number(d.usdEstimated) || 0,
    aiCalls: Number(d.aiCalls) || 0,
    tokens: (Number(d.tokensIn) || 0) + (Number(d.tokensOut) || 0),
  }));
  const todayKey = startOfUtcDay(now).toISOString().slice(0, 10);
  const today = last7d.find((d) => d.day === todayKey);
  const todayUsd = today ? today.usd : 0;
  const pctOfCeiling = ceilingUsd ? Math.round((todayUsd / ceilingUsd) * 1000) / 10 : null;
  const body = { todayUsd, ceilingUsd, pctOfCeiling, last7d };

  if (guard.reason === 'misconfigured') {
    return { ...body, state: 'fail', reason: 'GATETEST_DAILY_API_BUDGET_USD is set but not a positive number — server-key AI calls are refused' };
  }
  if (guard.reason === 'ledger-unavailable') {
    return { ...body, ...notChecked('the spend guard could not read the usage ledger') };
  }
  if (guard.reason === 'daily-budget-reached') {
    return { ...body, state: 'fail', reason: `daily ceiling reached: $${todayUsd.toFixed(2)} of $${ceilingUsd.toFixed(2)} — automatic AI callers report not checked` };
  }
  if (noCeiling) {
    return { ...body, state: 'warn', reason: `$${todayUsd.toFixed(2)} today; ${noCeilingReason}` };
  }
  if (pctOfCeiling != null && pctOfCeiling >= SPEND_WARN_PCT) {
    return { ...body, state: 'warn', reason: `$${todayUsd.toFixed(2)} of $${ceilingUsd.toFixed(2)} (${pctOfCeiling}%)` };
  }
  return { ...body, state: 'ok', reason: `$${todayUsd.toFixed(2)} of $${ceilingUsd.toFixed(2)} (${pctOfCeiling}%)` };
}

// ── the snapshot ────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {() => Function} deps.getSql           returns the sql tag, or throws when unconfigured
 * @param {Function} deps.getQueueStats
 * @param {Function} deps.getLaunchMetrics
 * @param {Function} deps.readLastPullDeploy
 * @param {Function} deps.checkServerSpend
 * @param {Function} deps.summarizeUsage
 * @param {string}   deps.serverAccountKey
 * @param {() => Date} [deps.now]
 * @param {number}   [deps.timeoutMs]
 */
async function buildOpsSnapshot(deps) {
  const now = typeof deps.now === 'function' ? deps.now() : new Date();
  const timeoutMs = deps.timeoutMs || SECTION_TIMEOUT_MS;
  let sql = null;
  let sqlReason = null;
  try {
    sql = deps.getSql();
  } catch (err) {
    sqlReason = /DATABASE_URL/.test(errMessage(err))
      ? 'database not configured (DATABASE_URL unset)'
      : `database unavailable: ${errMessage(err)}`;
  }
  const ctx = { ...deps, sql, sqlReason, now };

  const [queue, latency, deadLetters, deploy, spend] = await Promise.all([
    guarded('queue', () => readQueue(ctx), timeoutMs),
    guarded('latency', () => readLatency(ctx), timeoutMs),
    guarded('dead letters', () => readDeadLetters(ctx), timeoutMs),
    guarded('deploy', () => readDeploy(ctx), timeoutMs),
    guarded('spend', () => readSpend(ctx), timeoutMs),
  ]);
  // The latency contract carries the recent dead letters too (one read, two views).
  latency.recentDead = Array.isArray(deadLetters.recent) ? deadLetters.recent : null;

  const sections = { queue, latency, deadLetters, deploy, spend };
  const overall = Object.values(sections).reduce(
    (acc, s) => (STATE_RANK[s.state] > STATE_RANK[acc] ? s.state : acc),
    'ok',
  );
  return { generatedAt: now.toISOString(), overall, ...sections };
}

/** The real modules — required lazily so tests never load the DB driver. */
function defaultDeps() {
  const { getQueueStats } = require('./scan-queue-store');
  const { getLaunchMetrics } = require('./launch-metrics');
  const { readLastPullDeploy } = require('./pull-deploy-status');
  const { checkServerSpend, SERVER_ACCOUNT_KEY } = require('./server-spend-guard');
  const { summarizeUsage } = require('./usage-ledger');
  return {
    getQueueStats,
    getLaunchMetrics,
    readLastPullDeploy,
    checkServerSpend,
    summarizeUsage,
    serverAccountKey: SERVER_ACCOUNT_KEY,
  };
}

module.exports = {
  buildOpsSnapshot,
  defaultDeps,
  STATE_RANK,
  QUEUE_OLDEST_WARN_S,
  QUEUE_OLDEST_FAIL_S,
  P95_TOTAL_WARN_S,
  P95_TOTAL_FAIL_S,
  DEPLOY_SILENT_WARN_S,
  SPEND_WARN_PCT,
};
