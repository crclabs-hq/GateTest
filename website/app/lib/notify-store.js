'use strict';
/**
 * Notify-me store — email capture for not-yet-launched features
 * (first consumer: the "Penetration Testing — coming soon" section,
 * Craig 2026-07-14).
 *
 *   notify_signups(
 *     id         BIGSERIAL PRIMARY KEY,
 *     email      TEXT NOT NULL,
 *     topic      TEXT NOT NULL,            -- e.g. 'pentest'
 *     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     UNIQUE (email, topic)
 *   )
 *
 * Same conventions as mcp-subscription-store.js: the caller injects the
 * Neon tagged-template `sql` so unit tests run against a recorder. Every
 * helper is serverless-safe (single queries, no state).
 */

/** Topics we accept signups for. Add here when a new waitlist opens. */
const VALID_TOPICS = new Set(['pentest']);

const MAX_EMAIL_LENGTH = 254; // RFC 5321 upper bound

/**
 * Minimal, strict-enough email shape check: one @, no whitespace,
 * a dot in the domain. Deliverability is confirmed by the launch
 * email itself — this only keeps garbage out of the table.
 */
function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > MAX_EMAIL_LENGTH) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed);
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

async function ensureSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS notify_signups (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    topic TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (email, topic)
  )`;
}

/**
 * Record a signup. Idempotent on (email, topic) — signing up twice is a
 * no-op, never an error. Returns { ok, alreadySignedUp } or throws on
 * invalid input (callers validate first; this is the backstop).
 */
async function addSignup(sql, opts) {
  const { email, topic } = opts || {};
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!isValidEmail(email)) throw new Error('invalid email');
  if (!VALID_TOPICS.has(topic)) throw new Error(`invalid topic: ${topic}`);
  await ensureSchema(sql);
  const rows = await sql`INSERT INTO notify_signups (email, topic)
    VALUES (${normalizeEmail(email)}, ${topic})
    ON CONFLICT (email, topic) DO NOTHING
    RETURNING id`;
  return { ok: true, alreadySignedUp: !(rows && rows[0]) };
}

/** All signups for a topic, oldest first — for the launch-day export. */
async function listSignups(sql, topic) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!VALID_TOPICS.has(topic)) throw new Error(`invalid topic: ${topic}`);
  await ensureSchema(sql);
  const rows = await sql`SELECT email, created_at FROM notify_signups
    WHERE topic = ${topic}
    ORDER BY created_at ASC`;
  return rows || [];
}

module.exports = {
  VALID_TOPICS,
  isValidEmail,
  normalizeEmail,
  ensureSchema,
  addSignup,
  listSignups,
};
