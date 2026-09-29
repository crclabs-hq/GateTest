'use strict';
/**
 * Hash-chained audit trail for the secrets panel.
 *
 * Each row stores `prev_hash` (the previous row's hash, `genesis` for the
 * first) and `hash = sha256(JSON [prev_hash, at, actor, action, name, ip,
 * outcome, detail])`. `prev_hash` is UNIQUE in Postgres, so two concurrent
 * writers cannot both extend the same row — the loser gets a unique violation
 * and retries on the new tail. verifyAuditChain() recomputes every link: an
 * edited, deleted or reordered row breaks it at that row.
 *
 * A row NEVER holds a value or ciphertext. Callers pass fixed strings, names,
 * fingerprints and reason codes; as a second line of defence, a caller that
 * knows the value passes it in `forbid` and any column containing it is
 * replaced before the row is written.
 */

const crypto = require('node:crypto');

const GENESIS = 'genesis';
const MAX_RETRIES = 5;

function rowHash(prevHash, r) {
  const payload = JSON.stringify([prevHash, r.at, r.actor, r.action, r.name, r.ip, r.outcome, r.detail]);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function clean(v, forbid, max) {
  if (v === null || v === undefined) return null;
  let s = String(v).slice(0, max);
  for (const f of forbid) {
    if (f && f.length >= 4 && s.includes(f)) s = '[redacted]';
  }
  return s;
}

/**
 * @param {object} adapter  { lastAudit():Promise<{hash}|null>, insertAudit(row):Promise<void> }
 * @param {{actor:string, action:string, name?:string|null, ip?:string|null, outcome:string, detail?:string|null}} entry
 * @param {{ now?:()=>number, forbid?:string[] }} [opts]
 */
async function appendAudit(adapter, entry, opts = {}) {
  const forbid = (opts.forbid || []).filter((f) => typeof f === 'string');
  const now = opts.now || Date.now;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const last = await adapter.lastAudit();
    const prevHash = last && last.hash ? last.hash : GENESIS;
    const row = {
      at: new Date(now()).toISOString(),
      actor: clean(entry.actor || 'admin', forbid, 64),
      action: clean(entry.action, forbid, 32),
      name: clean(entry.name || null, forbid, 64),
      ip: clean(entry.ip || null, forbid, 64),
      outcome: clean(entry.outcome, forbid, 48),
      detail: clean(entry.detail || null, forbid, 200),
    };
    row.prevHash = prevHash;
    row.hash = rowHash(prevHash, row);
    try {
      await adapter.insertAudit(row);
      return row;
    } catch (err) {
      if (!(err && err.code === '23505')) throw err;
    }
  }
  throw new Error('audit chain contention — gave up after retries');
}

/**
 * @param {Array<{at:string, actor:string, action:string, name:string|null, ip:string|null,
 *                outcome:string, detail:string|null, prevHash:string, hash:string}>} rows  oldest first
 * @returns {{ ok:true, count:number } | { ok:false, brokenAt:number, reason:string }}
 */
function verifyAuditChain(rows) {
  let prev = GENESIS;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.prevHash !== prev) return { ok: false, brokenAt: i, reason: 'prev_hash_mismatch' };
    if (rowHash(r.prevHash, r) !== r.hash) return { ok: false, brokenAt: i, reason: 'hash_mismatch' };
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}

module.exports = { appendAudit, verifyAuditChain };
