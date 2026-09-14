'use strict';
/**
 * The repo-relative form of a path: ONE definition (Doctrine §4).
 *
 * `path.relative()` answers with the OS separator, so a module that embedded
 * the raw answer in a finding reported `src\index.html` on a Windows checkout
 * and `src/index.html` on the Linux CI gating the same commit. A finding id,
 * its `file` field, a `.gatetestignore` line and a baseline fingerprint
 * (`.gatetest/baseline.json`) all carry that string, so the same finding had
 * two identities (KI #109: 27 test files red on Windows only, and a baseline
 * written on one OS silently not matching on the other). Every module reaches
 * for `repoRelative()` instead, and the answer is `/`-joined on every OS.
 */
const path = require('path');

/**
 * `/`-joined form of a path that may carry either separator. Backslashes are
 * treated as separators on every OS: a report or ignore line written on
 * Windows must still read on Linux (finding-registry, ignore-file and
 * test-paths made the same choice, each in a private copy until now).
 * @param {string} p
 * @returns {string}
 */
function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Repo-relative, `/`-joined: the form a path takes inside a finding on every OS.
 * @param {string} root  absolute project root
 * @param {string} abs   absolute (or root-relative) file path
 * @returns {string}
 */
function repoRelative(root, abs) {
  return toPosix(path.relative(root, abs));
}

module.exports = { repoRelative, toPosix };
