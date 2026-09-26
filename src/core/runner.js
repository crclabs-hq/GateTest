/**
 * GateTest Runner - Orchestrates test module execution.
 * Enforces zero-tolerance: any single error blocks the entire pipeline.
 * Supports severity levels: error (blocks), warning (reports), info (informational).
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { repoRelative, toPosix } = require('./repo-path');

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
  wouldBlockFinding,
} = require('./confidence');

// verdictSource classification (the Fifty, move 14) — ONE table (doctrine
// #4) of which modules' findings are a model's judgment call rather than a
// deterministic rule. Set once here, in `TestResult.addCheck`, the single
// place every finding is created/normalised; every reporter reads the field
// off the check, never this table.
const { defaultVerdictSource } = require('./model-judged-modules');
const VALID_VERDICT_SOURCES = new Set(['deterministic', 'model', 'mixed']);

// .gatetestignore suppression + flywheel-learned confidence penalties.
// Both loaded defensively — a missing file / memory yields a no-op so the
// runner behaves exactly as before when neither is present.
let _ignoreFile = null;
try { _ignoreFile = require('./ignore-file'); } catch { _ignoreFile = null; }
let _noiseModel = null;
try { _noiseModel = require('./noise-model'); } catch { _noiseModel = null; }
// Accepted-risk overrides (src/core/accept-risk.js) — a recorded, expiring
// alternative to .gatetestignore. Loaded defensively like the two above.
let _acceptRisk = null;
try { _acceptRisk = require('./accept-risk'); } catch { _acceptRisk = null; }

function _loadBaselineMatcher(projectRoot) {
  try {
    const baseline = require('./baseline');
    const matcher = baseline.load(projectRoot);
    return matcher.isEmpty ? null : matcher;
  } catch { return null; }
}

/**
 * Reduce a check name to the RULE it came from, dropping the file and line.
 *
 * Module check names are commonly built as `<rule>:<detail>:<file>:<line>`,
 * so using the raw name as the suppression key produced one entry per file
 * per line — `hardcodedUrl:hardcoded-url:localhost:src\cfg.js:1` — and the
 * store grew without bound instead of counting "this rule was silenced".
 * Observed in an end-to-end CLI run (KI #76).
 *
 * @param {{name?: string, file?: string, filePath?: string}} check
 * @returns {string} the rule identity, e.g. `hardcoded-url:localhost`
 */
const { readPathFilter: _readPathFilter, pathInScope: _pathInScope } = require('./scan-paths');
const { ruleIdentity: _ruleIdentity } = require('./rule-identity');
const { isOffline: _isOffline } = require('./offline');

// Field-measured demotions (the Fifty, move 08) — a rule the field has
// silenced past the retirement line, with enough findings to trust the
// rate, ships as a warning instead of an error. Loaded defensively so a
// missing/malformed data/rule-demotions.json never blocks a scan.
let _ruleDemotion = null;
try { _ruleDemotion = require('./rule-demotion'); } catch { _ruleDemotion = null; }

/**
 * `.gatetest.json`'s `ignore` key (KI #112 G4, widened issue #657) feeds the
 * SAME .gatetestignore parser — never a second matcher. `config` may be a
 * GateTestConfig instance (`.get('ignore')`), a plain object some callers
 * construct directly (direct-repair.js), or absent; all three read as "no
 * extra lines" rather than throwing.
 *
 * Two shapes are accepted, both rendered as bare path-glob lines (the same
 * grammar `.gatetestignore` uses for a directory exclude):
 *   - a top-level array:        `ignore: ["scripts/**", "module:rule"]`
 *   - a nested `paths` object:  `ignore: { paths: ["scripts/**"] }`
 * A customer's build tooling templating `.gatetest.json` produced the
 * second shape (issue #657: `ignore.paths` was read into the merged config
 * by config.js but this function only ever recognised the first, so 754
 * findings under two glob patterns kept firing with no error anywhere —
 * Bible Forbidden #16, a config key that looks live and does nothing).
 */
function _configIgnoreLines(config) {
  try {
    const raw = typeof config?.get === 'function' ? config.get('ignore') : config?.ignore;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object' && Array.isArray(raw.paths)) return raw.paths;
    return [];
  } catch { return []; }
}

function _loadIgnoreMatcher(projectRoot, config) {
  try { return _ignoreFile ? _ignoreFile.load(projectRoot, _configIgnoreLines(config)) : null; }
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
    // Baseline matcher (KI #66) — grandfathered findings suppress the same
    // way, with suppressReason 'baseline' so reporters can distinguish.
    this._baselineMatcher = options.baselineMatcher || null;
    // Accepted-risk matcher (src/core/accept-risk.js) — a matched, unexpired
    // finding stops blocking but is NEVER suppressed/hidden: it stays in the
    // ranked findings list and is recorded on `check.overriddenBy` so the
    // summary can carry it in a separate `overrides[]` array. An EXPIRED
    // match does the opposite of a suppression — it blocks, with the
    // override named in the message (`check.expiredOverride`).
    this._acceptRiskMatcher = options.acceptRiskMatcher || null;
    this._projectRoot = options.projectRoot || null;
    // Per-module confidence penalty (0..1) learned from the flywheel: a module
    // that fires constantly AND gets dismissed repeatedly has its findings
    // softened below the block threshold until reviewed. 1 = no penalty.
    this._confidencePenalties = options.confidencePenalties || null;
    // Gate policy (the Fifty, move 14): a model-judged finding never blocks
    // unless the operator opted in. Default false everywhere this option is
    // absent (e.g. tests that build TestResult directly) so legacy callers
    // keep today's behaviour for deterministic findings and get the safer
    // (non-blocking) behaviour for model ones.
    this._modelVerdictsBlock = options.modelVerdictsBlock === true;
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
    let severity = details.severity || (passed ? Severity.INFO : Severity.ERROR);

    // Field-measured demotion (the Fifty, move 08): applied here — the one
    // place every module's severity is finalised — so no individual module
    // has to know about field data. Only a failing 'error' can be demoted,
    // and only down to 'warning'; the finding still appears, with the
    // reason attached as `check.demotedBy` below.
    let demotedBy = null;
    if (!passed && severity === Severity.ERROR && _ruleDemotion) {
      const filePath = details.file || details.filePath;
      const ruleId = _ruleIdentity({ name, file: filePath });
      const applied = _ruleDemotion.applyDemotion(ruleId, severity);
      severity = applied.severity;
      demotedBy = applied.demotion;
    }

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

    // verdictSource (the Fifty, move 14): a module that calls the AI client
    // for SOME of its findings and derives others deterministically (e.g.
    // fakeFixDetector's pattern engine vs its AI engine) passes an explicit
    // `details.verdictSource` per finding; anything else defaults from the
    // one module table (`model-judged-modules.js`). An invalid explicit
    // value is never trusted silently — it falls back to the module default
    // rather than letting a typo like 'ai' exempt a finding from the gate
    // count it belongs in.
    const verdictSource = VALID_VERDICT_SOURCES.has(details.verdictSource)
      ? details.verdictSource
      : defaultVerdictSource(this.module);

    const check = {
      name,
      passed,
      timestamp: Date.now(),
      ...details,
      // These MUST win over `...details` — `severity` may have just been
      // demoted above, and re-applying `details.severity` here would
      // silently undo it (the original bug: `severity` used to sit BEFORE
      // the spread, a no-op only because nothing ever mutated it after
      // being read from `details` in the first place). `verdictSource` is
      // validated above and must win over an unvalidated caller value for
      // the same reason.
      severity,
      confidence,
      confidenceSignals,
      verdictSource,
      // What a stricter policy (`--model-verdicts-block`) would decide on
      // confidence alone — preserved even when the gate itself does not act
      // on it, so the report always shows what a model-judged finding would
      // do under a stricter setting (the Fifty, move 14).
      wouldBlock: wouldBlockFinding({ severity, confidence, passed }, this._blockThreshold),
    };
    if (demotedBy) check.demotedBy = demotedBy;

    // .gatetestignore suppression — mark, don't drop, so it stays auditable.
    // The path-glob lines (`scripts/**`, from a bare .gatetestignore line OR
    // from .gatetest.json's `ignore.paths`) are anchored (`^…$`) against a
    // REPO-RELATIVE, posix-joined path — the exact form a hand-written
    // .gatetestignore line is written against. A module that reports an
    // absolute path (or one already relative-but-backslashed on Windows)
    // must be normalised the same way before matching, or a glob that is
    // provably correct never matches anything (issue #657).
    if (!passed && this._ignoreMatcher) {
      const filePath = details.file || details.filePath;
      const relFile = filePath
        ? (this._projectRoot && path.isAbsolute(filePath)
          ? repoRelative(this._projectRoot, filePath)
          : toPosix(filePath).replace(/^\.\//, ''))
        : filePath;
      const finding = { module: this.module, ruleKey: name, name, file: relFile };
      const kind = typeof this._ignoreMatcher.matchKind === 'function'
        ? this._ignoreMatcher.matchKind(finding)
        : (this._ignoreMatcher.matches(finding) ? 'moduleRule' : null);
      if (kind) {
        check.suppressed = true;
        check.suppressReason = 'gatetestignore';
        // Which kind of rule silenced it — the noise model may only learn
        // from module-scoped entries. See ignore-file.matchKind().
        check.suppressKind = kind;
      }
    }

    // Baseline suppression (KI #66) — a finding grandfathered by
    // `gatetest --baseline` doesn't block; only NEW findings do. Count-aware:
    // an aggregated per-file check resurfaces when it grows MORE instances
    // than were baselined (e.g. a second secret lands in a file that had one).
    if (!passed && !check.suppressed && this._baselineMatcher) {
      const filePath = details.file || details.filePath;
      const instances = Array.isArray(details.details) && details.details.length > 0
        ? details.details.length
        : 1;
      if (this._baselineMatcher.has(this.module, name, filePath, instances)) {
        check.suppressed = true;
        check.suppressReason = 'baseline';
      }
    }

    // Accepted-risk override (src/core/accept-risk.js) — identity is the
    // SAME finding id every other surface uses, `${module}:${name}`
    // (src/core/finding-registry.js `f.id`, `--format json` `issues[].id`;
    // doctrine #4, one definition). Never suppresses: an active override
    // only stops the finding from blocking (see blockingErrorChecks below);
    // an expired one changes nothing about blocking and instead names
    // itself in the message so the block is never a silent surprise
    // (Bible Forbidden #16).
    if (!passed && !check.suppressed && this._acceptRiskMatcher) {
      const matched = this._acceptRiskMatcher.match(`${this.module}:${name}`);
      if (matched && !matched.expired) {
        check.overriddenBy = matched.override;
      } else if (matched && matched.expired) {
        check.expiredOverride = matched.override;
        const who = matched.override.by ? ` by ${matched.override.by}` : '';
        check.message = `${check.message || name} [accepted-risk override${who} expired ${matched.override.until} — now blocking]`;
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
   * (severity === 'error' AND confidence >= blockThreshold, not suppressed,
   * AND — the Fifty, move 14 — not a model-judged finding held back by gate
   * policy: see `isBlockingFinding` / `gate.modelVerdictsBlock`.)
   */
  get blockingErrorChecks() {
    const t = this._blockThreshold;
    // An active (unexpired) accepted-risk override is the one thing besides
    // suppression that keeps an otherwise-confident error off the gate — it
    // still shows up in errorChecks/findings, just never here.
    return this.checks.filter(c => !c.suppressed && !c.overriddenBy && isBlockingFinding(c, t, this._modelVerdictsBlock));
  }

  /**
   * Errors that fell below the confidence threshold — reported but
   * don't block. Confidence-only, deliberately: a model-judged finding held
   * back by GATE POLICY (not by low confidence) is a different reason to be
   * non-blocking and is counted separately by `modelJudgedChecks`, so this
   * bucket keeps meaning exactly what it always meant.
   */
  get softErrorChecks() {
    const t = this._blockThreshold;
    return this.checks.filter(c =>
      !c.passed && !c.suppressed && c.severity === Severity.ERROR
        && c.verdictSource !== 'model' && !wouldBlockFinding(c, t),
    );
  }

  /**
   * Model-judged findings (verdictSource === 'model') that failed — reported
   * as warnings for gate purposes unless `gate.modelVerdictsBlock` is on
   * (the Fifty, move 14). Each retains `wouldBlock` so the report can say
   * what a stricter policy would decide.
   */
  get modelJudgedChecks() {
    return this.checks.filter(c => !c.passed && !c.suppressed && c.verdictSource === 'model');
  }

  /** Checks that failed with severity 'warning' — reported but don't block. */
  get warningChecks() {
    return this.checks.filter(c => !c.passed && !c.suppressed && c.severity === Severity.WARNING);
  }

  /**
   * Warnings whose confidence fell below the block threshold.
   *
   * Errors have had a confident/soft split since confidence shipped;
   * warnings never did. They ARE scored — `addCheck` runs `scoreFinding`
   * for warnings as well as errors, and applies the flywheel penalty — but
   * nothing downstream ever read the number, so for the 76 modules that
   * emit warnings the score, and the noise model's softening with it, was
   * computed and thrown away (KI #77).
   *
   * This is a REPORTED sub-count, not a filter. Every warning still appears
   * in `warningChecks`; low-confidence ones are merely also countable here
   * so the summary can say how much of the pile is shaky. Silently dropping
   * warnings would be the false-NEGATIVE direction, which is the one a
   * security tool must never take on its own initiative.
   */
  get softWarningChecks() {
    const t = this._blockThreshold;
    return this.warningChecks.filter((c) => {
      const conf = typeof c.confidence === 'number' ? c.confidence : DEFAULT_CONFIDENCE;
      return conf < t;
    });
  }

  /**
   * Findings softened by the flywheel — i.e. modules the user has put in
   * `.gatetestignore` enough times that `noise-model` penalised them.
   *
   * Surfacing this closes the disclosure gap noted on KI #76: softening was
   * only observable by inspecting `confidenceSignals` on an individual
   * check, so the scan output gave no hint that findings had been quieted.
   */
  get flywheelSoftenedChecks() {
    return this.checks.filter(
      c => !c.passed && !c.suppressed
        && Array.isArray(c.confidenceSignals)
        && c.confidenceSignals.includes('flywheel-softened'),
    );
  }

  /**
   * Findings demoted error -> warning by field silence data (the Fifty,
   * move 08, src/core/rule-demotion.js). Reported, not hidden — the same
   * disclosure reasoning as `flywheelSoftenedChecks`: a scan output must
   * never let a softened finding pass as if no field data existed.
   */
  get demotedChecks() {
    return this.checks.filter(c => !c.passed && !c.suppressed && c.demotedBy);
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
      softWarnings: this.softWarningChecks.length,
      flywheelSoftened: this.flywheelSoftenedChecks.length,
      // Model-judged findings (the Fifty, move 14) — never blocking by
      // default; see `checks[].verdictSource` / `wouldBlock` for the detail
      // a reporter needs per finding.
      modelJudged: this.modelJudgedChecks.length,
      infoFindings: this.infoFindingChecks.length,
      // Suppressed findings are excluded from every count above, which is
      // right for the gate but wrong for the noise model: a module whose
      // findings are all silenced looks like it never fires. Expose the
      // count so fireRate can stay honest (KI #76).
      suppressedChecks: this.suppressedChecks.length,
      // Findings a narrowed scan (--diff / --pr) dropped because they sat in
      // files the diff never touched. Zero on a full scan.
      scopedOut: this.scopedOut || 0,
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
    // Gate policy (the Fifty, move 14): does a model-judged finding block by
    // itself? Default false. Precedence: explicit constructor option (CLI
    // `--model-verdicts-block` arrives here via bin/gatetest.js) > config key
    // `gate.modelVerdictsBlock` (`.gatetest.json`) > env
    // `GATETEST_MODEL_VERDICTS_BLOCK=1`.
    this._modelVerdictsBlock = options.modelVerdictsBlock === true
      || (config && typeof config.get === 'function' && config.get('gate.modelVerdictsBlock') === true)
      || process.env.GATETEST_MODEL_VERDICTS_BLOCK === '1';
    // Shared source cache for confidence scoring across all modules
    const projectRoot = (config && config.projectRoot) || process.cwd();
    this._sourceCache = new SourceCache(projectRoot);
    // .gatetestignore matcher + flywheel-learned per-module confidence
    // penalties. Both are loaded once here (best-effort — a missing file or
    // memory just yields an empty matcher / no penalties) and threaded into
    // every TestResult so suppression and softening apply uniformly.
    this._ignoreMatcher = _loadIgnoreMatcher(projectRoot, config);
    this._confidencePenalties = _loadConfidencePenalties(projectRoot);
    // Accepted-risk overrides (move 3, docs/LAUNCH_BOARD.md): the caller
    // (bin/gatetest.js) already merged the `.gatetest/accepted-risks.json`
    // file with any `--accept-risk` CLI flags — this only builds the
    // lookup, so there is one merge, not one per module.
    this._acceptRiskOverrides = Array.isArray(options.acceptRiskOverrides) ? options.acceptRiskOverrides : [];
    this._acceptRiskMatcher = _acceptRisk ? _acceptRisk.buildOverrideMatcher(this._acceptRiskOverrides) : null;
    // Baseline ("only fail on NEW issues", KI #66). When capturing a fresh
    // baseline the old one must NOT suppress anything — the snapshot has to
    // see the full current state.
    this._captureBaseline = options.captureBaseline === true;
    this._baselineMatcher = this._captureBaseline ? null : _loadBaselineMatcher(projectRoot);
    this._projectRoot = projectRoot;
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
   * constructor option) > env var override > the module's OWN declared
   * estimate (optional `estimateTimeoutMs(moduleConfig)` instance method) >
   * heavy-module default > the general default. Kept a plain method (not a
   * constant lookup) so tests can inject a short timeout via the constructor
   * without touching env.
   *
   * The module-declared tier (added #640) lets a module size its own budget
   * from its own configured workload instead of inheriting the generic
   * ceiling meant for a lint pass — liveCrawler sizes itself from
   * crawlMax × pageTimeout rather than dying at the flat 120s default with
   * zero pages recorded. It sits BELOW the env var (an operator who set
   * GATETEST_MODULE_TIMEOUT_MS made a deliberate, if global, choice and it
   * still wins) but ABOVE the flat default, which is what actually mattered
   * for #640: nobody had set that env var for the customer's slow-host
   * crawl, so the flat 120s default was all that stood between "zero pages
   * recorded" and a budget shaped like the crawl's own configured workload.
   * `mod` is optional so existing callers/tests that only pass `name` keep
   * working — they just skip this tier.
   */
  _moduleTimeoutMs(name, mod, moduleConfig) {
    const overrides = this.options.moduleTimeouts
      || (this.config && this.config.config && this.config.config.moduleTimeouts)
      || {};
    if (typeof overrides[name] === 'number' && overrides[name] > 0) return overrides[name];

    const isHeavy = HEAVY_MODULES.has(name);
    const envKey = isHeavy ? 'GATETEST_HEAVY_MODULE_TIMEOUT_MS' : 'GATETEST_MODULE_TIMEOUT_MS';
    const envMs = Number(process.env[envKey]);
    if (Number.isFinite(envMs) && envMs > 0) return envMs;

    if (mod && typeof mod.estimateTimeoutMs === 'function') {
      const estimated = mod.estimateTimeoutMs(moduleConfig);
      if (typeof estimated === 'number' && estimated > 0) return estimated;
    }

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

    // Is there anything here to check? A tree with no source file passes
    // every module by default, and the summary must say so rather than
    // print "You're good" (src/core/scan-scope.js hasSourceFiles). Under
    // --strict an empty scan is a failed gate: the operator asked for
    // enforcement, and a gate that enforced nothing did not enforce.
    try {
      this._nothingChecked = !require('./scan-scope').hasSourceFiles(this._projectRoot);
    } catch { // error-ok — the inventory is a disclosure, never a reason to skip the scan
      this._nothingChecked = false;
    }

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

    // Repository path filter (.gatetest.json `paths`): stamped on every
    // module so _collectFiles decides scope in one place; findings from
    // modules with their own lookups are scoped at the runner below.
    this._pathFilter = _readPathFilter(this.config);
    this._pathFilterDropped = 0;
    for (const mod of this.modules.values()) mod._scanPathFilter = this._pathFilter;

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
      try { _aiFix.injectAutoFixes(this.results, this.config.projectRoot); } catch { /* error-ok — AI auto-fix injection is an enrichment; the scan result stands without it */ }
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
      baselineMatcher: this._baselineMatcher,
      acceptRiskMatcher: this._acceptRiskMatcher,
      projectRoot: this._projectRoot,
      confidencePenalties: this._confidencePenalties,
      modelVerdictsBlock: this._modelVerdictsBlock,
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
      const timeoutMs = this._moduleTimeoutMs(name, mod, moduleConfig);
      // Let the module read back the exact wall-clock budget it's racing
      // against, so a module that paces its own work (liveCrawler, #640)
      // can hand back a partial result instead of losing everything to the
      // timeout below.
      moduleConfig._moduleTimeoutMs = timeoutMs;
      await this._runModuleWithTimeout(name, mod.run(result, moduleConfig), timeoutMs);
      this._scopeResultToChangedFiles(result, name);
      this._scopeResultToPathFilter(result);
      // A defensive second pass, run AFTER every module regardless of how it
      // walked its own files (issue #657: the customer's hypothesis was that
      // a module with its own file lookup, rather than the shared
      // `_collectFiles`, could bypass suppression — TestResult.addCheck
      // already checks every finding as it's added, but it does so before
      // this module's checks have been through `_scopeResultToPathFilter`'s
      // repo-relative normalisation. This sweep re-checks anything the
      // per-check pass left unsuppressed using the same repo-relative path
      // every other scoping step in the runner uses, so no module's walker
      // shape can leave the config's `ignore.paths` globs unapplied.
      this._scopeResultToIgnoreConfig(result);

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
                  // error-ok — memory recording must never break an otherwise-good fix; the fix itself is already applied and recorded on the check
                }
              }
            }
          } catch (fixErr) {
            // The check stays failed, and the reason the fix could not be
            // applied travels with it — a fixer that threw used to be
            // indistinguishable from one that declined (self-scan 2026-09-13).
            check.autoFixError = (fixErr && fixErr.message) || String(fixErr);
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
   * The repo-relative, forward-slash paths a scan was narrowed to
   * (`--diff`, `--since`, `--pr`), or null for a full scan.
   */
  _scopedFileSet() {
    const root = this.config && this.config.projectRoot;
    const rel = (f) => {
      return root && path.isAbsolute(f) ? repoRelative(root, f) : toPosix(f);
    };
    if (this.options.diffOnly && Array.isArray(this.options.changedFiles) && this.options.changedFiles.length > 0) {
      return new Set(this.options.changedFiles.map(rel));
    }
    if (this._incrementalMode && this._incrementalFileSet) {
      return new Set(Array.from(this._incrementalFileSet, rel));
    }
    return null;
  }

  /**
   * Hold a narrowed scan to its own promise: only findings in changed files.
   *
   * Measured 2026-09-05 on PR #422: "Mode: diff-only (20 changed files)",
   * and a SARIF with 961 results across 379 files — 945 of them in files the
   * PR never touched. `_collectFiles` honours the changed set, but 22 of the
   * 25 quick-suite modules carry their own copy of the directory walk and
   * never see it, so `--diff` narrowed a handful of modules and reported
   * the rest as if it had narrowed everything. Every pre-existing finding
   * then reached GitHub Code Scanning as something the PR introduced.
   *
   * Filtering here, once, at the seam every module passes through, is the
   * only place the promise can be kept for all of them. Rules:
   *   - a finding with no file (repo-wide, config-level) is kept
   *   - a finding in a changed file is kept
   *   - a finding anchored elsewhere is kept when a changed file caused it —
   *     it names the file in `source` / `related` / its message (cross-file
   *     taint reports at the sink, duplicate-code at the twin)
   *   - modules in `incremental.alwaysRunList` are exempt by configuration
   */
  _scopeResultToChangedFiles(result, moduleName) {
    const scoped = this._scopedFileSet();
    if (!scoped || !result || !Array.isArray(result.checks)) return;
    const incCfg = (this.config && this.config.config && this.config.config.incremental) || {};
    if ((incCfg.alwaysRunList || []).includes(moduleName)) return;

    const root = this.config && this.config.projectRoot;
    const rel = (f) => {
      return (root && path.isAbsolute(f) ? repoRelative(root, f) : toPosix(f)).replace(/^\.\//, '');
    };
    // A changed path cited inside free text: bounded so `a.js` does not
    // match `data.js`, and `src/x.js` still matches `src/x.js:16`.
    const cited = Array.from(scoped, (f) => new RegExp(
      `(?:^|[^\\w/.-])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`,
    ));
    const causedByChange = (check) => {
      const text = [check.source, check.related, check.relatedFile, check.otherFile, check.message]
        .filter((v) => typeof v === 'string').join('\n');
      return text.length > 0 && cited.some((re) => re.test(text));
    };

    const before = result.checks.length;
    result.checks = result.checks.filter((check) => {
      if (check.passed) return true;
      const own = check.file || check.filePath;
      if (!own) return true;
      if (scoped.has(rel(own))) return true;
      return causedByChange(check);
    });
    const dropped = before - result.checks.length;
    if (dropped > 0) result.scopedOut = (result.scopedOut || 0) + dropped;
  }

  /**
   * Findings a module reported from outside the repository's path filter
   * (a module with its own lookup rather than _collectFiles). Repo-wide
   * findings (no file) stay. Counted, so the summary can say so.
   */
  _scopeResultToPathFilter(result) {
    if (!this._pathFilter || !result || !Array.isArray(result.checks)) return;
    const root = this.config && this.config.projectRoot;
    const rel = (f) => {
      return (root && path.isAbsolute(f) ? repoRelative(root, f) : toPosix(f)).replace(/^\.\//, '');
    };
    const before = result.checks.length;
    result.checks = result.checks.filter((check) => {
      if (check.passed) return true;
      const own = check.file || check.filePath;
      if (!own) return true;
      return _pathInScope(this._pathFilter, rel(own));
    });
    const dropped = before - result.checks.length;
    if (dropped > 0) {
      result.scopedOut = (result.scopedOut || 0) + dropped;
      this._pathFilterDropped += dropped;
    }
  }

  /**
   * Runner-level safety net for `.gatetestignore` / `.gatetest.json`
   * `ignore` suppression (issue #657), applied after every module returns —
   * so no module's file-walking shape decides whether suppression applies.
   * TestResult.addCheck already marks a match as it is added; this second
   * pass exists because that per-check match runs on whatever `file` string
   * the module happened to report (absolute, backslashed, already-relative),
   * while a hand-written `.gatetestignore` / `ignore.paths` glob is written
   * against the repo-relative, posix form. Re-normalising and re-checking
   * here — the SAME repo-relative conversion `_scopeResultToPathFilter`
   * uses two lines above — closes that gap without a second matcher
   * (Doctrine #4: `ignore-file.js` is still the only parser).
   */
  _scopeResultToIgnoreConfig(result) {
    if (!this._ignoreMatcher || !result || !Array.isArray(result.checks)) return;
    const root = this.config && this.config.projectRoot;
    const rel = (f) => {
      return (root && path.isAbsolute(f) ? repoRelative(root, f) : toPosix(f)).replace(/^\.\//, '');
    };
    for (const check of result.checks) {
      if (check.passed || check.suppressed) continue;
      const own = check.file || check.filePath;
      if (!own) continue;
      const finding = { module: result.module, ruleKey: check.name, name: check.name, file: rel(own) };
      const kind = typeof this._ignoreMatcher.matchKind === 'function'
        ? this._ignoreMatcher.matchKind(finding)
        : (this._ignoreMatcher.matches(finding) ? 'moduleRule' : null);
      if (kind) {
        check.suppressed = true;
        check.suppressReason = 'gatetestignore';
        check.suppressKind = kind;
      }
    }
  }

  /**
   * Get list of files changed relative to the merge-base with the default branch.
   */
  _getChangedFiles() {
    const { execSync } = require('child_process');
    const { resolveDiffBase } = require('./diff-base');
    const projectRoot = (this.config && this.config.projectRoot) || process.cwd();
    const opts = { encoding: 'utf-8', cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] };
    try {
      // The base is ONE decision shared with prSize and fakeFixDetector
      // (src/core/diff-base.js): explicit, --since/--pr, a merge-queue
      // base, GITHUB_BASE_REF, origin/main — a local `main` only when no
      // origin exists. Before this the runner asked for local `main` first
      // and fell back to HEAD~1 on CI, where a PR checkout has no `main`.
      const base = resolveDiffBase({ projectRoot, incrementalSince: this.options.incrementalSince });
      const diff = execSync(`git diff --name-only ${base ? base.mergeBase : 'HEAD~1'}`, opts).trim();

      // Also include staged and unstaged changes
      const staged = execSync('git diff --cached --name-only', opts).trim();

      const unstaged = execSync('git diff --name-only', opts).trim();

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
    // Blocking split by verdictSource (the Fifty, move 14) — "deterministic /
    // model-judged blocking" in the console summary. Model-judged blocking
    // is 0 unless `gate.modelVerdictsBlock` is on, since `blockingErrorChecks`
    // already excludes model findings by default.
    const totalDeterministicBlocking = this.results.reduce(
      (sum, r) => sum + r.blockingErrorChecks.filter(c => c.verdictSource !== 'model').length, 0,
    );
    const totalModelJudgedBlocking = totalBlockingErrors - totalDeterministicBlocking;
    const totalSoftErrors = this.results.reduce(
      (sum, r) => sum + r.softErrorChecks.length, 0,
    );
    const totalModelJudged = this.results.reduce(
      (sum, r) => sum + r.modelJudgedChecks.length, 0,
    );
    // Model-judged findings that WOULD block under a stricter policy —
    // `wouldBlock` preserved even though the gate did not act on it.
    const totalModelJudgedWouldBlock = this.results.reduce(
      (sum, r) => sum + r.modelJudgedChecks.filter(c => c.wouldBlock === true).length, 0,
    );
    const totalWarnings = this.results.reduce((sum, r) => sum + r.warningChecks.length, 0);
    // Sub-counts of the warning pile — reported, never subtracted from it.
    const totalSoftWarnings = this.results.reduce((sum, r) => sum + r.softWarningChecks.length, 0);
    const totalFlywheelSoftened = this.results.reduce(
      (sum, r) => sum + r.flywheelSoftenedChecks.length, 0,
    );
    const totalDemoted = this.results.reduce(
      (sum, r) => sum + r.demotedChecks.length, 0,
    );
    const totalInfoFindings = this.results.reduce((sum, r) => sum + r.infoFindingChecks.length, 0);
    const totalFixes = this.results.reduce((sum, r) => sum + r.fixes.length, 0);
    const totalBaselined = this.results.reduce(
      (sum, r) => sum + r.checks.filter(c => c.suppressReason === 'baseline').length, 0,
    );
    // `.gatetestignore` + `.gatetest.json` `ignore` (array or `{paths:[]}`)
    // suppressions, combined — issue #657 asked for one visible count so a
    // customer whose config suppresses findings can see it actually took.
    // Printed by the CLI (bin/gatetest.js), not here: this file is scanned
    // by codeQuality's `console.log` forbidden pattern (it is not in that
    // module's `excludePaths`), so the runner only carries the number on
    // the summary and the CLI is the one thing allowed to print it.
    const totalIgnoreSuppressed = this.results.reduce(
      (sum, r) => sum + r.checks.filter(c => c.suppressReason === 'gatetestignore').length, 0,
    );

    // Distinct module:ruleKey pairs the user silenced via .gatetestignore.
    // This is the noise model's missing input (KI #76): putting a rule in
    // .gatetestignore IS the user declaring it a false positive, so it is the
    // dismissal signal `persistent-memory.recordSuppression` always wanted and
    // never received — it had zero callers, so computePenalties() could only
    // ever return {}.
    //
    // Deliberately EXCLUDES suppressReason === 'baseline': a baselined finding
    // means "real, fix it later", not "wrong". Counting it would soften modules
    // for being accurate.
    //
    // Deduped per scan so one noisy file can't inflate the count — the signal
    // is "the user silenced this rule", once per run, regardless of hit count.
    const suppressedRules = [];
    {
      const seen = new Set();
      for (const r of this.results) {
        for (const c of r.checks) {
          if (c.suppressReason !== 'gatetestignore') continue;
          // Only a rule that NAMES the module is evidence about that module.
          // A bare `path/**` exclude says "this directory is not real code"
          // and implies nothing about accuracy — counting it softened
          // 555 findings across 8 accurate modules on this very repo,
          // purely because two ignore lines were directory excludes.
          if (c.suppressKind && c.suppressKind !== 'moduleRule') continue;
          const module = r.module;
          const ruleKey = _ruleIdentity(c);
          if (!module || !ruleKey) continue;
          const key = `${module}:${ruleKey}`;
          if (seen.has(key)) continue;
          seen.add(key);
          suppressedRules.push({ module, ruleKey });
        }
      }
    }

    // Accepted-risk overrides that applied to at least one finding this run
    // (move 3, docs/LAUNCH_BOARD.md) — active or expired, deduped by id.
    // Never derived from `this._acceptRiskOverrides` directly: only an
    // override that actually matched a real finding is worth reporting,
    // same reasoning as `suppressedRules` above.
    const acceptedRiskOverrides = [];
    {
      const seen = new Set();
      for (const r of this.results) {
        for (const c of r.checks) {
          const applied = c.overriddenBy || c.expiredOverride;
          if (!applied || seen.has(applied.id)) continue;
          seen.add(applied.id);
          acceptedRiskOverrides.push({
            id: applied.id,
            reason: applied.reason || null,
            by: applied.by || null,
            until: applied.until || null,
            created: applied.created || null,
            expired: Boolean(c.expiredOverride),
          });
        }
      }
    }

    // Baseline capture (`gatetest --baseline`) — snapshot the full current
    // failure surface so future runs only fail on NEW findings.
    let baselineInfo = null;
    if (this._captureBaseline) {
      try {
        const baseline = require('./baseline');
        const captured = baseline.capture(this.results, this._projectRoot);
        baselineInfo = { captured: captured.count, path: captured.path };
      } catch (err) {
        baselineInfo = { error: err.message || String(err) };
      }
    } else if (this._baselineMatcher) {
      baselineInfo = {
        active: true,
        fingerprints: this._baselineMatcher.count,
        suppressed: totalBaselined,
        capturedAt: this._baselineMatcher.capturedAt,
      };
    }

    // GATE DECISION: only CONFIDENT errors block. Failed modules block
    // unconditionally (runtime exceptions, module crashes). Soft errors
    // are visible in the report but don't fail the gate.
    const nothingChecked = this._nothingChecked === true;
    const strictEmpty = nothingChecked && this.options.strict === true;
    const rawGateStatus = (failed.length === 0 && totalBlockingErrors === 0 && !strictEmpty) ? 'PASSED' : 'BLOCKED';

    // KI #107 — admin softening, opt-in only, via `GATETEST_ADMIN=1` in the
    // environment of THIS run. `.gatetest.json`'s `admin`/`owner` keys are
    // read by other consumers (see config.js KNOWN_ROOT_KEYS) and never by
    // this decision — see src/core/admin-override.js for why. Never silent:
    // a loud notice here, and `adminOverride`/`rawGateStatus` on the summary
    // for every reporter (Forbidden #16).
    const adminOverride = require('./admin-override');
    const adminOverrideActive = rawGateStatus === 'BLOCKED' && adminOverride.isRequested();
    if (adminOverrideActive) {
      console.error(adminOverride.notice({ totalBlockingErrors, failedModules: failed.length }));
    }
    const gateStatus = adminOverrideActive ? 'PASSED' : rawGateStatus;

    // Finding registry: one defect = one finding across modules, ranked by
    // blocking → severity → confidence. Counts above are UNTOUCHED (the gate
    // already decided); reporters use `findings`/`findingSummary` to show
    // the ranked, deduped view and to say how many duplicates were folded
    // and how many low-confidence errors were held back (2026-08-18).
    const resultsJson = this.results.map(r => r.toJSON());
    let findings = [];
    let findingSummary = null;
    try {
      const registry = require('./finding-registry');
      registry.annotateDuplicates(resultsJson, {
        threshold: this._blockThreshold,
        modelVerdictsBlock: this._modelVerdictsBlock,
      });
      findings = registry.normalizeFindings(resultsJson, {
        threshold: this._blockThreshold,
        modelVerdictsBlock: this._modelVerdictsBlock,
      });
      findingSummary = registry.summarizeFindings(findings);
    } catch (err) { // error-ok — the registry is a presentation layer; a bug in it must never break a scan
      console.error('[GateTest] finding registry failed:', err && err.message ? err.message : err);
    }

    // Root cause on every red run (Launch Board move 12 / complaint C21): a
    // BLOCKED verdict says WHY, WHICH COMMIT, and HOW TO REPLAY — one
    // classifier (src/core/root-cause.js), never computed on a PASSED run.
    let rootCause = null;
    if (gateStatus === 'BLOCKED') {
      try {
        rootCause = require('./root-cause').buildRootCause({
          results: resultsJson,
          failedModules: failed.map(r => ({ module: r.module, error: String(r.error), failedChecks: r.failedChecks })),
          diffOnly: this.options.diffOnly,
          changedFiles: this.options.changedFiles,
          confidenceThreshold: this._blockThreshold,
          projectRoot: this._projectRoot,
          suite: this.options.suite || null,
          moduleName: this.options.moduleName || null,
          env: process.env,
        });
      } catch (err) { // error-ok — root-cause is a presentation layer; a bug in it must never break a scan
        console.error('[GateTest] root-cause classification failed:', err && err.message ? err.message : err);
      }
    }

    return {
      rootCause,
      gateStatus,
      // KI #107: the pre-override verdict and whether admin softening was
      // applied — always present so no reporter can show "PASSED" with no
      // trace that a blocking result was overridden (Forbidden #16).
      rawGateStatus,
      adminOverride: adminOverrideActive,
      // Gate policy (the Fifty, move 14): whether a model-judged finding is
      // allowed to block on its own. Always present so a reporter can say
      // "N model-judged finding(s) would block under a stricter policy"
      // without guessing which policy actually ran.
      modelVerdictsBlock: this._modelVerdictsBlock,
      // No source file under the root: every module passed by default.
      // Reporters print it beside the verdict; the JSON carries it so no
      // consumer can read an empty scan as a clean one. `strict` turns it
      // into the verdict itself (see the gate decision above).
      nothingChecked,
      projectRoot: this._projectRoot,
      findings,
      findingSummary,
      // Modules this suite deliberately did not run, and where they run
      // instead (src/core/config.js → SUITE_DEFERRALS). Always an array.
      // Carried on the summary so no consumer can present a deferred suite
      // as exhaustive — Forbidden #16.
      deferred: this.options.deferredModules || [],
      // KI #112 (issue #633): `.gatetest.json` keys nothing reads used to be
      // a stderr-only warning, invisible to `--format json` and the PR
      // comment. `null` (never emitted) when the config has none — a
      // three-state, never-blocking, printed-once-per-run finding
      // (src/core/config.js `getUnknownKeysCheck` — one definition).
      configCheck: (this.config && typeof this.config.getUnknownKeysCheck === 'function')
        ? this.config.getUnknownKeysCheck()
        : null,
      timestamp: new Date().toISOString(),
      duration: endTime - startTime,
      diffOnly: this.options.diffOnly,
      changedFiles: this.options.changedFiles,
      // Air-gapped mode (src/core/offline.js): nothing left the machine.
      offline: _isOffline(),
      // The repository's path filter, so every report can say what was
      // deliberately out of scope (Doctrine §6). Null when none is set.
      pathFilter: this._pathFilter
        ? { include: this._pathFilter.raw.include, exclude: this._pathFilter.raw.exclude, findingsDropped: this._pathFilterDropped }
        : null,
      confidenceThreshold: this._blockThreshold,
      incremental: this._incrementalMode
        ? { fileCount: this._incrementalFileSet ? this._incrementalFileSet.size : 0 }
        : null,
      baseline: baselineInfo,
      suppressedRules,
      overrides: acceptedRiskOverrides,
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
        // Blocking split by verdictSource (the Fifty, move 14) — the
        // console prints these as "N deterministic, M model-judged blocking".
        blockingErrorsDeterministic: totalDeterministicBlocking,
        blockingErrorsModelJudged: totalModelJudgedBlocking,
        softErrors: totalSoftErrors,
        // Model-judged findings that failed — never blocking by default
        // (verdictSource === 'model'); `modelJudgedWouldBlock` is the subset
        // that would block under `gate.modelVerdictsBlock`.
        modelJudged: totalModelJudged,
        modelJudgedWouldBlock: totalModelJudgedWouldBlock,
        warnings: totalWarnings,
        softWarnings: totalSoftWarnings,
        flywheelSoftened: totalFlywheelSoftened,
        demoted: totalDemoted,
        infoFindings: totalInfoFindings,
        baselined: totalBaselined,
        ignoreSuppressed: totalIgnoreSuppressed,
      },
      // The active demotion list (the Fifty, move 08) — a static fact about
      // this run's data/rule-demotions.json, independent of whether any
      // rule on it actually fired this scan. `checks.demoted` above is the
      // per-scan count of findings it actually softened.
      demotedRuleCount: _ruleDemotion ? _ruleDemotion.activeDemotionCount() : 0,
      fixes: {
        total: totalFixes,
        details: this.results.flatMap(r => r.fixes),
      },
      results: resultsJson,
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
  _ruleIdentity,
  DEFAULT_MODULE_TIMEOUT_MS,
  HEAVY_MODULE_TIMEOUT_MS,
  HEAVY_MODULES,
};
