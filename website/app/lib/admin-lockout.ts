/**
 * Admin auth lockout + audit log (Manifest item #20).
 *
 * Hardens /api/admin/auth against brute-force by tracking per-IP failure
 * counts in Neon. After N failed attempts within a sliding window, the
 * IP is locked out for a configurable cooldown.
 *
 * Also records successful logins to an audit table so suspicious access
 * patterns surface in /admin/health.
 *
 * Serverless-safe: every call is a single Postgres query via the
 * neon serverless driver (no in-memory state).
 *
 * GRACEFUL DEGRADATION:
 *   If DATABASE_URL is not set, OR if the DB query throws, the helpers
 *   degrade to a permissive default (no lockout, no audit row). The
 *   existing jitter delay in the route still applies. This means
 *   misconfigured deployments don't silently lock all admins out — but
 *   the docs MUST flag that lockout is disabled until DATABASE_URL is set.
 *
 * Schema (idempotent — admin_lockout_init() creates if missing):
 *   admin_auth_attempts(
 *     ip               TEXT PRIMARY KEY,
 *     failed_count     INTEGER NOT NULL DEFAULT 0,
 *     first_failure_at TIMESTAMPTZ,
 *     last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     locked_until     TIMESTAMPTZ
 *   )
 *   admin_auth_audit(
 *     id          BIGSERIAL PRIMARY KEY,
 *     ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     ip          TEXT,
 *     result      TEXT NOT NULL,  -- 'success' | 'fail' | 'locked'
 *     user_agent  TEXT
 *   )
 */

import { getDb } from "./db";

// ---------------------------------------------------------------------------
// Tunables (Bible: pre-authorized to change without Boss Rule)
// ---------------------------------------------------------------------------

export const MAX_FAILURES_BEFORE_LOCKOUT = 5;
export const WINDOW_MS = 15 * 60 * 1000;        // 15-minute rolling window
export const LOCKOUT_MS = 30 * 60 * 1000;       // 30-minute cooldown
export const AUDIT_RETENTION_DAYS = 90;

// ---------------------------------------------------------------------------
// Schema init — idempotent. Called on the first lockout check per cold
// start. Cheap (CREATE TABLE IF NOT EXISTS is a few ms on warm Postgres).
// ---------------------------------------------------------------------------

let _initPromise: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const sql = getDb();
      await sql`CREATE TABLE IF NOT EXISTS admin_auth_attempts (
        ip               TEXT PRIMARY KEY,
        failed_count     INTEGER NOT NULL DEFAULT 0,
        first_failure_at TIMESTAMPTZ,
        last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_until     TIMESTAMPTZ
      )`;
      await sql`CREATE TABLE IF NOT EXISTS admin_auth_audit (
        id         BIGSERIAL PRIMARY KEY,
        ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ip         TEXT,
        result     TEXT NOT NULL,
        user_agent TEXT
      )`;
      await sql`CREATE INDEX IF NOT EXISTS admin_auth_audit_ts_idx ON admin_auth_audit(ts DESC)`;
    } catch (err) { // error-ok — log-and-continue is intentional; failure here must not block the caller
      // Schema failures are not fatal — the helpers degrade.
      // eslint-disable-next-line no-console
      console.warn("[admin-lockout] schema init failed (DB unavailable?):", (err as Error)?.message);
    }
  })();
  return _initPromise;
}

// ---------------------------------------------------------------------------
// IP extraction — Vercel passes Cloudflare/X-Forwarded-For headers
// ---------------------------------------------------------------------------

export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  return "unknown";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LockoutState {
  locked: boolean;
  lockedUntil: Date | null;
  failedCount: number;
}

/**
 * Returns the current lockout state for the given IP.
 *
 * Graceful: returns { locked: false, failedCount: 0 } when DB unavailable.
 */
export async function checkLockout(ip: string): Promise<LockoutState> {
  if (!process.env.DATABASE_URL) {
    return { locked: false, lockedUntil: null, failedCount: 0 };
  }
  try {
    await ensureSchema();
    const sql = getDb();
    const rows = (await sql`
      SELECT failed_count, locked_until
      FROM admin_auth_attempts
      WHERE ip = ${ip}
    `) as Array<{ failed_count: number; locked_until: string | null }>;
    if (rows.length === 0) {
      return { locked: false, lockedUntil: null, failedCount: 0 };
    }
    const row = rows[0];
    const lockedUntil = row.locked_until ? new Date(row.locked_until) : null;
    const locked = !!lockedUntil && lockedUntil.getTime() > Date.now();
    return { locked, lockedUntil, failedCount: row.failed_count };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[admin-lockout] checkLockout failed:", (err as Error)?.message);
    return { locked: false, lockedUntil: null, failedCount: 0 };
  }
}

/**
 * Record a failed login attempt. If the failure pushes the count past
 * MAX_FAILURES_BEFORE_LOCKOUT within WINDOW_MS, the IP is locked for
 * LOCKOUT_MS.
 *
 * @returns the new lockout state after the failure is recorded.
 */
export async function recordFailure(ip: string, userAgent: string | null): Promise<LockoutState> {
  if (!process.env.DATABASE_URL) {
    return { locked: false, lockedUntil: null, failedCount: 0 };
  }
  try {
    await ensureSchema();
    const sql = getDb();

    const windowStart = new Date(Date.now() - WINDOW_MS);
    const lockoutUntil = new Date(Date.now() + LOCKOUT_MS);

    // Upsert + window-reset in one query. If first_failure_at is older
    // than the window, reset the counter; otherwise increment it. Lock
    // if the new count exceeds the threshold.
    const rows = (await sql`
      INSERT INTO admin_auth_attempts (ip, failed_count, first_failure_at, last_attempt_at)
      VALUES (${ip}, 1, NOW(), NOW())
      ON CONFLICT (ip) DO UPDATE SET
        failed_count = CASE
          WHEN admin_auth_attempts.first_failure_at < ${windowStart.toISOString()}
            THEN 1
          ELSE admin_auth_attempts.failed_count + 1
        END,
        first_failure_at = CASE
          WHEN admin_auth_attempts.first_failure_at < ${windowStart.toISOString()}
            THEN NOW()
          ELSE admin_auth_attempts.first_failure_at
        END,
        last_attempt_at = NOW(),
        locked_until = CASE
          WHEN (CASE
                  WHEN admin_auth_attempts.first_failure_at < ${windowStart.toISOString()}
                    THEN 1
                  ELSE admin_auth_attempts.failed_count + 1
                END) >= ${MAX_FAILURES_BEFORE_LOCKOUT}
            THEN ${lockoutUntil.toISOString()}::TIMESTAMPTZ
          ELSE admin_auth_attempts.locked_until
        END
      RETURNING failed_count, locked_until
    `) as Array<{ failed_count: number; locked_until: string | null }>;

    await sql`
      INSERT INTO admin_auth_audit (ip, result, user_agent)
      VALUES (${ip}, 'fail', ${userAgent})
    `;

    if (rows.length === 0) {
      return { locked: false, lockedUntil: null, failedCount: 1 };
    }
    const row = rows[0];
    const lockedUntilDate = row.locked_until ? new Date(row.locked_until) : null;
    const isLocked = !!lockedUntilDate && lockedUntilDate.getTime() > Date.now();
    return { locked: isLocked, lockedUntil: lockedUntilDate, failedCount: row.failed_count };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[admin-lockout] recordFailure failed:", (err as Error)?.message);
    return { locked: false, lockedUntil: null, failedCount: 0 };
  }
}

/**
 * Record a successful login. Clears the failure counter for the IP and
 * adds an audit row.
 */
export async function recordSuccess(ip: string, userAgent: string | null): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    const sql = getDb();
    await sql`DELETE FROM admin_auth_attempts WHERE ip = ${ip}`;
    await sql`
      INSERT INTO admin_auth_audit (ip, result, user_agent)
      VALUES (${ip}, 'success', ${userAgent})
    `;
  } catch (err) { // error-ok — log-and-continue is intentional; failure here must not block the caller
    // eslint-disable-next-line no-console
    console.warn("[admin-lockout] recordSuccess failed:", (err as Error)?.message);
  }
}

/**
 * Record a rejected-because-locked attempt (for visibility into who's
 * trying after they're locked out).
 */
export async function recordLockedRejection(ip: string, userAgent: string | null): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    const sql = getDb();
    await sql`
      INSERT INTO admin_auth_audit (ip, result, user_agent)
      VALUES (${ip}, 'locked', ${userAgent})
    `;
  } catch (err) { // error-ok — log-and-continue is intentional; failure here must not block the caller
    // eslint-disable-next-line no-console
    console.warn("[admin-lockout] recordLockedRejection failed:", (err as Error)?.message);
  }
}

/**
 * For /admin dashboard — recent audit log entries.
 */
export interface AuditEntry {
  ts: Date;
  ip: string | null;
  result: string;
  userAgent: string | null;
}

export async function recentAudit(limit = 100): Promise<AuditEntry[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    await ensureSchema();
    const sql = getDb();
    const cap = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = (await sql`
      SELECT ts, ip, result, user_agent
      FROM admin_auth_audit
      ORDER BY ts DESC
      LIMIT ${cap}
    `) as Array<{ ts: string; ip: string | null; result: string; user_agent: string | null }>;
    return rows.map((r) => ({
      ts: new Date(r.ts),
      ip: r.ip,
      result: r.result,
      userAgent: r.user_agent,
    }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[admin-lockout] recentAudit failed:", (err as Error)?.message);
    return [];
  }
}
