'use strict';
/**
 * The admin secrets store — encrypted rows + audit, over an adapter.
 *
 * Tables (created by store-pg.js ensureSchema, the CREATE TABLE IF NOT EXISTS
 * pattern every store in app/lib uses):
 *   platform_secrets(name PK, ciphertext, iv, tag, key_version, fingerprint,
 *                    updated_at, updated_by, last_verified_at, liveness)
 *   platform_secret_audit(id, at, actor, action, name, ip, outcome, detail,
 *                         prev_hash UNIQUE, hash)
 *
 * The adapter is injected so the whole store runs against an in-memory
 * adapter in tests; store-pg.js is the Postgres one. No function here logs.
 */

const { loadKeyring, encrypt, decrypt, fingerprint, StoreUnavailable } = require('./crypto');
const { checkName, checkValue } = require('./reserved');
const { appendAudit } = require('./audit');
const { inspectEnvValue } = require('../env-placeholder');

/** A request the caller got wrong — carries the HTTP status the route returns. */
class SecretsError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'SecretsError';
    this.code = code;
    this.status = status;
  }
}

const NAME_STATUS = { invalid_name: 400, reserved_name: 409 };

function assertName(name) {
  const c = checkName(name);
  if (!c.ok) throw new SecretsError(c.error, NAME_STATUS[c.error]);
}

/**
 * @param {{ adapter:object, env?:Record<string,string|undefined>, now?:()=>number,
 *           exampleFiles?:string[] }} deps
 */
function createSecretsStore(deps) {
  const adapter = deps.adapter;
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  let keyring = null;

  function ring() {
    if (!keyring) keyring = loadKeyring(env, { exampleFiles: deps.exampleFiles });
    return keyring;
  }

  function status() {
    try {
      const k = ring();
      return { storeReady: true, keyVersion: k.writeVersion };
    } catch (err) {
      return { storeReady: false, storeError: err && err.reason ? err.reason : 'store_unavailable', keyVersion: null };
    }
  }

  async function audit(entry, forbid) {
    return appendAudit(adapter, entry, { now, forbid });
  }

  async function list() {
    return adapter.listSecrets();
  }

  async function get(name) {
    const row = await adapter.getSecret(name);
    return row ? decrypt(ring(), name, row) : null;
  }

  /** Every stored secret, decrypted. Throws if ANY row fails — a render is all or nothing. */
  async function readAll() {
    const k = ring();
    const rows = await adapter.listSecrets();
    return rows.map((r) => ({ name: r.name, value: decrypt(k, r.name, r) }));
  }

  async function sameValueWarnings(name, value, fp) {
    const warnings = [];
    for (const r of await adapter.listSecrets()) {
      if (r.name === name || r.fingerprint !== fp) continue;
      try {
        if (decrypt(ring(), r.name, r) === value) warnings.push(`same_value_as:${r.name}`);
      } catch {
        // An unreadable row cannot be compared — say so rather than stay silent.
        warnings.push(`unreadable:${r.name}`);
      }
    }
    return warnings;
  }

  async function set(name, value, ctx) {
    assertName(name);
    const v = checkValue(value);
    if (!v.ok) throw new SecretsError(v.error, 400);
    const k = ring();
    const fp = fingerprint(value);
    const warnings = await sameValueWarnings(name, value, fp);
    if (!inspectEnvValue(name, value).ok) warnings.push('looks_like_placeholder');
    const before = await adapter.getSecret(name);
    const sealed = encrypt(k, name, value);
    await adapter.upsertSecret({
      name, ...sealed, fingerprint: fp, updatedAt: new Date(now()).toISOString(), updatedBy: ctx.actor,
    });
    await audit({
      actor: ctx.actor, action: 'set', name, ip: ctx.ip, outcome: 'ok',
      detail: before ? `fingerprint ${before.fingerprint}->${fp}` : `created fingerprint ${fp}`,
    }, [value]);
    return { fingerprint: fp, warnings };
  }

  async function remove(name, ctx) {
    assertName(name);
    ring();
    const removed = await adapter.deleteSecret(name);
    await audit({ actor: ctx.actor, action: 'delete', name, ip: ctx.ip, outcome: removed ? 'ok' : 'not_found' });
    return { removed };
  }

  /** Audited BEFORE the value is returned; no audit row, no value. */
  async function reveal(name, ctx) {
    assertName(name);
    const row = await adapter.getSecret(name);
    if (!row) {
      await audit({ actor: ctx.actor, action: 'reveal', name, ip: ctx.ip, outcome: 'not_found' });
      throw new SecretsError('not_found', 404);
    }
    const value = decrypt(ring(), name, row);
    try {
      await audit({ actor: ctx.actor, action: 'reveal', name, ip: ctx.ip, outcome: 'ok', detail: `fingerprint ${row.fingerprint}` }, [value]);
    } catch {
      throw new StoreUnavailable('audit_unavailable', 'reveal refused: the audit row could not be written');
    }
    return value;
  }

  async function markVerified(name, liveness, atIso) {
    return adapter.setLiveness(name, liveness, atIso);
  }

  return {
    status, audit, list, get, readAll, set, remove, reveal, markVerified,
    listAudit: (n) => adapter.listAudit(n),
    allAudit: () => adapter.allAudit(),
    stepUpAttempts: (key, sinceIso) => adapter.countStepUp(key, sinceIso),
    recordStepUpAttempt: (key, atIso) => adapter.recordStepUp(key, atIso),
  };
}

module.exports = { createSecretsStore, SecretsError };
