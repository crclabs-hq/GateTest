'use strict';
/**
 * In-memory stand-in for website/app/lib/secrets/store-pg.js, with the one
 * constraint the audit chain relies on (prev_hash UNIQUE → code 23505).
 * `rows` and `audit` are exposed so a test can inspect every column written.
 */
function createMemoryAdapter() {
  const rows = new Map();
  const audit = [];
  const stepUps = [];
  return {
    rows,
    audit,
    stepUps,
    async listSecrets() { return [...rows.values()].map((r) => ({ ...r })).sort((a, b) => (a.name < b.name ? -1 : 1)); },
    async getSecret(name) { return rows.has(name) ? { ...rows.get(name) } : null; },
    async upsertSecret(s) {
      const prev = rows.get(s.name);
      const keep = prev && prev.fingerprint === s.fingerprint;
      rows.set(s.name, { ...s, lastVerifiedAt: keep ? prev.lastVerifiedAt : null, liveness: keep ? prev.liveness : null });
    },
    async deleteSecret(name) { return rows.delete(name); },
    async replaceCipher(name, from, c) {
      const r = rows.get(name);
      if (!r || r.keyVersion !== from) return false;
      rows.set(name, { ...r, ...c });
      return true;
    },
    async setLiveness(name, liveness, at) {
      const r = rows.get(name);
      if (!r) return false;
      rows.set(name, { ...r, liveness, lastVerifiedAt: at });
      return true;
    },
    async lastAudit() { return audit.length ? { hash: audit[audit.length - 1].hash } : null; },
    async insertAudit(r) {
      if (audit.some((a) => a.prevHash === r.prevHash)) throw Object.assign(new Error('duplicate'), { code: '23505' });
      audit.push({ id: audit.length + 1, ...r });
    },
    async listAudit(limit) { return audit.slice().reverse().slice(0, limit || 50).map((a) => ({ ...a })); },
    async allAudit() { return audit.map((a) => ({ ...a })); },
    async countStepUp(key, since) { return stepUps.filter((s) => s.key === key && s.at > since).length; },
    async recordStepUp(key, at) { stepUps.push({ key, at }); },
  };
}

module.exports = { createMemoryAdapter };
