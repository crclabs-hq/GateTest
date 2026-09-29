#!/usr/bin/env node
'use strict';
/**
 * Import the app env file's catalogue secrets into the admin secrets store.
 * The migration step in docs/ops/secrets-panel.md. Run ON THE BOX, as root:
 *
 *   cd /opt/gatetest
 *   node scripts/ops/secrets-import-env.js            # dry run (default)
 *   APPLY=1 node scripts/ops/secrets-import-env.js    # write, then render the unit env file
 *   APPLY=1 OVERWRITE=1 node scripts/ops/secrets-import-env.js   # also replace stored values that differ
 *
 * Reads GATETEST_APP_ENV_PATH (default /opt/gatetest/website/.env.local).
 * Imports only names in the env catalogue (app/lib/env-catalogue.js) that are
 * not reserved, are set, and are not documentation filler. Prints NAMES and
 * 8-hex fingerprints only — never a value — and writes one audit row per key.
 * Takes no values in argv.
 */

const path = require('path');
const { LIB, openScriptStore, isApply, isOverwrite } = require('./secrets-common');

const catalogue = require(path.join(LIB, 'env-catalogue.js'));
const { inspectEnvValue } = require(path.join(LIB, 'env-placeholder.js'));
const { isReserved, checkValue } = require(path.join(LIB, 'secrets', 'reserved.js'));
const { fingerprint } = require(path.join(LIB, 'secrets', 'crypto.js'));

/**
 * Pure plan: what would happen to each catalogue name found in the app env file.
 * @param {Map<string,string>} appEnv
 * @param {Array<{name:string, fingerprint:string}>} storedRows
 * @param {{ overwrite?: boolean }} [opts]
 */
function planImport(appEnv, storedRows, opts = {}) {
  const stored = new Map(storedRows.map((r) => [r.name, r.fingerprint]));
  const plan = [];
  for (const { name } of catalogue.catalogueEntries()) {
    if (!appEnv.has(name)) continue;
    const v = appEnv.get(name);
    if (typeof v !== 'string' || !v.trim()) continue;
    const fp = fingerprint(v);
    let action = 'import';
    if (isReserved(name)) action = 'skip-reserved';
    else if (!checkValue(v).ok) action = `skip-${checkValue(v).error}`;
    else if (!inspectEnvValue(name, v).ok) action = 'skip-placeholder';
    else if (stored.get(name) === fp) action = 'unchanged';
    else if (stored.has(name) && !opts.overwrite) action = 'differs-kept';
    plan.push({ name, fingerprint: fp, action });
  }
  return plan;
}

async function main() {
  const apply = isApply();
  const overwrite = isOverwrite();
  const { store, appEnv, appEnvFile } = openScriptStore();
  if (!appEnv) throw new Error(`cannot read the app env file at ${appEnvFile}`);
  const st = store.status();
  if (!st.storeReady) throw new Error(`store unavailable: ${st.storeError}`);
  const plan = planImport(appEnv, await store.list(), { overwrite });
  const who = { actor: 'ops:import', ip: 'box' };
  for (const p of plan) {
    let outcome = p.action;
    if (apply && p.action === 'import') {
      await store.set(p.name, appEnv.get(p.name), who);
      outcome = 'imported';
    } else if (apply) {
      await store.audit({ ...who, action: 'import', name: p.name, outcome: p.action, detail: `fingerprint ${p.fingerprint}` }, []);
    }
    console.log(`${p.name.padEnd(36)} fp=${p.fingerprint}  ${outcome}`);
  }
  console.log(`[secrets-import] ${plan.length} catalogue name(s) found in ${appEnvFile}; ${apply ? 'APPLIED' : 'dry run — set APPLY=1 to write'}`);
  if (apply) {
    const { applyNow } = require(path.join(LIB, 'secrets', 'panel.js'));
    const { unitEnvPath } = require(path.join(LIB, 'secrets', 'materialize.js'));
    const r = await applyNow({ store, unitEnvFile: unitEnvPath(process.env), ctx: who });
    console.log(`[secrets-import] unit env file ${r.path}: applied=${r.applied} count=${r.count}${r.reason ? ` reason=${r.reason}` : ''}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[secrets-import] failed: ${err && (err.reason || err.message)}`);
    process.exit(1);
  });
}

module.exports = { planImport };
