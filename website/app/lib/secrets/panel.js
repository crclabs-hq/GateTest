'use strict';
/**
 * The admin secrets panel's service layer — what each API route does, with
 * every dependency injected (store, fs, env, paths, fetch, clock) so the whole
 * flow runs in node tests without Next, Postgres or a vendor.
 *
 * Routes (website/app/api/admin/secrets/**) only authenticate, parse, call one
 * function here and serialise the answer.
 */

const nodeFs = require('node:fs');
const catalogue = require('../env-catalogue');
const { inspectEnvValue } = require('../env-placeholder');
const { isReserved } = require('./reserved');
const { fingerprint } = require('./crypto');
const { parseEnvFile, readHeader } = require('./render-env');
const { materialize, accessReason } = require('./materialize');
const { detectShadow } = require('./shadow');
const { probeLiveness } = require('./liveness');

const PROOF_ON_SAVE_TIMEOUT_MS = 6000;

function errReason(err) {
  return (err && (err.reason || err.code || err.name)) || 'error';
}

/** Is the store reflected in the rendered file? Reads fingerprints only. */
function applyStateOf(rows, unitEnvFile, fs) {
  let text;
  try {
    text = fs.readFileSync(unitEnvFile, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return rows.length ? { lastAppliedAt: null, applied: false, reason: 'target-missing' } : { lastAppliedAt: null, applied: true };
    }
    return { lastAppliedAt: null, applied: false, reason: accessReason(err) };
  }
  const header = readHeader(text);
  const parsed = parseEnvFile(text);
  const inSync = parsed.size === rows.length && rows.every((r) => parsed.has(r.name) && fingerprint(parsed.get(r.name)) === r.fingerprint);
  return {
    lastAppliedAt: header ? header.renderedAt : null,
    applied: inSync,
    ...(inSync ? {} : { reason: 'out_of_sync' }),
  };
}

/** A real environment variable name — what the env-file parser can yield is not trusted to be one. */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function stateOf(name, value) {
  if (typeof value !== 'string' || !value.trim()) return 'missing';
  return inspectEnvValue(name, value).ok ? 'set' : 'placeholder';
}

function envState(name, env) {
  if (catalogue.isSet(name, env)) return 'set';
  const aliases = [name, ...(catalogue.ALIASES[name] || [])];
  return aliases.some((n) => typeof env[n] === 'string' && env[n].trim()) ? 'placeholder' : 'missing';
}

async function storedValue(store, name) {
  try { return { value: await store.get(name) }; } catch (err) { return { error: errReason(err) }; }
}

/**
 * GET /api/admin/secrets body.
 * @param {{ store, runtimeEnv, appEnv:Map|null, unitEnvFile:string, fs?:object }} d
 */
async function buildListing(d) {
  const fs = d.fs || nodeFs;
  const status = d.store.status();
  let rows = [];
  let storeError = status.storeError;
  try {
    rows = await d.store.list();
  } catch (err) {
    storeError = storeError || `database_unavailable: ${errReason(err)}`;
  }
  const byName = new Map(rows.map((r) => [r.name, r]));
  const entries = catalogue.catalogueEntries();
  for (const r of rows) if (!catalogue.tierOf(r.name)) entries.push({ name: r.name, tier: 'custom', why: '' });
  // Every name set in the server's app env file is listed too (Craig
  // 2026-10-01: "gatetest secrets listed on the server"). Before this, a name
  // that was set on the box but neither catalogued nor stored in the panel
  // was invisible here. Old names of catalogued entries (VAPRON_* and the
  // like) are already shown under their canonical row, so they are skipped.
  // Only the NAME leaves this function; state comes from the value, never
  // the value itself.
  const listed = new Set(entries.map((e) => e.name));
  const aliasNames = new Set(Object.values(catalogue.ALIASES).flat());
  const serverOnly = [];
  for (const name of (d.appEnv ? d.appEnv.keys() : [])) {
    if (listed.has(name) || aliasNames.has(name) || !ENV_NAME_RE.test(name)) continue;
    listed.add(name);
    serverOnly.push(name);
  }
  for (const name of serverOnly.sort()) {
    entries.push({ name, tier: 'custom', why: 'set in the server env file — not in the catalogue', fromServerFile: true });
  }

  const items = [];
  for (const e of entries) {
    const row = byName.get(e.name) || null;
    let state = envState(e.name, d.runtimeEnv);
    if (e.fromServerFile && state === 'missing') state = stateOf(e.name, d.appEnv.get(e.name));
    let error;
    if (row) {
      const sv = status.storeReady ? await storedValue(d.store, e.name) : { error: storeError };
      if (sv.error) { state = 'set'; error = sv.error; } else { state = stateOf(e.name, sv.value); }
    }
    const shadow = detectShadow({ name: e.name, storedFingerprint: row ? row.fingerprint : null, runtimeEnv: d.runtimeEnv, appEnv: d.appEnv });
    items.push({
      name: e.name, tier: e.tier, why: e.why, state, source: shadow.source,
      shadowed: shadow.shadowed, ...(shadow.shadowWinner ? { shadowWinner: shadow.shadowWinner } : {}),
      ...(row ? { fingerprint: row.fingerprint, updatedAt: row.updatedAt, updatedBy: row.updatedBy } : {}),
      liveness: (row && row.liveness) || 'unchecked',
      ...(row && row.lastVerifiedAt ? { lastVerifiedAt: row.lastVerifiedAt } : {}),
      reserved: isReserved(e.name),
      ...(error ? { error } : {}),
    });
  }
  return {
    storeReady: Boolean(status.storeReady && !storeError),
    ...(storeError ? { storeError } : {}),
    keyVersion: status.keyVersion,
    unitEnvPath: d.unitEnvFile,
    applyState: applyStateOf(rows, d.unitEnvFile, fs),
    items,
  };
}

/**
 * Names deleted (audited delete, outcome ok) after the file on disk was
 * rendered. A later apply may drop exactly those, so a delete whose own
 * apply failed can still reach the file — anything else missing from the
 * store is refused as would_drop_keys.
 */
async function deletedSinceRender(store, unitEnvFile, fs) {
  let renderedAt = '';
  try { renderedAt = (readHeader(fs.readFileSync(unitEnvFile, 'utf8')) || {}).renderedAt || ''; } catch { return []; }
  try {
    const rows = await store.listAudit(500);
    return rows.filter((r) => r.action === 'delete' && r.outcome === 'ok' && r.name && r.at >= renderedAt).map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * Re-render every stored secret and write the unit env file. Never throws.
 * @param {{ store, unitEnvFile:string, fs?:object, allowRemoving?:string[], now?:number, ctx:{actor,ip} }} d
 */
async function applyNow(d) {
  let entries;
  let result;
  try {
    entries = await d.store.readAll();
  } catch {
    result = { applied: false, reason: 'store_unavailable', path: d.unitEnvFile, count: 0 };
  }
  if (!result) {
    const allowRemoving = [...(d.allowRemoving || []), ...(await deletedSinceRender(d.store, d.unitEnvFile, d.fs || nodeFs))];
    result = materialize({ entries, path: d.unitEnvFile, fs: d.fs, now: d.now, allowRemoving });
  }
  try {
    await d.store.audit({
      actor: d.ctx.actor, action: 'apply', ip: d.ctx.ip, outcome: result.applied ? 'ok' : 'not_applied',
      detail: `count=${result.count}${result.reason ? ` reason=${result.reason}` : ''}${result.dropped ? ` dropped=${result.dropped.join(',')}` : ''}`,
    });
  } catch {
    // The write happened (or not) regardless; say so in the answer instead of
    // failing an apply that already reached the disk.
    result = { ...result, auditWritten: false };
  }
  const out = { applied: result.applied, path: result.path, count: result.count };
  if (result.auditWritten === false) out.auditWritten = false;
  if (result.reason) out.reason = result.reason;
  if (result.dropped) out.dropped = result.dropped;
  return out;
}

/** Value resolver for probes: the stored value when stored, else the runtime env. */
function resolver(store, runtimeEnv, storedNames) {
  const cache = new Map();
  return async (name) => {
    if (cache.has(name)) return cache.get(name);
    let v = runtimeEnv[name];
    if (storedNames.has(name)) {
      try { v = (await store.get(name)) ?? v; } catch { v = undefined; }
    }
    cache.set(name, v);
    return v;
  };
}

/**
 * Probe one name and persist the answer on its stored row (if any).
 * @returns {Promise<{liveness:string, checkedAt:string, persisted:boolean}>}
 */
async function verifyOne(d) {
  let storedNames = new Set();
  try { storedNames = new Set((await d.store.list()).map((r) => r.name)); } catch { storedNames = new Set(); }
  const resolve = resolver(d.store, d.runtimeEnv, storedNames);
  const pairs = ['STRIPE_SECRET_KEY', 'RESEND_API_KEY', 'GATETEST_APP_ID', 'GATETEST_PRIVATE_KEY', 'ANTHROPIC_API_KEY'];
  const values = new Map();
  for (const n of new Set([d.name, ...pairs])) values.set(n, await resolve(n));
  const liveness = await probeLiveness(d.name, {
    get: (n) => values.get(n), fetch: d.fetch, timeoutMs: d.timeoutMs, now: d.now,
  });
  const checkedAt = new Date((d.now || Date.now)()).toISOString();
  let persisted = false;
  if (storedNames.has(d.name)) {
    try { persisted = await d.store.markVerified(d.name, liveness, checkedAt); } catch { persisted = false; }
  }
  return { liveness, checkedAt, persisted };
}

/** Stand-in when there is no database at all: the listing still shows env state. */
function unavailableStore(reason) {
  const fail = async () => { throw Object.assign(new Error(reason), { name: 'StoreUnavailable', reason }); };
  return {
    status: () => ({ storeReady: false, storeError: reason, keyVersion: null }),
    list: fail, get: fail, readAll: fail, audit: fail, markVerified: fail,
  };
}

module.exports = { PROOF_ON_SAVE_TIMEOUT_MS, buildListing, applyNow, verifyOne, applyStateOf, unavailableStore };
