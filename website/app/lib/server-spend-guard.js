'use strict';

/**
 * Server-key daily spend guard — Usage Doctrine (CLAUDE.md), Meter 3, rule 9.
 *
 * Every automatic caller that spends OUR Anthropic key (as opposed to a
 * customer's BYOK key) — `/api/heal/sentry-webhook`, `/api/watches/tick`,
 * `/api/chat`, `/api/scan/guidance`, `/api/scan/server-fix` — sits under one
 * daily USD ceiling read from `GATETEST_DAILY_API_BUDGET_USD`. This module is
 * the one definition of that ceiling (Doctrine #4): callers ask
 * `checkServerSpend` before spending and call `recordServerSpend` after a
 * successful call. `/api/scan/fix` is deliberately NOT wired to this guard —
 * it already has its own per-request budget (`budget-tracker.js` /
 * `createTrackerForTier`) which is a different, tighter control.
 *
 * Storage: reuses the existing `usage_events` table (website/app/lib/
 * usage-ledger.js) rather than a new one — no migration needed, every column
 * this module writes already exists. Rows are written under a fixed,
 * non-customer identity (`SERVER_ACCOUNT_KEY`, namespaced `server:`, which
 * `accountKeysForApiKey` never returns) so they are invisible to any
 * customer's own usage dashboard while still going through the ledger's own
 * tested insert (`recordUsage`) and aggregation (`summarizeUsage`) — no new
 * SQL, no second definition of "how usage_events rows are shaped or summed".
 *
 * BYOK requests must never be recorded here (Doctrine #4 — the ceiling
 * protects OUR spend, not the customer's). None of the five wired routes
 * currently accept a customer-supplied Anthropic key, but `recordServerSpend`
 * still takes an `isCustomerKey` flag as a guard-level backstop: passing
 * `true` is a guaranteed no-op, independent of what any call site forgets.
 *
 * Fail-closed rules (never silently spend past a configured ceiling):
 *   - `GATETEST_DAILY_API_BUDGET_USD` unset/empty → guard disabled entirely
 *     (`allowed: true, reason: 'not-configured'`).
 *   - Set but not a positive number → `allowed: false, reason: 'misconfigured'`.
 *   - Set and valid, but no way to read today's spend (no `sql` and no
 *     `DATABASE_URL`, or the ledger query throws) → `allowed: false,
 *     reason: 'ledger-unavailable'`.
 *   - Set, valid, ledger reachable → allowed iff spent-so-far < ceiling.
 */

const {
  recordUsage,
  summarizeUsage,
  modelTierFor,
} = require('./usage-ledger');

// src/core/budget-tracker.js is the engine-side pricing twin — same
// MODEL_PRICING table as website/app/lib/budget-tracker.js
// (tests/budget-tracker-engine-twin.test.js pins them equal), and it already
// exports the exact `usdFor(model, inputTokens, outputTokens)` shape this
// module needs. Requiring across the website/src boundary this direction
// (website -> src/core) is the existing pattern — see e.g.
// website/app/lib/try-fix.js requiring '../../../src/core/shipped-rules'.
const { usdFor } = require('../../../src/core/budget-tracker');

// Never resolves to any customer identity `accountKeysForApiKey` can return
// (those are always `em:`, `apikey:`, `stripe:`, `checkout:`, or `org:`
// prefixed) — so these rows never appear on a customer's own usage report.
const SERVER_ACCOUNT_KEY = 'server:gatetest';

// The usage_events `surface` column is an enum enforced by
// usage-ledger.js's normalizeUsageEvent (SURFACES); this module must not add
// a new value (Doctrine #4 — one definition, and usage-ledger.js's write
// path is off-limits here). 'api' is the closest existing fit — hosted work
// GateTest itself triggered, not a customer-facing scan surface — and which
// value is picked has no effect on correctness: checkServerSpend filters by
// account_key, not surface.
const SERVER_SURFACE = 'api';

function toMicros(usd) {
  const n = Number(usd);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1e6) : 0;
}

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Parse GATETEST_DAILY_API_BUDGET_USD. Empty/unset is "off", not zero. */
function parseCeilingUsd() {
  const raw = process.env.GATETEST_DAILY_API_BUDGET_USD;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { configured: false };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return { configured: true, valid: false };
  return { configured: true, valid: true, usd: n };
}

/** Build a Neon sql client from DATABASE_URL, or null if that isn't possible. */
function tryDefaultSql() {
  if (!process.env.DATABASE_URL) return null;
  try {
    // eslint-disable-next-line global-require
    const { neon } = require('@neondatabase/serverless');
    return neon(process.env.DATABASE_URL);
  } catch {
    return null;
  }
}

/**
 * Check whether a server-key AI call is allowed right now.
 *
 * @param {{ sql?: Function, now?: Date }} [opts]
 * @returns {Promise<{ allowed: boolean, spentMicros: number, ceilingMicros: number|null, reason: string }>}
 */
async function checkServerSpend({ sql, now = new Date() } = {}) {
  const ceiling = parseCeilingUsd();

  if (!ceiling.configured) {
    return { allowed: true, spentMicros: 0, ceilingMicros: null, reason: 'not-configured' };
  }
  if (!ceiling.valid) {
    // Fail closed — an unparsable ceiling must not be read as "no ceiling".
    return { allowed: false, spentMicros: 0, ceilingMicros: null, reason: 'misconfigured' };
  }

  const ceilingMicros = toMicros(ceiling.usd);
  const dbSql = sql || tryDefaultSql();
  if (!dbSql) {
    return { allowed: false, spentMicros: 0, ceilingMicros, reason: 'ledger-unavailable' };
  }

  let spentMicros;
  try {
    const from = startOfUtcDay(now);
    const summary = await summarizeUsage(dbSql, SERVER_ACCOUNT_KEY, { from, to: now });
    spentMicros = toMicros(summary.totals.usdEstimated);
  } catch (err) {
    // error-ok — can't prove we're under the ceiling, so fail closed rather
    // than silently letting spend continue (Forbidden #16).
    console.warn('[server-spend-guard] checkServerSpend: ledger query failed (failing closed):', err && err.message ? err.message : err);
    return { allowed: false, spentMicros: 0, ceilingMicros, reason: 'ledger-unavailable' };
  }

  const allowed = spentMicros < ceilingMicros;
  return { allowed, spentMicros, ceilingMicros, reason: allowed ? 'ok' : 'daily-budget-reached' };
}

/**
 * Record one server-key AI call against today's ceiling. Best-effort and
 * never throws — a ledger outage must not fail the response that already
 * succeeded (same contract as usage-ledger's recordUsageIfConfigured).
 *
 * @param {{
 *   sql?: Function,
 *   route: string,
 *   model: string,
 *   inputTokens: number,
 *   outputTokens: number,
 *   now?: Date,
 *   isCustomerKey?: boolean,
 * }} opts
 * @returns {Promise<{ recorded: boolean, reason?: string, id?: number|null, usdEstimated?: number }>}
 */
async function recordServerSpend({
  sql,
  route,
  model,
  inputTokens,
  outputTokens,
  now = new Date(),
  isCustomerKey = false,
} = {}) {
  // Guard-level backstop: a BYOK call must never count against OUR ceiling,
  // regardless of what any call site does or forgets (Doctrine #4).
  if (isCustomerKey) return { recorded: false, reason: 'byok' };

  const dbSql = sql || tryDefaultSql();
  if (!dbSql) return { recorded: false, reason: 'ledger-unavailable' };

  const inTok = Number(inputTokens) > 0 ? Math.round(Number(inputTokens)) : 0;
  const outTok = Number(outputTokens) > 0 ? Math.round(Number(outputTokens)) : 0;
  const usdEstimated = usdFor(model, inTok, outTok);

  try {
    const { id } = await recordUsage(dbSql, {
      accountKey: SERVER_ACCOUNT_KEY,
      surface: SERVER_SURFACE,
      suite: typeof route === 'string' && route.trim() ? route.trim().slice(0, 40) : null,
      aiCalls: 1,
      tokensIn: inTok,
      tokensOut: outTok,
      usdEstimated,
      keyOwner: 'gatetest',
      modelTier: modelTierFor(model),
      occurredAt: now,
    });
    return { recorded: true, id, usdEstimated };
  } catch (err) {
    // error-ok — observability write only; the AI call already happened and
    // already returned to the customer, so this must never throw upward.
    console.warn('[server-spend-guard] recordServerSpend: write failed (continuing):', err && err.message ? err.message : err);
    return { recorded: false, reason: 'write-failed' };
  }
}

module.exports = {
  SERVER_ACCOUNT_KEY,
  checkServerSpend,
  recordServerSpend,
};
