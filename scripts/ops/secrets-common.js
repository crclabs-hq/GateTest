'use strict';
/**
 * Shared bootstrap for the box-side secrets scripts (secrets-import-env.js,
 * secrets-rekey.js). Run as root on the box from /opt/gatetest.
 *
 * Configuration comes from the environment, and any of DATABASE_URL,
 * GATETEST_SECRETS_MASTER_KEY and GATETEST_SECRETS_MASTER_KEY_NEXT not already
 * set are read from the app env file (GATETEST_APP_ENV_PATH, default
 * /opt/gatetest/website/.env.local) — so the owner never types a secret on a
 * command line and never sources the file into a shell. Nothing here takes a
 * value from argv, and nothing prints one.
 */

const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'website');
const LIB = path.join(WEB, 'app', 'lib');

const { parseEnvFile } = require(path.join(LIB, 'secrets', 'render-env.js'));
const { appEnvPath, readAppEnv } = require(path.join(LIB, 'secrets', 'shadow.js'));
const { createSecretsStore } = require(path.join(LIB, 'secrets', 'store.js'));
const { createPgAdapter } = require(path.join(LIB, 'secrets', 'store-pg.js'));

const BOOT_NAMES = ['DATABASE_URL', 'GATETEST_SECRETS_MASTER_KEY', 'GATETEST_SECRETS_MASTER_KEY_NEXT', 'SESSION_SECRET', 'GATETEST_ADMIN_PASSWORD'];

/** process.env, with the boot names filled from the app env file when absent. */
function bootEnv(env = process.env) {
  const file = appEnvPath(env);
  const appEnv = readAppEnv(file);
  const out = { ...env };
  if (appEnv) {
    for (const n of BOOT_NAMES) {
      if (!out[n] && appEnv.has(n)) out[n] = appEnv.get(n);
    }
  }
  return { env: out, appEnv, appEnvFile: file };
}

function neonSql(databaseUrl) {
  const modPath = require.resolve('@neondatabase/serverless', { paths: [WEB] });
  const { neon } = require(modPath);
  return neon(databaseUrl);
}

/** @returns {{ store, adapter, env, appEnv, appEnvFile }} */
function openScriptStore() {
  const boot = bootEnv();
  if (!boot.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (environment or app env file)');
  const adapter = createPgAdapter(neonSql(boot.env.DATABASE_URL));
  const store = createSecretsStore({
    adapter,
    env: boot.env,
    exampleFiles: [path.join(WEB, '.env.example')],
  });
  return { store, adapter, ...boot };
}

/** APPLY=1 or --apply writes; everything else is a dry run. */
function isApply(argv = process.argv, env = process.env) {
  return env.APPLY === '1' || argv.includes('--apply');
}

/** OVERWRITE=1 or --overwrite replaces stored values that differ (import only). */
function isOverwrite(argv = process.argv, env = process.env) {
  return env.OVERWRITE === '1' || argv.includes('--overwrite');
}

module.exports = { WEB, LIB, bootEnv, openScriptStore, isApply, isOverwrite, parseEnvFile };
