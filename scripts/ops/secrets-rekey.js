#!/usr/bin/env node
'use strict';
/**
 * Master-key rotation sweep for the admin secrets store
 * (docs/ops/secrets-panel.md "Rotating the master key"). Run ON THE BOX:
 *
 *   cd /opt/gatetest
 *   node scripts/ops/secrets-rekey.js           # dry run: which rows are not on the write key
 *   APPLY=1 node scripts/ops/secrets-rekey.js   # re-encrypt them, in batches
 *
 * Keys come from the environment ONLY — GATETEST_SECRETS_MASTER_KEY (the
 * current / old key) and GATETEST_SECRETS_MASTER_KEY_NEXT (the new key) —
 * filled from the app env file when not exported. Never from argv.
 *
 * Every row names the key that encrypted it (`key_version` = v1:<key id>).
 * The write key is NEXT when set, else the current key. A row on any other key
 * is decrypted with the key it names and re-encrypted with the write key; the
 * UPDATE only lands if the row still carries the version this sweep read, so a
 * concurrent edit is never overwritten — re-run and it is picked up. Rows whose
 * key is not loaded are reported, not touched. Re-runnable: a finished sweep
 * reports 0 pending. Prints names and key ids only.
 */

const path = require('path');
const { LIB, WEB, bootEnv, openScriptStore, isApply } = require('./secrets-common');

const { loadKeyring, decrypt, encrypt } = require(path.join(LIB, 'secrets', 'crypto.js'));
const { appendAudit } = require(path.join(LIB, 'secrets', 'audit.js'));

const BATCH = 25;

/** Pure plan: which rows need re-encryption to the keyring's write key. */
function planRekey(rows, keyring) {
  return rows
    .filter((r) => r.keyVersion !== keyring.writeVersion)
    .map((r) => ({ name: r.name, from: r.keyVersion, loaded: Boolean(keyring.keyFor(r.keyVersion)) }));
}

/** Re-encrypt one planned row. @returns {Promise<'rekeyed'|'key-not-loaded'|'changed-concurrently'|'decrypt-failed'>} */
async function rekeyOne(adapter, keyring, item) {
  if (!item.loaded) return 'key-not-loaded';
  const row = await adapter.getSecret(item.name);
  if (!row || row.keyVersion !== item.from) return 'changed-concurrently';
  let plain;
  try { plain = decrypt(keyring, item.name, row); } catch { return 'decrypt-failed'; }
  const sealed = encrypt(keyring, item.name, plain);
  plain = null;
  return (await adapter.replaceCipher(item.name, item.from, sealed)) ? 'rekeyed' : 'changed-concurrently';
}

async function main() {
  const apply = isApply();
  const { env } = bootEnv();
  const keyring = loadKeyring(env, { exampleFiles: [path.join(WEB, '.env.example')] });
  const { adapter } = openScriptStore();
  const plan = planRekey(await adapter.listSecrets(), keyring);
  console.log(`[secrets-rekey] target version ${keyring.writeVersion}${keyring.nextVersion ? ' (NEXT)' : ' (current)'}; ${plan.length} row(s) to move`);
  const counts = {};
  for (let i = 0; i < plan.length; i += BATCH) {
    for (const item of plan.slice(i, i + BATCH)) {
      const outcome = apply ? await rekeyOne(adapter, keyring, item) : (item.loaded ? 'pending' : 'key-not-loaded');
      counts[outcome] = (counts[outcome] || 0) + 1;
      if (apply) {
        await appendAudit(adapter, { actor: 'ops:rekey', action: 'rekey', name: item.name, ip: 'box', outcome, detail: `${item.from}->${keyring.writeVersion}` });
      }
      console.log(`${item.name.padEnd(36)} ${item.from} -> ${keyring.writeVersion}  ${outcome}`);
    }
  }
  console.log(`[secrets-rekey] ${apply ? 'APPLIED' : 'dry run — set APPLY=1 to write'}: ${JSON.stringify(counts)}`);
  if (counts['key-not-loaded'] || counts['decrypt-failed']) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[secrets-rekey] failed: ${err && (err.reason || err.message)}`);
    process.exit(1);
  });
}

module.exports = { planRekey, rekeyOne };
