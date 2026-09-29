'use strict';
/**
 * Write the rendered secrets file atomically, or say why not.
 *
 * Default target /var/lib/gatetest/unit-env/platform.env (GATETEST_UNIT_ENV_PATH
 * overrides). gatetest-web@.service loads it as its LAST EnvironmentFile=, and
 * gatetest-secrets-apply.path watches it and runs the blue/green restart — the
 * web process never restarts itself and never needs sudo.
 *
 * Sequence (each step fixes a hole in the design this was copied from):
 *   1. refuse if the render would DROP a key already in the file that the
 *      caller did not name in `allowRemoving` (a partial store read must not
 *      silently unset a production credential);
 *   2. write `<file>.tmp-<pid>-<rand>` in the SAME directory, mode 0600,
 *      fsync it;
 *   3. read the tmp file back and check every intended key parses back to
 *      exactly the intended value — the file systemd will read is the file
 *      we verified;
 *   4. keep the previous file as `<file>.bak` (0600, fsynced);
 *   5. rename tmp over the target, then fsync the directory so the rename
 *      itself survives a power cut.
 *
 * Never throws and never falls back to another path: an unwritable directory
 * is `{ applied:false, reason }`. Returns and reports key NAMES only.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');
const { renderEnv, parseEnvFile } = require('./render-env');

const DEFAULT_UNIT_ENV_PATH = '/var/lib/gatetest/unit-env/platform.env';

function unitEnvPath(env = process.env) {
  const v = env.GATETEST_UNIT_ENV_PATH;
  return typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_UNIT_ENV_PATH;
}

function readExisting(fs, file) {
  try {
    return parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return new Map();
    throw err;
  }
}

function writeFileSynced(fs, file, text, flags) {
  const fd = fs.openSync(file, flags, 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
}

function fsyncDir(fs, dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
    return true;
  } catch {
    // Windows cannot open or fsync a directory; on Linux this succeeds.
    return false;
  } finally {
    if (fd !== null) closeQuietly(fs, fd);
  }
}

/** Close a directory handle; a failed close cannot undo a completed fsync. */
function closeQuietly(fs, fd) {
  try {
    fs.closeSync(fd);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EBADF');
  }
}

function readBackMismatches(fs, tmp, entries) {
  const parsed = parseEnvFile(fs.readFileSync(tmp, 'utf8'));
  const bad = entries.filter((e) => parsed.get(e.name) !== e.value).map((e) => e.name);
  if (parsed.size !== entries.length) {
    for (const n of parsed.keys()) if (!entries.some((e) => e.name === n)) bad.push(n);
  }
  return bad;
}

/**
 * @param {{ entries: Array<{name:string,value:string}>, path?: string, fs?: object,
 *           now?: number, allowRemoving?: string[] }} opts
 * @returns {{applied:boolean, reason?:string, path:string, count:number, names?:string[], dropped?:string[], dirSynced?:boolean}}
 */
function materialize(opts) {
  const fs = opts.fs || nodeFs;
  const file = opts.path || unitEnvPath();
  const entries = opts.entries || [];
  const base = { path: file, count: entries.length };
  const dir = nodePath.dirname(file);
  let tmp = null;
  try {
    try {
      fs.accessSync(dir, nodeFs.constants.W_OK);
    } catch (err) {
      return { ...base, applied: false, reason: accessReason(err) };
    }
    const existing = readExisting(fs, file);
    const allow = new Set(opts.allowRemoving || []);
    const keep = new Set(entries.map((e) => e.name));
    const dropped = [...existing.keys()].filter((n) => !keep.has(n) && !allow.has(n)).sort();
    if (dropped.length) return { ...base, applied: false, reason: 'would_drop_keys', dropped };

    const text = renderEnv(entries, { now: opts.now });
    tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    writeFileSynced(fs, tmp, text, 'wx');
    const bad = readBackMismatches(fs, tmp, entries);
    if (bad.length) {
      fs.unlinkSync(tmp);
      tmp = null;
      return { ...base, applied: false, reason: 'readback_mismatch', names: bad.sort() };
    }
    if (existing.size || fileExists(fs, file)) {
      writeFileSynced(fs, `${file}.bak`, fs.readFileSync(file, 'utf8'), 'w');
    }
    fs.renameSync(tmp, file);
    tmp = null;
    const dirSynced = fsyncDir(fs, dir);
    return { ...base, applied: true, names: entries.map((e) => e.name).sort(), dirSynced };
  } catch (err) {
    if (tmp) removeQuietly(fs, tmp);
    if (err && err.name === 'RenderError') {
      return { ...base, applied: false, reason: `render_failed: ${err.code}`, names: [err.secretName] };
    }
    return { ...base, applied: false, reason: `write_failed: ${(err && (err.code || err.name)) || 'error'}` };
  }
}

/**
 * Reason spellings the admin UI words (website/app/admin/secrets/logic.js):
 * target-missing, permission_denied; anything else is passed through.
 */
function accessReason(err) {
  const code = err && err.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'target-missing';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'permission_denied';
  return `unit_env_dir_not_writable${code ? `: ${code}` : ''}`;
}

/**
 * Remove a leftover tmp file after a failed write. Returns whether it went;
 * a tmp that cannot be removed is 0600 in a 0700 directory and is replaced by
 * the next write's own tmp name, so the failure answer already given stands.
 */
function removeQuietly(fs, file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'ENOENT');
  }
}

function fileExists(fs, file) {
  try { fs.accessSync(file, nodeFs.constants.F_OK); return true; } catch { return false; }
}

module.exports = { unitEnvPath, materialize, accessReason };
