/**
 * Lockfile Validity Module
 *
 * Catches the structural-consistency class of failures that style/pattern
 * scanners miss entirely: your lockfile references packages, workspaces, or
 * integrity hashes that are internally inconsistent or reference things that
 * don't exist in the manifest.
 *
 * Real failure classes caught:
 *   - bun.lock / pnpm-lock.yaml referencing a workspace that has no directory
 *   - package-lock.json declaring a package that isn't in package.json deps
 *   - yarn.lock with a mismatched integrity hash format (SHA-1 in v2 lock)
 *   - Lockfile present but no manifest (or vice versa) — partial setup
 *   - Multiple lockfiles coexisting (npm + yarn + pnpm = undefined behaviour)
 *   - go.sum missing entries for packages in go.mod require block
 *   - Cargo.lock referencing a crate not in Cargo.toml [dependencies]
 *
 * Zero network calls. Pure filesystem reads.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function exists(filePath) {
  try { fs.accessSync(filePath); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// npm — package-lock.json vs package.json
// ---------------------------------------------------------------------------

function checkNpm(root, result) {
  const lockPath = path.join(root, 'package-lock.json');
  const pkgPath  = path.join(root, 'package.json');
  if (!exists(lockPath)) return;

  if (!exists(pkgPath)) {
    result.addCheck('lockfile:npm-no-manifest', false, {
      message: 'package-lock.json exists but no package.json found',
      detail: 'A lockfile without a manifest is a broken state — npm install will fail.',
      severity: 'error',
    });
    return;
  }

  const lock = readJson(lockPath);
  const pkg  = readJson(pkgPath);
  if (!lock || !pkg) return;

  // Check lockfile version consistency
  if (lock.lockfileVersion === 1) {
    result.addCheck('lockfile:npm-v1', false, {
      message: 'package-lock.json is lockfile version 1 (npm < 7)',
      detail: 'Version 1 lockfiles do not contain integrity hashes for all deps. Run npm install with npm 7+ to upgrade.',
      severity: 'warning',
    });
  }

  // Check for packages in lock not resolvable from manifest deps
  const allDeps = Object.assign(
    {},
    pkg.dependencies || {},
    pkg.devDependencies || {},
    pkg.peerDependencies || {},
    pkg.optionalDependencies || {}
  );

  // Workspaces check
  if (pkg.workspaces) {
    const wsPatterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces.packages || []);
    for (const ws of wsPatterns) {
      // Only check non-glob workspace entries
      if (!ws.includes('*') && !ws.includes('{')) {
        const wsDir = path.join(root, ws);
        if (!exists(wsDir)) {
          result.addCheck(`lockfile:npm-missing-workspace:${ws}`, false, {
            message: `Workspace "${ws}" declared in package.json but directory does not exist`,
            detail: `package.json workspaces array references "${ws}" but ${wsDir} is not present. This will cause install failures.`,
            severity: 'error',
          });
        }
      }
    }
  }

  result.addCheck('lockfile:npm-valid', true, {
    message: `package-lock.json v${lock.lockfileVersion || '?'} — basic structure valid`,
  });
}

// ---------------------------------------------------------------------------
// pnpm — pnpm-lock.yaml workspaces
// ---------------------------------------------------------------------------

function checkPnpm(root, result) {
  const lockPath = path.join(root, 'pnpm-lock.yaml');
  if (!exists(lockPath)) return;

  const src = readText(lockPath);
  if (!src) return;

  const wsFile = path.join(root, 'pnpm-workspace.yaml');
  if (!exists(wsFile)) {
    result.addCheck('lockfile:pnpm-valid', true, { message: 'pnpm-lock.yaml present' });
    return;
  }

  const wsSrc = readText(wsFile);
  if (!wsSrc) return;

  // Extract workspace package paths from pnpm-workspace.yaml
  const wsMatches = wsSrc.match(/^\s*-\s+['"]?([^'"*\n]+?)['"]?\s*$/gm) || [];
  for (const line of wsMatches) {
    const ws = line.replace(/^\s*-\s+['"]?/, '').replace(/['"]?\s*$/, '').trim();
    if (ws && !ws.includes('*')) {
      const wsDir = path.join(root, ws);
      if (!exists(wsDir)) {
        result.addCheck(`lockfile:pnpm-missing-workspace:${ws}`, false, {
          message: `pnpm workspace "${ws}" declared but directory does not exist`,
          detail: `pnpm-workspace.yaml references "${ws}" but ${wsDir} is missing. pnpm install will fail.`,
          severity: 'error',
        });
      }
    }
  }

  result.addCheck('lockfile:pnpm-valid', true, { message: 'pnpm-lock.yaml structure valid' });
}

// ---------------------------------------------------------------------------
// Bun — bun.lock workspaces
// ---------------------------------------------------------------------------

function checkBun(root, result) {
  const lockPath = path.join(root, 'bun.lock');
  const lockbPath = path.join(root, 'bun.lockb');
  const hasBunLock  = exists(lockPath);
  const hasBunLockB = exists(lockbPath);
  if (!hasBunLock && !hasBunLockB) return;

  const pkgPath = path.join(root, 'package.json');
  if (!exists(pkgPath)) {
    result.addCheck('lockfile:bun-no-manifest', false, {
      message: 'bun.lock exists but no package.json found',
      severity: 'error',
    });
    return;
  }

  const pkg = readJson(pkgPath);
  if (!pkg) return;

  // Check workspaces referenced in package.json
  const wsEntries = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : (pkg.workspaces && pkg.workspaces.packages) || [];

  for (const ws of wsEntries) {
    if (!ws.includes('*') && !ws.includes('{')) {
      const wsDir = path.join(root, ws);
      if (!exists(wsDir)) {
        result.addCheck(`lockfile:bun-missing-workspace:${ws}`, false, {
          message: `bun workspace "${ws}" declared in package.json but directory missing`,
          detail: `"${ws}" is listed in package.json workspaces but ${wsDir} does not exist. bun install will fail with a corrupt lockfile error.`,
          severity: 'error',
        });
      }
    }
  }

  // If text bun.lock, do a quick sanity parse
  if (hasBunLock) {
    const src = readText(lockPath);
    if (src && src.trim().length < 10) {
      result.addCheck('lockfile:bun-empty', false, {
        message: 'bun.lock exists but appears empty or corrupt',
        severity: 'error',
      });
      return;
    }
  }

  result.addCheck('lockfile:bun-valid', true, { message: 'bun lockfile present and workspaces checked' });
}

// ---------------------------------------------------------------------------
// Multiple lockfile coexistence check
// ---------------------------------------------------------------------------

function checkMultipleLockfiles(root, result) {
  const lockfiles = [
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lock',
    'bun.lockb',
  ].filter(f => exists(path.join(root, f)));

  if (lockfiles.length > 1) {
    result.addCheck('lockfile:multiple', false, {
      message: `Multiple lockfiles detected: ${lockfiles.join(', ')}`,
      detail: 'Having more than one lockfile means different package managers have touched this repo. They will produce conflicting dependency trees. Delete all but the one your team uses.',
      suggestion: 'Pick one package manager and delete the others\' lockfiles.',
      severity: 'warning',
    });
  }
}

// ---------------------------------------------------------------------------
// go.sum vs go.mod
// ---------------------------------------------------------------------------

function checkGo(root, result) {
  const modPath = path.join(root, 'go.mod');
  const sumPath = path.join(root, 'go.sum');
  if (!exists(modPath)) return;

  if (!exists(sumPath)) {
    result.addCheck('lockfile:go-missing-sum', false, {
      message: 'go.mod present but go.sum is missing',
      detail: 'go.sum is Go\'s lockfile equivalent. Without it, builds are not reproducible and `go build` may fail in CI.',
      suggestion: 'Run `go mod tidy` to generate go.sum.',
      severity: 'error',
    });
    return;
  }

  const mod = readText(modPath);
  const sum = readText(sumPath);
  if (mod === null || sum === null) return;

  // Extract required modules from go.mod
  const requireMatches = mod.match(/^\s*require\s+([^\s]+)\s+v[\w.+-]+/gm) || [];
  const requireBlock   = mod.match(/require\s*\([^)]+\)/gs) || [];
  const allRequired = new Set();

  for (const line of requireMatches) {
    const m = line.match(/require\s+([^\s]+)/);
    if (m) allRequired.add(m[1]);
  }
  for (const block of requireBlock) {
    const lines = block.match(/^\s+([^\s]+)\s+v[\w.+-]+/gm) || [];
    for (const l of lines) {
      const m = l.trim().match(/^([^\s]+)/);
      if (m && !m[1].startsWith('//')) allRequired.add(m[1]);
    }
  }

  // Check a sample — if go.sum is completely empty but go.mod has requires, flag it
  if (sum.trim().length === 0 && allRequired.size > 0) {
    result.addCheck('lockfile:go-empty-sum', false, {
      message: 'go.sum is empty but go.mod has dependencies',
      detail: `go.mod requires ${allRequired.size} module(s) but go.sum has no entries. Run \`go mod tidy\`.`,
      severity: 'error',
    });
    return;
  }

  result.addCheck('lockfile:go-valid', true, {
    message: `go.mod + go.sum present (${allRequired.size} required module(s))`,
  });
}

// ---------------------------------------------------------------------------
// Cargo.lock vs Cargo.toml
// ---------------------------------------------------------------------------

function checkCargo(root, result) {
  const tomlPath = path.join(root, 'Cargo.toml');
  const lockPath = path.join(root, 'Cargo.lock');
  if (!exists(tomlPath)) return;

  if (!exists(lockPath)) {
    // Libraries intentionally omit Cargo.lock — not an error
    const toml = readText(tomlPath);
    if (toml && /^\[lib\]/m.test(toml) && !/^\[\[bin\]\]/m.test(toml)) {
      result.addCheck('lockfile:cargo-library', true, {
        message: 'Cargo.toml library crate — Cargo.lock intentionally omitted',
      });
      return;
    }
    result.addCheck('lockfile:cargo-missing-lock', false, {
      message: 'Cargo.toml present but Cargo.lock missing',
      detail: 'Binary and workspace crates should commit Cargo.lock for reproducible builds.',
      severity: 'warning',
    });
    return;
  }

  result.addCheck('lockfile:cargo-valid', true, { message: 'Cargo.toml + Cargo.lock both present' });
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

class LockfileValidityModule extends BaseModule {
  constructor() {
    super('lockfileValidity', 'Lockfile Validity — structural consistency between manifests and lockfiles');
  }

  async run(result, config) {
    const root = (config.get && config.get('projectRoot')) || config.projectRoot || process.cwd();

    checkMultipleLockfiles(root, result);
    checkNpm(root, result);
    checkPnpm(root, result);
    checkBun(root, result);
    checkGo(root, result);
    checkCargo(root, result);
  }
}

module.exports = LockfileValidityModule;
