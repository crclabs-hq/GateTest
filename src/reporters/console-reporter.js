/**
 * Console Reporter - Rich terminal output for GateTest results.
 */

// Empty strings when stdout is not a TTY or NO_COLOR is set (src/core/color.js)
// — a CI log must read "Errors:   3", not "Errors:   \x1b[31m3\x1b[0m".
const COLORS = require('../core/color').palette();

const { triageFindings, countFoldedDuplicates } = require('../core/finding-triage');
const { suggestLine } = require('../core/ignore-file');
const { replayCommand } = require('../core/ci-run-url');
const { ruleKeyOf } = require('../core/finding-registry');
const { siteUrl } = require('../core/site-url');
const { OFFLINE_NOTE } = require('../core/offline');

class ConsoleReporter {
  /**
   * @param {object} runner
   * @param {object} [opts]
   * @param {boolean} [opts.showAll=false] — restore the full per-module dump
   *   (`gatetest --all`). Off by default: a scan of this repo streams 813
   *   warnings inline, which reads as noise even though every one is real,
   *   and the developer closes the terminal. Default output is now a ranked
   *   shortlist at the end. Nothing is dropped silently — the count of what
   *   is not shown, and the flag to see it, are printed every time.
   */
  constructor(runner, opts = {}) {
    this.runner = runner;
    this.showAll = Boolean(opts.showAll);
    this._attach();
  }

  _attach() {
    this.runner.on('suite:start', (data) => this._onSuiteStart(data));
    this.runner.on('module:start', (result) => this._onModuleStart(result));
    this.runner.on('module:end', (result) => this._onModuleEnd(result));
    this.runner.on('module:skip', (result) => this._onModuleSkip(result));
    this.runner.on('suite:end', (summary) => this._onSuiteEnd(summary));
  }

  /**
   * The shortlist. This is the part a first-time user actually reads.
   *
   * "813 warnings" tells a developer nothing they can act on and reads as
   * noise even when every finding is real — so they close the terminal and
   * never run it again. "3 things, here they are, here is the line" gets
   * trusted. The confidence score that ranks these already existed; nothing
   * was using it to decide what to show.
   *
   * Blocking errors are listed in full and never capped — they stop the
   * build, so hiding any of them would be indefensible. Everything else
   * competes for three slots, spread across modules so one noisy module
   * cannot fill the list.
   *
   * The hidden count and the flag to see them are always printed. Quietly
   * showing 3 of 813 is the same dishonesty as reporting 813, in the other
   * direction.
   */
  _whatMatters(summary) {
    if (this.showAll) return;

    const { blocking, top, hiddenCount } = triageFindings(summary.results, {
      blockThreshold: summary.confidenceThreshold,
    });
    // Root cause (move 12): why / since / replay — computed once by the
    // runner (src/core/root-cause.js), never on a PASSED run, and printed
    // even when there are no individual findings to list (e.g. a config
    // error or a budget-limited module crashed before producing any).
    const rootCause = summary.gateStatus === 'BLOCKED' ? summary.rootCause : null;
    if (blocking.length === 0 && top.length === 0 && !rootCause) return;

    const line = (f, mark) => {
      const c = f.check;
      const where = c.file ? `${c.file}${c.line ? `:${c.line}` : ''}` : f.module;
      console.log(`  ${mark} ${COLORS.bold}${where}${COLORS.reset}`);
      const msg = c.message || c.name;
      if (msg) console.log(`      ${msg}`);
      if (c.suggestion) console.log(`      ${COLORS.dim}→ ${c.suggestion}${COLORS.reset}`);
      // The exact line that silences THIS finding, verified against the
      // matcher (move 25). Friction on a false positive is what turns a
      // shrug into a rip-out.
      const ignore = suggestLine({ module: f.module, name: c.name, ruleKey: ruleKeyOf(c.name, c.file), file: c.file });
      if (ignore) console.log(`      ${COLORS.dim}wrong? add to .gatetestignore: ${COLORS.reset}${ignore}`);
    };

    // A repo with 200 blockers should not open with 200 lines of scroll —
    // that recreates the wall this whole section exists to remove. Worst
    // first, a readable slice, and the remainder disclosed rather than
    // dropped. The gate decision is untouched: all of them still block.
    const BLOCKING_SHOWN = 10;
    const blockingShown = blocking.slice(0, BLOCKING_SHOWN);
    const blockingHidden = blocking.length - blockingShown.length;

    console.log('');
    if (blocking.length > 0 || rootCause) {
      console.log(`${COLORS.bold}  What's blocking you${COLORS.reset}${blocking.length > BLOCKING_SHOWN ? ` ${COLORS.dim}(worst ${BLOCKING_SHOWN} of ${blocking.length})${COLORS.reset}` : ''}`);
      for (const f of blockingShown) line(f, `${COLORS.red}✗${COLORS.reset}`);
      if (blockingHidden > 0) {
        console.log(`      ${COLORS.dim}…and ${blockingHidden} more blocking finding(s).${COLORS.reset}`);
      }
      // The fixed three-line block every BLOCKED verdict ends with (move 12):
      // classifier verdict, the commit git blame resolves it to (or an
      // honest "not checked"), and the exact command to reproduce it.
      if (rootCause) {
        console.log('');
        console.log(`      ${COLORS.bold}why:${COLORS.reset}     ${rootCause.why}`);
        console.log(`      ${COLORS.bold}since:${COLORS.reset}   ${rootCause.sinceText}`);
        console.log(`      ${COLORS.bold}replay:${COLORS.reset}  ${rootCause.replay}`);
      }
      if (top.length > 0) console.log('');
    }
    if (top.length > 0) {
      console.log(`${COLORS.bold}  ${blocking.length > 0 ? 'Also worth a look' : 'Worth a look'}${COLORS.reset}`);
      for (const f of top) line(f, `${COLORS.yellow}~${COLORS.reset}`);
    }
    if (hiddenCount > 0) {
      console.log('');
      console.log(`  ${COLORS.dim}${hiddenCount} more finding(s) not shown — ${COLORS.reset}gatetest --all${COLORS.dim} for everything.${COLORS.reset}`);
    }
    const folded = countFoldedDuplicates(summary.results);
    if (folded > 0) {
      console.log(`  ${COLORS.dim}${folded} duplicate report(s) folded — the same line flagged by more than one module counts once.${COLORS.reset}`);
    }
  }

  _onSuiteStart(data) {
    console.log('');
    console.log(`${COLORS.bold}${COLORS.cyan}========================================${COLORS.reset}`);
    console.log(`${COLORS.bold}${COLORS.cyan}  GATETEST - Quality Assurance Gate${COLORS.reset}`);
    console.log(`${COLORS.bold}${COLORS.cyan}========================================${COLORS.reset}`);
    console.log(`${COLORS.dim}  Modules: ${data.modules.join(', ')}${COLORS.reset}`);
    console.log('');

    // Issue #630 — in --parallel mode every module "starts" in the same
    // burst (the [RUN] line above), so the only per-module signal a
    // customer gets is whichever result resolves first; a slow module
    // (a big monorepo's tsc pass, say) reads identically to a hung
    // process until SOMETHING prints. `_onModuleEnd` below adds an
    // elapsed-since-suite-start line, to stderr so `--format json`'s
    // stdout stays the one JSON document, once the run has been going
    // long enough that "is this still alive" is a real question.
    this._suiteStartedAt = Date.now();
    this._parallelRun = Boolean(this.runner.options && this.runner.options.parallel);
  }

  _onModuleStart(result) {
    process.stdout.write(`  ${COLORS.blue}[RUN]${COLORS.reset} ${result.module} `);
  }

  _onModuleEnd(result) {
    // Progress, not the report: a completion ping once a --parallel run
    // has run long enough that silence would read as a hang (Doctrine
    // #14 — speed is a precision feature, but honesty about slowness is
    // the fallback when a tree is just genuinely large). Always stderr,
    // never gated on `showAll` — this is liveness, not a finding.
    if (this._parallelRun && this._suiteStartedAt) {
      const sinceSuiteStartMs = Date.now() - this._suiteStartedAt;
      if (sinceSuiteStartMs > 30_000) {
        // Issue #649 (D1): this used to print `sinceSuiteStartMs` here too,
        // so every module finishing near the end of a long --parallel run
        // showed the SAME near-suite-total number — fakeFixDetector (1,186ms)
        // and memory (569,775ms) both read "[569.8s elapsed]". The runner
        // already records each module's own duration (`result.duration`,
        // the same value the JSON report carries — Doctrine #4, one
        // definition) — print THAT here. The suite clock is shown exactly
        // once, on the summary line (`_onSuiteEnd`'s "Time: Xms").
        process.stderr.write(
          `  ${COLORS.dim}[${(result.duration / 1000).toFixed(1)}s elapsed] ${result.module} finished${COLORS.reset}\n`,
        );
      }
    }

    const errors = result.errorChecks.length;
    const warnings = result.warningChecks.length;
    const fixes = result.fixes.length;

    if (result.status === 'passed') {
      const checkCount = result.checks.length;
      let extra = `${checkCount} checks, ${result.duration}ms`;
      if (warnings > 0) extra += `, ${warnings} warnings`;
      if (fixes > 0) extra += `, ${fixes} auto-fixed`;
      console.log(`${COLORS.green}[PASS]${COLORS.reset} ${COLORS.dim}(${extra})${COLORS.reset}`);
      // Warnings are collected and ranked for the shortlist at the end.
      // Streaming every one inline is what produced 813 lines of scroll.
      if (this.showAll) {
        for (const check of result.warningChecks) {
          console.log(`    ${COLORS.yellow}~ ${check.name}${COLORS.reset}`);
          if (check.message) {
            console.log(`      ${COLORS.dim}${check.message}${COLORS.reset}`);
          }
        }
      }
    } else {
      let extra = `${errors} errors, ${result.duration}ms`;
      if (warnings > 0) extra += `, ${warnings} warnings`;
      if (fixes > 0) extra += `, ${fixes} auto-fixed`;
      console.log(`${COLORS.red}[FAIL]${COLORS.reset} ${COLORS.dim}(${extra})${COLORS.reset}`);
      // Show errors first
      for (const check of result.errorChecks) {
        const prefix = check.autoFixed
          ? `${COLORS.green}+ FIXED${COLORS.reset}`
          : `${COLORS.red}x${COLORS.reset}`;
        // Soft-error annotation: low-confidence error doesn't block
        const isSoft = typeof check.confidence === 'number' && check.confidence < 0.7;
        const tag = isSoft
          ? ` ${COLORS.dim}(low confidence: ${check.confidence.toFixed(2)})${COLORS.reset}`
          : '';
        console.log(`    ${prefix} ${COLORS.red}${check.name}${COLORS.reset}${tag}`);
        if (check.expected !== undefined) {
          console.log(`      ${COLORS.dim}expected: ${check.expected}, got: ${check.actual}${COLORS.reset}`);
        }
        if (check.file) {
          console.log(`      ${COLORS.dim}file: ${check.file}:${check.line || ''}${COLORS.reset}`);
        }
        if (check.suggestion) {
          console.log(`      ${COLORS.yellow}fix: ${check.suggestion}${COLORS.reset}`);
        }
      }
      // Then warnings — same reasoning as the pass branch. Errors above are
      // always shown; they are why the module failed.
      if (this.showAll) {
        for (const check of result.warningChecks) {
          console.log(`    ${COLORS.yellow}~ ${check.name}${COLORS.reset}`);
          if (check.message) {
            console.log(`      ${COLORS.dim}${check.message}${COLORS.reset}`);
          }
        }
      }
    }
    // Show applied fixes
    for (const fix of result.fixes) {
      console.log(`    ${COLORS.green}+ auto-fixed: ${fix.description}${COLORS.reset}`);
    }
  }

  _onModuleSkip(result) {
    console.log(`  ${COLORS.yellow}[SKIP]${COLORS.reset} ${result.module} — ${result.error}`);
  }

  _onSuiteEnd(summary) {
    console.log('');
    console.log(`${COLORS.bold}${COLORS.cyan}----------------------------------------${COLORS.reset}`);

    if (summary.gateStatus === 'PASSED') {
      // Move 4 — a budget-limited PASS must never read identically to a
      // full, unlimited one: some of the modules that would have decided
      // this verdict never ran (Forbidden #16 — never a fake pass).
      const budgetNote = summary.budgetLimited
        ? ` (budget-limited: ${summary.budgetDeferredCount} module${summary.budgetDeferredCount === 1 ? '' : 's'} deferred)`
        : '';
      console.log(`${COLORS.bold}${COLORS.bgGreen}${COLORS.white}  GATE: PASSED${budgetNote}  ${COLORS.reset}`);
    } else {
      console.log(`${COLORS.bold}${COLORS.bgRed}${COLORS.white}  GATE: BLOCKED  ${COLORS.reset}`);
      // First line under a red gate in CI: the command that reproduces it
      // on the developer's machine (move 28). "Couldn't reproduce it
      // locally" is the most expensive sentence in CI.
      const replay = replayCommand();
      if (replay) console.log(`  ${COLORS.bold}Reproduce locally:${COLORS.reset} ${replay}`);
    }

    console.log('');
    // Never let an empty scan read as a clean one: no source file under the
    // root means every module passed by default, and this is said beside
    // the verdict, not buried in a module line (src/core/scan-scope.js).
    if (summary.nothingChecked) {
      const where = summary.projectRoot || 'the project root';
      console.log(`  ${COLORS.bold}${COLORS.yellow}⚠ No source files found under ${where} — nothing was checked.${COLORS.reset}`);
      console.log(`  ${COLORS.yellow}${summary.gateStatus === 'PASSED'
        ? 'Every module passed by default, not by inspection. Check --project, or pass --strict to fail an empty scan.'
        : 'The gate is BLOCKED because --strict was set: an empty scan enforces nothing.'}${COLORS.reset}`);
      console.log('');
    }
    if (summary.diffOnly) {
      console.log(`${COLORS.dim}  Mode: diff-only (${(summary.changedFiles || []).length} changed files)${COLORS.reset}`);
    }
    if (summary.offline) {
      console.log(`${COLORS.dim}  Mode: ${OFFLINE_NOTE}${COLORS.reset}`);
    }
    // The Fifty, move 08 — never silent: if the field-data demotion list is
    // active at all, say so, even on a run where nothing it covers fired.
    if (summary.demotedRuleCount > 0) {
      console.log(`${COLORS.dim}  ${summary.demotedRuleCount} rule(s) demoted by field silence data (see /noise)${COLORS.reset}`);
    }
    if (summary.pathFilter) {
      const pf = summary.pathFilter;
      const parts = [];
      if (pf.include.length) parts.push(`include ${pf.include.join(', ')}`);
      if (pf.exclude.length) parts.push(`exclude ${pf.exclude.join(', ')}`);
      console.log(`${COLORS.dim}  Scope: .gatetest.json paths — ${parts.join('; ')}${pf.findingsDropped ? ` (${pf.findingsDropped} finding(s) outside it not shown)` : ''}${COLORS.reset}`);
    }
    console.log(`  Modules:  ${summary.modules.passed}/${summary.modules.total} passed`);
    // "86/89 passed" reads as "the whole engine ran". When a suite
    // deliberately holds a module back, saying so here is the difference
    // between a documented trade-off and a silent coverage cut
    // (Forbidden #16 — never silently fail). Same spirit as the Softened
    // line below: never quiet about being quiet.
    for (const d of summary.deferred || []) {
      console.log(
        `  ${COLORS.dim}Deferred: ${d.module} — ${d.reason}. Runs in: ${d.runsIn}${COLORS.reset}`,
      );
    }
    // KI #112 (issue #633): `.gatetest.json` keys nothing reads, printed
    // exactly once per run (config.js already warns to stderr at load time;
    // this is the same finding surfacing where a customer actually reads
    // their scan result — console, and via json-output.js the JSON report).
    if (summary.configCheck) {
      console.log(`  ${COLORS.dim}Config: ${summary.configCheck.message}${COLORS.reset}`);
    }
    // Info-severity "findings" (markdown whitespace nits, missing Stylelint
    // config, etc.) never block and are never even a warning — but each one
    // still counts as one failed check in the raw total. Left in the
    // denominator, `passed/total` reads as "half this repo is broken" on a
    // perfectly healthy scan (self-scan 2026-07-15: 1272/2506). Excluding
    // them makes the headline reflect what actually needs attention.
    const infoFindings = summary.checks.infoFindings || 0;
    const actionableTotal = summary.checks.total - infoFindings;
    const infoNote = infoFindings > 0
      ? ` ${COLORS.dim}(+${infoFindings} info-only nit(s), never blocks — see Info below)${COLORS.reset}`
      : '';
    console.log(`  Checks:   ${summary.checks.passed}/${actionableTotal} passed${infoNote}`);
    const blocking = summary.checks.blockingErrors;
    const soft = summary.checks.softErrors;
    if (typeof blocking === 'number' && typeof soft === 'number' && soft > 0) {
      console.log(`  Errors:   ${COLORS.red}${blocking}${COLORS.reset} blocking, ${COLORS.dim}${soft} soft (low confidence)${COLORS.reset}`);
    } else {
      console.log(`  Errors:   ${COLORS.red}${summary.checks.errors}${COLORS.reset}`);
    }
    // The Fifty, move 14 (complaints C1/C4 — "40% of AI review alerts
    // ignored"): a model-judged finding is never weighted the same as a
    // deterministic rule firing. Shown whenever the scan produced any
    // model-judged findings at all, even when none of them were error-level
    // (the operator still deserves to see the split was zero, not omitted).
    const modelJudged = summary.checks.modelJudged || 0;
    if (modelJudged > 0) {
      const detBlocking = summary.checks.blockingErrorsDeterministic ?? blocking;
      const modelBlocking = summary.checks.blockingErrorsModelJudged || 0;
      const wouldBlock = summary.checks.modelJudgedWouldBlock || 0;
      const policyNote = summary.modelVerdictsBlock
        ? ''
        : (wouldBlock > 0
          ? `${COLORS.dim} (${wouldBlock} would block under --model-verdicts-block)${COLORS.reset}`
          : '');
      console.log(`  Verdicts: ${COLORS.dim}${detBlocking} deterministic blocking, ${modelBlocking} model-judged blocking${COLORS.reset}${policyNote}`);
    }
    // Warnings get the same confident/soft disclosure errors already had.
    // The score was being computed for warnings and then discarded, so a
    // pile of 800 gave no hint how much of it was shaky (KI #77).
    const softWarn = summary.checks.softWarnings;
    const softWarnNote = typeof softWarn === 'number' && softWarn > 0
      ? `${COLORS.dim} (${softWarn} low confidence)${COLORS.reset}`
      : '';
    console.log(`  Warnings: ${COLORS.yellow}${summary.checks.warnings}${COLORS.reset}${softWarnNote}`);
    // Flywheel softening was previously observable only by inspecting
    // confidenceSignals on an individual check — the scan said nothing about
    // findings having been quieted on the user's own past dismissals
    // (disclosure gap on KI #76). Never quiet about being quiet.
    const softened = summary.checks.flywheelSoftened;
    if (typeof softened === 'number' && softened > 0) {
      console.log(`  ${COLORS.dim}Softened: ${softened} finding(s) down-weighted from your .gatetestignore history — see ${COLORS.reset}gatetest --noise`);
    }
    // Accepted-risk overrides (move 3, docs/LAUNCH_BOARD.md) — recorded,
    // never silent: a run that carried one says so here even though the
    // finding itself no longer blocks. Full detail (reason/by/until) lives
    // in the report, not the console line (Forbidden #16 — never hidden,
    // just not duplicated in every line of output).
    if (Array.isArray(summary.overrides) && summary.overrides.length > 0) {
      console.log(`  ${COLORS.dim}${summary.overrides.length} accepted risk(s) (see report)${COLORS.reset}`);
    }
    if (infoFindings > 0) {
      console.log(`  Info:     ${COLORS.dim}${infoFindings}${COLORS.reset}`);
    }
    if (summary.fixes.total > 0) {
      console.log(`  Fixed:    ${COLORS.green}${summary.fixes.total}${COLORS.reset}`);
    }
    console.log(`  Time:     ${summary.duration}ms`);
    // Top-5 slowest modules (move 4) — per-module timing already existed
    // (#644/#650); this is the one-line "where did the time go" shortlist.
    if (Array.isArray(summary.slowestModules) && summary.slowestModules.length > 0) {
      const shortlist = summary.slowestModules
        .map((m) => `${m.module} (${(m.durationMs / 1000).toFixed(1)}s)`)
        .join(', ');
      console.log(`  ${COLORS.dim}Slowest:  ${shortlist}${COLORS.reset}`);
    }

    if (summary.failedModules.length > 0) {
      console.log('');
      console.log(`${COLORS.red}  Failed modules:${COLORS.reset}`);
      for (const fm of summary.failedModules) {
        console.log(`    ${COLORS.red}- ${fm.module}: ${fm.error}${COLORS.reset}`);
      }
    }

    this._whatMatters(summary);

    this._upsell(summary);

    console.log('');
    console.log(`${COLORS.dim}  Report generated at ${summary.timestamp}${COLORS.reset}`);
    console.log(`${COLORS.bold}${COLORS.cyan}========================================${COLORS.reset}`);
    console.log('');
  }

  /**
   * Conversion hook — fires only when there are fixable findings (the moment
   * of maximum intent). The free CLI just told the developer what's broken;
   * this is where we offer to fix it for them. Honest, single CTA, no spam.
   * Suppressible in CI / scripted runs via GATETEST_NO_UPSELL.
   */
  _upsell(summary) {
    if (process.env.GATETEST_NO_UPSELL) return;
    const errs =
      typeof summary.checks.errors === 'number'
        ? summary.checks.errors
        : (summary.checks.blockingErrors || 0) + (summary.checks.softErrors || 0);
    const warns = summary.checks.warnings || 0;
    const fixable = errs + warns;
    if (fixable <= 0) return;

    console.log('');
    console.log(`${COLORS.bold}${COLORS.magenta}  ────────────────────────────────────────${COLORS.reset}`);
    console.log(
      `${COLORS.bold}  🔧 GateTest found ${COLORS.magenta}${fixable}${COLORS.reset}${COLORS.bold} fixable issue${fixable === 1 ? '' : 's'} in this scan.${COLORS.reset}`,
    );
    console.log(
      `${COLORS.dim}     This scan ran the deterministic engine for free. To have them FIXED —${COLORS.reset}`,
    );
    console.log(
      `${COLORS.dim}     The fix engine opens a PR, re-scans each fix, and proves it worked:${COLORS.reset}`,
    );
    console.log(`     ${COLORS.cyan}${COLORS.bold}→ ${siteUrl()}${COLORS.reset}  ${COLORS.dim}(Scan + Fix, one verified PR)${COLORS.reset}`);
    console.log(
      `${COLORS.dim}     Already have an ANTHROPIC_API_KEY? Fix locally: ${COLORS.reset}${COLORS.cyan}gatetest fix${COLORS.reset}`,
    );
    console.log(`${COLORS.bold}${COLORS.magenta}  ────────────────────────────────────────${COLORS.reset}`);
  }
}

module.exports = { ConsoleReporter };
