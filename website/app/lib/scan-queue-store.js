/**
 * Signal Bus E1 — scan_queue persistence helper.
 *
 * The queue table backs the async push-event pipeline from Gluecron.
 * Rows are INSERTed by /api/events/push (inbound HMAC'd webhook) and
 * claimed by the cron-driven consumer at /api/scan/worker/tick.
 * event_id is the caller-supplied idempotency key.
 *
 * Storage: the existing Neon Postgres database (no new service dependency).
 * Serverless rules: no in-memory state, function-scoped only. Every helper
 * receives the sql tagged-template so the caller (route handler or test)
 * decides where the connection comes from. Mirrors the design of
 * installation-store.js.
 *
 * Status lifecycle:
 *   queued      → claimed by claimNextJob (→ running, started_at stamped)
 *   running     → markDone / markFailed / markNotChecked / reclaimStuck
 *   done        → terminal (result_json retained for debugging / audit)
 *   failed      → terminal-but-retryable if attempts < 5
 *   dead        → terminal; exceeded retry budget, error callback sent
 *   not_checked → terminal; the worker COULD NOT execute the row honestly
 *                 (e.g. an `api`-host bare-URL scan needing an unconfigured
 *                 browser runtime, KI #111/#113 Phase 2) — Doctrine #1's
 *                 third state. Never 'done' with zero findings, which would
 *                 read to the customer as "scanned clean".
 */

const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_SECONDS = [30, 120, 300, 900, 1800]; // 30s, 2m, 5m, 15m, 30m

/**
 * Where a queue row came from — the ONE definition (Doctrine #4).
 *
 *   gluecron — Signal Bus push event (/api/events/push). The default when a
 *              caller passes no host, because that was the queue's only
 *              producer when the column was added.
 *   github   — GitHub App webhook (/api/webhook) or install onboarding.
 *   api      — public REST API (/api/v1/scans), attributed by API key.
 *
 * Until KI #113 (2026-09-16) `enqueueScan` coerced EVERY value that was not
 * 'github' to 'gluecron' — an API-initiated row was stored as a Gluecron
 * push, the worker then posted its verdict to Gluecron's callback for a
 * repository that was never there, and `triggeredBy` was dropped on the
 * floor so /api/v1/scans/:id could never match a row to the key that made
 * it. An UNKNOWN host is now rejected, never relabelled: mislabelling a row
 * as a trusted producer is inventing trust.
 *
 * REPO_HOSTS is the subset the worker can fetch source from and post a
 * verdict back to. Rows from any other host are recorded and readable, but
 * the worker must not treat them as a repository push.
 */
const KNOWN_HOSTS = Object.freeze(['gluecron', 'github', 'api']);
const REPO_HOSTS = Object.freeze(['gluecron', 'github']);
const DEFAULT_HOST = 'gluecron';
const TRIGGERED_BY_MAX_LEN = 200;

/**
 * Validate a caller-supplied host against KNOWN_HOSTS.
 *   undefined / null / ''  → DEFAULT_HOST (documented default, see above)
 *   a known host           → itself
 *   anything else          → throws — never silently trusted (Forbidden #16)
 *
 * @param {unknown} host
 * @returns {'gluecron'|'github'|'api'}
 */
function normalizeHost(host) {
  if (host === undefined || host === null || host === '') return DEFAULT_HOST;
  if (typeof host === 'string' && KNOWN_HOSTS.includes(host)) return host;
  throw new Error(
    `enqueueScan: unknown host ${JSON.stringify(host)} — allowed: ${KNOWN_HOSTS.join(', ')}`
  );
}

/**
 * Ensure the `scan_queue` table exists. Idempotent. Mirrors the schema in
 * /api/db/init/route.ts — keep in sync.
 *
 * @param {Function} sql - tagged-template SQL function
 */
async function ensureScanQueueTable(sql) {
  await sql`CREATE TABLE IF NOT EXISTS scan_queue (
    id BIGSERIAL PRIMARY KEY,
    event_id TEXT UNIQUE NOT NULL,
    repository TEXT NOT NULL,
    sha TEXT NOT NULL,
    ref TEXT,
    pull_request_number INT,
    host TEXT NOT NULL DEFAULT 'gluecron',
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    result_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    triggered_by TEXT,
    metadata JSONB
  )`;
  await sql`ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS host TEXT NOT NULL DEFAULT 'gluecron'`;
  // base_sha: the commit this push/PR is compared against, so findings can
  // say whether they sit in code THIS change touched (2026-08-18).
  await sql`ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS base_sha TEXT`;
  // triggered_by / metadata (KI #113, 2026-09-16): who asked for the scan
  // ("api_key:<id>", "webhook:<delivery>", …) and the producer's own payload
  // (URL, suite, callback for API scans). NULL = unattributed row from before
  // the columns existed, or a producer that passes nothing.
  await sql`ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS triggered_by TEXT`;
  await sql`ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS metadata JSONB`;
  await sql`CREATE INDEX IF NOT EXISTS idx_scan_queue_ready
    ON scan_queue (status, next_run_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_scan_queue_repo_sha
    ON scan_queue (repository, sha)`;
}

/**
 * Enqueue a scan job. INSERT ... ON CONFLICT (event_id) DO NOTHING — the
 * caller-supplied eventId is the idempotency key, so a retried POST from
 * Gluecron never double-queues.
 *
 * Returns `{ duplicate: boolean, id: number | null }`. `duplicate: true`
 * means the insert was a no-op because an event with that id already
 * exists. `id` is the primary key of the inserted (or existing) row when
 * available; null if the database did not return a RETURNING row.
 *
 * @param {Object} opts
 * @param {string} opts.eventId
 * @param {string} opts.repository        "owner/name"
 * @param {string} opts.sha
 * @param {string|null} [opts.ref]
 * @param {number|null} [opts.pullRequestNumber]
 * @param {string|null} [opts.baseSha]      commit the change is compared against (push.before / PR base)
 * @param {'github'|'gluecron'|'api'} [opts.host]  source host (KNOWN_HOSTS); omitted → DEFAULT_HOST
 *                                          ('gluecron'); an unknown value THROWS
 * @param {string|null} [opts.triggeredBy]  who asked — e.g. "api_key:<id>"; stored verbatim
 *                                          (≤ 200 chars); omitted → null (unattributed)
 * @param {object|null} [opts.metadata]     producer payload, stored as JSONB; omitted → null
 * @param {Function} opts.sql
 * @returns {Promise<{duplicate: boolean, id: number|null}>}
 */
async function enqueueScan({
  eventId,
  repository,
  sha,
  ref = null,
  pullRequestNumber = null,
  baseSha = null,
  host = DEFAULT_HOST,
  triggeredBy = null,
  metadata = null,
  sql,
}) {
  if (!sql || typeof sql !== 'function') {
    throw new Error('enqueueScan: sql tagged-template is required');
  }
  if (!eventId) throw new Error('enqueueScan: eventId is required');
  if (!repository) throw new Error('enqueueScan: repository is required');
  if (!sha) throw new Error('enqueueScan: sha is required');

  const prNum =
    pullRequestNumber === null || pullRequestNumber === undefined
      ? null
      : Number(pullRequestNumber);

  const safeHost = normalizeHost(host);
  const safeBase = typeof baseSha === 'string' && /^[0-9a-f]{40}$/i.test(baseSha) ? baseSha : null;

  let safeTriggeredBy = null;
  if (triggeredBy !== null && triggeredBy !== undefined) {
    if (typeof triggeredBy !== 'string' || !triggeredBy.trim()) {
      throw new Error('enqueueScan: triggeredBy must be a non-empty string when supplied');
    }
    if (triggeredBy.length > TRIGGERED_BY_MAX_LEN) {
      throw new Error(`enqueueScan: triggeredBy exceeds ${TRIGGERED_BY_MAX_LEN} chars`);
    }
    safeTriggeredBy = triggeredBy;
  }

  let metadataJson = null;
  if (metadata !== null && metadata !== undefined) {
    if (typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('enqueueScan: metadata must be a plain object when supplied');
    }
    metadataJson = JSON.stringify(metadata);
  }

  const rows = await sql`
    INSERT INTO scan_queue
      (event_id, repository, sha, ref, pull_request_number, host, base_sha, status, attempts, next_run_at, triggered_by, metadata)
    VALUES
      (${eventId}, ${repository}, ${sha}, ${ref}, ${prNum}, ${safeHost}, ${safeBase}, 'queued', 0, NOW(), ${safeTriggeredBy}, ${metadataJson}::jsonb)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id
  `;

  if (Array.isArray(rows) && rows.length > 0) {
    return { duplicate: false, id: rows[0].id ?? null };
  }
  // ON CONFLICT fired — no row returned, the event was already queued.
  return { duplicate: true, id: null };
}

/**
 * Atomically claim the next ready job. Uses SELECT ... FOR UPDATE SKIP
 * LOCKED so concurrent worker ticks can't claim the same row. Bumps the
 * row to status='running', increments attempts, stamps started_at.
 *
 * Returns the claimed job or null when the queue is idle.
 *
 * @param {Function} sql
 * @returns {Promise<null | {id:number, event_id:string, repository:string, sha:string, ref:string|null, pull_request_number:number|null, attempts:number}>}
 */
async function claimNextJob(sql) {
  if (!sql || typeof sql !== 'function') {
    throw new Error('claimNextJob: sql tagged-template is required');
  }

  // Single-statement CTE: pick the oldest ready row with SKIP LOCKED, then
  // update it in place, returning the claimed row. This avoids a round-trip
  // and keeps the FOR UPDATE lock scoped to one transaction.
  const rows = await sql`
    WITH next AS (
      SELECT id FROM scan_queue
      WHERE status = 'queued' AND next_run_at <= NOW()
      ORDER BY next_run_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE scan_queue q
    SET status = 'running',
        attempts = q.attempts + 1,
        started_at = NOW()
    FROM next
    WHERE q.id = next.id
    RETURNING q.id, q.event_id, q.repository, q.sha, q.ref,
              q.pull_request_number, q.host, q.attempts, q.base_sha,
              q.triggered_by, q.metadata
  `;

  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

/**
 * Read one queue row by its idempotency key — the record /api/v1/scans/:id
 * returns. Carries the attribution columns (host, triggered_by, metadata)
 * alongside status and result so the caller can both check ownership and
 * report progress. Null when no row has that eventId.
 *
 * @param {string} eventId
 * @param {Function} sql
 * @returns {Promise<null | {id:number, event_id:string, repository:string, sha:string, ref:string|null,
 *   pull_request_number:number|null, host:string, triggered_by:string|null, metadata:object|null,
 *   status:string, attempts:number, last_error:string|null, result_json:object|null,
 *   created_at:string, started_at:string|null, completed_at:string|null}>}
 */
async function getScanByEventId(eventId, sql) {
  if (!sql || typeof sql !== 'function') {
    throw new Error('getScanByEventId: sql tagged-template is required');
  }
  if (!eventId || typeof eventId !== 'string') {
    throw new Error('getScanByEventId: eventId is required');
  }
  const rows = await sql`
    SELECT id, event_id, repository, sha, ref, pull_request_number, host,
           triggered_by, metadata, status, attempts, last_error, result_json,
           created_at, started_at, completed_at
    FROM scan_queue
    WHERE event_id = ${eventId}
    LIMIT 1
  `;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

/**
 * Map an internal scan_queue `status` to the four-state public API status
 * that GET /api/v1/scans/:id returns. ONE definition (Doctrine #4) so the
 * route never grows a second copy of this table that can drift from the
 * lifecycle above. 'not_checked' is its own public state, never folded into
 * 'completed' (which would read as "scanned, found nothing") or dropped to
 * the 'queued' fallback (which would look eternally pending).
 *
 * @param {string} internalStatus
 * @returns {'queued'|'running'|'completed'|'not_checked'|'failed'}
 */
const PUBLIC_STATUS_MAP = Object.freeze({
  pending: 'queued',
  queued: 'queued',
  running: 'running',
  in_progress: 'running',
  failed: 'running', // queue 'failed' means "will retry" — still in flight to the caller
  done: 'completed',
  completed: 'completed',
  succeeded: 'completed',
  not_checked: 'not_checked',
  dead: 'failed',
  error: 'failed',
});

function publicStatusFor(internalStatus) {
  const key = String(internalStatus || 'queued').toLowerCase();
  return PUBLIC_STATUS_MAP[key] || 'queued';
}

/**
 * Mark a job as successfully done. Stores the result JSON payload and
 * stamps completed_at.
 *
 * @param {number} id
 * @param {object} resultJson
 * @param {Function} sql
 */
async function markDone(id, resultJson, sql) {
  if (!sql || typeof sql !== 'function') {
    throw new Error('markDone: sql tagged-template is required');
  }
  if (id === null || id === undefined) {
    throw new Error('markDone: id is required');
  }
  const json = JSON.stringify(resultJson || {});
  await sql`
    UPDATE scan_queue
    SET status = 'done',
        result_json = ${json}::jsonb,
        completed_at = NOW(),
        last_error = NULL
    WHERE id = ${id}
  `;
}

/**
 * Mark a job as failed. If willRetry is true, the row is requeued with an
 * exponential backoff `next_run_at`. Otherwise the row is dead-lettered.
 *
 * @param {number} id
 * @param {string|Error} error
 * @param {boolean} willRetry
 * @param {Function} sql
 */
async function markFailed(id, error, willRetry, sql) {
  if (!sql || typeof sql !== 'function') {
    throw new Error('markFailed: sql tagged-template is required');
  }
  if (id === null || id === undefined) {
    throw new Error('markFailed: id is required');
  }
  const errText = String(
    error && error.message ? error.message : error || 'unknown error'
  ).slice(0, 1000);

  if (willRetry) {
    // Load current attempts to compute backoff. Fall back to the last entry
    // of the backoff table for any attempts value past the end.
    const rows = await sql`SELECT attempts FROM scan_queue WHERE id = ${id}`;
    const attempts =
      Array.isArray(rows) && rows.length > 0 && typeof rows[0].attempts === 'number'
        ? rows[0].attempts
        : 1;
    const backoffIdx = Math.min(attempts - 1, RETRY_BACKOFF_SECONDS.length - 1);
    const backoffSec = RETRY_BACKOFF_SECONDS[Math.max(0, backoffIdx)];
    await sql`
      UPDATE scan_queue
      SET status = 'queued',
          last_error = ${errText},
          next_run_at = NOW() + (${backoffSec} || ' seconds')::interval
      WHERE id = ${id}
    `;
  } else {
    await sql`
      UPDATE scan_queue
      SET status = 'dead',
          last_error = ${errText},
          completed_at = NOW()
      WHERE id = ${id}
    `;
  }
}

/**
 * Mark a job as executed but honestly unable to be checked — Doctrine #1's
 * third state (clean / found / not checked), the terminal state added for
 * KI #113 Phase 2. Used for `api`-host rows whose target needs a capability
 * the worker does not currently have wired up (e.g. the headless-browser
 * runtime pass for a bare website URL, gated by web-runtime-gate.js /
 * KI #111). `result_json` carries the reason and an empty findings array so
 * a client reading the row the same way it reads a `done` row never mistakes
 * "not checked" for "scanned clean" — the row is NEVER marked `done` here.
 *
 * @param {number} id
 * @param {string} reason  short machine-readable code, e.g. 'web-runtime:not-configured'
 * @param {Function} sql
 */
async function markNotChecked(id, reason, sql) {
  if (!sql || typeof sql !== 'function') {
    throw new Error('markNotChecked: sql tagged-template is required');
  }
  if (id === null || id === undefined) {
    throw new Error('markNotChecked: id is required');
  }
  const reasonText = String(reason || 'not-checked').slice(0, 200);
  const json = JSON.stringify({ notChecked: true, reason: reasonText, findings: [] });
  await sql`
    UPDATE scan_queue
    SET status = 'not_checked',
        result_json = ${json}::jsonb,
        completed_at = NOW(),
        last_error = NULL
    WHERE id = ${id}
  `;
}

/**
 * Force-dead a job. Used when we've decided not to retry (attempts >= MAX).
 *
 * @param {number} id
 * @param {string|Error} error
 * @param {Function} sql
 */
async function deadLetter(id, error, sql) {
  return markFailed(id, error, false, sql);
}

/**
 * Count of rows in status='queued'. Used by /api/events/push for
 * backpressure (429 when queue is full).
 *
 * @param {Function} sql
 * @returns {Promise<number>}
 */
async function getQueueDepth(sql) {
  if (!sql || typeof sql !== 'function') {
    throw new Error('getQueueDepth: sql tagged-template is required');
  }
  const rows = await sql`SELECT COUNT(*)::int AS depth FROM scan_queue WHERE status = 'queued'`;
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const depth = rows[0].depth;
  return typeof depth === 'number' ? depth : 0;
}

/**
 * Reclaim jobs that have been in status='running' for longer than the
 * stuck threshold (5 minutes). Vercel kills functions at 60s, but retries,
 * network blips, or a crashed tick can leave a row orphaned.
 *
 * @param {Function} sql
 * @returns {Promise<number>} number of rows reclaimed
 */
async function reclaimStuck(sql) {
  if (!sql || typeof sql !== 'function') {
    throw new Error('reclaimStuck: sql tagged-template is required');
  }
  const rows = await sql`
    UPDATE scan_queue
    SET status = 'queued',
        last_error = COALESCE(last_error, 'reclaimed from stuck running state')
    WHERE status = 'running'
      AND started_at < NOW() - INTERVAL '5 minutes'
    RETURNING id
  `;
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * Terminal-vs-retryable classification (2026-08-18 audit advancement #11).
 * A repo that returns 404, dead credentials, or "empty repository" will
 * fail identically on every attempt — retrying burns MAX_ATTEMPTS ticks
 * and delays the dead-letter callback the customer is waiting on. Rate
 * limits and network blips ARE worth retrying, so anything that smells
 * like throttling is explicitly NOT terminal even when it carries a 403.
 *
 * @param {string} message  the scan error message
 * @returns {boolean} true when retrying cannot possibly succeed
 */
const RETRYABLE_HINT_RE = /rate limit|secondary limit|abuse detection|timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|503|502|504/i;
const TERMINAL_RE = /\b404\b|not found|bad credentials|\b401\b|repository (?:access )?(?:blocked|disabled|unavailable)|empty repository|unknown revision|no commit found|has been archived|repository is archived|invalid repository/i;

function isTerminalScanError(message) {
  const msg = String(message || '');
  if (!msg) return false;
  if (RETRYABLE_HINT_RE.test(msg)) return false;
  return TERMINAL_RE.test(msg);
}

/**
 * Full queue posture for /api/status (advancement #11: "queue depth on
 * /api/status"). One query, grouped counts plus the age of the oldest
 * waiting job — the number that says "the queue is moving" or "nothing
 * has been picked up for an hour".
 *
 * @param {Function} sql
 * @returns {Promise<{queued:number, running:number, done:number, dead:number, oldest_queued_age_s:number|null}>}
 */
async function getQueueStats(sql) {
  if (!sql || typeof sql !== 'function') {
    throw new Error('getQueueStats: sql tagged-template is required');
  }
  const rows = await sql`
    SELECT status, COUNT(*)::int AS n,
           EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int AS oldest_age_s
    FROM scan_queue
    GROUP BY status
  `;
  const stats = { queued: 0, running: 0, done: 0, dead: 0, oldest_queued_age_s: null };
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r.status in stats) stats[r.status] = r.n;
    if (r.status === 'queued') stats.oldest_queued_age_s = r.oldest_age_s;
  }
  return stats;
}

module.exports = {
  ensureScanQueueTable,
  enqueueScan,
  claimNextJob,
  getScanByEventId,
  markDone,
  markFailed,
  markNotChecked,
  deadLetter,
  getQueueDepth,
  getQueueStats,
  reclaimStuck,
  isTerminalScanError,
  normalizeHost,
  publicStatusFor,
  PUBLIC_STATUS_MAP,
  KNOWN_HOSTS,
  REPO_HOSTS,
  DEFAULT_HOST,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_SECONDS,
};
