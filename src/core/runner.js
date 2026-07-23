/**
 * GateTest Runner - Orchestrates test module execution.
 * Enforces zero-tolerance: any single error blocks the entire pipeline.
 * Supports severity levels: error (blocks), warning (reports), info (informational).
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// AI Fix Engine — injected after all modules run, before the autoFix pass.
// Adds autoFix closures to any check that has a file path + fix hint but
// no existing autoFix function. This makes every module AI-fixable.
let _aiFix;
try { _aiFix = require('./ai-fix-engine'); } catch { _aiFix = null; }

// Confidence scoring — each finding gets a 0..1 score from context.
// Low-confidence error-severity findings are soft-blocked (downgraded
// to warning-equivalent at gate time) so doc-string examples, fixture
// files, and example data don't cause noise.
const {
  DEFAULT_CONFIDENCE,
  BLOCK_THRESHOLD,
  scoreFinding,
  isBlockingFinding,
} = require('./confidence');

// .gatetestignore suppression + flywheel-learned confidence penalties.
// Both loaded defensively — a missing file / memory yields a no-op so the
// runner behaves exactly as before when neither is present.
let _ignoreFile = null;
try { _ignoreFile = require('./ignore-file'); } catch { _ignoreFile = null; }
let _noiseModel = null;
try { _noiseModel = require('./noise-model'); } catch { _noiseModel = null; }

function _loadIgnoreMatcher(projectRoot) {
  try { return _ignoreFile ? _ignoreFile.load(projectRoot) : null; }
  catch { return null; }
}

function _loadConfidencePenalties(projectRoot) {
  try { return _noiseModel ? _noiseModel.computePenalties(projectRoot) : null; }
  catch { return null; }
}

/** Severity levels — only 'error' blocks the gate. */
const Severity = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
};

// Per-module wall-clock timeout. A module that hangs — infinite loop, a
// stuck subprocess, a pathological repo shape it wasn't tested against —
// must never hang the whole suite. Known Issue #40 (docs/ROADMAP.md): a
// full-suite scan hung indefinitely (45+ min, zero output) on a specific
// customer repo shape, twice reproduced. A hang with no result is exactly
// what a paying customer must never hit, so the runner now races every
// module against a timeout and records "timed out" as that module's
// result instead of blocking the whole process forever. Most modules
// finish in well under a second; a handful genuinely run real subprocess
// work (mutation testing spawns the customer's test suite N times, e2e/
// visual drive a real browser, chaos does fuzzing) and need a longer
// budget than the default.
const DEFAULT_MODULE_TIMEOUT_MS = 120_000; // 2 minutes
const HEAVY_MODULE_TIMEOUT_MS = 600_000;   // 10 minutes
const HEAVY_MODULES = new Set(['mutation', 'e2e', 'visual', 'visualRegression', 'chaos']);

/**
 * Source cache — lazily reads file contents the first time confidence
 * scoring asks for it, then reuses for subsequent lookups. Shared
 * across all TestResult instances in a single run via the runner.
 */
class SourceCache {
  constructor(projectRoot) {
    this.projectRoot = projectRoot || process.cwd();
    this.cache = new Map();
  }

  read(filePath) {
    if (!filePath) return null;
    const abs = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
    if (this.cache.has(abs)) return this.cache.get(abs);
    let content = null;
    try {
      // Bound by stat — don't load huge minified bundles
      const st = fs.statSync(abs);
      if (st.isFile() && st.size <= 2 * 1024 * 1024) {
        content = fs.readFileSync(abs, 'utf-8');
      }
    } catch {
      content = null;
    }
    this.cache.set(abs, content);
    return content;
  }
}

class TestResult {
  constructor(moduleName, options = {}) {
    this.module = moduleName;
    this.status = 'pending';  // pending | running | passed | failed | skipped
    this.checks = [];
    this.fixes = [];          // auto-fix records
    this.startTime = null;
    this.endTime = null;
    this.duration = 0;
    this.error = null;
    // Confidence-scoring context — injected by the runner. When absent
    // (e.g. tests that build TestResult directly) confidence defaults
    // to DEFAULT_CONFIDENCE so callers see the legacy "always block"
    // behaviour.
    this._sourceCache = options.sourceCache || null;
    this._blockThreshold = typeof options.blockThreshold === 'number'
      ? options.blockThreshold
      : BLOCK_THRESHOLD;
    // .gatetestignore matcher (from the runner) — a matched finding is
    // suppressed: excluded from block/soft/warning counts, kept visible in
    // the suppressed list. Null → nothing suppressed.
    this._ignoreMatcher = options.ignoreMatcher || null;
    // Per-module confidence penalty (0..1) learned from the flywheel: a module
    // that fires constantly AND gets dismissed repeatedly has its findings
    // softened below the block threshold until reviewed. 1 = no penalty.
    this._confidencePenalties = options.confidencePenalties || null;
  }

  start() {
    this.status = 'running';
    this.startTime = Date.now();
  }

  /**
   * Add a check result.
   * @param {string} name - Check identifier
   * @param {boolean} passed - Whether the check passed
   * @param {object} details - Additional details
   * @param {string} [details.severity='error'] - Severity: 'error', 'warning', or 'info'
   * @param {string} [details.fix] - Human-readable fix suggestion
   * @param {Function} [details.autoFix] - Function that auto-fixes the issue
   * @param {number} [details.confidence] - Explicit confidence 0..1. If
   *   absent, computed from path + source context. Errors below
   *   `blockThreshold` (default 0.7) do not block the gate.
   */
  addCheck(name, passed, details = {}) {
    const severity = details.severity || (passed ? Severity.INFO : Severity.ERROR);

    // Compute confidence ONLY for failing error/warning checks — passing
    // checks and info-level checks don't need scoring (they never block).
    let confidence;
    let confidenceSignals;
    if (typeof details.confidence === 'number') {
      // Explicit caller value wins
      confidence = details.confidence;
      confidenceSignals = details.confidenceSignals || [];
    } else if (!passed && (severity === Severity.ERROR || severity === Severity.WARNING)) {
      const filePath = details.file || details.filePath;
      let sourceText = null;
      if (filePath && this._sourceCache) {
        sourceText = this._sourceCache.read(filePath);
      }
      const scored = scoreFinding({
        filePath,
        ruleKey: name,
        module: this.module,
        message: details.message,
        line: details.line,
        column: details.column,
        sourceText,
      });
      confidence = scored.confidence;
      confidenceSignals = scored.signals;
      // Flywheel-learned softening: multiply in the module's penalty so a
      // chronically-dismissed noisy module drops below the block threshold.
      const penalty = this._confidencePenalties && this._confidencePenalties[this.module];
      if (typeof penalty === 'number' && penalty < 1) {
        confidence *= penalty;
        confidenceSignals = [...confidenceSignals, 'flywheel-softened'];
      }
    } else {
      confidence = DEFAULT_CONFIDENCE;
      confidenceSignals = [];
    }

    const check = {
      name,
      passed,
      severity,
      timestamp: Date.now(),
      ...details,
      confidence,
      confidenceSignals,
    };

    // .gatetestignore suppression — mark, don't drop, so it stays auditable.
    if (!passed && this._ignoreMatcher) {
      const filePath = details.file || details.filePath;
      if (this._ignoreMatcher.matches({ module: this.module, ruleKey: name, name, file: filePath })) {
        check.suppressed = true;
        check.suppressReason = 'gatetestignore';
      }
    }

    this.checks.push(check);
  }

  /**
   * Record an applied auto-fix.
   */
  addFix(checkName, description, filesChanged = []) {
    this.fixes.push({
      check: checkName,
      description,
      filesChanged,
      timestamp: Date.now(),
    });
  }

  pass() {
    this.status = 'passed';
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
  }

  fail(error) {
    this.status = 'failed';
    this.error = error;
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
  }

  skip(reason) {
    this.status = 'skipped';
    this.error = reason;
  }

  /** Checks suppressed via .gatetestignore — visible, but silenced. */
  get suppressedChecks() {
    return this.checks.filter(c => c.suppressed === true);
  }

  /** Checks that failed with severity 'error' — these block the gate. */
  get errorChecks() {
    return this.checks.filter(c => !c.passed && !c.suppressed && c.severity === Severity.ERROR);
  }

  /**
   * Errors that are CONFIDENT enough to actually block the gate.
   * (severity === 'error' AND confidence >= blockThreshold, not suppressed)
   */
  get blockingErrorChecks() {
    const t = this._blockThreshold;
    return this.checks.filter(c => !c.suppressed && isBlockingFinding(c, t));
  }

  /**
   * Errors that fell below the confidence threshold — reported but
   * don't block.
   */
  get softErrorChecks() {
    const t = this._blockThreshold;
    return this.checks.filter(c =>
      !c.passed && !c.suppressed && c.severity === Severity.ERROR && !isBlockingFinding(c, t),
    );
  }

  /** Checks that failed with severity 'warning' — reported but don't block. */
  get warningChecks() {
    return this.checks.filter(c => !c.passed && !c.suppressed && c.severity === Severity.WARNING);
  }

  /** Informational checks. */
  get infoChecks() {
    return this.checks.filter(c => c.severity === Severity.INFO);
  }

  /**
   * Info-severity findings that "failed" (markdown whitespace nits, missing
   * Stylelint config, etc.) — never block, never even a warning, but each
   * one still counts as one failed check in the raw total/passed ratio.
   * On a healthy, actively-maintained repo this can be the majority of
   * "failed" checks, making `passed/total` read as "half this repo is
   * broken" when it's actually clean. Reported separately so the headline
   * ratio reflects things that actually matter (self-scan 2026-07-15:
   * 2506 total checks, 1272 passed looked alarming — most of the gap was
   * this bucket).
   */
  get infoFindingChecks() {
    return this.checks.filter(c => !c.passed && !c.suppressed && c.severity === Severity.INFO);
  }

  get failedChecks() {
    // A .gatetestignore-suppressed finding is not a failure — it's visible in
    // suppressedChecks but excluded from every failure count/detail so a
    // customer who silenced it doesn't keep seeing it reported as a failure.
    return this.checks.filter(c => !c.passed && !c.suppressed);
  }

  get passedChecks() {
    return this.checks.filter(c => c.passed);
  }

  toJSON() {
    return {
      module: this.module,
      status: this.status,
      duration: this.duration,
      totalChecks: this.checks.length,
      passedChecks: this.passedChecks.length,
      failedChecks: this.failedChecks.length,
      errors: this.errorChecks.length,
      blockingErrors: this.blockingErrorChecks.length,
      softErrors: this.softErrorChecks.length,
      warnings: this.warningChecks.length,
      infoFindings: this.infoFindingChecks.length,
      fixes: this.fixes.length,
      checks: this.checks,
      appliedFixes: this.fixes,
      error: this.error ? String(this.error) : null,
    };
  }
}

class GateTestRunner extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.modules = new Map();
    this.results = [];
    this.options = {
      stopOnFirstFailure: false,
      parallel: false,
      autoFix: false,           // --fix: automatically apply safe fixes
      diffOnly: false,          // --diff: only scan git-changed files
      changedFiles: null,       // list of changed files (populated by diff mode)
      confidenceThreshold: BLOCK_THRESHOLD,
      reportOnly: false,        // --report-only: never block, just report
      ...options,
    };
    // Resolved blockThreshold — accounts for reportOnly mode (Infinity →
    // nothing blocks) and the alias between `blockThreshold` (internal)
    // and `confidenceThreshold` (CLI flag name). Used everywhere the
    // gate / module-fail / summary logic checks "is this finding
    // confident enough to block?".
    //
    // Why reportOnly exists: a fresh GateTest install on a mature
    // codebase surfaces dozens of pre-existing findings. Blocking the
    // customer's CI on day 1 — before they've triaged any of them — is
    // the canonical noisy-scanner anti-pattern. The new-customer install
    // path defaults to reportOnly so CI stays green from day 1; customers
    // opt INTO blocking via `block: true` input on the Action / `--strict`
    // flag on the CLI.
    this._blockThreshold = this.options.reportOnly === true
      ? Number.POSITIVE_INFINITY
      : (typeof options.blockThreshold === 'number'
          ? options.blockThreshold
          : this.options.confidenceThreshold);
    // Shared source cache for confidence scoring across all modules
    const projectRoot = (config && config.projectRoot) || process.cwd();
    this._sourceCache = new SourceCache(projectRoot);
    // .gatetestignore matcher + flywheel-learned per-module confidence
    // penalties. Both are loaded once here (best-effort — a missing file or
    // memory just yields an empty matcher / no penalties) and threaded into
    // every TestResult so suppression and softening apply uniformly.
    this._ignoreMatcher = _loadIgnoreMatcher(projectRoot);
    this._confidencePenalties = _loadConfidencePenalties(projectRoot);
    // Incremental mode state — set at construction when a pre-resolved file
    // Set is supplied (test / external caller), or set at run() time when
    // incrementalSince resolves successfully.
    this._incrementalMode = options.incrementalFiles instanceof Set;
    this._incrementalFileSet = this._incrementalMode ? options.incrementalFiles : null;
  }

  register(name, moduleInstance) {
    this.modules.set(name, moduleInstance);
  }

  /**
   * Resolve the wall-clock timeout for a given module, in ms.
   * Precedence: explicit per-module override (config.moduleTimeouts /
   * constructor option) > env var override > heavy-module default > the
   * general default. Kept a plain method (not a constant lookup) so tests
   * can inject a short timeout via the constructor without touching env.
   */
  _moduleTimeoutMs(name) {
    const overrides = this.options.moduleTimeouts
      || (this.config && this.config.config && this.config.config.moduleTimeouts)
      || {};
    if (typeof overrides[name] === 'number' && overrides[name] > 0) return overrides[name];

    const isHeavy = HEAVY_MODULES.has(name);
    const envKey = isHeavy ? 'GATETEST_HEAVY_MODULE_TIMEOUT_MS' : 'GATETEST_MODULE_TIMEOUT_MS';
    const envMs = Number(process.env[envKey]);
    if (Number.isFinite(envMs) && envMs > 0) return envMs;

    return isHeavy ? HEAVY_MODULE_TIMEOUT_MS : DEFAULT_MODULE_TIMEOUT_MS;
  }

  /**
   * Race a module's run() promise against its timeout. On timeout, throws
   * a descriptive error so the caller's existing crash-handling path
   * (result.fail(err) → module counted as failed, same as any other
   * runtime exception) applies unchanged. The module's own promise is
   * abandoned, not cancelled — Node has no way to forcibly stop an
   * in-flight async function — but the runner stops waiting on it and
   * moves on to the next module, which is the actual customer-facing bug
   * this fixes (see Known Issue #40).
   */
  _runModuleWithTimeout(name, promise, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Module "${name}" timed out after ${timeoutMs}ms — skipped, scan continues`));
      }, timeoutMs);
      // Deliberately NOT unref()'d: if the module's promise never settles and
      // nothing else is keeping the event loop alive, an unref'd timer lets
      // the process drain and exit BEFORE the timeout fires — the exact
      // no-result hang this race exists to prevent (Known Issue #40). The
      // .finally(clearTimeout) below already stops the timer from holding a
      // finished scan open, so a referenced timer costs nothing on the happy
      // path.
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async run(moduleNames) {
    const startTime = Date.now();
    this.results = [];

    // If diff mode, resolve changed files before running modules
    if (this.options.diffOnly && !this.options.changedFiles) {
      this.options.changedFiles = this._getChangedFiles();
    }

    // Incremental mode (--since <ref> / --pr): resolve changed files against
    // a specific ref. Pre-resolved incrementalFiles (Set) from the constructor
    // is already wired; here we handle the runtime resolution case.
    if (this.options.incrementalSince && !this._incrementalMode) {
      const resolved = this._resolveIncrementalFiles(this.options.incrementalSince);
      if (resolved.error) {
        console.warn(
          `[GateTest] Incremental scan unavailable: ${resolved.error}. Falling back to full scan.`,
        );
        // _incrementalMode stays false — full scan proceeds
      } else if (resolved.files.length === 0) {
        console.error('[GateTest] No relevant files changed since base. Nothing to scan.');
        const endTime = Date.now();
        const summary = {
          gateStatus: 'PASSED',
          timestamp: new Date().toISOString(),
          duration: endTime - startTime,
          diffOnly: this.options.diffOnly,
          changedFiles: this.options.changedFiles,
          confidenceThreshold: this._blockThreshold,
          modules: { total: 0, passed: 0, failed: 0, skipped: 0 },
          checks: { total: 0, passed: 0, failed: 0, errors: 0, blockingErrors: 0, softErrors: 0, warnings: 0 },
          fixes: { total: 0, details: [] },
          results: [],
          failedModules: [],
          incremental: { fileCount: 0 },
        };
        this.emit('suite:end', summary);
        return summary;
      } else {
        this._incrementalMode = true;
        this._incrementalFileSet = new Set(resolved.files);
      }
    }

    // Build an absolute-path Set of changed files once per run, then
    // stamp it onto each module so BaseModule._collectFiles can filter.
    // Bigger picture: this is the one wire that turns the whole engine
    // incremental — modules don't need any per-module change to gain
    // the speedup, just to keep using _collectFiles.
    if (
      this.options.diffOnly &&
      Array.isArray(this.options.changedFiles) &&
      this.options.changedFiles.length > 0 &&
      this.config &&
      this.config.projectRoot
    ) {
      const path = require('path');
      const root = this.config.projectRoot;
      const changedAbs = new Set(
        this.options.changedFiles.map((f) => path.resolve(root, f))
      );
      for (const mod of this.modules.values()) {
        mod._incrementalContext = {
          changedFilesAbs: changedAbs,
          changedFilesRel: this.options.changedFiles.slice(),
          projectRoot: root,
        };
      }
    }

    const modulesToRun = moduleNames || Array.from(this.modules.keys());

    this.emit('suite:start', { modules: modulesToRun, diffOnly: this.options.diffOnly });

    if (this.options.parallel) {
      await this._runParallel(modulesToRun);
    } else {
      await this._runSequential(modulesToRun);
    }

    // Inject AI autoFix closures onto checks that lack one (requires API key + file ref)
    if (this.config && this.config.projectRoot && _aiFix) {
      try { _aiFix.injectAutoFixes(this.results, this.config.projectRoot); } catch { /* non-fatal */ }
    }

    // Auto-fix pass: if enabled, run fixable checks
    if (this.options.autoFix) {
      await this._runAutoFixes();
    }

    const endTime = Date.now();
    const summary = this._buildSummary(startTime, endTime);

    this.emit('suite:end', summary);

    return summary;
  }

  async _runSequential(moduleNames) {
    for (const name of moduleNames) {
      const result = await this._runModule(name);
      this.results.push(result);

      if (result.status === 'failed' && this.options.stopOnFirstFailure) {
        break;
      }
    }
  }

  async _runParallel(moduleNames) {
    const promises = moduleNames.map(name => this._runModule(name));
    this.results = await Promise.all(promises);
  }

  async _runModule(name) {
    const mod = this.modules.get(name);
    const result = new TestResult(name, {
      sourceCache: this._sourceCache,
      // Use the runner's resolved _blockThreshold (which reflects
      // reportOnly + explicit override + default cascade) rather than
      // the raw options.confidenceThreshold. Otherwise reportOnly's
      // Infinity threshold is silently dropped here and modules still
      // see the default 0.7 threshold.
      blockThreshold: this._blockThreshold,
      ignoreMatcher: this._ignoreMatcher,
      confidencePenalties: this._confidencePenalties,
    });

    if (!mod) {
      result.skip(`Module "${name}" not registered`);
      this.emit('module:skip', result);
      return result;
    }

    result.start();
    this.emit('module:start', result);

    // Incremental skip / alwaysRun logic
    if (this._incrementalMode && this._incrementalFileSet) {
      const incCfg = (this.config && this.config.config && this.config.config.incremental) || {};
      const skipList = incCfg.skipList || [];
      if (skipList.includes(name)) {
        result.start();
        result.addCheck('incremental:skipped', true, {
          severity: 'info',
          message: `Module "${name}" skipped in incremental mode (full-graph analysis requires full scan)`,
        });
        result.pass();
        this.emit('module:end', result);
        return result;
      }
      // alwaysRunList modules run without the file filter (don't inject _incrementalFiles)
    }

    try {
      // Pass diff-mode context to module
      const moduleConfig = Object.create(this.config);
      moduleConfig._runnerOptions = this.options;
      // deployReadiness reads all prior results to compute the aggregate score
      moduleConfig._allResults = this.results;
      // Incremental: pass file filter to normal modules (not alwaysRunList ones)
      if (this._incrementalMode && this._incrementalFileSet) {
        const incCfg = (this.config && this.config.config && this.config.config.incremental) || {};
        const alwaysRunList = incCfg.alwaysRunList || [];
        if (!alwaysRunList.includes(name)) {
          moduleConfig._incrementalFiles = this._incrementalFileSet;
        }
      }
      const timeoutMs = this._moduleTimeoutMs(name);
      await this._runModuleWithTimeout(name, mod.run(result, moduleConfig), timeoutMs);

      // Only CONFIDENT errors block — soft errors (below threshold) are
      // surfaced in the report but don't fail the module. Warnings always
      // pass through. This kills the false-positive friction Craig hit
      // on PR #85: doc-string examples and example fixtures still show
      // up, they just don't fail CI.
      if (result.blockingErrorChecks.length > 0) {
        result.fail(
          `${result.blockingErrorChecks.length} error(s): ${result.blockingErrorChecks.map(c => c.name).join(', ')}`
        );
      } else {
        result.pass();
      }
    } catch (err) {
      result.fail(err);
    }

    this.emit('module:end', result);
    return result;
  }

  /**
   * Run auto-fixes for all fixable failed checks.
   *
   * Every successful fix is also recorded into the persistent MemoryStore so
   * future scans see this project's auto-fix history. This is what makes
   * memory-aware auto-fix a compounding moat: aiReview and agentic can
   * condition on "GateTest fixed this pattern N times before in this repo"
   * rather than re-suggesting the same fix in a vacuum.
   */
  async _runAutoFixes() {
    let totalFixed = 0;
    const memoryStore = this._getMemoryStoreSafe();
    for (const result of this.results) {
      for (const check of result.failedChecks) {
        if (typeof check.autoFix === 'function') {
          try {
            const fixResult = await check.autoFix();
            if (fixResult && fixResult.fixed) {
              check.passed = true;
              check.autoFixed = true;
              result.addFix(check.name, fixResult.description, fixResult.filesChanged || []);
              totalFixed++;

              if (memoryStore) {
                try {
                  memoryStore.recordFix({
                    checkName: check.name,
                    description: fixResult.description,
                    filesChanged: fixResult.filesChanged || [],
                  });
                } catch {
                  // Memory recording must never break an otherwise-good fix
                }
              }
            }
          } catch {
            // Fix failed — leave check as failed
          }
        }
      }

      // Re-evaluate module status after fixes — only confident errors
      // can re-fail the module.
      if (result.status === 'failed' && result.blockingErrorChecks.length === 0) {
        result.status = 'passed';
        result.error = null;
      }
    }

    if (totalFixed > 0) {
      this.emit('autofix:complete', { totalFixed });
    }
  }

  /**
   * Best-effort MemoryStore accessor. Runner never hard-depends on memory
   * being present — if projectRoot or the memory module is missing, fix
   * recording silently no-ops.
   */
  _getMemoryStoreSafe() {
    try {
      const projectRoot = this.config && this.config.projectRoot;
      if (!projectRoot) return null;
      const { MemoryStore } = require('./memory');
      return new MemoryStore(projectRoot);
    } catch {
      return null;
    }
  }

  /**
   * Get list of files changed relative to the merge-base with the default branch.
   */
  _getChangedFiles() {
    const { execSync } = require('child_process');
    try {
      // Get files changed vs merge-base with main/master
      const baseBranch = (() => {
        try {
          execSync('git rev-parse --verify main', { stdio: 'pipe' });
          return 'main';
        } catch {
          try {
            execSync('git rev-parse --verify master', { stdio: 'pipe' });
            return 'master';
          } catch {
            return 'HEAD~1';
          }
        }
      })();

      const mergeBase = execSync(`git merge-base HEAD ${baseBranch}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const diff = execSync(`git diff --name-only ${mergeBase}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      // Also include staged and unstaged changes
      const staged = execSync('git diff --cached --name-only', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const unstaged = execSync('git diff --name-only', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const allChanged = new Set([
        ...diff.split('\n').filter(Boolean),
        ...staged.split('\n').filter(Boolean),
        ...unstaged.split('\n').filter(Boolean),
      ]);

      return Array.from(allChanged);
    } catch {
      return null; // Fall back to full scan
    }
  }

  /**
   * Resolve the set of source files changed since a given git ref.
   * Returns { files: string[] } on success (may be empty) or { error: string }
   * on failure (bad ref, not a git repo, etc.).
   */
  _resolveIncrementalFiles(ref) {
    const { execSync } = require('child_process');
    const projectRoot = (this.config && this.config.projectRoot) || process.cwd();
    try {
      const raw = execSync(`git diff --name-only "${ref}" HEAD`, {
        encoding: 'utf-8',
        cwd: projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const sourceExts = new Set(
        (this.config &&
          this.config.config &&
          this.config.config.incremental &&
          this.config.config.incremental.sourceExtensions) || [],
      );

      const files = raw.split('\n')
        .filter(Boolean)
        .filter((rel) => {
          if (!sourceExts.size) return true;
          const ext = path.extname(rel).toLowerCase() || rel.toLowerCase();
          return sourceExts.has(ext);
        })
        .map((rel) => path.resolve(projectRoot, rel))
        .filter((abs) => fs.existsSync(abs));

      return { files };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }

  _buildSummary(startTime, endTime) {
    const passed = this.results.filter(r => r.status === 'passed');
    const failed = this.results.filter(r => r.status === 'failed');
    const skipped = this.results.filter(r => r.status === 'skipped');

    const totalChecks = this.results.reduce((sum, r) => sum + r.checks.length, 0);
    const passedChecks = this.results.reduce((sum, r) => sum + r.passedChecks.length, 0);
    const failedChecks = this.results.reduce((sum, r) => sum + r.failedChecks.length, 0);
    const totalErrors = this.results.reduce((sum, r) => sum + r.errorChecks.length, 0);
    const totalBlockingErrors = this.results.reduce(
      (sum, r) => sum + r.blockingErrorChecks.length, 0,
    );
    const totalSoftErrors = this.results.reduce(
      (sum, r) => sum + r.softErrorChecks.length, 0,
    );
    const totalWarnings = this.results.reduce((sum, r) => sum + r.warningChecks.length, 0);
    const totalInfoFindings = this.results.reduce((sum, r) => sum + r.infoFindingChecks.length, 0);
    const totalFixes = this.results.reduce((sum, r) => sum + r.fixes.length, 0);

    // GATE DECISION: only CONFIDENT errors block. Failed modules block
    // unconditionally (runtime exceptions, module crashes). Soft errors
    // are visible in the report but don't fail the gate.
    const gateStatus = (failed.length === 0 && totalBlockingErrors === 0) ? 'PASSED' : 'BLOCKED';

    return {
      gateStatus,
      timestamp: new Date().toISOString(),
      duration: endTime - startTime,
      diffOnly: this.options.diffOnly,
      changedFiles: this.options.changedFiles,
      confidenceThreshold: this._blockThreshold,
      incremental: this._incrementalMode
        ? { fileCount: this._incrementalFileSet ? this._incrementalFileSet.size : 0 }
        : null,
      modules: {
        total: this.results.length,
        passed: passed.length,
        failed: failed.length,
        skipped: skipped.length,
      },
      checks: {
        total: totalChecks,
        passed: passedChecks,
        failed: failedChecks,
        errors: totalErrors,
        blockingErrors: totalBlockingErrors,
        softErrors: totalSoftErrors,
        warnings: totalWarnings,
        infoFindings: totalInfoFindings,
      },
      fixes: {
        total: totalFixes,
        details: this.results.flatMap(r => r.fixes),
      },
      results: this.results.map(r => r.toJSON()),
      failedModules: failed.map(r => ({
        module: r.module,
        error: String(r.error),
        failedChecks: r.failedChecks,
      })),
    };
  }
}

module.exports = {
  GateTestRunner,
  TestResult,
  Severity,
  DEFAULT_MODULE_TIMEOUT_MS,
  HEAVY_MODULE_TIMEOUT_MS,
  HEAVY_MODULES,
};
