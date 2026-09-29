'use strict';
/**
 * Postgres adapter for the secrets store, on the Neon tagged-template client
 * (app/lib/db.ts getDb()). Schema is applied the way every other store in
 * app/lib does it: idempotent CREATE TABLE IF NOT EXISTS before the first
 * query in a process, memoised, retried after a failure.
 */

async function ensureSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS platform_secrets (
    name TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    key_version TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by TEXT,
    last_verified_at TIMESTAMPTZ,
    liveness TEXT
  )`;
  await sql`CREATE TABLE IF NOT EXISTS platform_secret_audit (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    name TEXT,
    ip TEXT,
    outcome TEXT NOT NULL,
    detail TEXT,
    prev_hash TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS admin_step_up_attempts (
    id BIGSERIAL PRIMARY KEY,
    scope_key TEXT NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_admin_step_up_key_time ON admin_step_up_attempts(scope_key, attempted_at)`;
}

const iso = (v) => (v ? new Date(v).toISOString() : null);

function toSecret(r) {
  return {
    name: r.name,
    ciphertext: r.ciphertext,
    iv: r.iv,
    tag: r.tag,
    keyVersion: r.key_version,
    fingerprint: r.fingerprint,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by || null,
    lastVerifiedAt: iso(r.last_verified_at),
    liveness: r.liveness || null,
  };
}

function toAudit(r) {
  return {
    id: Number(r.id),
    at: iso(r.at),
    actor: r.actor,
    action: r.action,
    name: r.name,
    ip: r.ip,
    outcome: r.outcome,
    detail: r.detail,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

function createPgAdapter(sql) {
  let ready = null;
  const schema = () => {
    if (!ready) ready = ensureSchema(sql).catch((err) => { ready = null; throw err; });
    return ready;
  };
  return {
    ensureSchema: schema,
    async listSecrets() {
      await schema();
      return (await sql`SELECT * FROM platform_secrets ORDER BY name`).map(toSecret);
    },
    async getSecret(name) {
      await schema();
      const rows = await sql`SELECT * FROM platform_secrets WHERE name = ${name} LIMIT 1`;
      return rows[0] ? toSecret(rows[0]) : null;
    },
    async upsertSecret(s) {
      await schema();
      await sql`INSERT INTO platform_secrets (name, ciphertext, iv, tag, key_version, fingerprint, updated_at, updated_by)
        VALUES (${s.name}, ${s.ciphertext}, ${s.iv}, ${s.tag}, ${s.keyVersion}, ${s.fingerprint}, ${s.updatedAt}, ${s.updatedBy})
        ON CONFLICT (name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
          key_version = EXCLUDED.key_version, fingerprint = EXCLUDED.fingerprint, updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by,
          last_verified_at = CASE WHEN platform_secrets.fingerprint = EXCLUDED.fingerprint THEN platform_secrets.last_verified_at END,
          liveness = CASE WHEN platform_secrets.fingerprint = EXCLUDED.fingerprint THEN platform_secrets.liveness END`;
    },
    async deleteSecret(name) {
      await schema();
      const rows = await sql`DELETE FROM platform_secrets WHERE name = ${name} RETURNING name`;
      return rows.length > 0;
    },
    /** Re-encrypt one row only if it still carries the key version the sweep read. */
    async replaceCipher(name, fromVersion, c) {
      await schema();
      const rows = await sql`UPDATE platform_secrets SET ciphertext = ${c.ciphertext}, iv = ${c.iv}, tag = ${c.tag}, key_version = ${c.keyVersion}
        WHERE name = ${name} AND key_version = ${fromVersion} RETURNING name`;
      return rows.length > 0;
    },
    async setLiveness(name, liveness, atIso) {
      await schema();
      const rows = await sql`UPDATE platform_secrets SET liveness = ${liveness}, last_verified_at = ${atIso}
        WHERE name = ${name} RETURNING name`;
      return rows.length > 0;
    },
    async lastAudit() {
      await schema();
      const rows = await sql`SELECT hash FROM platform_secret_audit ORDER BY id DESC LIMIT 1`;
      return rows[0] || null;
    },
    async insertAudit(r) {
      await schema();
      await sql`INSERT INTO platform_secret_audit (at, actor, action, name, ip, outcome, detail, prev_hash, hash)
        VALUES (${r.at}, ${r.actor}, ${r.action}, ${r.name}, ${r.ip}, ${r.outcome}, ${r.detail}, ${r.prevHash}, ${r.hash})`;
    },
    async listAudit(limit) {
      await schema();
      const n = Math.max(1, Math.min(500, Number(limit) || 50));
      return (await sql`SELECT * FROM platform_secret_audit ORDER BY id DESC LIMIT ${n}`).map(toAudit);
    },
    async allAudit() {
      await schema();
      return (await sql`SELECT * FROM platform_secret_audit ORDER BY id ASC`).map(toAudit);
    },
    async countStepUp(key, sinceIso) {
      await schema();
      const rows = await sql`SELECT COUNT(*)::int AS n FROM admin_step_up_attempts WHERE scope_key = ${key} AND attempted_at > ${sinceIso}`;
      return rows[0] ? Number(rows[0].n) : 0;
    },
    async recordStepUp(key, atIso) {
      await schema();
      await sql`INSERT INTO admin_step_up_attempts (scope_key, attempted_at) VALUES (${key}, ${atIso})`;
      await sql`DELETE FROM admin_step_up_attempts WHERE attempted_at < NOW() - INTERVAL '1 day'`;
    },
  };
}

module.exports = { createPgAdapter, ensureSchema };
