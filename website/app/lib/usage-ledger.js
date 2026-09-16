/**
 * Usage ledger — the customer-facing usage meter's persistence layer
 * (Craig 2026-09-16: "the best most intelligent usage meter for customers
 * to monitor what they are doing"). One append-only table:
 *
 *   usage_events(
 *     id                BIGSERIAL PRIMARY KEY,
 *     occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     account_key       TEXT NOT NULL,       -- customer identity, see below
 *     surface           TEXT NOT NULL,       -- where the work ran, see SURFACES
 *     repo              TEXT,                -- 'owner/name' only (redactRepo), never a URL/token
 *     suite             TEXT,                -- 'quick' | 'full' | 'deterministic' | 'nuclear' | ...
 *     modules_run       INTEGER NOT NULL DEFAULT 0,
 *     findings_total    INTEGER NOT NULL DEFAULT 0,
 *     findings_blocking INTEGER NOT NULL DEFAULT 0,
 *     ai_calls          INTEGER NOT NULL DEFAULT 0,
 *     tokens_in         BIGINT  NOT NULL DEFAULT 0,
 *     tokens_out        BIGINT  NOT NULL DEFAULT 0,
 *     usd_estimated     DOUBLE PRECISION NOT NULL DEFAULT 0,
 *     key_owner         TEXT NOT NULL DEFAULT 'gatetest',  -- 'gatetest' | 'byok'
 *     model_tier        TEXT,                -- 'standard' | 'deep' (vendor-neutral, never a model id)
 *     scan_id           TEXT,
 *     tier              TEXT                 -- paid tier the run was billed at
 *   )
 *
 * IDENTITY — why account_key is a hashed e-mail
 * --------------------------------------------
 * The customer reaches GateTest through five doors and each door has its
 * own record: `api_keys.customer_email` (gt_live_ REST keys),
 * `mcp_subscriptions.customer_email` (gtmcp_ hosted-MCP keys),
 * `continuous_subscriptions.customer_email` (the $49/mo push scans), the
 * OAuth session cookie (`payload.e`) on the dashboard, and the Stripe
 * checkout session (`customer_details.email`) on every pay-per-scan run.
 * The ONE field all five share is the customer's e-mail. API-key ids,
 * Stripe customer ids and OAuth logins each exist on only some doors, so a
 * ledger keyed on any of them would split one customer's usage into
 * several views. The ledger therefore keys on `em:<sha256(salt|email)>`:
 * stable across surfaces, and no PII at rest (same approach as
 * scan-history-store's hashRepoUrl). When no e-mail is known at write
 * time the row is still written under a namespaced fallback
 * (`apikey:<id>`, `stripe:<cus_…>`, `checkout:<cs_…>`, `org:<host>/<owner>`)
 * so nothing is lost; the read side queries every key the caller owns
 * (accountKeysForApiKey), never a key it does not.
 *
 * BYOK rows carry the same token counts and the same estimated USD (from
 * budget-tracker's price table) as GateTest-paid rows, flagged
 * key_owner='byok' — the customer sees one view whoever paid.
 *
 * Conventions: same as continuous-subscription-store.js — the caller
 * injects the tagged-template `sql`; every helper is a single query or a
 * fixed sequence of them; no in-memory state (serverless rule).
 * `recordUsageIfConfigured` is the best-effort writer for request paths:
 * it never throws and logs one warning on failure, so a ledger outage can
 * never fail a customer's scan or fix.
 */

'use strict';

const crypto = require('crypto');

const ACCOUNT_KEY_SALT = 'gatetest:usage_ledger:v1';

// The six surfaces Craig named, plus the two hosted paths that had no name:
// 'push' (GitHub App / Gluecron webhook scans drained by the worker) and
// 'api' (POST /api/v1/scans). Both are hosted work the customer is doing and
// a meter that hid them would under-report.
const SURFACES = Object.freeze(['web', 'action', 'mcp', 'cli', 'vscode', 'hosted-fix', 'push', 'api']);
const KEY_OWNERS = Object.freeze(['gatetest', 'byok']);

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 366;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_RECENT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Canonical account key for a customer e-mail, or null when there isn't one. */
function accountKeyForEmail(email) {
  if (typeof email !== 'string') return null;
  const normalised = email.trim().toLowerCase();
  if (!normalised || !normalised.includes('@')) return null;
  const digest = crypto.createHash('sha256').update(`${ACCOUNT_KEY_SALT}|${normalised}`).digest('hex');
  return `em:${digest}`;
}

function namespaced(prefix, value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  return `${prefix}:${v.slice(0, 120)}`;
}

/**
 * Resolve the best available identity for a write. E-mail wins because it is
 * the one identity every surface shares (see header); the rest are
 * fallbacks so a row is never dropped for want of an e-mail.
 *
 * @param {{ email?: string, stripeCustomerId?: string, apiKeyId?: string,
 *           checkoutSessionId?: string, org?: string, fallback?: string }} ids
 * @returns {string|null}
 */
function resolveAccountKey(ids = {}) {
  return (
    accountKeyForEmail(ids.email)
    || namespaced('stripe', ids.stripeCustomerId)
    || namespaced('apikey', ids.apiKeyId)
    || namespaced('checkout', ids.checkoutSessionId)
    || namespaced('org', ids.org)
    || (typeof ids.fallback === 'string' && ids.fallback.trim() ? ids.fallback.trim().slice(0, 160) : null)
  );
}

/**
 * Every ledger key an authenticated REST key may read: its customer's
 * e-mail key (shared with the other surfaces) and its own `apikey:` fallback.
 * Nothing else — this is the row-level boundary between customers.
 *
 * @param {{ id?: string, customer_email?: string|null }} key api_keys row
 * @returns {string[]}
 */
function accountKeysForApiKey(key) {
  const keys = [];
  const em = accountKeyForEmail(key && key.customer_email);
  if (em) keys.push(em);
  const own = namespaced('apikey', key && key.id != null ? String(key.id) : null);
  if (own) keys.push(own);
  return keys;
}

function normaliseAccountKeys(accountKey) {
  const list = Array.isArray(accountKey) ? accountKey : [accountKey];
  const clean = list.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim());
  if (clean.length === 0) throw new Error('accountKey is required');
  return clean;
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

/**
 * Reduce a repo reference to 'owner/name'. Accepts a URL (https / ssh), a
 * 'host/owner/name' triple or an 'owner/name' pair. Returns null for
 * anything else — the ledger never stores a URL, a query string or a token.
 */
function redactRepo(repo) {
  if (typeof repo !== 'string' || !repo.trim()) return null;
  let s = repo.trim();
  s = s.replace(/^git@([^:]+):/, '$1/');
  s = s.replace(/^[a-z]+:\/\//i, '');
  s = s.replace(/[?#].*$/, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/\.git$/i, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[parts.length - 2];
  const name = parts[parts.length - 1];
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  return `${owner}/${name}`;
}

function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function nonNegNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function textOrNull(v, max = 120) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Vendor-neutral label for the model a run used. 'standard' is the default
 * (cheap) model, anything else the customer or the tier selected is 'deep'.
 * Never returns a model id — the API is customer-facing.
 */
function modelTierFor(modelId) {
  if (typeof modelId !== 'string' || !modelId.trim()) return null;
  let cheap = null;
  try {
    // eslint-disable-next-line global-require
    cheap = require('./engine-models').CHEAP_MODEL;
  } catch {
    cheap = null;
  }
  return modelId === cheap ? 'standard' : 'deep';
}

/**
 * Count blocking findings the same way the gate does (one definition —
 * gate-verdict.js). Returns 0 when the result has no finding registry.
 */
function countBlockingFindings(scanResult) {
  if (!scanResult || typeof scanResult !== 'object') return 0;
  try {
    // eslint-disable-next-line global-require
    const { computeGateVerdict } = require('./gate-verdict');
    const verdict = computeGateVerdict(scanResult, 'advisory');
    return nonNegInt(verdict && verdict.blocking);
  } catch {
    return 0;
  }
}

/**
 * Sum what a hosted scan's modules report about their own AI usage.
 * Deterministic scans have no module with a cost → { aiCalls: 0, … }.
 */
function aiTotalsFromModules(modules) {
  const out = { aiCalls: 0, tokensIn: 0, tokensOut: 0, usd: 0 };
  if (!Array.isArray(modules)) return out;
  for (const m of modules) {
    if (!m || typeof m !== 'object') continue;
    const usd = nonNegNumber(m.costUsd);
    const tin = nonNegInt(m.tokensIn);
    const tout = nonNegInt(m.tokensOut);
    if (usd > 0 || tin > 0 || tout > 0) {
      out.aiCalls += nonNegInt(m.aiCalls) || 1;
      out.tokensIn += tin;
      out.tokensOut += tout;
      out.usd += usd;
    }
  }
  return out;
}

/**
 * Validate + coerce a usage event into the row shape. Throws on a missing
 * identity or an unknown surface — those are programming errors at the
 * call site, and the best-effort writer turns them into one warning.
 */
function normalizeUsageEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('usage event is required');
  const accountKey = typeof event.accountKey === 'string' ? event.accountKey.trim() : '';
  if (!accountKey) throw new Error('accountKey is required');
  const surface = typeof event.surface === 'string' ? event.surface.trim().toLowerCase() : '';
  if (!SURFACES.includes(surface)) throw new Error(`invalid surface: ${event.surface}`);
  const keyOwner = event.keyOwner === 'byok' || event.byok === true ? 'byok' : 'gatetest';
  let occurredAt = null;
  if (event.occurredAt instanceof Date && !Number.isNaN(event.occurredAt.getTime())) {
    occurredAt = event.occurredAt.toISOString();
  } else if (typeof event.occurredAt === 'string' && !Number.isNaN(Date.parse(event.occurredAt))) {
    occurredAt = new Date(event.occurredAt).toISOString();
  }
  return {
    occurred_at: occurredAt,
    account_key: accountKey.slice(0, 160),
    surface,
    repo: redactRepo(event.repo),
    suite: textOrNull(event.suite, 40),
    modules_run: nonNegInt(event.modulesRun),
    findings_total: nonNegInt(event.findingsTotal),
    findings_blocking: nonNegInt(event.findingsBlocking),
    ai_calls: nonNegInt(event.aiCalls),
    tokens_in: nonNegInt(event.tokensIn),
    tokens_out: nonNegInt(event.tokensOut),
    usd_estimated: Number(nonNegNumber(event.usdEstimated).toFixed(6)),
    key_owner: KEY_OWNERS.includes(keyOwner) ? keyOwner : 'gatetest',
    model_tier: textOrNull(event.modelTier, 40),
    scan_id: textOrNull(event.scanId, 80),
    tier: textOrNull(event.tier, 40),
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

async function ensureSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS usage_events (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    account_key TEXT NOT NULL,
    surface TEXT NOT NULL,
    repo TEXT,
    suite TEXT,
    modules_run INTEGER NOT NULL DEFAULT 0,
    findings_total INTEGER NOT NULL DEFAULT 0,
    findings_blocking INTEGER NOT NULL DEFAULT 0,
    ai_calls INTEGER NOT NULL DEFAULT 0,
    tokens_in BIGINT NOT NULL DEFAULT 0,
    tokens_out BIGINT NOT NULL DEFAULT 0,
    usd_estimated DOUBLE PRECISION NOT NULL DEFAULT 0,
    key_owner TEXT NOT NULL DEFAULT 'gatetest',
    model_tier TEXT,
    scan_id TEXT,
    tier TEXT
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_usage_events_account_time
    ON usage_events (account_key, occurred_at DESC)`;
  // Safe migration slot: add columns here with ADD COLUMN IF NOT EXISTS
  // (idempotent) when the row shape grows — never edit the CREATE above.
  await sql`ALTER TABLE usage_events
    ADD COLUMN IF NOT EXISTS model_tier TEXT`;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Append one usage event.
 * @returns {Promise<{ id: number|null }>}
 */
async function recordUsage(sql, event) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  const row = normalizeUsageEvent(event);
  await ensureSchema(sql);
  const rows = await sql`INSERT INTO usage_events
      (occurred_at, account_key, surface, repo, suite, modules_run, findings_total, findings_blocking,
       ai_calls, tokens_in, tokens_out, usd_estimated, key_owner, model_tier, scan_id, tier)
    VALUES
      (COALESCE(${row.occurred_at}::timestamptz, NOW()), ${row.account_key}, ${row.surface}, ${row.repo}, ${row.suite},
       ${row.modules_run}, ${row.findings_total}, ${row.findings_blocking},
       ${row.ai_calls}, ${row.tokens_in}, ${row.tokens_out}, ${row.usd_estimated},
       ${row.key_owner}, ${row.model_tier}, ${row.scan_id}, ${row.tier})
    RETURNING id`;
  return { id: rows && rows[0] ? rows[0].id : null };
}

/**
 * Best-effort writer for request paths. Never throws. Returns the inserted
 * id, or null when the database is not configured or the write failed (one
 * console.warn, no rethrow — the customer's scan/fix must not depend on it).
 *
 * @param {object} event   see normalizeUsageEvent
 * @param {{ sql?: Function }} [opts]  test hook — inject a tagged-template
 */
async function recordUsageIfConfigured(event, opts = {}) {
  let sql = opts.sql;
  try {
    if (!sql) {
      if (!process.env.DATABASE_URL) return null;
      // eslint-disable-next-line global-require
      const { neon } = require('@neondatabase/serverless');
      sql = neon(process.env.DATABASE_URL);
    }
    const out = await recordUsage(sql, event);
    return out.id;
  } catch (err) { // error-ok — the ledger is observability, never the customer's critical path
    console.warn('[usage-ledger] recordUsage failed (continuing):', err && err.message ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Parse `from` / `to` query params (ISO dates). Defaults to the last 30
 * days ending now; `to` is exclusive-ish (end of that instant). Rejects
 * garbage and inverted or oversized windows.
 *
 * @param {{ get: (k: string) => string|null }|Record<string,string>|null} params
 * @param {Date} [now]
 * @returns {{ ok: true, from: Date, to: Date } | { ok: false, error: string }}
 */
function parseUsageWindow(params, now = new Date()) {
  const read = (k) => {
    if (!params) return null;
    if (typeof params.get === 'function') return params.get(k);
    return Object.prototype.hasOwnProperty.call(params, k) ? params[k] : null;
  };
  const rawFrom = read('from');
  const rawTo = read('to');
  let to = now;
  if (rawTo) {
    const t = Date.parse(rawTo);
    if (Number.isNaN(t)) return { ok: false, error: 'to must be an ISO-8601 date' };
    to = new Date(t);
    // A bare date means the whole of that day.
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawTo.trim())) to = new Date(t + 24 * 60 * 60 * 1000 - 1);
  }
  let from;
  if (rawFrom) {
    const f = Date.parse(rawFrom);
    if (Number.isNaN(f)) return { ok: false, error: 'from must be an ISO-8601 date' };
    from = new Date(f);
  } else {
    from = new Date(startOfUtcDay(to).getTime() - (DEFAULT_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000);
  }
  if (from.getTime() > to.getTime()) return { ok: false, error: 'from must not be after to' };
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    return { ok: false, error: `window must be ${MAX_WINDOW_DAYS} days or fewer` };
  }
  return { ok: true, from, to };
}

function emptyTotals() {
  return {
    events: 0,
    scans: 0,
    fixes: 0,
    modulesRun: 0,
    findingsTotal: 0,
    findingsBlocking: 0,
    aiCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    usdEstimated: 0,
    usdGatetestPaid: 0,
    usdByok: 0,
    byokEvents: 0,
  };
}

function round6(n) {
  return Number((Number(n) || 0).toFixed(6));
}

/**
 * Pure aggregation. Accepts raw usage_events rows OR partially grouped rows
 * (a row may carry `events` = how many events it stands for; default 1).
 * Sums are additive so both shapes produce the same answer.
 *
 * @param {Array<object>} rows
 * @param {{ from: Date, to: Date }} window   series is gap-filled per UTC day
 * @returns {{ totals: object, bySurface: object, series: Array<object> }}
 */
function aggregateUsageRows(rows, window) {
  const totals = emptyTotals();
  const bySurface = {};
  const byDay = new Map();

  const list = Array.isArray(rows) ? rows : [];
  for (const r of list) {
    if (!r) continue;
    const events = r.events != null ? nonNegInt(r.events) : 1;
    const surface = typeof r.surface === 'string' ? r.surface : 'unknown';
    const byok = r.key_owner === 'byok';
    const tin = nonNegInt(r.tokens_in);
    const tout = nonNegInt(r.tokens_out);
    const usd = nonNegNumber(r.usd_estimated);
    const ai = nonNegInt(r.ai_calls);
    const mods = nonNegInt(r.modules_run);
    const ft = nonNegInt(r.findings_total);
    const fb = nonNegInt(r.findings_blocking);

    totals.events += events;
    if (surface === 'hosted-fix') totals.fixes += events; else totals.scans += events;
    totals.modulesRun += mods;
    totals.findingsTotal += ft;
    totals.findingsBlocking += fb;
    totals.aiCalls += ai;
    totals.tokensIn += tin;
    totals.tokensOut += tout;
    totals.usdEstimated += usd;
    if (byok) { totals.usdByok += usd; totals.byokEvents += events; } else { totals.usdGatetestPaid += usd; }

    const s = bySurface[surface] || (bySurface[surface] = {
      events: 0, modulesRun: 0, findingsTotal: 0, findingsBlocking: 0, aiCalls: 0,
      tokensIn: 0, tokensOut: 0, usdEstimated: 0, usdByok: 0, byokEvents: 0,
    });
    s.events += events;
    s.modulesRun += mods;
    s.findingsTotal += ft;
    s.findingsBlocking += fb;
    s.aiCalls += ai;
    s.tokensIn += tin;
    s.tokensOut += tout;
    s.usdEstimated += usd;
    if (byok) { s.usdByok += usd; s.byokEvents += events; }

    let day = typeof r.day === 'string' ? r.day.slice(0, 10) : null;
    if (!day && r.occurred_at) {
      const t = r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at);
      if (!Number.isNaN(t.getTime())) day = dayKey(t);
    }
    if (day) {
      const d = byDay.get(day) || { day, events: 0, aiCalls: 0, tokensIn: 0, tokensOut: 0, usdEstimated: 0, findingsTotal: 0 };
      d.events += events;
      d.aiCalls += ai;
      d.tokensIn += tin;
      d.tokensOut += tout;
      d.usdEstimated += usd;
      d.findingsTotal += ft;
      byDay.set(day, d);
    }
  }

  totals.tokensTotal = totals.tokensIn + totals.tokensOut;
  totals.usdEstimated = round6(totals.usdEstimated);
  totals.usdGatetestPaid = round6(totals.usdGatetestPaid);
  totals.usdByok = round6(totals.usdByok);
  for (const s of Object.values(bySurface)) {
    s.usdEstimated = round6(s.usdEstimated);
    s.usdByok = round6(s.usdByok);
  }

  // Gap-fill the series across the window so a chart never hides a quiet day.
  const series = [];
  if (window && window.from instanceof Date && window.to instanceof Date) {
    const start = startOfUtcDay(window.from);
    const end = startOfUtcDay(window.to);
    for (let t = start.getTime(); t <= end.getTime() && series.length <= MAX_WINDOW_DAYS; t += 24 * 60 * 60 * 1000) {
      const key = dayKey(new Date(t));
      const d = byDay.get(key);
      series.push(d
        ? { ...d, usdEstimated: round6(d.usdEstimated) }
        : { day: key, events: 0, aiCalls: 0, tokensIn: 0, tokensOut: 0, usdEstimated: 0, findingsTotal: 0 });
    }
  } else {
    for (const d of [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1))) {
      series.push({ ...d, usdEstimated: round6(d.usdEstimated) });
    }
  }

  return { totals, bySurface, series };
}

/**
 * Totals + per-surface breakdown + per-day series for one customer over a
 * window. One grouped query (day × surface × key_owner), aggregated in JS.
 *
 * @param {Function} sql
 * @param {string|string[]} accountKey   every key the caller owns
 * @param {{ from?: Date, to?: Date }} [opts]
 */
async function summarizeUsage(sql, accountKey, opts = {}) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  const keys = normaliseAccountKeys(accountKey);
  const window = resolveWindow(opts);
  await ensureSchema(sql);
  const rows = await sql`SELECT
      to_char(date_trunc('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
      surface,
      key_owner,
      COUNT(*)::int AS events,
      COALESCE(SUM(modules_run), 0)::bigint AS modules_run,
      COALESCE(SUM(findings_total), 0)::bigint AS findings_total,
      COALESCE(SUM(findings_blocking), 0)::bigint AS findings_blocking,
      COALESCE(SUM(ai_calls), 0)::bigint AS ai_calls,
      COALESCE(SUM(tokens_in), 0)::bigint AS tokens_in,
      COALESCE(SUM(tokens_out), 0)::bigint AS tokens_out,
      COALESCE(SUM(usd_estimated), 0)::double precision AS usd_estimated
    FROM usage_events
    WHERE account_key = ANY(${keys})
      AND occurred_at >= ${window.from.toISOString()}
      AND occurred_at <= ${window.to.toISOString()}
    GROUP BY 1, 2, 3
    ORDER BY 1 ASC`;
  const agg = aggregateUsageRows(rows || [], window);
  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    totals: agg.totals,
    bySurface: agg.bySurface,
    series: agg.series,
  };
}

function resolveWindow(opts) {
  const to = opts.to instanceof Date && !Number.isNaN(opts.to.getTime()) ? opts.to : new Date();
  const from = opts.from instanceof Date && !Number.isNaN(opts.from.getTime())
    ? opts.from
    : new Date(startOfUtcDay(to).getTime() - (DEFAULT_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000);
  return { from, to };
}

function publicRow(r) {
  return {
    id: r.id != null ? Number(r.id) : null,
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at || null,
    surface: r.surface,
    repo: r.repo || null,
    suite: r.suite || null,
    tier: r.tier || null,
    scanId: r.scan_id || null,
    modulesRun: nonNegInt(r.modules_run),
    findingsTotal: nonNegInt(r.findings_total),
    findingsBlocking: nonNegInt(r.findings_blocking),
    aiCalls: nonNegInt(r.ai_calls),
    tokensIn: nonNegInt(r.tokens_in),
    tokensOut: nonNegInt(r.tokens_out),
    usdEstimated: round6(r.usd_estimated),
    keyOwner: r.key_owner === 'byok' ? 'byok' : 'gatetest',
    modelTier: r.model_tier || null,
  };
}

/**
 * Newest-first page of one customer's events. Keyset pagination on id:
 * `cursor` is the id to continue BELOW; `nextCursor` is null on the last
 * page. Fetches limit+1 to know whether another page exists.
 *
 * @param {Function} sql
 * @param {string|string[]} accountKey
 * @param {{ limit?: number, cursor?: number|string|null, from?: Date, to?: Date }} [opts]
 * @returns {Promise<{ events: Array<object>, nextCursor: number|null }>}
 */
async function listUsage(sql, accountKey, opts = {}) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  const keys = normaliseAccountKeys(accountKey);
  const requested = Number(opts.limit);
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), MAX_LIST_LIMIT)
    : DEFAULT_LIST_LIMIT;
  const cursorNum = opts.cursor != null && opts.cursor !== '' ? Number(opts.cursor) : null;
  const cursor = Number.isFinite(cursorNum) && cursorNum > 0 ? Math.floor(cursorNum) : null;
  const fetchN = limit + 1;
  await ensureSchema(sql);
  const hasWindow = opts.from instanceof Date || opts.to instanceof Date;
  const window = hasWindow ? resolveWindow(opts) : null;
  const fromIso = window ? window.from.toISOString() : null;
  const toIso = window ? window.to.toISOString() : null;
  const rows = cursor === null
    ? await sql`SELECT id, occurred_at, account_key, surface, repo, suite, modules_run, findings_total,
          findings_blocking, ai_calls, tokens_in, tokens_out, usd_estimated, key_owner, model_tier, scan_id, tier
        FROM usage_events
        WHERE account_key = ANY(${keys})
          AND (${fromIso}::timestamptz IS NULL OR occurred_at >= ${fromIso}::timestamptz)
          AND (${toIso}::timestamptz IS NULL OR occurred_at <= ${toIso}::timestamptz)
        ORDER BY id DESC
        LIMIT ${fetchN}`
    : await sql`SELECT id, occurred_at, account_key, surface, repo, suite, modules_run, findings_total,
          findings_blocking, ai_calls, tokens_in, tokens_out, usd_estimated, key_owner, model_tier, scan_id, tier
        FROM usage_events
        WHERE account_key = ANY(${keys})
          AND id < ${cursor}
          AND (${fromIso}::timestamptz IS NULL OR occurred_at >= ${fromIso}::timestamptz)
          AND (${toIso}::timestamptz IS NULL OR occurred_at <= ${toIso}::timestamptz)
        ORDER BY id DESC
        LIMIT ${fetchN}`;
  const list = Array.isArray(rows) ? rows : [];
  const page = list.slice(0, limit);
  const nextCursor = list.length > limit && page.length > 0 ? Number(page[page.length - 1].id) : null;
  return { events: page.map(publicRow), nextCursor };
}

/**
 * The GET /api/v1/usage payload: `{ summary, series, bySurface, recent }`.
 */
async function buildUsageReport(sql, accountKey, opts = {}) {
  const summary = await summarizeUsage(sql, accountKey, opts);
  const recentLimit = Number.isFinite(Number(opts.recentLimit)) && Number(opts.recentLimit) > 0
    ? Math.min(Math.floor(Number(opts.recentLimit)), MAX_LIST_LIMIT)
    : DEFAULT_RECENT_LIMIT;
  const window = resolveWindow(opts);
  const recent = await listUsage(sql, accountKey, { limit: recentLimit, from: window.from, to: window.to });
  return {
    summary: { window: summary.window, ...summary.totals },
    series: summary.series,
    bySurface: summary.bySurface,
    recent: recent.events,
    nextCursor: recent.nextCursor,
  };
}

/**
 * Route logic for GET /api/v1/usage, framework-free so it is unit-testable.
 * The Next route authenticates with the same helper /api/v1/scans uses and
 * hands the result here.
 *
 * @param {{
 *   auth: { ok: true, key: { id: string, customer_email?: string|null } } | { ok: false, status: number, error: string },
 *   searchParams: { get: (k: string) => string|null } | Record<string,string> | null,
 *   getSql: () => Function,
 *   now?: Date,
 * }} args
 * @returns {Promise<{ status: number, body: object }>}
 */
async function handleUsageRequest({ auth, searchParams, getSql, now = new Date() }) {
  if (!auth || auth.ok !== true) {
    return {
      status: (auth && Number.isInteger(auth.status) && auth.status >= 400) ? auth.status : 401,
      body: { error: (auth && auth.error) || 'Missing API key — pass Authorization: Bearer <key> or X-API-Key header', code: 'AUTH_FAILED' },
    };
  }
  const window = parseUsageWindow(searchParams, now);
  if (!window.ok) return { status: 400, body: { error: window.error, code: 'BAD_REQUEST' } };
  const keys = accountKeysForApiKey(auth.key);
  if (keys.length === 0) {
    return { status: 403, body: { error: 'This API key is not linked to an account', code: 'NO_ACCOUNT' } };
  }
  let sql;
  try {
    sql = getSql();
  } catch (err) {
    return { status: 503, body: { error: err && err.message ? err.message : 'database not configured', code: 'DB_UNAVAILABLE' } };
  }
  const report = await buildUsageReport(sql, keys, { from: window.from, to: window.to });
  return { status: 200, body: report };
}

module.exports = {
  SURFACES,
  KEY_OWNERS,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  accountKeyForEmail,
  resolveAccountKey,
  accountKeysForApiKey,
  redactRepo,
  modelTierFor,
  countBlockingFindings,
  aiTotalsFromModules,
  normalizeUsageEvent,
  ensureSchema,
  recordUsage,
  recordUsageIfConfigured,
  parseUsageWindow,
  aggregateUsageRows,
  summarizeUsage,
  listUsage,
  buildUsageReport,
  handleUsageRequest,
};
