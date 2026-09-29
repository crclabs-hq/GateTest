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
 * A BUILD/TRANSFORM tool broke before any test could run — esbuild, tsc,
 * babel or node itself choking on the suite's own files or config. Distinct
 * from MISSING_TOOLCHAIN_RE (a binary or dependency that was never
 * installed): the toolchain here IS present, it just can't process what it
 * was given. AlecRae.com (issue #771, GT-14b) pinned an esbuild ES2024
 * target this scan box's Node did not support, and unitTests reported "Unit
 * tests failed" for a suite that never got the chance to run a single test.
 * Checked only AFTER `looksLikeMissingToolchain` and only when no genuine
 * test failure (TAP `not ok`, jest/mocha stack frame) was parsed out of the
 * same output — a real failure always wins.
 */
const TOOLCHAIN_BUILD_FAILURE_RE = /Transform failed with \d+ error|ERR_UNKNOWN_FILE_EXTENSION|Unsupported ES target|SyntaxError:\s*Unexpected token|\bEACCES\b/i;

/** @param {string} out combined stdout + stderr */
function looksLikeToolchainBuildFailure(out) {
  return TOOLCHAIN_BUILD_FAILURE_RE.test(String(out || ''));
}

/**
 * The first output line that actually names the toolchain failure (the line
 * TOOLCHAIN_BUILD_FAILURE_RE matched), falling back to the first non-blank
 * line — used for the three-state "tests could not run: <first error line>;
 * not checked" wording so the customer sees the real signal, not line one of
 * a stack trace (`[eval]:1`) that says nothing.
 */
function firstToolchainErrorLine(out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => TOOLCHAIN_BUILD_FAILURE_RE.test(l));
  return (hit || lines[0] || 'unknown error').slice(0, 200);
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

module.exports = { looksLikeMissingToolchain, nodeDepsMissing, looksLikeToolchainBuildFailure, firstToolchainErrorLine };
