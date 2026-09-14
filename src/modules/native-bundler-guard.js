/**
 * Native Bundler Guard — catches native Node addons in bundled projects.
 *
 * Native packages (those with `.node` binary files or `node-pre-gyp` builds)
 * cannot be bundled by bun --bundle, webpack, esbuild, or Rollup. The error
 * only surfaces at runtime — often in production — when the bundler either
 * silently omits the .node file or throws a `require.extensions['.node']`
 * error.
 *
 * This module:
 *   1. Detects bundling scripts in package.json (bun build, webpack, esbuild,
 *      rollup, tsup, ncc, pkg, nexe).
 *   2. Scans dependencies for known-native packages.
 *   3. Flags any native package present alongside a bundler script.
 *   4. Also flags `require('*.node')` calls in source (direct .node load).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const BaseModule    = require('./base-module');
const { makeAutoFix } = require('../core/ai-fix-engine');

// ─── well-known native packages ────────────────────────────────────────────

const NATIVE_PACKAGES = new Map([
  // Database
  ['better-sqlite3',     'Uses a compiled .node binary — cannot be bundled; keep as an external.'],
  ['libsql',             'LibSQL native addon — cannot be bundled; use external: ["libsql"] in your bundler config.'],
  ['sqlite3',            'SQLite native addon — cannot be bundled.'],
  ['mysql2',             'Contains optional native bindings — flag as external.'],
  ['bcrypt',             'bcrypt uses a native addon; consider bcryptjs (pure JS) if bundling.'],
  ['argon2',             'argon2 uses a native addon; cannot be bundled.'],
  ['@node-rs/argon2',    '@node-rs/argon2 is a native Rust addon — cannot be bundled.'],
  ['@node-rs/bcrypt',    '@node-rs/bcrypt is a native Rust addon — cannot be bundled.'],
  // Media / graphics
  ['sharp',              'sharp uses libvips native bindings — cannot be bundled; mark as external.'],
  ['canvas',             'canvas uses Cairo native bindings — cannot be bundled.'],
  ['@napi-rs/canvas',    '@napi-rs/canvas is a native addon — cannot be bundled.'],
  ['pdfkit',             'pdfkit uses optional native fs bindings.'],
  // Crypto / compression
  ['node-forge',         'node-forge may use native crypto — test carefully when bundling.'],
  ['zstd-napi',          'zstd-napi is a native Rust/NAPI addon — cannot be bundled.'],
  ['lzma-native',        'lzma-native uses native bindings — cannot be bundled.'],
  // System / OS
  ['fsevents',           'fsevents is macOS-only and native — exclude from non-macOS bundles.'],
  ['chokidar',           'chokidar depends on fsevents on macOS — mark as external when bundling for macOS targets.'],
  ['cpu-features',       'cpu-features is a native addon.'],
  ['node-gyp-build',     'node-gyp-build is a native build helper — presence indicates a native dependency.'],
  ['bindings',           'bindings resolves .node files — presence indicates a native dependency.'],
  // Electron
  ['electron',           'electron is not bundleable — it is the host runtime.'],
  ['@electron/remote',   '@electron/remote requires the electron host.'],
]);

// ─── bundler detection ─────────────────────────────────────────────────────

const BUNDLER_PATTERNS = [
  /\bbun\s+build\b/,
  /\bwebpack\b/,
  /\besbuild\b/,
  /\brollup\b/,
  /\btsup\b/,
  /\bncc\b/,
  /\bnexe\b/,
  /\bpkg\b.*\.js/,
  /\bparcel\s+build\b/,
  /\bvite\s+build\b/,
  /\bnext\s+build\b/,  // Next.js bundles server-side code
];

function hasBundlerScript(scripts) {
  return Object.values(scripts).some(s =>
    typeof s === 'string' && BUNDLER_PATTERNS.some(re => re.test(s))
  );
}

function detectBundlerTools(scripts) {
  const tools = new Set();
  for (const s of Object.values(scripts)) {
    if (typeof s !== 'string') continue;
    if (/\bbun\s+build\b/.test(s))     tools.add('bun');
    if (/\bwebpack\b/.test(s))         tools.add('webpack');
    if (/\besbuild\b/.test(s))         tools.add('esbuild');
    if (/\brollup\b/.test(s))          tools.add('rollup');
    if (/\btsup\b/.test(s))            tools.add('tsup');
    if (/\bncc\b/.test(s))             tools.add('ncc');
    if (/\bnext\s+build\b/.test(s))    tools.add('next');
  }
  return [...tools];
}

// ─── module ────────────────────────────────────────────────────────────────


/**
 * Is `name` a whole path SEGMENT of `rel`? `rel.includes('node_modules')`
 * is a substring test — it also matches a directory merely CONTAINING the
 * word. Same mistake as `.includes('.git')` matching `.github`.
 */
function hasSegment(rel, name) {
  return typeof rel === 'string' && rel.split(/[\\/]+/).includes(name);
}

class NativeBundlerGuard extends BaseModule {
  constructor() {
    super('nativeBundlerGuard', 'Native Bundler Guard — catches native Node addons that cannot be bundled');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      result.addCheck('native-bundler-guard:no-package-json', true, {
        severity: 'info',
        message: 'No package.json found — bundler guard skipped',
      });
      return;
    }

    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch {
      result.addCheck('native-bundler-guard:parse-error', true, { severity: 'info', message: 'Could not parse package.json' });
      return;
    }

    const scripts = pkg.scripts || {};
    if (!hasBundlerScript(scripts)) {
      result.addCheck('native-bundler-guard:no-bundler', true, {
        severity: 'info',
        message: 'No bundler scripts detected — native addon guard not applicable',
      });
      return;
    }

    const bundlerTools = detectBundlerTools(scripts);
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
    };

    let issueCount = 0;

    for (const [pkg_name, warning] of NATIVE_PACKAGES) {
      if (allDeps[pkg_name]) {
        issueCount++;
        result.addCheck(`native-bundler-guard:${pkg_name}`, false, {
          severity: 'error',
          message: `Native package \`${pkg_name}\` found alongside bundler (${bundlerTools.join(', ')}). ${warning}`,
          file: 'package.json',
          fix: `Add \`${pkg_name}\` to the \`external\` array in your ${bundlerTools[0] || 'bundler'} config so it is not inlined into the bundle.`,
          autoFix: makeAutoFix(
            pkgPath,
            'native-bundler-guard',
            `${pkg_name} is a native package that cannot be bundled`,
            undefined,
            `Add "${pkg_name}" to the external array in your bundler config`
          ),
        });
      }
    }

    // Also scan source for require('*.node')
    const jsFiles = this._collectFiles(projectRoot, ['.js', '.ts', '.mjs', '.cjs']);
    for (const file of jsFiles) {
      const rel = repoRelative(projectRoot, file);
      if (hasSegment(rel, 'node_modules')) continue;
      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      let m;
      const re = /require\s*\(\s*['"`][^'"]+\.node['"`]\s*\)/g;
      while ((m = re.exec(content)) !== null) {
        const lineNo = content.slice(0, m.index).split(/\r?\n/).length;
        issueCount++;
        result.addCheck(`native-bundler-guard:dot-node:${rel}:${lineNo}`, false, {
          severity: 'error',
          message: `Direct \`.node\` binary load in \`${rel}:${lineNo}\` cannot be bundled`,
          file: rel,
          line: lineNo,
          fix: 'Remove the .node require or mark this file as a bundler external.',
          autoFix: makeAutoFix(file, 'native-bundler-guard:dot-node', `Direct .node binary load cannot be bundled`, lineNo, 'Mark this module as external in your bundler config'),
        });
      }
    }

    if (issueCount === 0) {
      result.addCheck('native-bundler-guard:clean', true, {
        severity: 'info',
        message: `No native packages found alongside bundler (${bundlerTools.join(', ')})`,
      });
    }
  }
}

module.exports = NativeBundlerGuard;
