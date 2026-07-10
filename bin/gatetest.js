#!/usr/bin/env node

/**
 * GateTest CLI - Command-line interface for the GateTest QA system.
 *
 * Usage:
 *   gatetest                    Run standard test suite
 *   gatetest --suite full       Run the full test suite
 *   gatetest --suite quick      Run quick checks only
 *   gatetest --module security  Run a specific module
 *   gatetest --module visual    Run visual regression tests
 *   gatetest --validate         Validate CLAUDE.md file
 *   gatetest --report           Show latest report
 *   gatetest --list             List available modules
 *   gatetest --init             Initialize GateTest in a project
 */

const path = require('path');
const fs = require('fs');
const { GateTest } = require('../src/index');

const HELP = `
  GateTest - Advanced QA Gate System
  Nothing ships unless it's pristine.

  USAGE
    gatetest [options]
    gatetest sweep [sweep-options]   Run the Bible's pre-merge sweep (tests +
                                     build + module load + gate + secrets +
                                     TODOs + self-scan) and exit 0 if green,
                                     1 if any blocking step failed. See
                                     "gatetest sweep --help" for details.
    gatetest scan  [options]         Explicit alias for the default scan flow
                                     (same as running gatetest with no
                                     subcommand). Useful for unambiguous
                                     scripts.
    gatetest replay <run-url>        Reproduce a failing CI run locally
                                     (run 'gatetest replay --help' for detail)
    gatetest fix --apply [options]   Run AI fix engine and apply changes directly
                                     to files on disk. No git branch, no PR.
                                     Works entirely locally. Requires
                                     ANTHROPIC_API_KEY. See 'gatetest fix --help'.
    gatetest train [options]         Run all flywheel trainers locally —
                                     pattern miner, recipe promoter,
                                     regression-test generator, cross-repo
                                     promoter, adversarial mutator. Outputs
                                     land at ~/.gatetest/trainers/. See
                                     'gatetest train --help' for options.
    gatetest trace <file|-> [opts]   Resolve a minified/bundled stack trace
                                     back to original file:line:column via
                                     source maps. Same engine as the MCP
                                     resolve_stack_trace tool. See
                                     'gatetest trace --help'.
    gatetest blame <file> --line <n> Find which git commit introduced a
                                     specific line — read-only, never
                                     checks out or mutates the working
                                     tree. Same engine as the MCP
                                     blame_regression tool. See
                                     'gatetest blame --help'.

  OPTIONS
    --suite <name>     Run a test suite: quick, standard, full (default: standard)
    --module <name>    Run a specific module by name
    --skip-module <name>
                       Skip a specific module within the chosen suite.
                       Repeatable. Useful for CI gates that want most of
                       the suite but want to defer slow modules (e.g.
                       mutation testing) to a nightly run.
    --validate         Validate the CLAUDE.md file
    --report           Display the latest test report
    --noise            Show which modules are noisy for this repo (fire-rate +
                       dismissals, learned from scan history) and which have
                       been auto-softened. Silence noise via .gatetestignore.
    --list             List all available test modules
    --init             Initialize GateTest in the current project
    --parallel         Run modules in parallel
    --stop-first       Stop on first module failure
    --fix              Auto-fix safe issues (formatting, imports, etc.)
    --auto-pr          After a failed gate, AI-fix every finding with a file path
                       and open a pull request with the fixes. Requires gh CLI
                       authenticated (or GH_TOKEN env var) AND ANTHROPIC_API_KEY.
                       Use this in CI to turn "gate blocked" into "gate blocked
                       BUT here is a PR to merge."
    --auto-pr-base <ref>    Base branch for the auto-PR (default: current branch)
    --auto-pr-branch <name> Override the auto-generated branch name
    --model <name>     Claude model for AI fixes (fix --apply and --auto-pr):
                       sonnet (default) | opus | fable — or full model ids.
                       Env fallback: GATETEST_FIX_MODEL. Runs on YOUR OWN
                       ANTHROPIC_API_KEY (bring-your-own-key): calls go straight
                       from your machine to api.anthropic.com, you control the
                       spend. Fable 5 is ~3.3x Sonnet cost per token.
    --since <ref>      Incremental scan: only check files changed since <ref>
                       (branch, tag, or commit SHA). Skips full-graph modules
                       (importCycle, deadCode, crossFileTaint, openapiDrift).
                       Security and PR-meta modules always run in full.
    --pr               Incremental scan: auto-detect base branch from
                       GITHUB_BASE_REF (CI) or fall back to origin/main.
                       Shortcut for --since in pull-request workflows.
    --diff             Only scan git-changed files (fast pre-commit mode)
    --report-only      Report findings but NEVER fail the gate. Use this
                       on a fresh GateTest install so CI stays green from
                       day 1 while the team triages pre-existing findings.
                       Default for new installs; opt INTO strict mode.
    --strict           Force blocking behaviour even when --report-only or
                       a report-only env/config flag is set. Use once
                       you've triaged the baseline and want the gate to
                       enforce. Wins over --report-only when both pass.
    --watch            Watch for file changes and re-scan continuously
    --sarif            Output results in SARIF format (for GitHub Security)
    --junit            Output results in JUnit XML format (for CI)
    --github-annotations
                       Emit GitHub Actions workflow commands so findings
                       appear as inline annotations on the PR diff (red
                       squiggles on the changed line). Auto-on when the
                       GITHUB_ACTIONS env var is set, so CI workflows
                       get this for free. Pass explicitly to force it
                       on outside Actions (e.g. local debugging).
    --ci-init <type>   Generate CI config: github, gitlab, circleci
    --project <path>   Set project root (default: cwd)
    --confidence-threshold <0..1>
                       Confidence threshold below which error-severity
                       findings are downgraded to "soft errors" (visible
                       in the report, don't block the gate). Default 0.7.
                       Lower = stricter (more findings block). Higher =
                       more lenient (more findings downgrade). Findings
                       in test files, fixtures, docs, and inside string
                       literals get a confidence multiplier <1 so they
                       fall below threshold by default.
    --help, -h         Show this help message
    --doctor           Audit your environment — checks every prerequisite for
                       auto-fix to work (Node version, gh CLI, ANTHROPIC_API_KEY,
                       workflow file version, etc.) and reports what's missing
                       with copy-paste fix commands. Run this any time you
                       suspect something isn't working.
    --doctor-quick     Same but skips the live Anthropic API ping (offline mode)
    --version, -v      Show version

    --server <url>     Scan a live server: SSL, headers, DNS, performance
    --crawl <url>      Crawl a live website and test every page
    --crawl-loop <url> Crawl, report failures, wait for fixes, repeat until clean
    --crawl-max <n>    Max pages to crawl (default: 100)
    --feedback         Show the latest crawl feedback report

    --diagnose <url>   Full real-time diagnosis: availability, response time, cache, bottleneck, action plan
    --monitor <url>    Continuous monitoring: polls every 60s, alerts on downtime/slowness/stale content
    --monitor-interval <n>  Polling interval in seconds (default: 60)
    --monitor-heal     Auto-apply safe fixes (cache flush) when issues detected
    --flush <url>      Flush CDN cache: tries Vercel, Cloudflare, custom webhook, then gives manual steps

  EXAMPLES
    gatetest                          Run standard checks
    gatetest sweep                    Run the Bible's full pre-merge sweep
    gatetest sweep --fast             Sweep gate-only (skip tests + build)
    gatetest --suite full             Run every single check
    gatetest --module security        Security scan only
    gatetest --module visual          Visual regression only
    gatetest --suite quick            Fast pre-commit checks
    gatetest --server https://gatetest.ai    Scan server SSL, headers, DNS
    gatetest --crawl https://zoobicon.com   Crawl and test live site
    gatetest --diagnose https://mysite.com  Full real-time diagnosis + action plan
    gatetest --monitor https://mysite.com   Start continuous monitoring (60s poll)
    gatetest --monitor https://mysite.com --monitor-interval 30 --monitor-heal
    gatetest --flush https://mysite.com     Flush CDN cache (Vercel/Cloudflare/webhook)
    gatetest --crawl-loop https://zoobicon.com  Continuous test-fix loop

  MODULES
    syntax         Syntax & compilation validation
    lint           ESLint, Stylelint, Markdownlint
    secrets        Secret & credential detection
    codeQuality    Code quality analysis
    unitTests      Unit test execution
    integrationTests  Integration test execution
    e2e            End-to-end test execution
    visual         Visual regression testing
    accessibility  WCAG 2.2 AAA compliance
    performance    Performance & Web Vitals
    security       Security analysis
    seo            SEO & metadata validation
    links          Broken link detection
    compatibility  Browser compatibility
    dataIntegrity  Data integrity validation
    documentation  Documentation completeness
    liveCrawler    Live site crawl & verification
`;

async function main() {
  // Subcommand routing (backwards-compatible).
  //   gatetest sweep [...]   → run the Bible's pre-merge sweep locally
  //   gatetest replay <url>  → reproduce a failing GitHub Actions run locally
  //   gatetest scan  [...]   → alias for the default scan flow (current
  //                            behavior; the word "scan" is consumed and the
  //                            rest of the flags are parsed as usual)
  //   gatetest <other>       → if the first arg is not a recognised
  //                            subcommand, fall through to flag parsing so
  //                            every existing invocation keeps working.
  const rawArgs = process.argv.slice(2);
  const first = rawArgs[0];
  const KNOWN_SUBCOMMANDS = new Set(['sweep', 'replay', 'scan', 'train', 'fix', 'trace', 'blame']);
  if (first === 'sweep') {
    const { runSweep } = require('./gatetest-sweep');
    const code = await runSweep(rawArgs.slice(1));
    process.exit(code);
  }
  if (first === 'replay') {
    const replay = require('./gatetest-replay');
    const code = await replay.main(rawArgs.slice(1));
    process.exit(code || 0);
  }
  if (first === 'train') {
    const train = require('./gatetest-train');
    const code = await train.main(rawArgs.slice(1));
    process.exit(code || 0);
  }
  if (first === 'trace') {
    const trace = require('./gatetest-trace');
    const code = await trace.main(rawArgs.slice(1));
    process.exit(code || 0);
  }
  if (first === 'blame') {
    const blame = require('./gatetest-blame');
    const code = await blame.main(rawArgs.slice(1));
    process.exit(code || 0);
  }
  if (first === 'fix') {
    const projectRoot = (() => {
      const pidx = rawArgs.indexOf('--project');
      return pidx !== -1 ? rawArgs[pidx + 1] : process.cwd();
    })();
    const code = await runFixApply(rawArgs.slice(1), projectRoot);
    process.exit(code || 0);
  }
  // 'scan' is an explicit alias for the default behavior. Consume it.
  const effectiveArgv = first === 'scan' ? rawArgs.slice(1) : rawArgs;
  const args = parseArgs(effectiveArgv);
  // Ignore stale "scan" token if it somehow re-appears later.
  if (args._subcommand === 'scan') delete args._subcommand;
  // (KNOWN_SUBCOMMANDS export only used to keep the route table in one place.)
  void KNOWN_SUBCOMMANDS;

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.version) {
    const pkg = require('../package.json');
    console.log(`GateTest v${pkg.version}`);
    process.exit(0);
  }

  const projectRoot = args.project || process.cwd();

  if (args.init) {
    initProject(projectRoot);
    return;
  }

  // Doctor — full environment audit, plain-English, for non-experts.
  // Designed so Craig (or any customer) can answer "why isn't auto-fix
  // working?" in 30 seconds without needing a developer to interpret.
  if (args.doctor) {
    const { runDoctor, renderDoctor } = require('../src/core/doctor');
    const result = await runDoctor({
      projectRoot,
      probeAnthropic: !args.doctorQuick,
    });
    console.log(renderDoctor(result));
    process.exit(result.summary.bad > 0 ? 1 : 0);
  }

  // Health check — verify GitHub API access before starting scans
  if (args.health) {
    const { GitHubBridge } = require('../src/core/github-bridge');
    const bridge = new GitHubBridge({ projectRoot });
    console.log('\n[GateTest] GitHub API Health Check\n');

    const health = await bridge.healthCheck();
    if (health.available) {
      console.log(`  Status:     CONNECTED`);
      console.log(`  Latency:    ${health.latencyMs}ms`);
      console.log(`  Rate Limit: ${health.rateLimit.remaining}/${health.rateLimit.limit} remaining`);
      if (health.rateLimit.resetsAt) {
        console.log(`  Resets At:  ${health.rateLimit.resetsAt}`);
      }
    } else {
      console.log(`  Status:     UNREACHABLE`);
      console.log(`  Error:      ${health.error || `HTTP ${health.statusCode}`}`);
    }

    console.log(`  Circuit:    ${health.circuitBreaker.status} (${health.circuitBreaker.failures} failures)`);

    const status = bridge.getAccessStatus();
    console.log(`  Retry:      ${status.retryConfig.maxRetries} retries, ${status.retryConfig.baseDelayMs}ms base delay\n`);

    // Try auth verification
    try {
      const auth = await bridge.verifyAuth();
      console.log(`  Auth:       ${auth.type} — ${auth.login || auth.name}`);
    } catch (err) { // error-ok — auth check in CLI health output; failure message shown to user
      console.log(`  Auth:       ${err.message}`);
    }

    console.log('');
    process.exit(health.available ? 0 : 1);
  }

  if (args.initClaudeMd) {
    const { ClaudeMdGenerator } = require('../src/core/claude-md-generator');
    const siteUrl = args.crawl || args.crawlLoop || null;
    const generator = new ClaudeMdGenerator(projectRoot, { siteUrl });
    const outPath = await generator.generateAndWrite();
    console.log(`\n[GateTest] CLAUDE.md generated at: ${outPath}`);
    console.log('[GateTest] Hooks installed at: .claude/settings.json');
    console.log('[GateTest] Scan script created: gatetest-scan.js\n');
    return;
  }

  // CI config generation
  if (args.ciInit) {
    const { CiGenerator } = require('../src/core/ci-generator');
    const gen = new CiGenerator(projectRoot);
    const outPath = gen.generate(args.ciInit);
    console.log(`\n[GateTest] CI config generated: ${outPath}\n`);
    return;
  }

  // Resolve the incremental base ref for --since / --pr
  const incrementalSince = args.since
    || (args.pr
      ? (process.env.GITHUB_BASE_REF
          ? `origin/${process.env.GITHUB_BASE_REF}`
          : 'origin/main')
      : undefined);

  const gatetest = new GateTest(projectRoot, {
    parallel: args.parallel || false,
    stopOnFirstFailure: args['stop-first'] || false,
    autoFix: args.fix || false,
    diffOnly: args.diff || false,
    sarif: args.sarif || false,
    junit: args.junit || false,
    githubAnnotations: args.githubAnnotations || false,
    // Report-only mode — gate reports findings but never fails the
    // workflow on them. Strict mode (default OFF) reverses this and
    // blocks on confident errors. See `runner.js` for the mechanism.
    reportOnly: args.reportOnly === true && args.strict !== true,
    ...(incrementalSince ? { incrementalSince } : {}),
    ...(typeof args.confidenceThreshold === 'number'
      ? { confidenceThreshold: args.confidenceThreshold }
      : {}),
  });

  gatetest.init();

  // Watch mode
  if (args.watch) {
    await runWatchMode(gatetest, args);
    return;
  }

  if (args.validate) {
    const validation = gatetest.validateClaudeMd();
    console.log('\nCLAUDE.md Validation:');
    console.log(`  Valid: ${validation.valid}`);
    console.log(`  Sections: ${validation.stats.sections}`);
    console.log(`  Checklist Items: ${validation.stats.totalItems}`);
    console.log(`  Gate Rules: ${validation.stats.gateRules}`);
    console.log(`  Version: ${validation.stats.version}`);
    if (validation.issues.length > 0) {
      console.log('\n  Issues:');
      for (const issue of validation.issues) {
        console.log(`    - ${issue}`);
      }
    }
    process.exit(validation.valid ? 0 : 1);
  }

  if (args.list) {
    const modules = gatetest.registry.list();
    console.log('\nAvailable GateTest Modules:\n');
    for (const name of modules) {
      const mod = gatetest.registry.get(name);
      console.log(`  ${name.padEnd(20)} ${mod?.description || ''}`);
    }
    console.log('');
    process.exit(0);
  }

  if (args.report) {
    showLatestReport(projectRoot);
    return;
  }

  if (args.noise) {
    showNoiseReport(projectRoot);
    return;
  }

  if (args.feedback) {
    showCrawlFeedback(projectRoot);
    return;
  }

  // Live site crawl
  if (args.crawl) {
    await runCrawl(gatetest, args.crawl, args.crawlMax || 100);
    return;
  }

  // Continuous crawl-fix loop
  if (args.crawlLoop) {
    await runCrawlLoop(gatetest, args.crawlLoop, args.crawlMax || 100);
    return;
  }

  // Full real-time diagnosis
  if (args.diagnose) {
    const Diagnostics = require('../src/runtime/diagnostics');
    const diag = new Diagnostics();
    const url = args.diagnose.startsWith('http') ? args.diagnose : `https://${args.diagnose}`;
    console.log(`\n  GATETEST — Real-Time Diagnosis\n  Target: ${url}\n`);
    try {
      const r = await diag.diagnose(url);
      const icon = { healthy: '\x1b[32m✓ HEALTHY\x1b[0m', warning: '\x1b[33m! WARNING\x1b[0m', degraded: '\x1b[33m⚠ DEGRADED\x1b[0m', critical: '\x1b[31m✗ CRITICAL\x1b[0m' }[r.status] || r.status;
      console.log(`  Status: ${icon}`);
      if (r.checks.responseTime) console.log(`  Response: p50=${r.checks.responseTime.p50}ms, p95=${r.checks.responseTime.p95}ms`);
      if (r.checks.cache) console.log(`  Cache: ${r.checks.cache.strategy || 'unknown'} | CDN: ${r.checks.cache.cdnStatus || 'n/a'}`);
      if (r.checks.bottleneck?.classification !== 'none') console.log(`  Bottleneck: ${r.checks.bottleneck?.classification || 'none'}`);
      if (r.issues.length > 0) {
        console.log('\n  Issues found:');
        for (const i of r.issues) console.log(`    ${i.severity === 'critical' ? '\x1b[31m✗\x1b[0m' : i.severity === 'error' ? '\x1b[33m!\x1b[0m' : '·'} [${i.code}] ${i.message}`);
      }
      if (r.actions.length > 0) {
        console.log('\n  Recommended actions:');
        for (const a of r.actions) console.log(`    → ${a}`);
      }
      console.log('');
      process.exit(r.status === 'healthy' ? 0 : 1);
    } catch (err) {
      console.error(`\n  \x1b[31mDiagnosis failed: ${err.message}\x1b[0m\n`);
      process.exit(1);
    }
  }

  // Continuous monitoring
  if (args.monitor) {
    const Monitor = require('../src/runtime/monitor');
    const url = args.monitor.startsWith('http') ? args.monitor : `https://${args.monitor}`;
    const monitor = new Monitor({
      autoHeal: args.monitorHeal || false,
      webhook: process.env.GATETEST_ALERT_WEBHOOK,
      logFile: require('path').join(process.cwd(), '.gatetest', 'monitor', 'monitor.log'),
    });
    monitor.addTarget(url, { interval: args.monitorInterval || 60, label: url });
    monitor.start();
    return;
  }

  // Cache flush
  if (args.flush) {
    const CacheManager = require('../src/runtime/cache-manager');
    const cm = new CacheManager();
    const url = args.flush.startsWith('http') ? args.flush : `https://${args.flush}`;
    console.log(`\n  GATETEST — Cache Flush\n  Target: ${url}\n`);
    try {
      const r = await cm.flush(url);
      for (const a of r.actions) {
        const icon = a.success ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
        console.log(`  ${icon} ${a.provider}: ${a.message}`);
      }
      if (r.manualSteps.length > 0) {
        console.log('\n  Manual steps:');
        for (const s of r.manualSteps) console.log(`    ${s}`);
      }
      console.log('');
      process.exit(r.actions.some(a => a.success) ? 0 : 1);
    } catch (err) {
      console.error(`\n  \x1b[31mFlush failed: ${err.message}\x1b[0m\n`);
      process.exit(1);
    }
  }

  // Server scan — check SSL, headers, DNS, performance on a live URL
  if (args.server) {
    const ServerScanner = require('../src/scanners/server-scanner');
    const scanner = new ServerScanner();
    const url = args.server.startsWith('http') ? args.server : `https://${args.server}`;
    console.log(`\n  GATETEST — Server Scan\n  Target: ${url}\n`);

    try {
      const result = await scanner.scan(url);
      for (const mod of result.modules) {
        const icon = mod.status === 'passed' ? '\x1b[32m✓\x1b[0m' : mod.status === 'warning' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✗\x1b[0m';
        console.log(`  ${icon} ${mod.label || mod.name} — ${mod.checks} checks, ${mod.issues} issues`);
        for (const d of (mod.details || [])) {
          const color = d.startsWith('error') ? '\x1b[31m' : d.startsWith('warning') ? '\x1b[33m' : d.startsWith('pass') ? '\x1b[32m' : '\x1b[90m';
          console.log(`      ${color}${d}\x1b[0m`);
        }
      }
      console.log(`\n  ${result.totalIssues === 0 ? '\x1b[32mSERVER: CLEAN\x1b[0m' : `\x1b[33mSERVER: ${result.totalIssues} ISSUES\x1b[0m`} — ${result.totalChecks} checks, ${result.duration}ms\n`);
      process.exit(result.totalIssues === 0 ? 0 : 1);
    } catch (err) {
      console.error(`\n  \x1b[31mError: ${err.message}\x1b[0m\n`);
      process.exit(1);
    }
  }

  // Run tests
  let summary;
  if (args.module) {
    summary = await gatetest.runModule(args.module);
  } else {
    summary = await gatetest.runSuite(args.suite || 'standard', { skipModules: args.skipModules });
  }

  // Flywheel: record this scan's anonymized finding signal (module names +
  // counts only, no code/paths) and kick a best-effort central flush. Both
  // are no-ops under GATETEST_NO_TELEMETRY / .gatetest.json telemetry:false,
  // and neither can throw or block the exit. First-run gets a one-line notice.
  try {
    const scanTelemetry = require('../src/core/scan-telemetry');
    const uploader = require('../src/core/telemetry-uploader');
    if (scanTelemetry.telemetryEnabled(projectRoot)) {
      scanTelemetry.recordScanFindings(summary, {
        source: 'cli',
        projectRoot,
        suite: args.module ? 'module' : (args.suite || 'standard'),
      });
      maybeNoticeTelemetry(projectRoot);
      uploader.flushInBackground({ projectRoot });
    }
  } catch { /* telemetry is best-effort — never affects the gate */ } // error-ok

  // --auto-pr: when the gate fails AND the customer wants automated fixes,
  // invoke the AI fix engine for every finding with a file path and open a
  // pull request. Closes the long-standing "gate finds errors but doesn't
  // fix them" UX gap.
  if (args.autoPr && summary.gateStatus !== 'PASSED') {
    const autoPrResult = await runAutoPr(summary, projectRoot, args);
    // The summary's gate verdict still drives the exit code so the original
    // PR remains blocked until reviewed — but the fix-PR is now waiting.
    if (autoPrResult.prUrl) {
      console.log(`\n  \x1b[36m[GateTest auto-PR] Fix PR opened: ${autoPrResult.prUrl}\x1b[0m\n`);
    } else if (autoPrResult.error) {
      console.log(`\n  \x1b[33m[GateTest auto-PR] Could not open fix PR: ${autoPrResult.error}\x1b[0m\n`);
    }
  }

  process.exit(summary.gateStatus === 'PASSED' ? 0 : 1);
}

/**
 * Show the anonymized-telemetry notice exactly once per machine. Writes a
 * marker under ~/.gatetest so it never repeats. Best-effort — a failure to
 * read/write the marker simply means the notice may show again, never a crash.
 */
function maybeNoticeTelemetry(projectRoot) {
  try {
    const osMod = require('os');
    const fsMod = require('fs');
    const pathMod = require('path');
    const marker = pathMod.join(osMod.homedir(), '.gatetest', '.telemetry-notice-shown');
    if (fsMod.existsSync(marker)) return;
    fsMod.mkdirSync(pathMod.dirname(marker), { recursive: true });
    fsMod.writeFileSync(marker, new Date().toISOString(), 'utf-8');
    console.log(
      '\n  \x1b[2mGateTest sends anonymized scan stats (module names + counts only —\n' +
      '  never your code, paths, or findings) to improve the engine.\n' +
      '  Opt out any time: set GATETEST_NO_TELEMETRY=1 or add "telemetry": false\n' +
      '  to .gatetest.json.\x1b[0m\n'
    );
  } catch { /* best-effort notice */ } // error-ok
}

/**
 * Auto-PR runner — applies AI-driven fixes to every finding that has a file
 * path, then opens a pull request via the `gh` CLI.
 *
 * Uses the full production fix pipeline (iterative retry loop, syntax gate,
 * regression test generation, rich PR body) — same pipeline as /api/scan/fix.
 *
 * Returns { prUrl, fixesApplied, error }. Never throws — the gate's exit
 * code is the authoritative signal; the auto-PR is a value-add on top.
 *
 * Pre-conditions checked at runtime:
 *   - We're inside a git repository
 *   - `gh` CLI is on PATH and authenticated (or GH_TOKEN is set)
 *   - ANTHROPIC_API_KEY is set
 */
async function runAutoPr(summary, projectRoot, args) {
  const { execSync } = require('child_process');
  const { runFixBatch } = require('../src/core/cli-fix-orchestrator');
  const { resolveModelChoice, CHEAP_MODEL } = require('../src/core/engine-models');

  function sh(cmd, opts) {
    return execSync(cmd, { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
  }

  // Model choice: --model flag > GATETEST_FIX_MODEL env > CHEAP_MODEL.
  // Validated BEFORE the key check so a bad name fails fast and keyless.
  let fixModel = CHEAP_MODEL;
  const rawModel = args.model || process.env.GATETEST_FIX_MODEL;
  if (rawModel) {
    const choice = resolveModelChoice(rawModel);
    if (!choice.ok) return { error: choice.error };
    fixModel = choice.model;
  }

  // Pre-flight checks
  try { sh('git rev-parse --git-dir'); }
  catch { return { error: 'Not a git repository — auto-PR skipped' }; }

  try { sh('gh --version'); }
  catch { return { error: 'gh CLI not found on PATH. Install: https://cli.github.com/' }; }

  // BYOK: this is the user's own Anthropic key — calls go straight from this
  // machine to api.anthropic.com; the user controls the spend.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { error: 'ANTHROPIC_API_KEY not set — AI fix engine cannot run' };
  }

  // Capture original branch so we can return to it if needed
  let originalBranch = 'main';
  try { originalBranch = sh('git rev-parse --abbrev-ref HEAD').trim(); }
  catch { /* default to main */ }

  const baseBranch = args.autoPrBase || originalBranch;
  const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const fixBranch = args.autoPrBranch || `gatetest/auto-fix-${ts}`;

  // Collect every fixable finding from the summary
  const { extractFileFromCheck } = require('../src/core/parse-finding');
  const fixable = [];
  const needsManualReview = [];
  for (const moduleResult of summary.results || []) {
    for (const check of moduleResult.checks || []) {
      if (check.passed) continue;
      if (check.severity !== 'error' && check.severity !== 'warning') continue;
      const checkWithModule = { ...check, module: moduleResult.module || moduleResult.name };
      const { file, line } = extractFileFromCheck(checkWithModule);
      const entry = {
        moduleName: moduleResult.module || moduleResult.name || 'unknown',
        checkName: check.name || 'unnamed-check',
        file,
        line,
        message: check.message || check.details?.message || check.name || '',
        severity: check.severity,
      };
      if (file) {
        fixable.push(entry);
      } else {
        needsManualReview.push(entry);
      }
    }
  }

  if (fixable.length === 0 && needsManualReview.length === 0) {
    return { error: 'No actionable findings — nothing to fix automatically' };
  }
  if (fixable.length === 0) {
    return { error: `No findings with file paths — ${needsManualReview.length} config-level finding(s) need manual review (see workflow log).`, needsManualReview };
  }

  console.log(`\n  [GateTest auto-PR] ${fixable.length} fixable finding(s). Running production fix pipeline...\n`);

  // Create fix branch off the current branch
  try {
    sh(`git checkout -b ${fixBranch}`);
  } catch (err) {
    return { error: `Could not create branch ${fixBranch}: ${err.message?.slice(0, 200) || err}` };
  }

  // Run the full production fix pipeline
  let orchestration;
  try {
    orchestration = await runFixBatch(fixable, projectRoot, apiKey, {
      maxAttempts: 3,
      fileCap: 50,
      model: fixModel,
    });
  } catch (err) {
    try { sh(`git checkout ${originalBranch}`); sh(`git branch -D ${fixBranch}`); } catch { /* ignore */ }
    return { error: `Fix orchestration failed: ${err.message?.slice(0, 200) || err}` };
  }

  const { accepted, testFiles, allFixes, prBody } = orchestration;

  if (accepted.length === 0) {
    try { sh(`git checkout ${originalBranch}`); sh(`git branch -D ${fixBranch}`); } catch { /* ignore */ }
    return { error: 'No fixes passed the syntax gate — nothing to commit' };
  }

  // Write accepted fixes to disk
  const require_path = require('path');
  for (const fix of accepted) {
    const absPath = require_path.isAbsolute(fix.file) ? fix.file : require_path.join(projectRoot, fix.file);
    require('fs').writeFileSync(absPath, fix.fixed, 'utf-8');
    console.log(`  [\x1b[32m✓\x1b[0m] ${fix.file} (${fix.issues.length} issue${fix.issues.length !== 1 ? 's' : ''})`);
  }

  // Write generated test files
  for (const testFile of testFiles) {
    const absPath = require_path.join(projectRoot, testFile.path);
    const dir = require_path.dirname(absPath);
    require('fs').mkdirSync(dir, { recursive: true });
    require('fs').writeFileSync(absPath, testFile.content, 'utf-8');
    console.log(`  [\x1b[36m+\x1b[0m] ${testFile.path} (regression test)`);
  }

  // Commit + push + open PR
  try {
    sh('git add -A');
    const filesFixed = accepted.length;
    const testsAdded = testFiles.length;
    const subject = `fix: GateTest auto-fixes (${filesFixed} file${filesFixed !== 1 ? 's' : ''}${testsAdded > 0 ? `, ${testsAdded} regression test${testsAdded !== 1 ? 's' : ''}` : ''})`;
    sh(`git commit -m ${JSON.stringify(subject)}`);
    sh(`git push -u origin ${fixBranch}`);

    const totalActionable = fixable.length + needsManualReview.length;

    // Prepend config-level manual-review items to the pr-composer body
    let fullPrBody = prBody;
    if (needsManualReview.length > 0) {
      const manualSection = [
        ``,
        `## Config-level findings (manual review required)`,
        ``,
        `These findings have no file path — the auto-fix engine can't apply a code change. Review them by hand:`,
        ``,
        ...needsManualReview.slice(0, 30).map((f) => `- ⚠️ \`${f.moduleName}:${f.checkName}\` — ${(f.message || '').slice(0, 200)}`),
        ...(needsManualReview.length > 30 ? [`- _… plus ${needsManualReview.length - 30} more — see the workflow log_`] : []),
      ].join('\n');
      fullPrBody = prBody + '\n' + manualSection;
    }

    const prTitle = `GateTest auto-fix — ${allFixes.length} fix${allFixes.length !== 1 ? 'es' : ''} (${totalActionable} findings total)`;
    const prResult = sh(`gh pr create --base ${JSON.stringify(baseBranch)} --head ${JSON.stringify(fixBranch)} --title ${JSON.stringify(prTitle)} --body ${JSON.stringify(fullPrBody)}`);
    const prUrl = prResult.trim().split('\n').filter((l) => l.startsWith('https://')).pop();

    return { prUrl, fixesApplied: accepted.length, fixesAttempted: fixable.length };
  } catch (err) {
    return { error: `Commit/push/PR step failed: ${err.message?.slice(0, 200) || err}`, fixesApplied: accepted.length };
  }
}

/**
 * `gatetest fix --apply` — run the AI fix engine and write changes directly
 * to disk. Same pipeline as `--auto-pr` but without any git/PR operations.
 * Safe to run on a working directory with uncommitted changes.
 */
async function runFixApply(argv, rootDir) {
  const { GateTest } = require('../src/index');
  const { runFixBatch } = require('../src/core/cli-fix-orchestrator');
  const { extractFileFromCheck } = require('../src/core/parse-finding');
  const { resolveModelChoice, CHEAP_MODEL, ALLOWED_FIX_MODELS } = require('../src/core/engine-models');

  const localArgs = { suite: 'standard' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') localArgs.help = true;
    else if (a === '--apply') localArgs.apply = true;
    else if (a === '--dry-run') localArgs.dryRun = true;
    else if (a === '--suite' && argv[i + 1]) localArgs.suite = argv[++i];
    else if (a === '--model' && argv[i + 1]) localArgs.model = argv[++i];
    else if (a === '--project' && argv[i + 1]) { rootDir = path.resolve(argv[++i]); }
  }

  if (localArgs.help) {
    console.log(`
  gatetest fix --apply

    Run GateTest's AI fix engine and apply changes directly to files on disk.
    No git branch is created, no PR is opened. This is the "local dev" mode —
    run it before committing, review the diff, commit manually.

  USAGE
    gatetest fix --apply [options]

  OPTIONS
    --apply               Required guard flag (prevents accidental invocation)
    --suite <name>        Suite to scan (default: standard)
    --project <path>      Project root (default: cwd)
    --dry-run             Show what would be fixed without writing any files
    --model <name>        Claude model for the fix engine. One of:
                            sonnet (claude-sonnet-5, default)
                            opus   (claude-opus-4-8)
                            fable  (claude-fable-5, most capable, ~3.3x Sonnet cost)
                          Env fallback: GATETEST_FIX_MODEL.

  REQUIRES
    ANTHROPIC_API_KEY — YOUR OWN Anthropic key (bring-your-own-key). Fix calls
    go straight from this machine to api.anthropic.com — you control the spend,
    and nothing is proxied through GateTest servers.
`);
    return 0;
  }

  if (!localArgs.apply) {
    console.error('\n  [GateTest fix] Requires --apply flag. Run: gatetest fix --apply\n');
    console.error('  Use --help for full options.\n');
    return 1;
  }

  // Model choice: --model flag > GATETEST_FIX_MODEL env > CHEAP_MODEL.
  // Validated BEFORE the key check so a bad name fails fast and keyless.
  let fixModel = CHEAP_MODEL;
  const rawModel = localArgs.model || process.env.GATETEST_FIX_MODEL;
  if (rawModel) {
    const choice = resolveModelChoice(rawModel);
    if (!choice.ok) {
      console.error(`\n  [GateTest fix] ${choice.error}\n`);
      for (const [id, m] of Object.entries(ALLOWED_FIX_MODELS)) {
        console.error(`    ${m.aliases[0].padEnd(8)} ${id.padEnd(18)} ${m.label}`);
      }
      console.error('');
      return 1;
    }
    fixModel = choice.model;
  }

  // BYOK: this is the user's own Anthropic key — calls go straight from this
  // machine to api.anthropic.com; the user controls the spend.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('\n  [GateTest fix] ANTHROPIC_API_KEY is not set.\n');
    console.error('  Bring your own key: https://console.anthropic.com/ → API keys, then');
    console.error('  export ANTHROPIC_API_KEY=sk-ant-... (you pay Anthropic directly).\n');
    return 1;
  }

  console.log(`\n  \x1b[36m[GateTest fix]\x1b[0m Scanning ${rootDir} (suite: ${localArgs.suite})...\n`);

  const gt = new GateTest(rootDir, {});
  gt.init();
  const summary = await gt.runSuite(localArgs.suite);

  if (summary.gateStatus === 'PASSED') {
    console.log('\n  \x1b[32m[GateTest fix]\x1b[0m Gate passed — nothing to fix.\n');
    return 0;
  }

  // Collect every finding that has a file path
  const fixable = [];
  const noFile = [];
  for (const moduleResult of summary.results || []) {
    for (const check of moduleResult.checks || []) {
      if (check.passed) continue;
      if (check.severity !== 'error' && check.severity !== 'warning') continue;
      const merged = { ...check, module: moduleResult.module || moduleResult.name };
      const { file } = extractFileFromCheck(merged);
      const entry = {
        moduleName: merged.module || 'unknown',
        checkName: check.name || 'unnamed-check',
        file,
        message: check.message || check.details?.message || check.name || '',
        severity: check.severity,
      };
      if (file) fixable.push(entry);
      else noFile.push(entry);
    }
  }

  if (fixable.length === 0) {
    console.log(`\n  \x1b[33m[GateTest fix]\x1b[0m No file-level findings to fix.`);
    if (noFile.length > 0) console.log(`  ${noFile.length} config-level finding(s) need manual review.\n`);
    return 1;
  }

  console.log(`  \x1b[36m[GateTest fix]\x1b[0m ${fixable.length} finding(s). Running AI fix engine...\n`);

  let orchestration;
  try {
    orchestration = await runFixBatch(fixable, rootDir, apiKey, { maxAttempts: 3, fileCap: 50, model: fixModel });
  } catch (err) {
    console.error(`\n  \x1b[31m[GateTest fix]\x1b[0m Fix engine error: ${err.message?.slice(0, 300) || err}\n`);
    return 1;
  }

  const { accepted, testFiles } = orchestration;

  if (accepted.length === 0) {
    console.log('\n  \x1b[33m[GateTest fix]\x1b[0m No fixes passed the syntax gate.\n');
    return 1;
  }

  if (localArgs.dryRun) {
    console.log(`\n  \x1b[36m[GateTest fix --dry-run]\x1b[0m Would apply ${accepted.length} fix(es):\n`);
    for (const fix of accepted) console.log(`    \x1b[32m✓\x1b[0m ${fix.file}`);
    if (testFiles.length > 0) console.log(`\n  Would write ${testFiles.length} regression test(s).`);
    console.log('');
    return 0;
  }

  // Write fixes
  for (const fix of accepted) {
    const absPath = path.isAbsolute(fix.file) ? fix.file : path.join(rootDir, fix.file);
    fs.writeFileSync(absPath, fix.fixed, 'utf-8');
    console.log(`  [\x1b[32m✓\x1b[0m] ${fix.file} (${fix.issues.length} issue${fix.issues.length !== 1 ? 's' : ''} fixed)`);
  }

  // Write regression tests
  for (const testFile of testFiles) {
    const absPath = path.join(rootDir, testFile.path);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, testFile.content, 'utf-8');
    console.log(`  [\x1b[36m+\x1b[0m] ${testFile.path} (regression test)`);
  }

  console.log(`\n  \x1b[32m[GateTest fix]\x1b[0m Applied ${accepted.length} fix(es) to disk.`);
  console.log('  Run \x1b[1mgit diff\x1b[0m to review, then commit.\n');
  return 0;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
    else if (arg === '--validate') args.validate = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--report') args.report = true;
    else if (arg === '--noise') args.noise = true;
    else if (arg === '--init') args.init = true;
    else if (arg === '--init-claude-md') args.initClaudeMd = true;
    else if (arg === '--health') args.health = true;
    else if (arg === '--doctor') args.doctor = true;
    else if (arg === '--doctor-quick') { args.doctor = true; args.doctorQuick = true; }
    else if (arg === '--parallel') args.parallel = true;
    else if (arg === '--github-annotations') args.githubAnnotations = true;
    else if (arg === '--stop-first') args['stop-first'] = true;
    else if (arg === '--fix') args.fix = true;
    else if (arg === '--auto-pr') args.autoPr = true;
    else if (arg === '--auto-pr-base' && argv[i + 1]) args.autoPrBase = argv[++i];
    else if (arg === '--auto-pr-branch' && argv[i + 1]) args.autoPrBranch = argv[++i];
    else if (arg === '--model' && argv[i + 1]) args.model = argv[++i];
    else if (arg === '--since' && argv[i + 1]) args.since = argv[++i];
    else if (arg === '--pr') args.pr = true;
    else if (arg === '--diff') args.diff = true;
    else if (arg === '--report-only') args.reportOnly = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--watch') args.watch = true;
    else if (arg === '--sarif') args.sarif = true;
    else if (arg === '--junit') args.junit = true;
    else if (arg === '--ci-init' && argv[i + 1]) args.ciInit = argv[++i];
    else if (arg === '--confidence-threshold' && argv[i + 1]) {
      const v = parseFloat(argv[++i]);
      if (!Number.isNaN(v) && v >= 0 && v <= 1) args.confidenceThreshold = v;
    }
    else if (arg === '--suite' && argv[i + 1]) args.suite = argv[++i];
    else if (arg === '--module' && argv[i + 1]) args.module = argv[++i];
    else if (arg === '--skip-module' && argv[i + 1]) {
      args.skipModules = args.skipModules || [];
      args.skipModules.push(argv[++i]);
    }
    else if (arg === '--project' && argv[i + 1]) args.project = argv[++i];
    else if (arg === '--server' && argv[i + 1]) args.server = argv[++i];
    else if (arg === '--crawl' && argv[i + 1]) args.crawl = argv[++i];
    else if (arg === '--crawl-loop' && argv[i + 1]) args.crawlLoop = argv[++i];
    else if (arg === '--crawl-max' && argv[i + 1]) args.crawlMax = parseInt(argv[++i]);
    else if (arg === '--feedback') args.feedback = true;
    else if (arg === '--diagnose' && argv[i + 1]) args.diagnose = argv[++i];
    else if (arg === '--monitor' && argv[i + 1]) args.monitor = argv[++i];
    else if (arg === '--monitor-interval' && argv[i + 1]) args.monitorInterval = parseInt(argv[++i]);
    else if (arg === '--monitor-heal') args.monitorHeal = true;
    else if (arg === '--flush' && argv[i + 1]) args.flush = argv[++i];
  }
  return args;
}

function initProject(projectRoot) {
  const configDir = path.join(projectRoot, '.gatetest');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const dirs = ['reports', 'screenshots', 'baselines', 'modules'];
  for (const dir of dirs) {
    const fullPath = path.join(configDir, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }

  // Create default config
  const configPath = path.join(configDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      thresholds: {},
      modules: {},
      reporting: { formats: ['json', 'html', 'console'] },
    }, null, 2));
  }

  console.log('\nGateTest initialized successfully!');
  console.log(`  Config: ${configDir}/config.json`);
  console.log(`  Reports: ${configDir}/reports/`);
  console.log('\nRun "gatetest --suite quick" to test your setup.\n');
}

/**
 * `gatetest --noise` — show which modules are noisy for this repo, learned
 * from the flywheel (fire-rate + dismissals). This is both the customer's
 * transparency view and our tuning worklist. Modules marked "softened" have
 * had their findings auto-downgraded below the block threshold.
 */
function showNoiseReport(projectRoot) {
  let rows = [];
  try {
    rows = require('../src/core/noise-model').getNoiseReport(projectRoot);
  } catch (err) {
    console.log(`\n  Could not read flywheel history: ${err.message}\n`);
    process.exit(1);
  }

  console.log('\n  \x1b[1mGateTest — module noise report\x1b[0m');
  console.log('  \x1b[2m(learned from this repo\'s scan history: .gatetest/memory.json)\x1b[0m\n');

  const withHistory = rows.filter((r) => r.runs > 0 || r.dismissals > 0);
  if (withHistory.length === 0) {
    console.log('  No scan history yet — run a few scans, then check back.\n');
    console.log('  Silence a noisy check any time by adding a line to \x1b[1m.gatetestignore\x1b[0m:');
    console.log('    \x1b[2mmodule:rule            # silence one rule in a module\x1b[0m');
    console.log('    \x1b[2mmodule                 # silence a whole module\x1b[0m');
    console.log('    \x1b[2msecrets:apiKey@test/**  # silence only under test/\x1b[0m\n');
    return;
  }

  console.log('  ' + 'module'.padEnd(22) + 'fires'.padEnd(9) + 'dismissed'.padEnd(11) + 'status');
  console.log('  ' + '─'.repeat(52));
  for (const r of withHistory.slice(0, 30)) {
    const firePct = `${Math.round((r.fireRate || 0) * 100)}%`;
    const status = r.noisy
      ? `\x1b[33msoftened (×${r.penalty})\x1b[0m`
      : (r.fireRate >= 0.5 ? '\x1b[2mhigh-fire\x1b[0m' : '\x1b[32mok\x1b[0m');
    console.log(
      '  ' + r.module.padEnd(22) +
      `${firePct} (${r.fires}/${r.runs})`.padEnd(9 + 6) +
      String(r.dismissals).padEnd(11) +
      status
    );
  }
  const softened = withHistory.filter((r) => r.noisy).length;
  console.log('');
  if (softened > 0) {
    console.log(`  \x1b[33m${softened}\x1b[0m module(s) auto-softened after repeated dismissals — findings still`);
    console.log('  show up, but no longer block the gate. Permanently silence with \x1b[1m.gatetestignore\x1b[0m.\n');
  } else {
    console.log('  No modules softened yet. Add a line to \x1b[1m.gatetestignore\x1b[0m to silence noise:');
    console.log('    \x1b[2mmodule:rule   |   module   |   secrets:apiKey@test/**\x1b[0m\n');
  }
}

function showLatestReport(projectRoot) {
  const reportPath = path.join(projectRoot, '.gatetest/reports/gatetest-report-latest.json');
  if (!fs.existsSync(reportPath)) {
    console.log('\nNo reports found. Run "gatetest" first.\n');
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  console.log('\nLatest GateTest Report:');
  console.log(`  Status: ${report.gatetest.gateStatus}`);
  console.log(`  Time: ${report.gatetest.timestamp}`);
  console.log(`  Modules: ${report.summary.modules.passed}/${report.summary.modules.total} passed`);
  console.log(`  Checks: ${report.summary.checks.passed}/${report.summary.checks.total} passed`);
  console.log(`  Duration: ${report.summary.duration}ms`);

  if (report.failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of report.failures) {
      console.log(`    - ${f.module}: ${f.error}`);
    }
  }
  console.log('');
}

async function runCrawl(gatetest, url, maxPages) {
  // Inject crawl URL into config
  gatetest.config.config.modules.liveCrawler = {
    url,
    maxPages,
    timeout: 10000,
    checkExternal: true,
  };

  console.log(`\n[GateTest] Crawling ${url} (max ${maxPages} pages)...\n`);
  const summary = await gatetest.runModule('liveCrawler');

  // Show the feedback report
  const feedbackPath = path.join(gatetest.projectRoot, '.gatetest/reports/crawl-feedback.md');
  if (fs.existsSync(feedbackPath)) {
    console.log('\n' + fs.readFileSync(feedbackPath, 'utf-8'));
  }

  process.exit(summary.gateStatus === 'PASSED' ? 0 : 1);
}

async function runCrawlLoop(gatetest, url, maxPages) {
  gatetest.config.config.modules.liveCrawler = {
    url,
    maxPages,
    timeout: 10000,
    checkExternal: true,
  };

  let round = 1;
  const maxRounds = 20;

  while (round <= maxRounds) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`[GateTest] CRAWL LOOP — Round ${round}/${maxRounds}`);
    console.log(`[GateTest] Testing: ${url}`);
    console.log(`${'='.repeat(50)}\n`);

    const summary = await gatetest.runModule('liveCrawler');

    const feedbackPath = path.join(gatetest.projectRoot, '.gatetest/reports/crawl-feedback.md');
    if (fs.existsSync(feedbackPath)) {
      const feedback = fs.readFileSync(feedbackPath, 'utf-8');
      console.log('\n' + feedback);

      if (feedback.includes('ALL CLEAR')) {
        console.log('\n[GateTest] SITE IS CLEAN. All pages verified. Loop complete.\n');
        process.exit(0);
      }
    }

    console.log(`\n[GateTest] Issues found. Waiting for fixes...`);
    console.log(`[GateTest] Fix the issues above, then press ENTER to re-test.`);
    console.log(`[GateTest] Or press Ctrl+C to exit.\n`);

    // Wait for user input (or for Claude to signal it's done fixing)
    await new Promise((resolve) => {
      process.stdin.once('data', resolve);
    });

    round++;
  }

  console.log(`\n[GateTest] Maximum rounds (${maxRounds}) reached. Exiting.\n`);
  process.exit(1);
}

function showCrawlFeedback(projectRoot) {
  const feedbackPath = path.join(projectRoot, '.gatetest/reports/crawl-feedback.md');
  if (!fs.existsSync(feedbackPath)) {
    console.log('\nNo crawl feedback found. Run "gatetest --crawl <url>" first.\n');
    process.exit(1);
  }
  console.log('\n' + fs.readFileSync(feedbackPath, 'utf-8'));
}

/**
 * Watch mode — monitors file changes and re-runs GateTest continuously.
 * Uses fs.watch for near-instant feedback during development.
 */
async function runWatchMode(gatetest, args) {
  const watchDirs = ['src', 'lib', 'app', 'pages', 'components', 'website', 'tests', 'test'];
  const projectRoot = gatetest.projectRoot;
  const debounceMs = 500;
  let timer = null;
  let running = false;
  let round = 0;

  const runScan = async () => {
    if (running) return;
    running = true;
    round++;

    console.log(`\n${'='.repeat(50)}`);
    console.log(`[GateTest] WATCH MODE — Scan #${round}`);
    console.log(`[GateTest] ${new Date().toLocaleTimeString()}`);
    console.log(`${'='.repeat(50)}\n`);

    try {
      if (args.module) {
        await gatetest.runModule(args.module);
      } else {
        await gatetest.runSuite(args.suite || 'quick');
      }
    } catch (err) { // error-ok — watch mode must keep running after a scan error
      console.error(`[GateTest] Error: ${err.message}`);
    }

    running = false;
    console.log(`\n${'-'.repeat(50)}`);
    console.log(`[GateTest] Watching for changes... (Ctrl+C to exit)`);
  };

  // Initial scan
  await runScan();

  // Watch directories
  for (const dir of watchDirs) {
    const fullPath = path.join(projectRoot, dir);
    if (!fs.existsSync(fullPath)) continue;

    try {
      fs.watch(fullPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Ignore generated files
        if (filename.includes('.gatetest') || filename.includes('node_modules')) return;
        if (filename.endsWith('.map') || filename.endsWith('.d.ts')) return;

        if (timer) clearTimeout(timer);
        timer = setTimeout(runScan, debounceMs);
      });
    } catch {
      // fs.watch may not support recursive on all platforms
    }
  }

  // Keep process alive
  await new Promise(() => {});
}

main().catch(err => {
  console.error(`\n[GateTest] Fatal error: ${err.message}\n`);
  process.exit(1);
});
