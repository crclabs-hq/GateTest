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

// ─── Local fix on the user's own key ─────────────────────────────────────────
//
// The helpers below are pure and vscode-free so the node:test suite pins them.
// The engine pieces they read (engine-models, budget-tracker, the
// orchestrator's FIX_CALL_SHAPE) come from whichever engine was resolved, and
// an engine version that lacks one of them is reported as such — the numbers
// are never typed here.

/** SecretStorage key for the provider API key. Never a settings.json key. */
const PROVIDER_KEY_STORAGE_ID = 'gatetest.providerKey';

/** Load an engine-internal module from the resolved package; null when that engine version does not ship it. */
function loadEngineModule(packageDir, rel) {
  if (!packageDir) return null;
  const p = path.join(packageDir, 'src', 'core', rel);
  if (!fs.existsSync(p)) return null;
  return require(p);
}

/** The depth tiers the engine defines for editor fixes, with labels. Null when the engine predates them. */
function fixDepthChoices(packageDir) {
  const models = loadEngineModule(packageDir, 'engine-models.js');
  if (!models || !models.FIX_DEPTHS) return null;
  return Object.keys(models.FIX_DEPTHS).map((id) => ({ id, label: models.FIX_DEPTHS[id].label }));
}

/**
 * Turn the `gatetest.fixDepth` setting into the model the engine runs. The
 * depth → model table is the engine's (engine-models.js FIX_DEPTHS), so no
 * model id lives in the extension. Empty → standard. An engine that predates
 * the table still runs `standard` on its default; `deep` asks for an upgrade.
 */
function resolveFixDepth(packageDir, raw) {
  const models = loadEngineModule(packageDir, 'engine-models.js');
  if (!models || !models.CHEAP_MODEL) {
    return { ok: false, depth: null, model: null, error: 'this engine has no fix-model table (engine-models.js missing) — upgrade @gatetest/cli' };
  }
  const depth = typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : 'standard';
  if (typeof models.modelForDepth === 'function') {
    const r = models.modelForDepth(depth);
    return r.ok ? { ok: true, depth: r.depth, model: r.model } : { ok: false, depth: null, model: null, error: r.error };
  }
  if (depth === 'standard') return { ok: true, depth, model: models.CHEAP_MODEL };
  return { ok: false, depth: null, model: null, error: `this engine has no "${depth}" fix depth — upgrade @gatetest/cli, or set gatetest.fixDepth to "standard"` };
}

/** `runFixBatch` groups issues as `module:check — message`; one finding gets the same line. */
function issueTextFor(record) {
  return `${record.module || 'module'}:${record.rule || 'check'} — ${record.message || ''}`;
}

/** `$0.0480` under ten cents, `$1.23` above — never a bare float. */
function formatUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  return `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
}

function formatTokens(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/**
 * The cost line the output channel and the notification both print.
 * `cost` is the worker's summary: { tokensIn, tokensOut, usdEstimated, depth,
 * calls, priced, priceNote, knownPrice, exact }. The model id is never printed. A null usdEstimated is
 * printed as unavailable with the reason — never as $0.00.
 */
function formatCost(cost) {
  const c = cost || {};
  const parts = [`${formatTokens(c.tokensIn)} in / ${formatTokens(c.tokensOut)} out tokens`];
  if (c.priced && typeof c.usdEstimated === 'number') {
    parts.push(`${formatUsd(c.usdEstimated)}${c.knownPrice === false ? ' (no rate at this depth — worst-case rate)' : ''}`);
  } else {
    parts.push(`USD unavailable${c.priceNote ? ` (${c.priceNote})` : ''}`);
  }
  if (c.depth) parts.push(`${c.depth} depth`);
  if (typeof c.calls === 'number') parts.push(`${c.calls} call(s)`);
  if (c.exact === false && (c.tokensIn || c.tokensOut)) parts.push('token counts estimated — the provider returned no usage');
  return parts.join(' · ');
}

/**
 * The cost estimate shown BEFORE a fix runs. Reads the engine's price table
 * and the orchestrator's request shape from the resolved engine. When the
 * engine has no price table (bundled @gatetest/cli ≤ 1.61.x) the estimate is
 * reported unavailable with the reason — the caller shows that, never a
 * guessed figure.
 */
function estimateBeforeFix({ packageDir, model, fileText, engineVersion }) {
  const budget = loadEngineModule(packageDir, 'budget-tracker.js');
  const orchestrator = loadEngineModule(packageDir, 'cli-fix-orchestrator.js');
  const version = engineVersion ? `engine ${engineVersion}` : 'this engine';
  if (!budget || typeof budget.estimateFixCost !== 'function') {
    return { available: false, reason: `${version} has no price table (src/core/budget-tracker.js) — upgrade @gatetest/cli to see USD` };
  }
  if (!orchestrator || !orchestrator.FIX_CALL_SHAPE) {
    return { available: false, reason: `${version} does not export its fix request shape (FIX_CALL_SHAPE) — upgrade @gatetest/cli to see USD` };
  }
  const estimate = budget.estimateFixCost({ model, fileText, ...orchestrator.FIX_CALL_SHAPE });
  return { available: true, estimate };
}

/** One paragraph for the pre-run prompt; every number comes from `estimateBeforeFix`. */
function formatEstimate(result, maxUsd) {
  if (!result || !result.available) {
    return `Cost estimate unavailable: ${result ? result.reason : 'no engine'}. Tokens will still be counted from the provider's response; the USD cap cannot be enforced.`;
  }
  const e = result.estimate;
  const rate = `$${e.rate.input}/$${e.rate.output} per million tokens in/out${e.knownPrice ? '' : ' (no rate at this depth — worst-case rate assumed)'}`;
  const cap = Number.isFinite(maxUsd) && maxUsd > 0 ? ` Cap: ${formatUsd(maxUsd)}.` : ' No cap set.';
  return `Estimated ${formatUsd(e.perAttemptUsd)} per attempt (~${formatTokens(e.inputTokensPerCall)} in / up to ${formatTokens(e.outputTokensPerCall)} out tokens), ` +
    `up to ${formatUsd(e.worstCaseUsd)} over ${e.maxAttempts} attempts, at this depth's price of ${rate}.${cap}`;
}

/**
 * Whether a fix may start or continue under `gatetest.fixMaxUsd`.
 *   - no cap (unset, 0, Infinity) → allowed, not enforced
 *   - cap but no price table    → allowed only if the caller confirms; says so
 *   - cap and a figure          → blocked when the figure is over the cap
 */
function capDecision({ usd, maxUsd, priced }) {
  const hasCap = typeof maxUsd === 'number' && Number.isFinite(maxUsd) && maxUsd > 0;
  if (!hasCap) return { allowed: true, enforced: false, reason: 'no USD cap set (gatetest.fixMaxUsd)' };
  if (!priced || typeof usd !== 'number') {
    return { allowed: true, enforced: false, needsConfirmation: true, reason: `cap ${formatUsd(maxUsd)} cannot be enforced — no price table in this engine` };
  }
  if (usd > maxUsd) return { allowed: false, enforced: true, reason: `${formatUsd(usd)} is over the cap of ${formatUsd(maxUsd)} (gatetest.fixMaxUsd)` };
  return { allowed: true, enforced: true, reason: `${formatUsd(usd)} is within the cap of ${formatUsd(maxUsd)}` };
}

/**
 * After the re-scan: is the finding we fixed still reported in that file?
 * Identity is file + module + rule (a fix moves lines, so line is ignored);
 * a finding with no rule falls back to its message.
 */
function findingStillPresent(records, target) {
  if (!target || !target.file) return false;
  const wanted = path.resolve(target.file);
  return (records || []).some((r) => {
    if (!r || !r.file || path.resolve(r.file) !== wanted) return false;
    if ((r.module || null) !== (target.module || null)) return false;
    if (target.rule) return (r.rule || null) === target.rule;
    return (r.message || '') === (target.message || '');
  });
}

module.exports = {
  EDITOR_SKIP_MODULES,
  PROVIDER_KEY_STORAGE_ID,
  resolveEngineEntry,
  entryFromPath,
  findingsToDiagnostics,
  summarize,
  loadEngineModule,
  fixDepthChoices,
  resolveFixDepth,
  issueTextFor,
  formatUsd,
  formatTokens,
  formatCost,
  estimateBeforeFix,
  formatEstimate,
  capDecision,
  findingStillPresent,
};
