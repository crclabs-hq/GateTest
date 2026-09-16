'use strict';
/**
 * engine-bridge.js — the VS Code extension's in-process link to the GateTest
 * engine.
 *
 * The extension used to spawn the `gatetest` CLI with `--format json` and
 * `--file`, two flags the CLI never had, and then JSON.parse a console
 * report. It also needed the binary on PATH, which broke on Windows
 * (spawn EINVAL) and on every machine without a global install.
 *
 * Now the engine is loaded as a library — the same `GateTest` class the MCP
 * server and the hosted preview already call — inside a worker thread so a
 * long scan never freezes the editor. This file is plain CommonJS with no
 * `vscode` import so it can be unit-tested from the repo's node:test suite
 * without compiling the extension.
 */

const fs = require('fs');
const path = require('path');

/** Modules the editor never runs: they need a test runner / long wall-clock
 *  and belong to CI. Reported back as "deferred" so the user knows. */
const EDITOR_SKIP_MODULES = ['mutation', 'chaos'];

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Accepts a package dir, its src/index.js, or any file inside the package. */
function entryFromPath(p) {
  if (!p) return null;
  const candidate = path.resolve(p);
  if (!fs.existsSync(candidate)) return null;
  if (fs.statSync(candidate).isFile()) {
    // A file — walk up to the package root so we can read its version.
    let dir = path.dirname(candidate);
    for (let i = 0; i < 6; i++) {
      const pkg = readPkg(dir);
      if (pkg && pkg.name === '@gatetest/cli') {
        return { entry: candidate, version: pkg.version, packageDir: dir };
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }
  const pkg = readPkg(candidate);
  if (!pkg || pkg.name !== '@gatetest/cli') return null;
  const main = path.join(candidate, pkg.main || 'src/index.js');
  return fs.existsSync(main) ? { entry: main, version: pkg.version, packageDir: candidate } : null;
}

/**
 * Where the engine comes from, first match wins:
 *   1. `gatetest.enginePath` (a checkout or an installed @gatetest/cli)
 *   2. the workspace's own node_modules/@gatetest/cli (pinned by the project)
 *   3. the copy bundled with the extension (node_modules/@gatetest/cli)
 *   4. a sibling checkout — the extension lives inside the GateTest repo
 *      at vscode-extension/, so ../src/index.js is the engine under development
 */
function resolveEngineEntry({ configuredPath, workspaceRoot, extensionDir } = {}) {
  const attempts = [];
  const tryOne = (source, p) => {
    if (!p) return null;
    const hit = entryFromPath(p);
    attempts.push({ source, path: p, ok: Boolean(hit) });
    return hit ? { ...hit, source, attempts } : null;
  };

  return (
    tryOne('setting', configuredPath && configuredPath.trim()) ||
    tryOne('workspace', workspaceRoot && path.join(workspaceRoot, 'node_modules', '@gatetest', 'cli')) ||
    tryOne('bundled', extensionDir && path.join(extensionDir, 'node_modules', '@gatetest', 'cli')) ||
    tryOne('checkout', extensionDir && path.dirname(extensionDir)) ||
    { entry: null, version: null, source: null, attempts }
  );
}

/** Make a finding's path absolute under the scanned root. */
function absoluteFile(root, file) {
  if (!file) return null;
  return path.isAbsolute(file) ? file : path.join(root, file);
}

/**
 * The engine's ranked, deduplicated findings → editor diagnostics. Findings
 * with no file (repo-level checks such as "no CI config") are returned
 * separately so the caller can print them in the output channel.
 */
function findingsToDiagnostics(summary, root, { onlyFile } = {}) {
  const findings = Array.isArray(summary && summary.findings) ? summary.findings : [];
  const wanted = onlyFile ? path.resolve(onlyFile) : null;
  const inFiles = [];
  const repoLevel = [];

  for (const f of findings) {
    if (!f || f.duplicateOf) continue;
    const severity = SEVERITY_ORDER[f.severity] === undefined ? 'info' : f.severity;
    const file = absoluteFile(root, f.file);
    const record = {
      file,
      line: Number(f.line) > 0 ? Number(f.line) : 1,
      severity,
      message: String(f.message || f.rule || f.id || ''),
      module: f.module || 'unknown',
      rule: f.rule || null,
      suggestion: f.suggestion || null,
      blocking: Boolean(f.blocking),
      ignoreLine: f.ignoreLine || null,
    };
    if (!file) {
      repoLevel.push(record);
      continue;
    }
    if (wanted && path.resolve(file) !== wanted) continue;
    inFiles.push(record);
  }

  inFiles.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line);
  return { inFiles, repoLevel };
}

/** One line for the status bar and the output channel. */
function summarize(summary, { onlyFile, inFilesCount } = {}) {
  const checks = (summary && summary.checks) || {};
  const modules = (summary && summary.modules) || {};
  const passed = Boolean(summary && summary.gateStatus === 'PASSED');
  const errors = Number(checks.blockingErrors || 0);
  const warnings = Number(checks.warnings || 0);
  const scope = onlyFile ? ` in ${path.basename(onlyFile)}` : '';
  const deferred = Array.isArray(summary && summary.deferred) ? summary.deferred : [];
  const parts = [
    passed ? 'PASSED' : 'BLOCKED',
    `${modules.passed || 0}/${modules.total || 0} modules passed`,
    `${errors} blocking, ${warnings} warning(s)`,
  ];
  if (typeof inFilesCount === 'number') parts.push(`${inFilesCount} finding(s)${scope}`);
  if (summary && summary.nothingChecked) parts.push('nothing was checked — no source files under the root');
  if (deferred.length) parts.push(`deferred to CI: ${deferred.join(', ')}`);
  return { passed, errors, warnings, text: parts.join(' · ') };
}

module.exports = {
  EDITOR_SKIP_MODULES,
  resolveEngineEntry,
  entryFromPath,
  findingsToDiagnostics,
  summarize,
};
