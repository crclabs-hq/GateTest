'use strict';
/**
 * A sandbox copy of the project for anything that must WRITE to run — the
 * mutation module used to write each mutant into the user's real source
 * file and restore it afterwards, which is one SIGKILL away from a corrupt
 * working tree (the Fifty, move 20: never write to the user's tree).
 *
 * The copy carries the tracked shape of the tree: every file except the
 * walk-excluded directories, with `node_modules` (at any depth) SYMLINKED
 * to the original so installed dependencies resolve without a second
 * install. Bounded: past MAX_FILES or MAX_BYTES the copy is refused and the
 * caller reports "not run" instead of mutating in place — a refusal is
 * honest, a silent fallback is the defect this file exists to remove.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { repoRelative } = require('./repo-path');
const { WALK_EXCLUDES } = require('./walk-excludes');

const MAX_FILES = 40000;
const MAX_BYTES = 512 * 1024 * 1024;
const SKIP = new Set(WALK_EXCLUDES.filter((n) => n !== 'node_modules'));

/**
 * @param {string} projectRoot
 * @param {{prefix?:string, maxFiles?:number, maxBytes?:number}} [opts]
 * @returns {{dir:string, files:number, bytes:number, symlinked:string[]}|{error:string}}
 */
function copyTreeForSandbox(projectRoot, opts = {}) {
  const maxFiles = opts.maxFiles || MAX_FILES;
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const root = path.resolve(projectRoot);
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), opts.prefix || 'gt-sandbox-')); } catch (err) { return { error: `cannot create a sandbox: ${err.message}` }; }
  const stat = { files: 0, bytes: 0, symlinked: [] };

  const walk = (src, dst) => {
    let entries;
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; } // error-ok — an unreadable dir is left out of the copy
    fs.mkdirSync(dst, { recursive: true });
    for (const e of entries) {
      const from = path.join(src, e.name);
      const to = path.join(dst, e.name);
      if (e.name === 'node_modules' && e.isDirectory()) {
        fs.symlinkSync(from, to, 'junction');
        stat.symlinked.push(repoRelative(root, from));
        continue;
      }
      if (SKIP.has(e.name)) continue;
      if (e.isSymbolicLink()) continue; // never follow a link out of the tree
      if (e.isDirectory()) { walk(from, to); continue; }
      if (!e.isFile()) continue;
      // Copy, then measure the COPY: no check on the source followed by an
      // act on it (raceCondition:fs-toctou, found by the self-scan).
      fs.copyFileSync(from, to);
      stat.files++; stat.bytes += fs.statSync(to).size;
      if (stat.files > maxFiles || stat.bytes > maxBytes) {
        throw Object.assign(new Error(`tree exceeds the sandbox bound (${stat.files} files / ${Math.round(stat.bytes / 1048576)} MB; limit ${maxFiles} files / ${Math.round(maxBytes / 1048576)} MB)`), { bound: true });
      }
    }
  };

  try {
    walk(root, dir);
  } catch (err) {
    removeTree(dir);
    return { error: err.message };
  }
  return { dir, ...stat };
}

/** Best-effort removal; never throws. */
function removeTree(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* error-ok — a leftover temp dir is not a scan failure */ }
}

module.exports = { copyTreeForSandbox, removeTree, MAX_FILES };
