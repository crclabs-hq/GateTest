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
// Argument parsing lives in src/core so it can be unit-tested — this file
// runs main() at import time and exports nothing, so anything defined here
// is unreachable from a test. See the module header for the silent
// unknown-flag bug that survived because of exactly that.
const {
  parseArgs,
  describeArgProblems,
  argProblemsAreFatal,
  projectPathProblem,
  resolveFileFilter,
  USAGE_EXIT_CODE,
} = require('../src/core/cli-args');
const { buildJsonOutput, scanExitCode } = require('../src/core/json-output');
const { crawlReportPaths, crawlExitCode, crawlResultLabel, buildCrawlFindings, crawlFindingIds } = require('../src/modules/live-crawler-report');
const { createConvergenceGuard, REASONS: CONVERGENCE_REASONS } = require('../src/core/convergence-guard');

/**
 * `--project <path>` must name an existing directory, or the run is a usage
 * error — never a green scan of a directory this process created to have
 * somewhere to write the report (reproduced 2026-09-14). Shared by the scan
 * flow and `gatetest fix`, which resolve the root separately.
 */
function requireProjectDir(projectRoot) {
  const problem = projectPathProblem(projectRoot);
  if (!problem) return;
  console.error(`[GateTest] Error: ${problem}`);
  console.error('[GateTest] Nothing was scanned. Check the --project path (it is resolved against the current directory).');
  process.exit(USAGE_EXIT_CODE);
}

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
    gatetest verify-report <file>    Check a report's signature + findings digest
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
    gatetest usage [options]         Your usage meter: scans, fixes,
                                     findings, AI tokens and estimated cost
                                     across every surface, BYOK and metered
                                     runs listed separately. Reads
                                     GATETEST_API_KEY (a gt_live_ REST key);
                                     --json for the raw report. See
                                     'gatetest usage --help'.

  OPTIONS
    --suite <name>     Run a test suite: quick, standard, full (default: standard)
                       "full" is the 88-module engine. It deliberately does
                       NOT run mutation testing, which re-runs your whole
                       test suite once per mutant — minutes, not seconds.
                       Every scan prints what it deferred. Run it directly
                       with "gatetest --module mutation", or via --suite
                       nuclear / the GitHub Action, where a CI runner can
                       afford a complete pass.
    --module <name>    Run a specific module by name
    --skip-module <name>
                       Skip a specific module within the chosen suite.
                       Repeatable. Useful for CI gates that want most of
                       the suite but want to defer slow modules (e.g.
                       mutation testing) to a nightly run.
    --validate         Validate the CLAUDE.md file
    --report           Display the latest test report
    --all              Show every finding. By default the scan ends with a
                       short ranked list of what matters plus a count of
                       what was not shown — 800 streamed warnings is not a
                       report, it is a wall.
    --noise            Show which modules are noisy for this repo (fire-rate +
                       dismissals, learned from scan history) and which have
                       been auto-softened. Silence noise via .gatetestignore.
    --list             List all available test modules
    --init             Initialize GateTest in the current project
    --init-claude-md   Generate CLAUDE.md for this project, install the Claude Code
                       hooks (.claude/settings.json) and write gatetest-scan.js
    --health           Check the GitHub API connection (reachability, latency,
                       rate-limit budget) without running a scan
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
    --model <name>     AI model for fixes (fix --apply and --auto-pr):
                       sonnet (default) | opus | fable — or a full model id
                       from your provider. Env fallback: GATETEST_FIX_MODEL.
                       Runs on YOUR OWN ANTHROPIC_API_KEY (bring-your-own-key):
                       calls go straight from your machine to the provider, you
                       control the spend. fable is the most capable at ~3.3x
                       the default's cost per token.
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
    --baseline         Snapshot every CURRENT finding into
                       .gatetest/baseline.json ("clean as you code").
                       Commit the file; later runs only fail on NEW
                       findings — pre-existing ones stay visible but never
                       block. Onboard a mature repo without eating the
                       backlog on day one. Re-run to refresh; delete the
                       file to see everything again. Respects --suite.
    --watch            Watch for file changes and re-scan continuously
    --format <json|text>
                       Output format for a scan (--suite / --module runs).
                       "json" prints ONE JSON document on stdout and nothing
                       else there — progress, warnings and notices go to
                       stderr — so an editor or script can JSON.parse it.
                       The exit code is unchanged: 0 gate passed, 1 gate
                       blocked, 2 usage error. Shape:
                         { version, generatedAt, suite, module, project,
                           files, passed, gateStatus, exitCode, summary,
                           counts: { errors, warnings, notes, blocking,
                                     total, duplicatesCollapsed },
                           modules, checks, duration, deferred,
                           failedModules, report,
                           issues: [ { id, module, ruleId,
                                       severity: error|warning|info,
                                       message, file (repo-relative, '/'),
                                       line, column (1-based; null when
                                       unknown), blocking, confidence,
                                       fixable, suggestion, ignoreLine } ] }
                       Cross-module duplicates are folded into one issue,
                       as the console does; the folded count is reported.
                       Default: text.
    --json             Same as --format json.
    --file <path>      Scan only the named file(s). Repeatable, or one
                       comma-separated list; relative paths are taken from
                       --project (absolute paths work). Same narrowing as
                       --diff: modules that walk the tree see only these
                       files and findings anchored in other files are
                       dropped. Modules that read a fixed file
                       (package.json, the lockfile, CI config) still run,
                       so repo-level findings — which carry no file — can
                       still appear. A path outside the project, a
                       directory or a missing file is reported on stderr;
                       when nothing scannable remains the run is a usage
                       error (exit 2), never a green scan of nothing.
                       Alias: --files.
    --sarif            Output results in SARIF format (for GitHub Security)
    --junit            Output results in JUnit XML format (for CI)
    --offline          Air-gapped mode: nothing leaves this machine. No
                       telemetry upload, no AI calls (--fix / --auto-pr are
                       refused with a message, not silently skipped), no
                       live API ping from --doctor. The summary and the signed
                       provenance record it. Same as GATETEST_OFFLINE=1.
    --compliance       Write the compliance evidence pack: findings filed
                       under OWASP Top 10 / SOC 2 / CIS Controls, control by
                       control, with the raw results and the signed
                       provenance (.gatetest/reports/gatetest-compliance-*).
                       A control is PASS only when a mapped module ran and
                       found nothing; "not checked" is printed, never hidden.
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
    --doctor-quick     Same but skips the live AI provider API ping (offline mode)
    --version, -v      Show version

    --server <url>     Scan a live server: SSL, headers, DNS, performance.
                       Exit code follows severity: errors fail the gate,
                       warnings alone do not unless --strict is also given.
                       With --format json (or --json), prints ONE JSON
                       document on stdout and nothing else there — progress
                       and the human report go to stderr instead. Shape:
                         { target, startedAt, durationMs, exitCode,
                           groups: [ { name, checks: [ { name, passed,
                                       severity, message } ] } ],
                           summary }
                       Default (no flag): unchanged text output.
    --crawl <url>      Crawl a live website and test every page. The exit
                       code comes only from this run's own report: broken
                       links/images/scripts/stylesheets and page errors
                       always fail; a page that timed out or was skipped by
                       the crawl budget only fails once the not-checked
                       share of pages exceeds 20% (the report always says
                       "N pages not checked (reason)" either way).
                       With --format json (or --json), prints ONE JSON
                       document on stdout and nothing else there — progress
                       and the human report go to stderr instead. Shape:
                         { url, pagesScanned, generatedAt, result, exitCode,
                           findings: [ { type, severity, message, url } ] }
                       Default (no flag): unchanged text output.
    --crawl-loop <url> Crawl, report failures, wait for fixes, repeat until clean
    --crawl-max <n>    Max pages to crawl (default: 100)
    --crawl-page-timeout <ms>  Per-page fetch budget (default: 15000). A
                       stalled page costs at most this much, not the whole
                       crawl's wall-clock ceiling.
    --crawl-header "Name: value"   Send a header on same-origin requests so the
                       crawler can reach pages behind auth (repeatable;
                       values support \${ENV_VAR} expansion)
    --crawl-cookie "name=value; n2=v2"  Send session cookies (same-origin only)
    --crawl-storage-state <file>   Playwright storage-state JSON for a fully
                       logged-in browser crawl (export via
                       npx playwright codegen --save-storage=state.json <url>)
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
    gatetest --server https://gatetest.io    Scan server SSL, headers, DNS
    gatetest --crawl https://zoobicon.com   Crawl and test live site
    gatetest --crawl https://app.example.com --crawl-cookie "session=\${SESSION}"
                                      Authenticated crawl (reaches /dashboard/*)
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
    accessibility  WCAG 2.2 automated audit (AA + AAA-aligned)
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
  const KNOWN_SUBCOMMANDS = new Set(['sweep', 'replay', 'scan', 'train', 'fix', 'trace', 'blame', 'verify-report', 'usage']);
  if (first === 'verify-report') {
    // gatetest verify-report <report.json> [--key <key>]
    // Checks the HMAC signature over the provenance block and that the
    // findings still match the digest the provenance recorded (move 21).
    const { verifyReport } = require('../src/core/report-provenance');
    const file = rawArgs.slice(1).find((a) => !a.startsWith('--'));
    const kidx = rawArgs.indexOf('--key');
    const key = kidx >= 0 ? rawArgs[kidx + 1] : process.env.GATETEST_REPORT_SIGNING_KEY;
    if (!file) { console.error('usage: gatetest verify-report <report.json> [--key <key>]  (or GATETEST_REPORT_SIGNING_KEY)'); process.exit(2); }
    if (!key) { console.error('verify-report: no key — pass --key or set GATETEST_REPORT_SIGNING_KEY'); process.exit(2); }
    let report;
    try { report = JSON.parse(require('fs').readFileSync(file, 'utf8')); } catch (err) { console.error(`verify-report: cannot read ${file}: ${err.message}`); process.exit(2); }
    const v = verifyReport(report, key);
    const p = report.provenance || {};
    console.log(`${v.ok ? 'VERIFIED' : 'NOT VERIFIED'}: ${v.reason}`);
    if (p.engine) console.log(`  engine ${p.engine.name} v${p.engine.version}${p.engine.commit ? ` @ ${p.engine.commit}` : ''} · gate ${p.gateStatus} · ${p.findings ? p.findings.count : '?'} findings · digest ${p.findings ? p.findings.sha256.slice(0, 12) : '?'}…`);
    // The policy the run was judged under — so two reports that disagree
    // can be told apart by policy, not only by engine (move 26).
    if (p.policy) {
      const d = (f) => (!f || !f.present ? 'absent' : f.sha256 ? `${f.sha256.slice(0, 12)}…` : 'unreadable');
      console.log(`  policy .gatetest.json ${d(p.policy.configFile)} · .gatetestignore ${d(p.policy.ignoreFile)}`);
    }
    process.exit(v.ok ? 0 : 1);
  }
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
  if (first === 'usage') {
    // gatetest usage — the customer usage meter (GET /api/v1/usage) rendered
    // as a table or --json. Reads GATETEST_API_KEY; no key → one line, exit 2.
    const usage = require('./gatetest-usage');
    const code = await usage.main(rawArgs.slice(1));
    process.exit(code || 0);
  }
  if (first === 'fix') {
    if (require('../src/core/offline').isOffline()) {
      console.error('[GateTest] offline mode: `gatetest fix` needs the AI provider API. Unset GATETEST_OFFLINE to use it.');
      process.exit(2);
    }
    const projectRoot = (() => {
      const pidx = rawArgs.indexOf('--project');
      return pidx !== -1 ? rawArgs[pidx + 1] : process.cwd();
    })();
    requireProjectDir(projectRoot);
    const code = await runFixApply(rawArgs.slice(1), projectRoot);
    process.exit(code || 0);
  }
  // 'scan' is an explicit alias for the default behavior. Consume it.
  const effectiveArgv = first === 'scan' ? rawArgs.slice(1) : rawArgs;
  const args = parseArgs(effectiveArgv);
  // Anything the parser could not use is reported before the scan starts.
  // Advisory on a developer's machine — a stray argument from a wrapper
  // script must not cost someone their scan (Forbidden #25). But it must not
  // be SILENT either: an ignored `--report-only` blocks a build nobody meant
  // to gate, and an ignored `--strict` is a green that cannot turn red.
  // Under --strict or in CI it is a usage error (exit 2): there, a scan that
  // ran on a command line it only partly understood is not a pass. See
  // argProblemsAreFatal in src/core/cli-args.js.
  // (`--help` / `--version` still answer: the operator is asking what the
  // flags are, which is the one time a wrong one should not end the run.)
  const fatalArgs = argProblemsAreFatal(args) && !args.help && !args.version;
  for (const line of describeArgProblems(args, { fatal: fatalArgs })) console.error(line);
  if (fatalArgs) process.exit(USAGE_EXIT_CODE);
  // --offline: one switch, recorded everywhere (src/core/offline.js). The
  // AI-backed paths need api.anthropic.com, so they are refused out loud
  // rather than run against a network that is not there.
  const { isOffline, enableOffline } = require('../src/core/offline');
  if (args.offline) enableOffline();
  if (isOffline() && (args.fix || args.autoPr)) {
    console.error('[GateTest] offline mode: --fix / --auto-pr need the AI provider API and are not run. The scan continues without them.');
    args.fix = false;
    args.autoPr = false;
  }
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
  // A --project that does not exist is a usage error, not an empty repo.
  // Checked before anything below can create it: GateTestConfig, the
  // reporters and `--init` all mkdir under the root on demand.
  requireProjectDir(projectRoot);

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
      probeAnthropic: !args.doctorQuick && !isOffline(),
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

  // Resolve the incremental base ref for --since / --pr. In a merge queue
  // (GITHUB_EVENT_NAME=merge_group) the base is the queue's, named in the
  // event payload — not GITHUB_BASE_REF, which is empty there (the Fifty,
  // move 27). Everything else the modules decide through src/core/diff-base.js.
  const { mergeGroupBase } = require('../src/core/diff-base');
  const incrementalSince = args.since
    || (args.pr
      ? ((mergeGroupBase() || [])[0]
          || (process.env.GITHUB_BASE_REF
            ? `origin/${process.env.GITHUB_BASE_REF}`
            : 'origin/main'))
      : undefined);

  // --file: narrow the scan to named files. Same wire as --diff (runner.js
  // `diffOnly` + `changedFiles`): BaseModule._collectFiles intersects with
  // the set, and the runner drops findings anchored elsewhere at the seam
  // every module passes through. Resolved before anything runs so a list
  // that names nothing scannable is a usage error, not a green empty scan.
  let fileFilter = null;
  if (Array.isArray(args.files) && args.files.length > 0) {
    const resolved = resolveFileFilter(args.files, projectRoot);
    for (const problem of resolved.problems) console.error(`[GateTest] Warning: ${problem}`);
    if (resolved.files.length === 0) {
      console.error('[GateTest] Error: --file named nothing under the project root that can be scanned. Nothing was scanned.');
      process.exit(USAGE_EXIT_CODE);
    }
    fileFilter = resolved.files;
  }

  // --format json: stdout belongs to the one JSON document. The console
  // reporter is not attached (`silent`), and everything else that would
  // reach stdout during the run — a module's console.log, a reporter's
  // notice, the telemetry notice — is routed to stderr until the document
  // is written. Only the scan flow honours it; --list, --report, --crawl
  // and friends keep their own output.
  const jsonMode = args.format === 'json';

  const gatetest = new GateTest(projectRoot, {
    parallel: args.parallel || false,
    stopOnFirstFailure: args['stop-first'] || false,
    autoFix: args.fix || false,
    diffOnly: args.diff || fileFilter !== null,
    ...(fileFilter ? { changedFiles: fileFilter } : {}),
    silent: jsonMode,
    sarif: args.sarif || false,
    // --all restores the full per-module finding dump. Default output is a
    // ranked shortlist: 813 streamed warnings reads as noise and the
    // developer stops running the tool.
    showAll: args.all || false,
    junit: args.junit || false,
    compliance: args.compliance || false,
    githubAnnotations: args.githubAnnotations || false,
    // Report-only mode — gate reports findings but never fails the
    // workflow on them. Strict mode (default OFF) reverses this and
    // blocks on confident errors. See `runner.js` for the mechanism.
    reportOnly: args.reportOnly === true && args.strict !== true,
    // --strict also makes an EMPTY scan (no source files under the root) a
    // failed gate — see runner.js `nothingChecked`.
    strict: args.strict === true,
    ...(args.baseline ? { captureBaseline: true } : {}),
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
    await runCrawl(gatetest, args.crawl, args.crawlMax || 100,
      { ...crawlAuthFromArgs(args), ...(args.crawlPageTimeout ? { pageTimeout: args.crawlPageTimeout } : {}) },
      jsonMode);
    return;
  }

  // Continuous crawl-fix loop
  if (args.crawlLoop) {
    await runCrawlLoop(gatetest, args.crawlLoop, args.crawlMax || 100,
      { ...crawlAuthFromArgs(args), ...(args.crawlPageTimeout ? { pageTimeout: args.crawlPageTimeout } : {}) });
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
    // --format json: stdout is the one JSON document, so progress and the
    // human-readable report go to stderr instead (same convention as the
    // suite scan's jsonMode, and as --crawl above).
    const log = jsonMode ? console.error : console.log;
    log(`\n  GATETEST — Server Scan\n  Target: ${url}\n`);

    try {
      const startedAt = new Date().toISOString();
      const result = await scanner.scan(url);
      for (const mod of result.modules) {
        const icon = mod.status === 'passed' ? '\x1b[32m✓\x1b[0m' : mod.status === 'warning' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✗\x1b[0m';
        log(`  ${icon} ${mod.label || mod.name} — ${mod.checks} checks, ${mod.issues} issues`);
        for (const d of (mod.details || [])) {
          const color = d.startsWith('error') ? '\x1b[31m' : d.startsWith('warning') ? '\x1b[33m' : d.startsWith('pass') ? '\x1b[32m' : '\x1b[90m';
          log(`      ${color}${d}\x1b[0m`);
        }
      }
      // Severity-based gate (issue #677 item 3): `result.totalIssues`
      // conflated errors and warnings into one count, so a single warning
      // (e.g. a CSP 'unsafe-inline' warning) failed the gate the same way
      // an SSL failure would. ServerScanner.exitCode/summaryLabel are the
      // one definition of the severity split, shared with the test suite.
      const exitCode = ServerScanner.exitCode(result, { strict: args.strict === true });
      const { errors } = ServerScanner.countSeverities(result);
      const summaryText = `SERVER: ${ServerScanner.summaryLabel(result)} — ${result.totalChecks} checks, ${result.duration}ms`;

      if (jsonMode) {
        const doc = {
          target: url,
          startedAt,
          durationMs: result.duration,
          exitCode,
          groups: ServerScanner.toJsonGroups(result),
          summary: summaryText,
        };
        // Never process.exit() right after a stdout write: a piped stdout is
        // asynchronous on POSIX (synchronous only on Windows — see Node's own
        // docs on process.stdout), so a forced exit can race the write and
        // hand the consumer a truncated or empty document even from inside
        // the write's own callback (reproduced in CI on Linux, not on
        // Windows). Setting exitCode and returning lets the event loop drain
        // naturally — nothing else is scheduled once a --server scan is
        // done, so the process exits on its own right after the write
        // actually completes.
        process.stdout.write(`${JSON.stringify(doc)}\n`);
        process.exitCode = exitCode;
        return;
      }

      const summaryColor = exitCode === 0 ? '\x1b[32m' : (errors > 0 ? '\x1b[31m' : '\x1b[33m');
      console.log(`\n  ${summaryColor}${summaryText}\x1b[0m\n`);
      process.exit(exitCode);
    } catch (err) {
      console.error(`\n  \x1b[31mError: ${err.message}\x1b[0m\n`);
      process.exit(1);
    }
  }

  // Progress and ETA (issue #630): a customer on a large tree saw no file
  // count and no ETA before the CLI went quiet, so a slow-but-healthy scan
  // read identically to a hang. Both numbers come from a real walk and the
  // resolved suite (src/core/scan-scope.js `scanInventory`, one definition,
  // the same exclude set every module honours) — never typed. Always
  // stderr, unconditionally: a `--format json` run's stdout is the one
  // JSON document, and this line must never land inside it either way.
  if (!args.module) {
    const { scanInventory } = require('../src/core/scan-scope');
    const inventory = scanInventory(projectRoot);
    const suiteModules = gatetest.config.getSuite(args.suite || 'standard');
    console.error(
      `[GateTest] Scanning ${inventory.fileCount} files in ${inventory.packageCount} packages ` +
      `across ${suiteModules.length} modules`
    );
  }

  // Run tests
  const realStdoutWrite = process.stdout.write;
  if (jsonMode) {
    process.stdout.write = function redirectedToStderr(chunk, encoding, cb) {
      return process.stderr.write(chunk, encoding, cb);
    };
  }
  // The one way a scan ends. Human mode exits with the code; JSON mode
  // writes the document (with that same code inside it) and then exits with
  // it — computed once, so the two can never disagree.
  const finish = (summary, exitCode) => {
    if (!jsonMode) process.exit(exitCode);
    const reportDir = path.resolve(projectRoot, gatetest.config.get('reporting.outputDir') || '.gatetest/reports');
    const latest = path.join(reportDir, 'gatetest-report-latest.json');
    const doc = buildJsonOutput(summary, {
      projectRoot,
      suite: args.module ? null : (args.suite || 'standard'),
      module: args.module || null,
      files: fileFilter,
      exitCode,
      reportPath: fs.existsSync(latest) ? latest : null,
    });
    process.stdout.write = realStdoutWrite;
    // Exit from the write callback, not after it: a pipe write is
    // asynchronous on Windows and process.exit() would cut the document off.
    process.stdout.write(`${JSON.stringify(doc)}\n`, () => process.exit(exitCode));
  };

  let summary;
  if (args.module) {
    summary = await gatetest.runModule(args.module);
  } else {
    summary = await gatetest.runSuite(args.suite || 'standard', { skipModules: args.skipModules });
  }

  // --baseline: the run above executed with captureBaseline (old baseline
  // ignored, full failure surface visible) and the runner wrote the
  // snapshot. Capturing is setup, not a gate run — exit green so a team
  // can baseline a red repo, which is the entire point.
  if (args.baseline) {
    const b = summary.baseline || {};
    if (b.error) {
      console.error(`\n  \x1b[31m[GateTest] Baseline capture failed: ${b.error}\x1b[0m\n`);
      return finish(summary, scanExitCode(summary, { baseline: true }));
    }
    console.log(`\n  \x1b[32m[GateTest] Baseline captured: ${b.captured} pre-existing finding(s) grandfathered.\x1b[0m`);
    console.log(`  File: ${b.path}`);
    console.log('  Commit this file. From now on the gate only fails on NEW findings.');
    console.log('  Refresh after paying down debt: gatetest --baseline');
    console.log('  See everything again: delete .gatetest/baseline.json\n');
    return finish(summary, scanExitCode(summary, { baseline: true }));
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
      maybeNoticeTelemetry();
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

  // Plain-English recap + the single next command — the approachability layer
  // for entry-level users. Suppressed for machine-readable output modes and
  // when the developer opted into automation (--auto-pr / --sarif / --junit).
  if (!jsonMode && !args.sarif && !args.junit && !args.githubAnnotations && !args.reportOnly) {
    printPlainSummary(summary, projectRoot);
  }

  return finish(summary, scanExitCode(summary));
}

/**
 * The plain-English recap lives in src/core/plain-summary.js so its copy is
 * tested without running a scan; this only decides the context and prints.
 */
function printPlainSummary(summary, projectRoot) {
  const { plainSummaryLines, plainSummaryContext } = require('../src/core/plain-summary');
  const { colorEnabled } = require('../src/core/color');
  for (const line of plainSummaryLines(summary, plainSummaryContext(summary, projectRoot), { color: colorEnabled() })) {
    console.log(line);
  }
}

/**
 * Show the anonymized-telemetry notice exactly once per machine. Writes a
 * marker under ~/.gatetest so it never repeats. Best-effort — a failure to
 * read/write the marker simply means the notice may show again, never a crash.
 */
function maybeNoticeTelemetry() {
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
  catch { /* error-ok — no git repo or detached HEAD — main is the documented default base */ }

  const baseBranch = args.autoPrBase || originalBranch;
  const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const fixBranch = args.autoPrBranch || `gatetest/auto-fix-${ts}`;
  // Return to the original branch and drop the fix branch after a failed
  // run. A cleanup that itself fails leaves the user checked out on the fix
  // branch, so it is reported in the error rather than erased (self-scan
  // 2026-09-13 — two `catch { /* ignore */ }` here).
  const abandonFixBranch = () => {
    try {
      sh(`git checkout ${originalBranch}`);
      sh(`git branch -D ${fixBranch}`);
      return '';
    } catch (cleanupErr) {
      return ` (cleanup failed: ${cleanupErr.message?.slice(0, 120) || cleanupErr} — you may still be on ${fixBranch})`;
    }
  };

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
    return { error: `Fix orchestration failed: ${err.message?.slice(0, 200) || err}${abandonFixBranch()}` };
  }

  const { accepted, testFiles, allFixes, prBody } = orchestration;

  if (accepted.length === 0) {
    return { error: `No fixes passed the syntax gate — nothing to commit${abandonFixBranch()}` };
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
  const { runFixBatch, formatDryRunPlan } = require('../src/core/cli-fix-orchestrator');
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
    --dry-run             Print the plan (per-file diff) and write NOTHING —
                          no fixes, no temp files, no test swap-in
    --model <name>        AI model for the fix engine. One of:
${Object.entries(ALLOWED_FIX_MODELS)
    .map(([id, m]) => `                            ${m.aliases[0]}${id === CHEAP_MODEL ? ' [default]' : ''}`)
    .join('\n')}
                          — or a full model id from your provider.
                          Env fallback: GATETEST_FIX_MODEL.

  REQUIRES
    ANTHROPIC_API_KEY — YOUR OWN AI provider key (bring-your-own-key). Fix calls
    go straight from this machine to the provider — you control the spend,
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
    console.error('  export ANTHROPIC_API_KEY=sk-ant-... (you pay the provider directly).\n');
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

  // --dry-run is decided HERE, before the orchestrator runs: until KI #112
  // the flag was only consulted after runFixBatch had already written every
  // winning hypothesis (and swapped candidates in for test runs), so the
  // "would apply" plan described changes that were already on disk.
  let orchestration;
  try {
    orchestration = await runFixBatch(fixable, rootDir, apiKey, {
      maxAttempts: 3, fileCap: 50, model: fixModel, dryRun: Boolean(localArgs.dryRun),
    });
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
    console.log(formatDryRunPlan(accepted));
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
  // Info-only findings (markdown nits, missing Stylelint config, etc.) never
  // block and are never a warning — excluded from the denominator so this
  // doesn't read as "half failed" on a healthy repo (see console-reporter.js).
  const infoFindings = report.summary.checks.infoFindings || 0;
  console.log(`  Checks: ${report.summary.checks.passed}/${report.summary.checks.total - infoFindings} passed`);
  console.log(`  Duration: ${report.summary.duration}ms`);

  if (report.failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of report.failures) {
      console.log(`    - ${f.module}: ${f.error}`);
    }
  }
  console.log('');
}

/** Translate --crawl-header/--crawl-cookie/--crawl-storage-state into liveCrawler config. */
function crawlAuthFromArgs(args) {
  const auth = {};
  if (args.crawlHeaders) {
    auth.headers = {};
    for (const raw of args.crawlHeaders) {
      const sep = raw.indexOf(':');
      if (sep > 0) auth.headers[raw.slice(0, sep).trim()] = raw.slice(sep + 1).trim();
      else console.warn(`[GateTest] Ignoring malformed --crawl-header "${raw}" — expected "Name: value"`);
    }
  }
  if (args.crawlCookie) auth.cookie = args.crawlCookie;
  if (args.crawlStorageState) auth.storageState = args.crawlStorageState;
  return auth;
}

/**
 * A run's own crawl report, keyed by pid + target origin (crawlReportPaths,
 * same definition the module writes with) so two concurrent `--crawl`
 * processes from the same project root never read each other's file. Belt
 * and suspenders on top of the path keying: also refuse to print a file
 * whose own "# URL:" header does not match the URL this run just crawled —
 * a leftover file from a crashed/reused pid must never be presented as this
 * run's result (reproduced 2026-09-21/22: a tallrig run printed gluecron's
 * report; a timed-out run printed a stale report from an earlier crawl).
 */
function readOwnCrawlReport(mdPath, url) {
  if (!fs.existsSync(mdPath)) return null;
  const content = fs.readFileSync(mdPath, 'utf-8');
  const urlLine = content.split(/\r?\n/).find((l) => l.startsWith('# URL: '));
  if (!urlLine || urlLine.slice('# URL: '.length).trim() !== url) return null;
  return content;
}

/** If the liveCrawler module hit its wall-clock timeout, the message to show instead of any report. */
function crawlTimeoutMessage(summary) {
  const failed = (summary.failedModules || []).find((m) => m.module === 'liveCrawler');
  if (!failed) return null;
  const match = /timed out after (\d+)ms/.exec(failed.error || '');
  if (!match) return null;
  return `No crawl report: module timed out after ${match[1]}ms — no data was collected for this run.`;
}

/** This run's own crawl JSON data (the same file generateFeedbackReport writes the .md report from), or null if absent/mismatched. */
function readOwnCrawlJsonData(jsonPath, url) {
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    if (!data || data.baseUrl !== url) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Print this run's own crawl report (or say plainly why there isn't one).
 * Shared by runCrawl/runCrawlLoop.
 *
 * Checks for an actual report FIRST, ahead of the runner's timeout verdict:
 * an outer wall-clock race can mark the module "failed" moments after its
 * (abandoned, still-running) run() call already finished writing a clean
 * report to disk (issue #677 item 2) — a genuine report on disk, keyed to
 * THIS run's pid+origin and carrying THIS run's own URL, is never stale by
 * construction, so there is nothing to lose by trusting it over the
 * runner's crash flag. Only when no such report exists do we explain why,
 * via the timeout message when the module truly never got that far.
 */
function printOwnCrawlReport(gatetest, url) {
  const { mdPath } = crawlReportPaths(gatetest.projectRoot, url);
  const report = readOwnCrawlReport(mdPath, url);
  if (report) {
    console.log('\n' + report);
    return report;
  }
  const timeoutMessage = crawlTimeoutMessage(gatetest._lastCrawlSummary);
  console.log(`\n[GateTest] ${timeoutMessage || `No crawl report was produced for ${url} this run.`}\n`);
  return null;
}

/**
 * This run's own crawl data — the real report if `generateFeedbackReport`
 * wrote one for this exact pid+origin+URL, or an honest "nothing was
 * verified" fallback when the module's run() never got that far (its own
 * outer wall-clock timeout fired first). Both the exit code and the
 * `--format json` document are built from this SAME object, so they can
 * never disagree (issue #677 item 2, reproduced once on a 40-page crawl of
 * tallrig.com — the report said ALL CLEAR, the process still exited 1 with
 * nothing anywhere explaining why, because the exit code used to come from
 * the runner's generic module status instead of the report's findings).
 */
function crawlDataForRun(gatetest, url, maxPages) {
  const { jsonPath } = crawlReportPaths(gatetest.projectRoot, url);
  const data = readOwnCrawlJsonData(jsonPath, url);
  if (data) return data;
  return {
    baseUrl: url, pagesScanned: 0, maxPages,
    errors: [], brokenLinks: [], brokenImages: [], brokenScripts: [], brokenStylesheets: [],
    timedOutPages: [], budgetExhausted: false,
  };
}

async function runCrawl(gatetest, url, maxPages, authConfig = {}, jsonMode = false) {
  // Inject crawl URL into config — merged over any .gatetest config so
  // file-based crawl settings (headers, cookie, thresholds) still apply
  gatetest.config.config.modules.liveCrawler = {
    ...(gatetest.config.config.modules.liveCrawler || {}),
    url,
    maxPages,
    timeout: 10000,
    checkExternal: true,
    ...authConfig,
  };

  // --format json: stdout is the one JSON document, so progress goes to
  // stderr instead (same convention as the suite scan's jsonMode, and as
  // --server below).
  const log = jsonMode ? console.error : console.log;
  log(`\n[GateTest] Crawling ${url} (max ${maxPages} pages)...\n`);
  const summary = await gatetest.runModule('liveCrawler');
  gatetest._lastCrawlSummary = summary;

  const data = crawlDataForRun(gatetest, url, maxPages);
  const exitCode = crawlExitCode(data);

  if (jsonMode) {
    const doc = {
      url: data.baseUrl || url,
      pagesScanned: data.pagesScanned || 0,
      generatedAt: new Date().toISOString(),
      result: crawlResultLabel(data),
      exitCode,
      findings: buildCrawlFindings(data),
    };
    // Never process.exit() right after a stdout write — see the matching
    // comment on the --server JSON path above. A piped stdout is
    // asynchronous on POSIX, so a forced exit (even from inside the write's
    // own callback) can race the write and hand the consumer a truncated or
    // empty document; reproduced in CI on Linux against this exact code
    // path, not on Windows. Setting exitCode and returning lets the event
    // loop drain naturally instead.
    process.stdout.write(`${JSON.stringify(doc)}\n`);
    process.exitCode = exitCode;
    return;
  }

  printOwnCrawlReport(gatetest, url);
  process.exit(exitCode);
}

async function runCrawlLoop(gatetest, url, maxPages, authConfig = {}) {
  gatetest.config.config.modules.liveCrawler = {
    ...(gatetest.config.config.modules.liveCrawler || {}),
    url,
    maxPages,
    timeout: 10000,
    checkExternal: true,
    ...authConfig,
  };

  const maxRounds = 20;
  // Convergence guard (complaint C23, src/core/convergence-guard.js): every
  // round's findings — the SAME array `--format json` and the exit code
  // both read (crawlDataForRun + buildCrawlFindings), so this can never
  // disagree with what the human report shows — feed the guard. It decides
  // converged / no-progress / oscillating / max-iterations, so the loop
  // always ends with a stated reason instead of a bare round counter.
  const guard = createConvergenceGuard({ maxIterations: maxRounds });
  let round = 1;

  while (round <= maxRounds) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`[GateTest] CRAWL LOOP — Round ${round}/${maxRounds}`);
    console.log(`[GateTest] Testing: ${url}`);
    console.log(`${'='.repeat(50)}\n`);

    const summary = await gatetest.runModule('liveCrawler');
    gatetest._lastCrawlSummary = summary;
    printOwnCrawlReport(gatetest, url);

    const data = crawlDataForRun(gatetest, url, maxPages);
    const step = guard.step({ findingIds: crawlFindingIds(data) });

    if (step.done) {
      console.log(`\n[GateTest] ${step.message}\n`);
      // `converged` is the only reason that means the site actually came up
      // clean — every other reason is a stated stop, not a pass.
      process.exit(step.reason === CONVERGENCE_REASONS.CONVERGED ? 0 : 1);
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

  // Watch directories. A watcher that cannot be attached is reported, and a
  // session that attached none exits: "Watching for changes..." over zero
  // watchers is the report-success-while-doing-nothing shape (doctrine §1;
  // self-scan 2026-09-13 found the failure erased by an empty catch).
  const unwatchable = [];
  let watching = 0;
  for (const dir of watchDirs) {
    const fullPath = path.join(projectRoot, dir);
    if (!fs.existsSync(fullPath)) continue;

    try {
      fs.watch(fullPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Ignore generated files — by path segment, not substring: an edit
        // to `.gatetestignore` SHOULD trigger a rescan, and `.gatetest`
        // matched it (2026-09-05).
        const segments = String(filename).split(/[\\/]/);
        if (segments.includes('.gatetest') || segments.includes('node_modules')) return;
        if (filename.endsWith('.map') || filename.endsWith('.d.ts')) return;

        if (timer) clearTimeout(timer);
        timer = setTimeout(runScan, debounceMs);
      });
      watching += 1;
    } catch (watchErr) {
      // fs.watch may not support recursive on all platforms — say so.
      unwatchable.push(`${dir} (${watchErr.message})`);
      console.error(`[GateTest] Cannot watch ${dir}: ${watchErr.message}`);
    }
  }
  if (watching === 0) {
    console.error(`[GateTest] Watch mode attached no watchers${unwatchable.length ? ` — ${unwatchable.join(', ')}` : ''}. Exiting.`);
    process.exit(1);
  }

  // Keep process alive
  await new Promise(() => {});
}

main().catch(err => {
  console.error(`\n[GateTest] Fatal error: ${err.message}\n`);
  process.exit(1);
});
