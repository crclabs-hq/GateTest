'use strict';
/**
 * Complaint C22 first-run hint: does the project's OWN `.gitignore` already
 * cover `.gatetest/`? If not — and the scan actually wrote there — the CLI
 * prints one stderr line pointing at `--report-dir` / `--no-artifacts`.
 *
 * Deliberately does NOT reuse `gitignore.js`'s `buildIgnoreMatcher` — that
 * matcher hard-skips `.gatetest` unconditionally (`src/core/walk-excludes.js`,
 * so a scan never walks its own report output) and would report "already
 * ignored" even on a repo whose real `.gitignore` has no such line, which is
 * exactly the customer this hint exists for. It reuses `compilePattern`
 * instead — the one definition of gitignore pattern syntax — without the
 * hard-skip contamination.
 */

const fs = require('fs');
const path = require('path');
const { compilePattern } = require('./gitignore');

/** Only the root `.gitignore` — `.gatetest/` is a project-root concern. */
function gatetestDirIsGitignored(projectRoot) {
  let content;
  try {
    content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
  } catch {
    return false; // no .gitignore at all — definitely not covered
  }
  let ignored = false;
  for (const line of content.split('\n')) {
    const compiled = compilePattern(line, '');
    if (!compiled) continue;
    // `.gatetest` is always tested as a directory, so a dirOnly pattern
    // (`.gatetest/`) still applies — no isDir gate needed here.
    if (compiled.regex.test('.gatetest')) ignored = !compiled.negate;
  }
  return ignored;
}

function isGitRepo(projectRoot) {
  try {
    return fs.existsSync(path.join(projectRoot, '.git'));
  } catch {
    return false;
  }
}

module.exports = { gatetestDirIsGitignored, isGitRepo };
