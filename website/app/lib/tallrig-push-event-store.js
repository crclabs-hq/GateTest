/**
 * Persistence for Tallrig's signed push events — see
 * website/app/api/integrations/tallrig/events/route.ts for the wire contract
 * (issue #672).
 *
 * Every other operational ledger in this codebase (audit-log-store,
 * dissent-store, scan-queue-store, ...) is Postgres-backed via a DI'd `sql`
 * tagged-template, because Vercel's serverless filesystem is otherwise
 * ephemeral. Push events don't fit that shape: `/api/status` only reports
 * config readiness (booleans + env var names, no events) and
 * platform-siblings.js is a health-polling registry, not an event log —
 * neither is a home for "the last 500 things Tallrig told us". Per the
 * issue spec, this is the documented fallback: a small JSON-lines file
 * under the app's data directory (website/app/data/, the same directory
 * digest-mailer.js and public-status.js already read runtime/generated
 * JSON from), capped at 500 events, oldest dropped first.
 *
 * Same DI shape as hn-reply-assistant/queue-store.js: every function takes
 * an injectable `_fs` (defaults to node:fs) so tests run against an
 * in-memory fake instead of touching disk.
 *
 * Idempotency: dedupe key is the event's own id when the payload carries
 * one, else sha256(rawBody) — so a Tallrig retry (three attempts before
 * dead-letter) never double-records.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE_NAME = 'tallrig-push-events.jsonl';
const MAX_EVENTS = 500;

function eventsFilePath(dataDir) {
  return path.join(dataDir || DATA_DIR, FILE_NAME);
}

/** Dedupe key: the payload's own event id when present, else a body hash. */
function dedupeKeyFor(payload, rawBody) {
  const id =
    payload && typeof payload === 'object'
      ? payload.id || payload.eventId || payload.event_id
      : null;
  if (id != null && String(id).trim()) return `id:${String(id).trim()}`;
  return `sha256:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
}

/** Best-effort field extraction — Tallrig's exact payload shape may nest
 * fields under `data`; this reads either top-level or `data.<field>` so a
 * reasonable variation in shape doesn't silently lose the sha/shaSource. */
function firstOf(payload, keys) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const data = p.data && typeof p.data === 'object' ? p.data : {};
  for (const key of keys) {
    if (p[key] !== undefined && p[key] !== null) return p[key];
    if (data[key] !== undefined && data[key] !== null) return data[key];
  }
  return null;
}

function readAll({ dataDir, _fs = fs } = {}) {
  const file = eventsFilePath(dataDir);
  if (!_fs.existsSync(file)) return [];
  const raw = _fs.readFileSync(file, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null; // a corrupted line is skipped, never fatal
      }
    })
    .filter(Boolean);
}

function writeAll(events, { dataDir, _fs = fs } = {}) {
  const dir = dataDir || DATA_DIR;
  if (!_fs.existsSync(dir)) _fs.mkdirSync(dir, { recursive: true });
  const file = eventsFilePath(dataDir);
  const body = events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
  _fs.writeFileSync(file, body, 'utf8');
}

/**
 * Append one verified push event, deduped on event id (or body hash),
 * capped at MAX_EVENTS (oldest dropped first).
 *
 * @param {object} opts
 * @param {string} opts.rawBody          the raw request body (unparsed)
 * @param {object} opts.payload          JSON.parse(rawBody), or {} if unparsable
 * @param {string|null} opts.keyId       X-Tallrig-Key-Id header value
 * @param {string} [opts.dataDir]        override for tests
 * @param {object} [opts._fs]            injectable fs for tests
 * @returns {{ stored: boolean, event: object }} stored=false means this
 *   event id (or body hash) was already recorded — the retry was a no-op.
 */
function appendEvent(opts) {
  const { rawBody, payload, keyId = null, dataDir, _fs = fs } = opts;
  const events = readAll({ dataDir, _fs });
  const dedupeKey = dedupeKeyFor(payload, rawBody);

  const existing = events.find((e) => e.dedupeKey === dedupeKey);
  if (existing) return { stored: false, event: existing };

  const type = firstOf(payload, ['type', 'event']);
  const record = {
    dedupeKey,
    type: typeof type === 'string' ? type : null,
    keyId: typeof keyId === 'string' ? keyId : null,
    sha: (() => {
      const v = firstOf(payload, ['sha']);
      return typeof v === 'string' ? v : null;
    })(),
    shaSource: (() => {
      const v = firstOf(payload, ['shaSource']);
      return typeof v === 'string' ? v : null;
    })(),
    name: (() => {
      const v = firstOf(payload, ['name']);
      return typeof v === 'string' ? v : null;
    })(),
    receivedAt: new Date().toISOString(),
  };

  const next = events.concat(record);
  const capped = next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
  writeAll(capped, { dataDir, _fs });
  return { stored: true, event: record };
}

/** The most recent `limit` events, newest first — for the admin list. */
function listRecent(limit = 50, opts = {}) {
  const events = readAll(opts);
  return events.slice(-limit).reverse();
}

/**
 * The most recent `deploy.finished` event that carried a sha, shaped for
 * /api/platform-status's `lastTallrigDeploy` field. Returns null if none
 * has ever been recorded (or none of them had a sha).
 */
function lastTallrigDeploy(opts = {}) {
  const events = readAll(opts);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type === 'deploy.finished' && e.sha) {
      return { sha: e.sha, shaSource: e.shaSource || null, at: e.receivedAt };
    }
  }
  return null;
}

module.exports = {
  MAX_EVENTS,
  DATA_DIR,
  eventsFilePath,
  dedupeKeyFor,
  appendEvent,
  listRecent,
  lastTallrigDeploy,
};
