'use strict';
/**
 * Names the admin secrets panel may never store, and the name/value rules.
 *
 * A reserved name is one the store itself, or the authentication in front of
 * it, depends on. Storing one would either brick the store at boot (it cannot
 * decrypt without the key / reach Postgres without DATABASE_URL) or let a
 * stolen admin session rewrite the credential that proves it is admin. Also
 * reserved: the variables that change how the Node process itself runs, since
 * the rendered env file is loaded by the web unit (NODE_OPTIONS=--require …
 * would be code execution, NODE_TLS_REJECT_UNAUTHORIZED=0 would turn off TLS
 * verification for every outbound call).
 */

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_VALUE_BYTES = 16 * 1024;

// { name, reason } rows rather than a name-keyed object, so no line reads as
// `SOME_PASSWORD: "..."` to a secrets scanner.
const RESERVED_LIST = Object.freeze([
  { name: 'GATETEST_SECRETS_MASTER_KEY', reason: "the store's own encryption key" },
  { name: 'GATETEST_SECRETS_MASTER_KEY_NEXT', reason: "the store's rotation key" },
  { name: 'GATETEST_ADMIN_PASSWORD', reason: 'admin auth derives the admin cookie and the step-up cookie from it (app/lib/admin-auth.ts)' },
  { name: 'ADMIN_PASSWORD', reason: 'an older name for the admin credential' },
  { name: 'GATETEST_ADMIN_USERNAMES', reason: 'admin allowlist, GitHub logins and emails (app/lib/admin-allowlist.ts)' },
  { name: 'GATETEST_ADMIN_EMAILS', reason: 'admin allowlist by verified email (app/lib/admin-allowlist.ts)' },
  { name: 'SESSION_SECRET', reason: 'signs customer and admin OAuth sessions' },
  { name: 'DATABASE_URL', reason: 'the store needs it to boot' },
  { name: 'GATETEST_UNIT_ENV_PATH', reason: 'where the store writes — must not be redirectable from the store' },
  { name: 'GATETEST_APP_ENV_PATH', reason: 'where the shadow detector reads — must not be redirectable from the store' },
  { name: 'NODE_OPTIONS', reason: 'changes how the Node process loads code' },
  { name: 'NODE_ENV', reason: 'changes the runtime mode of the whole app' },
  { name: 'NODE_TLS_REJECT_UNAUTHORIZED', reason: 'would disable TLS verification process-wide' },
  { name: 'NODE_EXTRA_CA_CERTS', reason: 'would add trusted certificate authorities process-wide' },
  { name: 'PATH', reason: 'process search path' },
  { name: 'HOME', reason: 'process home directory' },
  { name: 'PORT', reason: 'set per blue/green instance by the unit' },
  { name: 'HOSTNAME', reason: 'bind address' },
  { name: 'LD_PRELOAD', reason: 'dynamic loader injection' },
  { name: 'LD_LIBRARY_PATH', reason: 'dynamic loader search path' },
]);
const RESERVED = Object.freeze(Object.fromEntries(RESERVED_LIST.map((r) => [r.name, r.reason])));

/** @returns {{ok:true} | {ok:false, error:'invalid_name'|'reserved_name', reason:string}} */
function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { ok: false, error: 'invalid_name', reason: 'names match ^[A-Z][A-Z0-9_]{1,63}$' };
  }
  if (Object.prototype.hasOwnProperty.call(RESERVED, name)) {
    return { ok: false, error: 'reserved_name', reason: RESERVED[name] };
  }
  return { ok: true };
}

function isReserved(name) {
  return Object.prototype.hasOwnProperty.call(RESERVED, name);
}

/**
 * The value rule. NUL, CR and LF are refused: the rendered env file is one
 * `NAME="value"` per line, and a PEM must be pasted with its newlines written
 * as the two characters `\n` (app/lib/github-app.ts accepts that form).
 * @returns {{ok:true} | {ok:false, error:'value_empty'|'value_too_long'|'value_invalid_chars'}}
 */
function checkValue(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return { ok: false, error: 'value_empty' };
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) return { ok: false, error: 'value_too_long' };
  if (/[\0\r\n]/.test(value)) return { ok: false, error: 'value_invalid_chars' };
  return { ok: true };
}

module.exports = { NAME_RE, MAX_VALUE_BYTES, RESERVED, checkName, checkValue, isReserved };
