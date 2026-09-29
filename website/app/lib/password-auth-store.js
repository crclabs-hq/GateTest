'use strict';
/**
 * Password sign-in — the database side of password-auth-core.js, on the
 * Neon tagged-template client (app/lib/db.ts getDb()).
 *
 * Schema is applied the way every other store in app/lib does it
 * (release-notifier.js, usage-ledger.js, continuous-subscription-store.js):
 * `ensureSchema(sql)` runs idempotent `CREATE TABLE IF NOT EXISTS` /
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements before the first
 * query in a process, and the same statements are mirrored into
 * app/lib/schema.sql and the admin `POST /api/db/init` route. There is no
 * hand-run migration.
 *
 * Additive only:
 *   customers.password_hash        TEXT         — `scrypt$N$r$p$salt$hash`, NULL for OAuth-only
 *   customers.email_verified_at    TIMESTAMPTZ  — set by a verify or reset link
 *   customers.password_updated_at  TIMESTAMPTZ
 *   auth_tokens                    — verify / reset links (sha256 of the token only)
 *   auth_login_failures            — the cross-process sign-in throttle
 */

async function ensureSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    github_login TEXT,
    stripe_customer_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    total_scans INTEGER DEFAULT 0,
    total_spent_usd NUMERIC(10,2) DEFAULT 0
  )`;
  await sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT`;
  await sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ`;
  await sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ`;
  await sql`CREATE TABLE IF NOT EXISTS auth_tokens (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
    token_hash TEXT NOT NULL UNIQUE,
    payload TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_auth_tokens_customer_kind ON auth_tokens(customer_id, kind)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expires_at)`;
  await sql`CREATE TABLE IF NOT EXISTS auth_login_failures (
    id BIGSERIAL PRIMARY KEY,
    scope_key TEXT NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_auth_login_failures_key_time ON auth_login_failures(scope_key, attempted_at)`;
}

// One schema pass per process; a failure clears the memo so the next
// request retries rather than running against a half-applied schema.
let schemaReady = null;
function ensureSchemaOnce(sql) {
  if (!schemaReady) {
    schemaReady = ensureSchema(sql).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

const iso = (ms) => new Date(ms).toISOString();

function rowToCustomer(r) {
  if (!r) return null;
  return {
    id: r.id,
    email: r.email,
    github_login: r.github_login || null,
    password_hash: r.password_hash || null,
    email_verified_at: r.email_verified_at || null,
  };
}

/**
 * Build the store interface password-auth-core.js expects, over one Neon
 * `sql` tagged-template function.
 */
function createStore(sql) {
  return {
    ensureSchema: () => ensureSchemaOnce(sql),

    async findCustomerByEmail(email) {
      await ensureSchemaOnce(sql);
      const rows = await sql`SELECT id, email, github_login, password_hash, email_verified_at
        FROM customers WHERE LOWER(email) = ${email} LIMIT 1`;
      return rowToCustomer(rows && rows[0]);
    },

    async ensureCustomer(email) {
      await ensureSchemaOnce(sql);
      const existing = await this.findCustomerByEmail(email);
      if (existing) return existing;
      const id = require('node:crypto').randomUUID();
      await sql`INSERT INTO customers (id, email) VALUES (${id}, ${email})
        ON CONFLICT (email) DO NOTHING`;
      return (await this.findCustomerByEmail(email)) || { id, email, github_login: null, password_hash: null, email_verified_at: null };
    },

    async setPassword(customerId, hash, { verifiedAt, now }) {
      await ensureSchemaOnce(sql);
      const verified = verifiedAt ? iso(verifiedAt) : null;
      await sql`UPDATE customers
        SET password_hash = ${hash},
            password_updated_at = ${iso(now)},
            email_verified_at = COALESCE(email_verified_at, ${verified}::timestamptz)
        WHERE id = ${customerId}`;
    },

    async insertToken({ id, customerId, kind, tokenHash, payload, expiresAt, now }) {
      await ensureSchemaOnce(sql);
      await sql`INSERT INTO auth_tokens (id, customer_id, kind, token_hash, payload, expires_at, created_at)
        VALUES (${id}, ${customerId}, ${kind}, ${tokenHash}, ${payload || null}, ${iso(expiresAt)}, ${iso(now)})`;
    },

    async findToken(kind, tokenHash) {
      await ensureSchemaOnce(sql);
      const rows = await sql`SELECT t.id, t.customer_id, t.kind, t.payload, t.expires_at, t.used_at,
          c.email, c.github_login
        FROM auth_tokens t JOIN customers c ON c.id = t.customer_id
        WHERE t.kind = ${kind} AND t.token_hash = ${tokenHash} LIMIT 1`;
      return rows && rows[0] ? rows[0] : null;
    },

    async consumeToken(id, now) {
      await ensureSchemaOnce(sql);
      await sql`UPDATE auth_tokens SET used_at = ${iso(now)} WHERE id = ${id} AND used_at IS NULL`;
    },

    async invalidateTokens(customerId, kind, now) {
      await ensureSchemaOnce(sql);
      await sql`UPDATE auth_tokens SET used_at = ${iso(now)}
        WHERE customer_id = ${customerId} AND kind = ${kind} AND used_at IS NULL`;
    },

    async countFailures(key, sinceMs) {
      await ensureSchemaOnce(sql);
      const rows = await sql`SELECT COUNT(*)::int AS n FROM auth_login_failures
        WHERE scope_key = ${key} AND attempted_at > ${iso(sinceMs)}`;
      return rows && rows[0] ? Number(rows[0].n) || 0 : 0;
    },

    async recordFailure(key, now) {
      await ensureSchemaOnce(sql);
      await sql`INSERT INTO auth_login_failures (scope_key, attempted_at) VALUES (${key}, ${iso(now)})`;
      // Opportunistic prune of this key's rows that have aged out of every window.
      await sql`DELETE FROM auth_login_failures WHERE scope_key = ${key} AND attempted_at < ${iso(now - 24 * 60 * 60 * 1000)}`;
    },

    async clearFailures(key) {
      await ensureSchemaOnce(sql);
      await sql`DELETE FROM auth_login_failures WHERE scope_key = ${key}`;
    },
  };
}

module.exports = { ensureSchema, createStore };
