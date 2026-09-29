/**
 * DB Init API — Executes schema to create tables.
 *
 * POST /api/db/init
 *
 * Idempotent: all statements use IF NOT EXISTS.
 * Admin-only: requires valid admin session cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";
import { getAdminConfig, getAdminUser, SESSION_COOKIE_NAME } from "../../../lib/admin-session";
import { ADMIN_COOKIE_NAME } from "../../../lib/admin-auth";
import { getDb } from "../../../lib/db";
// Single source of truth for the scan_queue schema + its migrations.
// Same require-style as /api/webhook's `queueStore` import — the store is CJS.
const { ensureScanQueueTable } = require("@/app/lib/scan-queue-store");
// Email + password sign-in: customers.password_hash / email_verified_at /
// password_updated_at, auth_tokens, auth_login_failures. Same delegation
// rule as scan_queue — the store owns the DDL and its ADD COLUMN IF NOT
// EXISTS repairs, this route only calls it.
const { ensureSchema: ensurePasswordAuthSchema } = require("@/app/lib/password-auth-store");

function checkPwCookie(v: string | undefined): boolean {
  const pw = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (!pw || !v) return false;
  const exp = createHmac("sha256", pw).update("gatetest-admin-v1").digest("hex");
  const a = Buffer.from(v), b = Buffer.from(exp);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();

  // Auth: GitHub OAuth OR password cookie
  const oauthStatus = getAdminConfig();
  let adminLogin: string | null = null;
  if (oauthStatus.ok && oauthStatus.config) {
    adminLogin = getAdminUser(cookieStore.get(SESSION_COOKIE_NAME)?.value, oauthStatus.config);
  }
  if (!adminLogin && checkPwCookie(cookieStore.get(ADMIN_COOKIE_NAME)?.value)) {
    adminLogin = "admin";
  }
  if (!adminLogin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Suppress unused variable warning — req is required by the route handler signature
  void req;

  try {
    const sql = getDb();

    // Execute each statement separately — Neon tagged template doesn't support multi-statement
    await sql`CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      payment_intent_id TEXT,
      customer_email TEXT,
      repo_url TEXT NOT NULL,
      tier TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      results JSONB,
      summary TEXT,
      score INTEGER,
      ai_cost_usd NUMERIC(10,4),
      tier_price_usd NUMERIC(10,2),
      modules_run TEXT[],
      duration_ms INTEGER
    )`;

    await sql`CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      github_login TEXT,
      stripe_customer_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      total_scans INTEGER DEFAULT 0,
      total_spent_usd NUMERIC(10,2) DEFAULT 0
    )`;

    await sql`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT UNIQUE NOT NULL,
      key_prefix TEXT NOT NULL,
      name TEXT NOT NULL,
      customer_email TEXT,
      tier_allowed TEXT NOT NULL DEFAULT 'quick',
      rate_limit_per_hour INTEGER NOT NULL DEFAULT 60,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      total_calls INTEGER DEFAULT 0
    )`;

    await sql`CREATE TABLE IF NOT EXISTS api_calls (
      id BIGSERIAL PRIMARY KEY,
      api_key_id TEXT NOT NULL,
      repo_url TEXT,
      tier TEXT,
      status_code INTEGER,
      issues_found INTEGER,
      duration_ms INTEGER,
      idempotency_key TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;

    await sql`CREATE TABLE IF NOT EXISTS installations (
      id BIGSERIAL PRIMARY KEY,
      host TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      customer_email TEXT,
      customer_login TEXT,
      setup_action TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (host, installation_id)
    )`;

    // Signal Bus E1 — scan_queue backs the async push-event pipeline from
    // Gluecron AND the GitHub App webhook. Rows are INSERTed by
    // /api/events/push and /api/webhook, and claimed by the cron-driven
    // consumer at /api/scan/worker/tick.
    //
    // DELEGATED, not duplicated. This route used to carry its own copy of the
    // scan_queue DDL, and the two copies diverged: the store's version gained
    // a `host` column for dual-host support while this one never did. Because
    // CREATE TABLE IF NOT EXISTS silently does nothing on an existing table,
    // production kept a scan_queue with no `host` column while the worker
    // queried `q.host` — so EVERY tick died with
    //   "column q.host does not exist"
    // and the queue never drained. Pushes were enqueued and never scanned, so
    // no commit status was ever posted.
    //
    // ensureScanQueueTable() owns this schema and ships the idempotent
    // ALTER ... ADD COLUMN IF NOT EXISTS that repairs an already-created
    // table, which is what makes calling this route a real fix for an
    // existing database rather than a no-op.
    await ensureScanQueueTable(sql);
    await ensurePasswordAuthSchema(sql);

    await sql`CREATE INDEX IF NOT EXISTS idx_scans_session ON scans(session_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_scans_email ON scans(customer_email)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_customers_github ON customers(github_login)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(active)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_api_calls_key ON api_calls(api_key_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_api_calls_created ON api_calls(created_at)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_api_calls_idem ON api_calls(idempotency_key)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_installations_host_id ON installations(host, installation_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_installations_customer_email ON installations(customer_email)`;
    // scan_queue indexes are created by ensureScanQueueTable() above — kept
    // there so the schema and its indexes never drift apart again.

    // Watchdog: continuously monitored domains/repos
    await sql`CREATE TABLE IF NOT EXISTS watches (
      id BIGSERIAL PRIMARY KEY,
      owner_login TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL DEFAULT 15,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_checked_at TIMESTAMPTZ,
      last_status TEXT,
      last_issue_count INTEGER DEFAULT 0,
      auto_fix_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (owner_login, target_type, target)
    )`;

    await sql`CREATE TABLE IF NOT EXISTS heal_history (
      id BIGSERIAL PRIMARY KEY,
      watch_id BIGINT REFERENCES watches(id) ON DELETE CASCADE,
      triggered_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      before_issue_count INTEGER,
      after_issue_count INTEGER,
      pr_url TEXT,
      details JSONB
    )`;

    await sql`CREATE INDEX IF NOT EXISTS idx_watches_owner ON watches(owner_login)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_watches_enabled_checked ON watches(enabled, last_checked_at)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_heal_history_watch ON heal_history(watch_id, triggered_at DESC)`;

    return NextResponse.json({
      ok: true,
      tables: ["scans", "customers", "api_keys", "api_calls", "installations", "scan_queue", "auth_tokens", "auth_login_failures", "watches", "heal_history"],
      indexes: 20,
      message: "Schema initialized (idempotent — safe to run multiple times)",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
