/**
 * Feedback-event store — persistence for the two customer feedback loops
 * (POST /api/feedback; read by GET /api/admin/feedback).
 *
 *   feedback_events(
 *     id             BIGSERIAL PRIMARY KEY,
 *     ts             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     scan_id        TEXT,            -- hosted scan id (scn_… / Stripe session) when known
 *     surface        TEXT NOT NULL,   -- 'repo' | 'web' | 'wp' | 'preview' | 'finding' | …
 *     tier           TEXT,            -- 'quick' | 'full' | 'preview' | 'full-report' | …
 *     rating         TEXT NOT NULL,   -- 'up' | 'down'
 *     rule           TEXT,            -- finding surface only: module or module:rule
 *     text           TEXT,            -- REDACTED free text, ≤ 1000 chars (feedback-redact.js)
 *     page           TEXT,            -- path the customer was on (no query string)
 *     ip             TEXT,            -- per-IP rate limiting + abuse review
 *     escalated      BOOLEAN NOT NULL DEFAULT FALSE,
 *     issue_number   INTEGER,         -- GitHub issue opened or commented on
 *     escalation_ref TEXT             -- html_url of that issue / comment
 *   )
 *
 * Same conventions as continuous-subscription-store.js: the caller injects
 * the Neon tagged-template `sql`, every helper is a single query or two,
 * and nothing is held between requests (Bible: no in-memory state).
 *
 * The rate limit is Postgres-backed on purpose. lib/rate-limit.js keeps a
 * per-instance bucket and accepts a `dbBackedFn`; `countRecentByIp` is that
 * function, counting the rows this table already holds — so a burst spread
 * over cold starts is still counted, and no second table is needed.
 */

'use strict';

const FEEDBACK_WINDOW_MS = 60_000;

async function ensureFeedbackSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS feedback_events (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scan_id TEXT,
    surface TEXT NOT NULL,
    tier TEXT,
    rating TEXT NOT NULL,
    rule TEXT,
    text TEXT,
    page TEXT,
    ip TEXT,
    escalated BOOLEAN NOT NULL DEFAULT FALSE,
    issue_number INTEGER,
    escalation_ref TEXT
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_feedback_events_ts ON feedback_events (ts DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_feedback_events_ip_ts ON feedback_events (ip, ts DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_feedback_events_rule_ts ON feedback_events (rule, ts DESC)`;
}

/**
 * Insert one validated, already-redacted event. Returns the new row id.
 *
 * @param {Function} sql
 * @param {{ surface: string, rating: string, tier?: string|null, scanId?: string|null,
 *           rule?: string|null, text?: string|null, page?: string|null, ip?: string|null }} event
 */
async function recordFeedback(sql, event) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!event || !event.surface || !event.rating) throw new Error('surface and rating are required');
  await ensureFeedbackSchema(sql);
  const rows = await sql`INSERT INTO feedback_events
      (scan_id, surface, tier, rating, rule, text, page, ip)
    VALUES (${event.scanId || null}, ${event.surface}, ${event.tier || null}, ${event.rating},
            ${event.rule || null}, ${event.text || null}, ${event.page || null}, ${event.ip || null})
    RETURNING id`;
  return rows[0] ? String(rows[0].id) : null;
}

/** Stamp the escalation outcome onto the row it belongs to. */
async function markEscalated(sql, id, { issueNumber, ref }) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!id) return false;
  await sql`UPDATE feedback_events
    SET escalated = TRUE, issue_number = ${issueNumber || null}, escalation_ref = ${ref || null}
    WHERE id = ${id}`;
  return true;
}

/**
 * The `dbBackedFn` for lib/rate-limit.js: how many feedback rows this IP
 * wrote inside the window, counting the request in flight. `ttl` is the
 * time until the oldest counted row leaves the window.
 *
 * @returns {Promise<{ count: number, ttl: number }>}
 */
async function countRecentByIp(sql, ip, windowMs = FEEDBACK_WINDOW_MS) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  const since = new Date(Date.now() - windowMs).toISOString();
  const rows = await sql`SELECT COUNT(*)::int AS n, MIN(ts) AS oldest
    FROM feedback_events WHERE ip = ${ip || 'unknown'} AND ts >= ${since}`;
  const n = rows[0] && Number.isFinite(Number(rows[0].n)) ? Number(rows[0].n) : 0;
  const oldest = rows[0] && rows[0].oldest ? new Date(rows[0].oldest).getTime() : NaN;
  const ttl = Number.isFinite(oldest) ? Math.max(0, windowMs - (Date.now() - oldest)) : windowMs;
  return { count: n + 1, ttl };
}

/**
 * The most recent escalated row for a rule inside `days` — the candidate
 * open issue a second "this finding is wrong" click should comment on
 * instead of opening a duplicate. Null when none.
 *
 * @returns {Promise<{ issueNumber: number, ref: string|null } | null>}
 */
async function findRecentEscalation(sql, rule, days = 7) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!rule) return null;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await sql`SELECT issue_number, escalation_ref FROM feedback_events
    WHERE rule = ${rule} AND issue_number IS NOT NULL AND ts >= ${since}
    ORDER BY ts DESC LIMIT 1`;
  const row = rows[0];
  if (!row || !row.issue_number) return null;
  return { issueNumber: Number(row.issue_number), ref: row.escalation_ref || null };
}

/** Last `limit` rows, newest first — the admin triage view. */
async function listRecentFeedback(sql, limit = 200) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  const cap = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
  await ensureFeedbackSchema(sql);
  return sql`SELECT id, ts, scan_id, surface, tier, rating, rule, text, page,
      escalated, issue_number, escalation_ref
    FROM feedback_events ORDER BY ts DESC LIMIT ${cap}`;
}

/**
 * Up / down counts per surface over the last `days`.
 *
 * @returns {Promise<Array<{ surface: string, up: number, down: number }>>}
 */
async function countsBySurface(sql, days) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await sql`SELECT surface,
      COUNT(*) FILTER (WHERE rating = 'up')::int AS up,
      COUNT(*) FILTER (WHERE rating = 'down')::int AS down
    FROM feedback_events WHERE ts >= ${since}
    GROUP BY surface ORDER BY surface`;
  return rows.map((r) => ({ surface: r.surface, up: Number(r.up) || 0, down: Number(r.down) || 0 }));
}

module.exports = {
  FEEDBACK_WINDOW_MS,
  ensureFeedbackSchema,
  recordFeedback,
  markEscalated,
  countRecentByIp,
  findRecentEscalation,
  listRecentFeedback,
  countsBySurface,
};
