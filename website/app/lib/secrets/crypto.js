'use strict';
/**
 * Admin secrets panel — envelope crypto (docs/ops/secrets-panel.md).
 *
 * AES-256-GCM, a fresh 12-byte random IV per write, 16-byte tag.
 *
 * Three deliberate differences from the design this was copied from:
 *
 *  1. The secret NAME is bound into the GCM additional authenticated data
 *     (`gatetest-secret:v1:<NAME>`). A ciphertext copied from row A into row
 *     B fails authentication instead of quietly decrypting as B's value.
 *  2. The key is a DEDICATED master key, GATETEST_SECRETS_MASTER_KEY (32
 *     bytes, base64 or hex) — never derived from SESSION_SECRET or the admin
 *     password, and refused when it equals either of them or a value shipped
 *     in .env.example.
 *  3. Every row records which key encrypted it (`key_version` =
 *     `v1:<key id>`, the id being a one-way hash of the key). Rotation sets
 *     GATETEST_SECRETS_MASTER_KEY_NEXT: new writes use NEXT, reads use the key
 *     the row names, and scripts/ops/secrets-rekey.js sweeps the rest. There is
 *     no "try current, then next, then pass the bytes through" — a row whose
 *     key is not loaded, or whose tag does not verify, THROWS.
 *
 * Nothing in this file logs, and no error message carries key material or a
 * value.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMAT = 'v1';
const AAD_PREFIX = `gatetest-secret:${FORMAT}:`;
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** The store cannot run (no key, bad key, key for a row not loaded, DB down). */
class StoreUnavailable extends Error {
  constructor(reason, message) {
    super(message || `secrets store unavailable: ${reason}`);
    this.name = 'StoreUnavailable';
    this.code = 'store_unavailable';
    this.reason = reason;
  }
}

/** A stored record did not authenticate. Never falls back to plaintext. */
class DecryptFailed extends Error {
  constructor(name) {
    super(`stored secret ${name} failed authentication — refusing to use it`);
    this.name = 'DecryptFailed';
    this.code = 'decrypt_failed';
  }
}

/** Decode a configured key: 64 hex chars, or base64/base64url of 32 bytes. */
function decodeKey(raw, label) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw new StoreUnavailable(`${label}_missing`, `${label} is not set`);
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    buf = Buffer.from(s, 'hex');
  } else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } else {
    throw new StoreUnavailable(`${label}_malformed`, `${label} is neither base64 nor hex`);
  }
  if (buf.length !== KEY_BYTES) {
    throw new StoreUnavailable(`${label}_wrong_length`, `${label} must decode to exactly ${KEY_BYTES} bytes`);
  }
  if (buf.every((b) => b === buf[0])) {
    throw new StoreUnavailable(`${label}_weak`, `${label} is a repeated byte, not a random key`);
  }
  return buf;
}

/** Every value assigned in the .env.example files that exist (raw strings). */
function exampleValues(files) {
  const out = new Set();
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const v = m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (v) out.add(v);
    }
  }
  return out;
}

function defaultExampleFiles() {
  const cwd = process.cwd();
  return [path.join(cwd, '.env.example'), path.join(cwd, 'website', '.env.example')];
}

/** Opaque id of a key: a one-way hash, safe to store beside the ciphertext. */
function keyId(key) {
  return crypto.createHash('sha256').update('gatetest-secrets-keyid:v1:').update(key).digest('hex').slice(0, 16);
}

function refuseShared(raw, key, env, examples, label) {
  const trimmed = raw.trim();
  for (const other of ['SESSION_SECRET', 'GATETEST_ADMIN_PASSWORD']) {
    const v = env[other];
    if (typeof v === 'string' && v.trim() && v.trim() === trimmed) {
      throw new StoreUnavailable(`${label}_not_dedicated`, `${label} must be a dedicated key, not the value of ${other}`);
    }
  }
  for (const ex of examples) {
    if (ex === trimmed) throw new StoreUnavailable(`${label}_is_example`, `${label} equals a value from .env.example`);
    let decoded = null;
    try { decoded = decodeKey(ex, 'example'); } catch { decoded = null; }
    if (decoded && crypto.timingSafeEqual(decoded, key)) {
      throw new StoreUnavailable(`${label}_is_example`, `${label} equals a value from .env.example`);
    }
  }
}

/**
 * Load the keyring from the environment. Throws StoreUnavailable when the
 * current key is unusable, or when NEXT is set but unusable (a half-configured
 * rotation must stop writes, not silently write with the old key).
 *
 * @param {Record<string,string|undefined>} [env]
 * @param {{ exampleFiles?: string[] }} [opts]
 */
function loadKeyring(env = process.env, opts = {}) {
  const examples = exampleValues(opts.exampleFiles || defaultExampleFiles());
  const rawCurrent = env.GATETEST_SECRETS_MASTER_KEY;
  const current = decodeKey(rawCurrent, 'master_key');
  refuseShared(rawCurrent, current, env, examples, 'master_key');
  let next = null;
  const rawNext = env.GATETEST_SECRETS_MASTER_KEY_NEXT;
  if (typeof rawNext === 'string' && rawNext.trim()) {
    next = decodeKey(rawNext, 'master_key_next');
    refuseShared(rawNext, next, env, examples, 'master_key_next');
  }
  const keys = new Map();
  keys.set(keyId(current), current);
  if (next) keys.set(keyId(next), next);
  const writeKey = next || current;
  return {
    writeVersion: `${FORMAT}:${keyId(writeKey)}`,
    currentVersion: `${FORMAT}:${keyId(current)}`,
    nextVersion: next ? `${FORMAT}:${keyId(next)}` : null,
    keyFor(version) {
      const m = /^v1:([0-9a-f]{16})$/.exec(String(version || ''));
      if (!m) return null;
      return keys.get(m[1]) || null;
    },
    writeKey,
  };
}

function aadFor(name) {
  return Buffer.from(AAD_PREFIX + name, 'utf8');
}

/** Encrypt `plaintext` for secret `name` with the keyring's write key. */
function encrypt(keyring, name, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyring.writeKey, iv);
  cipher.setAAD(aadFor(name));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyVersion: keyring.writeVersion,
  };
}

/**
 * Decrypt a stored record for `name`. Throws StoreUnavailable('key_not_loaded')
 * when the row's key is not configured, DecryptFailed when it does not verify.
 */
function decrypt(keyring, name, record) {
  const key = keyring.keyFor(record && record.keyVersion);
  if (!key) throw new StoreUnavailable('key_not_loaded', `the key that encrypted ${name} is not loaded`);
  try {
    const iv = Buffer.from(String(record.iv), 'base64');
    const tag = Buffer.from(String(record.tag), 'base64');
    if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error('shape');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aadFor(name));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(String(record.ciphertext), 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptFailed(name);
  }
}

/** First 8 hex of sha256(value) — lets the UI show "changed" without the value. */
function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8);
}

module.exports = {
  FORMAT, AAD_PREFIX, StoreUnavailable, DecryptFailed,
  decodeKey, loadKeyring, encrypt, decrypt, fingerprint, keyId, exampleValues,
};
