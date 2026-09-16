'use strict';
/**
 * Public status summary — the PURE mapper behind /status and
 * GET /api/status/public (Fifty move 22, Craig 2026-09-16: "best customer
 * service possible, on automation").
 *
 * Takes the readings the internal probes already produce — /api/status
 * (config readiness + queue posture), /api/platform-status (build stamp),
 * the scan_queue table (worker activity, last GitHub delivery), a reachability
 * probe of /api/mcp, and the Stripe mode — and turns them into a customer-safe
 * summary: per component, one of four states and a sentence a stranger can
 * read.
 *
 * ── Rules this file enforces ───────────────────────────────────────────────
 *   1. NOTHING typed by hand becomes a state. Every state is derived from a
 *      reading; when a reading is missing or malformed the state is
 *      "unknown", said plainly (Doctrine #1: print the third state).
 *   2. NO internal name leaves this function. Details are fixed templates
 *      that interpolate counts and ages only — never an env var name, a
 *      hostname, an IP, an error message, or a file path. `redactIfLeaky()`
 *      is the belt to that brace: any detail that LOOKS like an internal
 *      identifier is replaced with the generic sentence before it ships.
 *      tests/public-status.test.js feeds adversarial readings through and
 *      asserts none of the known internal names survive.
 *   3. NEVER THROWS. A reading that throws on access, a null input, a wrong
 *      shape — each yields "unknown" for that component and the rest are
 *      still computed. The route and the page can therefore never 500 on
 *      their own dependency (Forbidden #15).
 *
 * Pure: no I/O, no `process.env`, no `Date.now()` unless `now` is omitted.
 * The collector that gathers the readings lives in public-status-collect.ts.
 */

/** Component names — ONE definition, used by the summary, the page and the incident schema. */
const COMPONENT_NAMES = Object.freeze([
  'Website',
  'Hosted scans',
  'Scan worker',
  'GitHub App webhooks',
  'API',
  'MCP hosted endpoint',
  'Payments',
]);

const STATES = Object.freeze(['operational', 'degraded', 'down', 'unknown']);
const OVERALLS = Object.freeze(['operational', 'partial', 'major', 'unknown']);
const INCIDENT_IMPACTS = Object.freeze(['none', 'minor', 'major']);

/** A queued job older than this has been waiting too long — the worker is not keeping up. */
const QUEUE_STALE_SECONDS = 900;
/** How far back the incident list on /status reaches. */
const INCIDENT_WINDOW_DAYS = 14;

/** The one sentence used whenever a component cannot be assessed. */
const UNKNOWN_DETAIL = 'Could not be verified just now.';

// ---------------------------------------------------------------------------
// Leak guard — the shapes internal identifiers take. A detail matching any of
// these is replaced wholesale. Kept deliberately broad: a false replacement
// costs one sentence of nuance, a false pass costs a secret's NAME on a
// public page.
// ---------------------------------------------------------------------------
const LEAKY_PATTERNS = [
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/,          // ENV_VAR_NAME
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,            // IPv4
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/i, // host.name.tld
  /https?:\/\//i,                           // any URL
  /[\\/][\w.-]+[\\/]/,                      // a path segment
  /\b(?:sk|rk|pk|re|whsec|ghp|gho|ghs|github_pat)_[A-Za-z0-9]+/, // key prefixes
  /\bError\b|\bECONN|\bETIMEDOUT|\bENOTFOUND|\bstack\b/,          // error text
];

function redactIfLeaky(detail) {
  const text = typeof detail === 'string' ? detail : '';
  if (!text.trim()) return UNKNOWN_DETAIL;
  return LEAKY_PATTERNS.some((re) => re.test(text)) ? UNKNOWN_DETAIL : text;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isObject(v) {
  return v !== null && typeof v === 'object';
}

/** A reading is unusable if absent, not an object, or carries an `error` key. */
function usable(reading) {
  return isObject(reading) && !('error' in reading);
}

function asCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function isCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * The queue reading, or null unless every count is an actual number. A
 * string where a count should be is garbage, and garbage must read as
 * "unknown" — never as "0 queued, none stuck".
 */
function validQueue(queue) {
  if (!usable(queue)) return null;
  if (!isCount(queue.queued) || !isCount(queue.running) || !isCount(queue.dead)) return null;
  const oldest = queue.oldest_queued_age_s;
  if (oldest !== null && oldest !== undefined && !isCount(oldest)) return null;
  return queue;
}

function parseTime(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Human age: "just now", "4 min", "3 h", "2 days". Never negative. */
function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

function shortCommit(commit) {
  const c = typeof commit === 'string' ? commit.trim() : '';
  if (!/^[0-9a-f]{7,40}$/i.test(c)) return 'unknown';
  return c.slice(0, 8).toLowerCase();
}

function component(name, state, detail) {
  return {
    name,
    state: STATES.includes(state) ? state : 'unknown',
    detail: redactIfLeaky(detail),
  };
}

/** Run one mapper; a throw anywhere inside becomes "unknown", never an exception. */
function safely(name, fn) {
  try {
    const out = fn();
    if (isObject(out) && typeof out.state === 'string') return component(name, out.state, out.detail);
    return component(name, 'unknown', UNKNOWN_DETAIL);
  } catch {
    return component(name, 'unknown', UNKNOWN_DETAIL);
  }
}

// ---------------------------------------------------------------------------
// Per-component mappers — each takes the raw reading and returns {state, detail}
// ---------------------------------------------------------------------------

/**
 * Website — this summary is being served, so the process answered. That is
 * the whole claim; anything stronger would be typed, not measured.
 */
function mapWebsite(readings) {
  const build = usable(readings.build) ? readings.build : null;
  if (build && typeof build.version === 'string' && /^\d+\.\d+\.\d+/.test(build.version)) {
    return { state: 'operational', detail: `Serving requests on version ${build.version.match(/^\d+\.\d+\.\d+/)[0]}.` };
  }
  return { state: 'operational', detail: 'Serving requests.' };
}

/**
 * Hosted scans — the queue posture from /api/status. Dead-lettered jobs or a
 * job waiting past the ceiling both mean a customer is waiting on a result
 * that is not coming at the usual pace.
 */
function mapHostedScans(rawQueue) {
  const queue = validQueue(rawQueue);
  if (!queue) return { state: 'unknown', detail: UNKNOWN_DETAIL };
  const queued = asCount(queue.queued);
  const running = asCount(queue.running);
  const dead = asCount(queue.dead);
  const oldest = Number(queue.oldest_queued_age_s);
  const oldestOk = Number.isFinite(oldest) && oldest >= 0;

  if (dead > 0) {
    return {
      state: 'degraded',
      detail: `${dead} scan${dead === 1 ? '' : 's'} could not complete after retries; ${queued} queued, ${running} running.`,
    };
  }
  if (oldestOk && oldest > QUEUE_STALE_SECONDS) {
    return {
      state: 'degraded',
      detail: `Scans are queuing longer than usual — the oldest has waited ${Math.floor(oldest / 60)} min; ${queued} queued, ${running} running.`,
    };
  }
  return {
    state: 'operational',
    detail: `${queued} queued, ${running} running, none stuck.`,
  };
}

/**
 * Scan worker — the process that turns queued jobs into results. Its
 * heartbeat is inferred from the queue table: the last time it started or
 * finished a job, and whether anything is waiting past the ceiling.
 */
function mapScanWorker(worker, queue, now) {
  const q = validQueue(queue);
  const queued = q ? asCount(q.queued) : 0;
  const oldest = q ? Number(q.oldest_queued_age_s) : NaN;
  if (q && queued > 0 && Number.isFinite(oldest) && oldest > QUEUE_STALE_SECONDS) {
    return {
      state: 'down',
      detail: `Jobs are waiting and none has been picked up for over ${Math.floor(QUEUE_STALE_SECONDS / 60)} minutes.`,
    };
  }
  if (!usable(worker)) return { state: 'unknown', detail: UNKNOWN_DETAIL };
  const last = parseTime(worker.lastActivityAt);
  if (last === null) {
    return { state: 'unknown', detail: 'No jobs processed yet on this deployment.' };
  }
  if (q && queued > 0) {
    return { state: 'operational', detail: `Processing — last job activity ${formatAge(now - last)}.` };
  }
  return { state: 'operational', detail: `Idle — last job activity ${formatAge(now - last)}.` };
}

/**
 * GitHub App webhooks — the only persisted signal is the last delivery that
 * got as far as the queue. Configured with no deliveries on record is
 * "unknown", not "operational": we cannot see a webhook that never arrived.
 */
function mapWebhooks(webhooks, now) {
  if (!usable(webhooks)) return { state: 'unknown', detail: UNKNOWN_DETAIL };
  if (webhooks.configured === false) {
    return { state: 'degraded', detail: 'Not configured on this deployment — pushes and pull requests are not being received.' };
  }
  if (webhooks.configured !== true) return { state: 'unknown', detail: UNKNOWN_DETAIL };
  const last = parseTime(webhooks.lastDeliveryAt);
  if (last === null) {
    return { state: 'unknown', detail: 'Configured; no deliveries recorded yet.' };
  }
  return { state: 'operational', detail: `Last delivery accepted ${formatAge(now - last)}.` };
}

/**
 * API — the deployment's own account of whether its core configuration is
 * complete (/api/status). A missing required setting means scans, sign-in or
 * checkout fail; that is "down" for the API even while pages still render.
 */
function mapApi(readiness) {
  if (!usable(readiness)) return { state: 'unknown', detail: UNKNOWN_DETAIL };
  const missingRequired = Array.isArray(readiness.missing_required) ? readiness.missing_required.length : null;
  const missingImportant = Array.isArray(readiness.missing_important) ? readiness.missing_important.length : 0;
  const placeholders = Array.isArray(readiness.invalid_placeholders) ? readiness.invalid_placeholders.length : 0;
  if (missingRequired === null) return { state: 'unknown', detail: UNKNOWN_DETAIL };
  if (missingRequired > 0 || readiness.ready === false) {
    return { state: 'down', detail: 'Core configuration is incomplete — scans, sign-in or checkout may fail.' };
  }
  if (missingImportant > 0 || placeholders > 0) {
    const n = missingImportant + placeholders;
    return { state: 'degraded', detail: `Responding; ${n} optional integration${n === 1 ? ' is' : 's are'} not fully configured.` };
  }
  return { state: 'operational', detail: 'Responding; configuration complete.' };
}

/**
 * MCP hosted endpoint — a GET to /api/mcp answers with a JSON body (the
 * transport is POST-only, so a 405 with a body IS the healthy answer).
 */
function mapMcp(mcp) {
  if (!usable(mcp)) return { state: 'unknown', detail: UNKNOWN_DETAIL };
  if (mcp.reachable === true) return { state: 'operational', detail: 'Reachable; accepting connections from MCP clients.' };
  if (mcp.reachable === false) {
    const status = Number(mcp.status);
    if (status >= 500) return { state: 'down', detail: 'Not answering — MCP clients cannot connect.' };
    if (status === 404) return { state: 'down', detail: 'Endpoint missing from the running build.' };
    return { state: 'degraded', detail: 'Answering unexpectedly — some MCP clients may fail to connect.' };
  }
  return { state: 'unknown', detail: UNKNOWN_DETAIL };
}

/**
 * Payments — Stripe MODE (never a key) plus whether webhook signatures can be
 * verified. Test mode in production means real cards fail; a missing webhook
 * secret means subscription changes are not applied.
 */
function mapPayments(payments) {
  if (!usable(payments)) return { state: 'unknown', detail: UNKNOWN_DETAIL };
  const mode = typeof payments.mode === 'string' ? payments.mode : 'unknown';
  const webhook = payments.webhookConfigured === true;
  const production = payments.production === true;
  if (mode === 'unset') return { state: 'down', detail: 'Checkout is unavailable — payments are not configured.' };
  if (mode === 'test' && production) return { state: 'degraded', detail: 'Payments are in test mode — real cards are not accepted.' };
  if (mode === 'live' || mode === 'test') {
    if (!webhook) return { state: 'degraded', detail: 'Checkout works; subscription updates may be delayed.' };
    return { state: 'operational', detail: mode === 'live' ? 'Checkout and subscription updates working.' : 'Test mode; checkout and subscription updates working.' };
  }
  return { state: 'unknown', detail: UNKNOWN_DETAIL };
}

// ---------------------------------------------------------------------------
// Overall
// ---------------------------------------------------------------------------

function overallOf(components) {
  const states = components.map((c) => c.state);
  if (states.includes('down')) return 'major';
  if (states.includes('degraded')) return 'partial';
  // "Website" is green because this code ran — that alone is not evidence
  // the product works. With every MEASURED component unknown, say unknown.
  const measured = components.filter((c) => c.name !== 'Website').map((c) => c.state);
  if (measured.length === 0 || measured.every((s) => s === 'unknown')) return 'unknown';
  return 'operational';
}

function headlineOf(overall, components) {
  const unknown = components.filter((c) => c.state === 'unknown').length;
  const suffix = unknown > 0 && overall !== 'unknown'
    ? ` ${unknown} component${unknown === 1 ? '' : 's'} could not be verified.`
    : '';
  switch (overall) {
    case 'operational': return `All systems operational.${suffix}`;
    case 'partial': return `Partial degradation — some features are slower or limited.${suffix}`;
    case 'major': return `Major outage — a core surface is down.${suffix}`;
    default: return 'Status could not be verified just now.';
  }
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Summarise the readings into the public status shape.
 *
 * @param {object|null|undefined} readings
 * @param {object}   [readings.build]     { version, commit, builtAt }
 * @param {object}   [readings.readiness] the /api/status body (or { error })
 * @param {object}   [readings.queue]     { queued, running, done, dead, oldest_queued_age_s } (or { error })
 * @param {object}   [readings.worker]    { lastActivityAt } (or { error })
 * @param {object}   [readings.webhooks]  { configured, lastDeliveryAt } (or { error })
 * @param {object}   [readings.mcp]       { reachable, status } (or { error })
 * @param {object}   [readings.payments]  { mode, webhookConfigured, production } (or { error })
 * @param {number}   [readings.now]       epoch ms, for tests
 * @returns {{
 *   overall: 'operational'|'partial'|'major'|'unknown',
 *   headline: string,
 *   components: Array<{ name: string, state: string, detail: string, checkedAt: string }>,
 *   version: string, commit: string, builtAt: string|null, checkedAt: string,
 * }}
 */
function summarisePublicStatus(readings) {
  const r = isObject(readings) ? readings : {};
  let now = Date.now();
  try {
    const n = Number(r.now);
    if (Number.isFinite(n) && n > 0) now = n;
  } catch { /* error-ok — fall back to the wall clock */ }
  const checkedAt = new Date(now).toISOString();

  // Every reading is fetched through a getter that may throw (a Proxy, a
  // poisoned object) — read each ONCE inside its own guard.
  const get = (key) => { try { return r[key]; } catch { return { error: true }; } };
  const build = get('build');
  const readiness = get('readiness');
  const queue = get('queue');
  const worker = get('worker');
  const webhooks = get('webhooks');
  const mcp = get('mcp');
  const payments = get('payments');

  const components = [
    safely('Website', () => mapWebsite({ build })),
    safely('Hosted scans', () => mapHostedScans(queue)),
    safely('Scan worker', () => mapScanWorker(worker, queue, now)),
    safely('GitHub App webhooks', () => mapWebhooks(webhooks, now)),
    safely('API', () => mapApi(readiness)),
    safely('MCP hosted endpoint', () => mapMcp(mcp)),
    safely('Payments', () => mapPayments(payments)),
  ].map((c) => ({ ...c, checkedAt }));

  const overall = overallOf(components);

  let version = 'unknown';
  let commit = 'unknown';
  let builtAt = null;
  try {
    if (usable(build)) {
      if (typeof build.version === 'string' && /^\d+\.\d+\.\d+/.test(build.version)) version = build.version.match(/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?/)[0];
      commit = shortCommit(build.commit);
      const t = parseTime(build.builtAt);
      builtAt = t === null ? null : new Date(t).toISOString();
    }
  } catch { /* error-ok — build stamp stays unknown */ }

  return {
    overall,
    headline: headlineOf(overall, components),
    components,
    version,
    commit,
    builtAt,
    checkedAt,
  };
}

// ---------------------------------------------------------------------------
// Incidents — website/app/data/incidents.json
// ---------------------------------------------------------------------------

/**
 * Validate the incidents file. Returns a list of human-readable problems;
 * empty means valid. Never throws.
 *
 * Schema per entry: { date: ISO-8601, title, components: COMPONENT_NAMES[],
 * impact: 'none'|'minor'|'major', resolved: boolean, summary }.
 */
function validateIncidents(data) {
  const problems = [];
  const list = isObject(data) && Array.isArray(data.incidents) ? data.incidents : data;
  if (!Array.isArray(list)) return ['incidents must be an array (or { incidents: [] })'];
  list.forEach((inc, i) => {
    const at = `incidents[${i}]`;
    if (!isObject(inc)) { problems.push(`${at}: not an object`); return; }
    if (typeof inc.date !== 'string' || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(inc.date) || Number.isNaN(Date.parse(inc.date))) {
      problems.push(`${at}.date: must be an ISO-8601 date (YYYY-MM-DD or full UTC timestamp)`);
    }
    if (typeof inc.title !== 'string' || !inc.title.trim()) problems.push(`${at}.title: required`);
    if (!Array.isArray(inc.components)) problems.push(`${at}.components: must be an array`);
    else inc.components.forEach((c) => { if (!COMPONENT_NAMES.includes(c)) problems.push(`${at}.components: "${c}" is not a known component`); });
    if (!INCIDENT_IMPACTS.includes(inc.impact)) problems.push(`${at}.impact: must be one of ${INCIDENT_IMPACTS.join(', ')}`);
    if (typeof inc.resolved !== 'boolean') problems.push(`${at}.resolved: must be a boolean`);
    if (typeof inc.summary !== 'string' || !inc.summary.trim()) problems.push(`${at}.summary: required`);
  });
  return problems;
}

/**
 * The incidents inside the public window, newest first. Malformed entries
 * are dropped rather than thrown on — the page must render.
 */
function recentIncidents(data, now = Date.now(), days = INCIDENT_WINDOW_DAYS) {
  const list = isObject(data) && Array.isArray(data.incidents) ? data.incidents : Array.isArray(data) ? data : [];
  const cutoff = now - days * 86_400_000;
  return list
    .filter((inc) => isObject(inc) && typeof inc.date === 'string')
    .map((inc) => ({ inc, t: parseTime(inc.date) }))
    .filter(({ t }) => t !== null && t >= cutoff && t <= now + 86_400_000)
    .sort((a, b) => b.t - a.t)
    .map(({ inc }) => inc);
}

module.exports = {
  COMPONENT_NAMES,
  STATES,
  OVERALLS,
  INCIDENT_IMPACTS,
  QUEUE_STALE_SECONDS,
  INCIDENT_WINDOW_DAYS,
  UNKNOWN_DETAIL,
  summarisePublicStatus,
  validateIncidents,
  recentIncidents,
  formatAge,
  redactIfLeaky,
  // exposed for tests
  _mappers: { mapWebsite, mapHostedScans, mapScanWorker, mapWebhooks, mapApi, mapMcp, mapPayments },
};
