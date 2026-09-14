'use strict';

/**
 * One answer to "did this command fail, or did it never get to run?"
 *
 * A test runner that exits non-zero because a binary is missing, a module
 * cannot be resolved, or the build failed before the test task is not a
 * failing test suite — it is OUR environment. Reporting "tests failed"
 * there blames the customer's code for the scanner's box (doctrine §1: the
 * third state is "not checked", and it must be visible). unitTests and
 * integrationTests both ask this; until 2026-09-05 only unitTests did, so
 * nest's and prisma's `test:integration` — run here with no dependencies
 * installed — blocked as "Integration tests failed".
 */

const fs = require('fs');
const path = require('path');

// Each alternation is a runner that never reached a test: a missing binary
// (`/bin/sh: 1: vendor/bin/phpunit: not found` — laravel, where composer had
// not run), a missing module, or a BUILD that failed before the test task
// (ktor's Gradle compile under a toolchain this box does not have).
const MISSING_TOOLCHAIN_RE = /ModuleNotFoundError|No module named|command not found|is not recognized as an internal|ENOENT|not found: |: not found\b|Cannot find module|npm ERR! missing script|could not determine executable to run|Could not find a version that satisfies|SDK location not found|Could not resolve all (?:files|dependencies)|Unsupported class file major version|Execution failed for task '[^']*:compile|Compilation error\. See log|BUILD FAILURE[\s\S]*COMPILATION ERROR/i;

/** @param {string} out combined stdout + stderr */
function looksLikeMissingToolchain(out) {
  return MISSING_TOOLCHAIN_RE.test(String(out || ''));
}

/**
 * A Node project whose dependencies were never installed cannot run its
 * scripts at all; say so before trying (a fresh clone in CI, or here).
 */
function nodeDepsMissing(projectRoot) {
  const pkg = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkg)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(pkg, 'utf-8'));
    const declares = Object.keys(manifest.dependencies || {}).length + Object.keys(manifest.devDependencies || {}).length;
    if (declares === 0) return false;
  } catch { return false; } // error-ok — an unreadable manifest is a different finding (syntax module)
  return !fs.existsSync(path.join(projectRoot, 'node_modules'));
}

module.exports = { looksLikeMissingToolchain, nodeDepsMissing };
