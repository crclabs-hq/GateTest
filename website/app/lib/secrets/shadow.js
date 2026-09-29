'use strict';
/**
 * Shadow detector — would a DIFFERENT value than the stored one win at runtime?
 *
 * ── Precedence, as it actually works on the box ────────────────────────────
 * 1. systemd builds the web process environment before Node starts.
 *    gatetest-web@.service reads `EnvironmentFile=/opt/gatetest/website/.env.local`
 *    and then `EnvironmentFile=-/var/lib/gatetest/unit-env/platform.env` LAST.
 *    systemd.exec(5): when the same variable is set by more than one
 *    EnvironmentFile=, the files are read in order and the LATER one wins;
 *    variables from EnvironmentFile= also override Environment= lines. So the
 *    store's rendered file beats a raw line for the same name in .env.local.
 * 2. `next start` then loads .env files, but only fills names that are NOT
 *    already in process.env. Next 16 docs
 *    (node_modules/next/dist/docs/01-app/02-guides/environment-variables.md,
 *    "Environment Variable Load Order"): lookup goes `process.env`, then
 *    `.env.$(NODE_ENV).local`, `.env.local`, `.env.$(NODE_ENV)`, `.env`,
 *    "stopping once the variable is found". So Next can never override what
 *    systemd put there.
 *
 * Therefore the stored value LOSES when:
 *   - the running process was started before the last apply (the restart the
 *     path unit triggers has not happened, or failed), or
 *   - the process was started by a unit without the platform.env line (the
 *     old single gatetest-web.service, or a template not yet reinstalled) —
 *     then the raw .env.local line wins, or
 *   - something else in the unit sets it after platform.env (nothing today).
 * All three show up the same way: process.env[name] differs from the stored
 * value. The winner is named `app-env-file` when the runtime value equals the
 * raw line in the app env file, `process-env` otherwise.
 *
 * Comparison is by fingerprint only — no value leaves this function.
 */

const nodeFs = require('node:fs');
const { fingerprint } = require('./crypto');
const { parseEnvFile } = require('./render-env');

const DEFAULT_APP_ENV_PATH = '/opt/gatetest/website/.env.local';

function appEnvPath(env = process.env) {
  const v = env.GATETEST_APP_ENV_PATH;
  return typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_APP_ENV_PATH;
}

/** Parsed app env file, or null when it cannot be read (then it is simply not compared). */
function readAppEnv(file, fs = nodeFs) {
  try {
    return parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function fp(v) {
  return typeof v === 'string' && v.length ? fingerprint(v) : null;
}

/**
 * @param {{ name:string, storedFingerprint:string|null,
 *           runtimeEnv: Record<string,string|undefined>, appEnv: Map<string,string>|null }} a
 * @returns {{ shadowed:boolean, shadowWinner?:'app-env-file'|'process-env',
 *             source:'store'|'env'|'both'|'none', live:boolean }}
 */
function detectShadow(a) {
  const runtimeFp = fp(a.runtimeEnv[a.name]);
  const appFp = a.appEnv && a.appEnv.has(a.name) ? fp(a.appEnv.get(a.name)) : null;
  const stored = Boolean(a.storedFingerprint);
  const envHasOwn = Boolean(appFp) || Boolean(runtimeFp && (!stored || runtimeFp !== a.storedFingerprint));
  const source = stored && envHasOwn ? 'both' : stored ? 'store' : envHasOwn ? 'env' : 'none';
  if (!stored) return { shadowed: false, source, live: Boolean(runtimeFp) };
  if (!runtimeFp) {
    // The stored value is not in the running process at all — pending apply /
    // restart, not a shadow: nothing else is answering in its place.
    return { shadowed: false, source, live: false };
  }
  if (runtimeFp === a.storedFingerprint) return { shadowed: false, source, live: true };
  return {
    shadowed: true,
    shadowWinner: appFp && appFp === runtimeFp ? 'app-env-file' : 'process-env',
    source,
    live: false,
  };
}

module.exports = { appEnvPath, readAppEnv, detectShadow };
