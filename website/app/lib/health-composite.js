'use strict';
/**
 * Composite health — the PURE half of GET /api/health/deep (issue #809).
 *
 * `/api/health` is a liveness ping (the container HEALTHCHECK; it must stay
 * constant) and `/api/v1/health` is a locked partner shape. Neither can go
 * red through a dead database, a silent queue or a rejected AI key — a
 * monitor read green through all three in September. This module turns the
 * readings the deep route gathers into one readiness verdict that CAN go
 * red, and says which sub-check took it there.
 *
 * Sub-checks, and why each is required or optional:
 *   db       required — no scan results, sessions or keys persist without it
 *   queue    required — pushes are scanned by the worker draining scan_queue
 *   ai       required — the review and fix paths throw without the AI key;
 *                       the reading is the LAST RECORDED successful call in
 *                       the usage ledger, never a live paid call
 *   mail     optional — the digest / key e-mails degrade, the site still runs
 *   runtime  optional — the browser worker tier is an augmentation; a
 *                       deployment without it ships static probes honestly
 *
 * Per-check status: ok | degraded | unknown | down | not-configured.
 * Overall: `down` (HTTP 503) when a REQUIRED check is down or unconfigured;
 * `degraded` (200) when any check is degraded/unknown or an OPTIONAL check
 * is down; `ok` (200) otherwise. An optional check that is not configured is
 * neutral — reported, never counted.
 *
 * Rules shared with public-status.js: nothing typed by hand becomes a
 * state; no internal name leaves (every reason passes redactIfLeaky, so an
 * env var name, hostname, IP, URL or error text is replaced wholesale); and
 * nothing here throws. Pure: no I/O, no process.env; `now` is injectable.
 */

const { redactIfLeaky, UNKNOWN_DETAIL } = require('./public-status');

/** Sub-check names — ONE definition, in response order. */
const CHECK_NAMES = Object.freeze(['db', 'queue', 'ai', 'mail', 'runtime']);
const REQUIRED_CHECKS = Object.freeze(['db', 'queue', 'ai']);
const OPTIONAL_CHECKS = Object.freeze(['mail', 'runtime']);

const STATUSES = Object.freeze(['ok', 'degraded', 'unknown', 'down', 'not-configured']);
const OVERALLS = Object.freeze(['ok', 'degraded', 'down']);

/**
 * Per-check ceiling. Every probe runs in parallel under its own timer, so the
 * whole route answers in about the slowest ceiling — well under the 5 s a
 * monitor gives a readiness probe — and can never hang on a dead dependency.
 */
const DEFAULT_TIMEOUT_MS = 2500;
/** A successful AI call older than this no longer proves the key works. */
const AI_RECENT_HOURS = 24;
/** Verdict cache, shared by the route and its Cache-Control header. */
const HEALTH_TTL_SECONDS = 30;

function isObject(v) {
  return v !== null && typeof v === 'object';
}

function normaliseStatus(s) {
  return STATUSES.includes(s) ? s : 'unknown';
}

function latencyOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * Run one probe under a ceiling. A probe resolves `{ status, reason }`;
 * a throw or a timeout never escapes — each becomes the status the caller
 * chose for it (`onError` / `onTimeout`, default "unknown") with a fixed
 * reason, because an error message is the leak channel this route closes.
 *
 * @param {() => Promise<{status?: string, reason?: string}>} probe
 * @param {{ timeoutMs?: number, onTimeout?: string, onError?: string, now?: () => number }} [opts]
 * @returns {Promise<{ status: string, latencyMs: number, reason: string }>}
 */
async function runCheck(probe, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const onTimeout = normaliseStatus(opts.onTimeout);
  const onError = normaliseStatus(opts.onError);
  const started = now();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: onTimeout, reason: `no answer within ${timeoutMs} ms` }), timeoutMs);
  });
  let result;
  try {
    const run = Promise.resolve().then(() => (typeof probe === 'function' ? probe() : null));
    result = await Promise.race([run.catch(() => ({ status: onError, reason: 'check failed' })), timeout]);
  } finally {
    clearTimeout(timer);
  }
  const r = isObject(result) ? result : { status: 'unknown', reason: 'check returned nothing' };
  return {
    status: normaliseStatus(r.status),
    latencyMs: Math.max(0, now() - started),
    reason: redactIfLeaky(typeof r.reason === 'string' ? r.reason : ''),
  };
}

/**
 * Run every probe in parallel under its own ceiling.
 *
 * @param {Record<string, () => Promise<{status?: string, reason?: string}>>} probes  keyed by check name
 * @param {{ timeouts?: Record<string, number>, onTimeout?: Record<string, string>, onError?: Record<string, string>, now?: () => number }} [opts]
 * @returns {Promise<Record<string, { status: string, latencyMs: number, reason: string }>>}
 */
async function runChecks(probes, opts = {}) {
  const names = isObject(probes) ? Object.keys(probes) : [];
  const timeouts = isObject(opts.timeouts) ? opts.timeouts : {};
  const onTimeout = isObject(opts.onTimeout) ? opts.onTimeout : {};
  const onError = isObject(opts.onError) ? opts.onError : {};
  const settled = await Promise.all(names.map((name) => runCheck(probes[name], {
    timeoutMs: timeouts[name],
    onTimeout: onTimeout[name],
    onError: onError[name],
    now: opts.now,
  })));
  const out = {};
  names.forEach((name, i) => { out[name] = settled[i]; });
  return out;
}

function overallOf(checks) {
  const required = CHECK_NAMES.filter((n) => checks[n].required);
  const optional = CHECK_NAMES.filter((n) => !checks[n].required);
  if (required.some((n) => checks[n].status === 'down' || checks[n].status === 'not-configured')) return 'down';
  if (required.some((n) => checks[n].status === 'degraded' || checks[n].status === 'unknown')) return 'degraded';
  if (optional.some((n) => checks[n].status === 'down' || checks[n].status === 'degraded' || checks[n].status === 'unknown')) return 'degraded';
  return 'ok';
}

/**
 * Compose the readiness verdict from per-check results.
 *
 * @param {Record<string, {status?: string, latencyMs?: number, reason?: string}>|null|undefined} results
 * @param {{ required?: readonly string[], now?: number }} [opts]
 * @returns {{
 *   ok: boolean,
 *   status: 'ok'|'degraded'|'down',
 *   failing: string[],
 *   checks: Record<string, { status: string, required: boolean, latencyMs: number|null, reason: string }>,
 *   checkedAt: string,
 *   ttlSeconds: number,
 * }}
 */
function composeHealth(results, opts = {}) {
  const r = isObject(results) ? results : {};
  const required = Array.isArray(opts.required) ? opts.required : REQUIRED_CHECKS;
  const now = Number.isFinite(opts.now) && opts.now > 0 ? opts.now : Date.now();

  const checks = {};
  for (const name of CHECK_NAMES) {
    let reading;
    try { reading = r[name]; } catch { reading = null; }
    const v = isObject(reading) ? reading : { status: 'unknown', reason: 'not measured' };
    let reason;
    try { reason = typeof v.reason === 'string' ? v.reason : ''; } catch { reason = ''; }
    checks[name] = {
      status: normaliseStatus(v.status),
      required: required.includes(name),
      latencyMs: latencyOf(v.latencyMs),
      reason: redactIfLeaky(reason),
    };
  }

  const status = overallOf(checks);
  const failing = CHECK_NAMES.filter((n) => checks[n].required
    ? checks[n].status !== 'ok'
    : checks[n].status !== 'ok' && checks[n].status !== 'not-configured');

  return {
    ok: status !== 'down',
    status,
    failing,
    checks,
    checkedAt: new Date(now).toISOString(),
    ttlSeconds: HEALTH_TTL_SECONDS,
  };
}

/** The HTTP status a verdict answers with: 503 only when a required check is down. */
function httpStatusOf(verdict) {
  return isObject(verdict) && verdict.ok === true ? 200 : 503;
}

module.exports = {
  CHECK_NAMES,
  REQUIRED_CHECKS,
  OPTIONAL_CHECKS,
  STATUSES,
  OVERALLS,
  DEFAULT_TIMEOUT_MS,
  AI_RECENT_HOURS,
  HEALTH_TTL_SECONDS,
  UNKNOWN_DETAIL,
  runCheck,
  runChecks,
  composeHealth,
  httpStatusOf,
};
