/**
 * GateTest Configuration - Central configuration management.
 * Loads from .gatetest/config.json, environment variables, and CLI args.
 */

const fs = require('fs');
const path = require('path');
const { innerHtmlAssignmentIsSafe } = require('./inner-html-safety');

/**
 * Modules a suite deliberately does NOT run, and where they run instead.
 *
 * A module dropped from a suite with no trace is a silent coverage cut —
 * the user believes they ran "the full engine" and no longer did
 * (Forbidden #16: never silently fail). So every omission is recorded
 * here, surfaced in the console summary ("Deferred: ..."), carried on the
 * scan summary as `summary.deferred` for API/MCP/website consumers, and
 * covered by tests/suite-deferrals.test.js — which also asserts each
 * deferred module still runs in at least one suite, so this table can
 * never become a way to quietly retire a module.
 *
 * mutation (2026-09-04): mutation testing re-runs the customer's ENTIRE
 * test suite once per mutant. Measured on this repo: the suite is 7559
 * tests / ~55s, so the mutation module's own BASELINE run alone costs as
 * much as the rest of the scan put together, and a real 50-mutant pass
 * would cost ~45 minutes. It cannot fit the 60s interactive bar in
 * CLAUDE.md §9 at any budget, and a truncated 4-mutant sample is a worse
 * answer than a complete nightly one. Worse, the per-mutant timeout
 * (30s) is SHORTER than this suite's runtime, so every mutant would time
 * out and be scored as "killed" — a fake 100%. It runs in full, uncapped,
 * in .github/workflows/mutation-nightly.yml, on demand via
 * `gatetest --module mutation`, and in the `nuclear` suite (CI path).
 */
const SUITE_DEFERRALS = {
  full: [
    {
      module: 'mutation',
      reason: 're-runs your whole test suite once per mutant — minutes, not seconds',
      runsIn: 'nightly CI, `gatetest --module mutation`, or --suite nuclear',
    },
  ],
};

const DEFAULT_CONFIG = {
  // Quality thresholds (from CLAUDE.md)
  thresholds: {
    unitTestCoverage: 90,
    integrationTestCoverage: 85,
    e2eCriticalPathCoverage: 100,
    mutationTestScore: 80,
    lighthousePerformance: 95,
    lighthouseAccessibility: 100,
    lighthouseBestPractices: 100,
    lighthouseSeo: 100,
    wcagLevel: 'AAA',
    maxSecurityVulnerabilities: 0,
    maxBrokenLinks: 0,
    maxConsoleErrors: 0,
    maxTypeScriptErrors: 0,
    maxLintErrors: 0,
    maxBundleSizeJs: 200 * 1024,   // 200KB gzipped
    maxBundleSizeCss: 50 * 1024,   // 50KB gzipped
    maxApiResponseTime: 200,        // ms p95
    maxFcp: 1000,                   // ms
    maxLcp: 2000,                   // ms
    maxCls: 0.05,
    maxInp: 200,                    // ms
    maxTbt: 150,                    // ms
    maxTti: 2500,                   // ms
    maxFunctionLength: 100,          // lines
    maxFileLength: 300,             // lines
    maxCyclomaticComplexity: 10,
  },

  // Test suite configuration
  suites: {
    quick: [
      'memory',
      'syntax',
      'lint',
      'secrets',
      'codeQuality',
      'dependencies',
      'shell',
      'sqlMigrations',
      'terraform',
      'kubernetes',
      'promptSafety',
      'deadCode',
      'secretRotation',
      'webHeaders',
      'typescriptStrictness',
      'undefinedRef',
      'flakyTests',
      'errorSwallow',
      'nPlusOne',
      'retryHygiene',
      'raceCondition',
      'resourceLeak',
      'ssrf',
      'hardcodedUrl',
      'envVars',
      'asyncIteration',
      'homoglyph',
      'openapiDrift',
      'prSize',
      'prQuality',
      'redos',
      'cronExpression',
      'datetimeBug',
      'importCycle',
      'spineHealth',
      'moneyFloat',
      'logPii',
      'featureFlag',
      'tlsSecurity',
      'cookieSecurity',
      'crossFileTaint',
      'fakeFixDetector',
    ],
    standard: [
      'memory',
      'syntax',
      'lint',
      'secrets',
      'codeQuality',
      'unitTests',
      'integrationTests',
      'dependencies',
      'dockerfile',
      'ciSecurity',
      'shell',
      'sqlMigrations',
      'terraform',
      'kubernetes',
      'promptSafety',
      'deadCode',
      'secretRotation',
      'webHeaders',
      'typescriptStrictness',
      'undefinedRef',
      'flakyTests',
      'errorSwallow',
      'nPlusOne',
      'retryHygiene',
      'raceCondition',
      'resourceLeak',
      'ssrf',
      'hardcodedUrl',
      'envVars',
      'asyncIteration',
      'homoglyph',
      'openapiDrift',
      'prSize',
      'prQuality',
      'redos',
      'cronExpression',
      'datetimeBug',
      'importCycle',
      'spineHealth',
      'moneyFloat',
      'logPii',
      'featureFlag',
      'tlsSecurity',
      'cookieSecurity',
      'crossFileTaint',
      'fakeFixDetector',
    ],
    full: [
      'memory',
      'syntax',
      'lint',
      'secrets',
      'codeQuality',
      'unitTests',
      'integrationTests',
      'e2e',
      'visual',
      'accessibility',
      'performance',
      'security',
      'seo',
      'links',
      'compatibility',
      'dataIntegrity',
      'documentation',
      'dependencies',
      'sbom',
      'dockerfile',
      'ciSecurity',
      'shell',
      'sqlMigrations',
      'terraform',
      'kubernetes',
      'promptSafety',
      'deadCode',
      'secretRotation',
      'webHeaders',
      'typescriptStrictness',
      'undefinedRef',
      'flakyTests',
      'errorSwallow',
      'nPlusOne',
      'retryHygiene',
      'raceCondition',
      'resourceLeak',
      'ssrf',
      'hardcodedUrl',
      'envVars',
      'asyncIteration',
      'homoglyph',
      'openapiDrift',
      'prSize',
      'prQuality',
      'redos',
      'cronExpression',
      'datetimeBug',
      'importCycle',
      'spineHealth',
      'moneyFloat',
      'logPii',
      'featureFlag',
      'tlsSecurity',
      'cookieSecurity',
      'crossFileTaint',
      // NOTE: 'mutation' is deliberately NOT here — see SUITE_DEFERRALS below.
      // It re-runs the customer's ENTIRE test suite once per mutant, which
      // cannot fit an interactive scan. It stays in `nuclear` (CI/Action
      // path) and runs nightly. This also makes the code match what the
      // README has always promised for the $99 Full Scan: "88 modules;
      // mutation + chaos run via the GitHub Action instead".
      'python',
      'go',
      'rust',
      'java',
      'ruby',
      'php',
      'csharp',
      'kotlin',
      'swift',
      'aiReview',
      'agentic',
      'fakeFixDetector',
      'claudeCompliance',
      'aiHallucination',
      'authBypass',
      'bashSafety',
      'bundleSize',
      'cacheHeaders',
      'ciParamValidator',
      'deployContract',
      'deployReadiness',
      'deployScriptValidator',
      'duplicateCode',
      'envIntegrity',
      'monorepoConstraints',
      'nativeBundlerGuard',
      'rollbackHonesty',
      'serviceConsistency',
      'systemd',
      'trpcContract',
      'webhookPayload',
      'zodSchemaPresence',
    ],
    live: [
      'liveCrawler',
      'explorer',
      'chaos',
    ],
    nuclear: [
      'memory',
      'aiGuardrails',
      'sbom',
      'syntax',
      'lint',
      'secrets',
      'codeQuality',
      'unitTests',
      'integrationTests',
      'e2e',
      'visual',
      'accessibility',
      'performance',
      'security',
      'seo',
      'links',
      'compatibility',
      'dataIntegrity',
      'documentation',
      'dependencies',
      'dockerfile',
      'ciSecurity',
      'shell',
      'sqlMigrations',
      'terraform',
      'kubernetes',
      'promptSafety',
      'deadCode',
      'secretRotation',
      'webHeaders',
      'typescriptStrictness',
      'undefinedRef',
      'flakyTests',
      'errorSwallow',
      'nPlusOne',
      'retryHygiene',
      'raceCondition',
      'resourceLeak',
      'ssrf',
      'hardcodedUrl',
      'envVars',
      'asyncIteration',
      'homoglyph',
      'openapiDrift',
      'prSize',
      'prQuality',
      'redos',
      'cronExpression',
      'datetimeBug',
      'importCycle',
      'spineHealth',
      'moneyFloat',
      'logPii',
      'featureFlag',
      'tlsSecurity',
      'cookieSecurity',
      'crossFileTaint',
      'liveCrawler',
      'explorer',
      'chaos',
      'mutation',
      'python',
      'go',
      'rust',
      'java',
      'ruby',
      'php',
      'csharp',
      'kotlin',
      'swift',
      'aiReview',
      'agentic',
      'fakeFixDetector',
      'claudeCompliance',
      'aiHallucination',
      'authBypass',
      'bashSafety',
      'bundleSize',
      'cacheHeaders',
      'ciParamValidator',
      'deployContract',
      'deployReadiness',
      'deployScriptValidator',
      'duplicateCode',
      'envIntegrity',
      'monorepoConstraints',
      'nativeBundlerGuard',
      'rollbackHonesty',
      'serviceConsistency',
      'systemd',
      'trpcContract',
      'webhookPayload',
      'zodSchemaPresence',
      // Nuclear-only AI-driven modules (Anthropic spend per scan)
      'architectureDrift',
      'intentVerification',
      'regressionPredictor',
    ],
    // WordPress side product (wp subdomain) — Boss Rule D, Craig 2026-05-13.
    // Reuses some general-purpose modules from the developer suites where
    // they apply to a live WP URL (webHeaders, tlsSecurity, cookieSecurity,
    // accessibility, seo, links, performance) plus the new WP-specific
    // modules that only make sense when scanning a real WP site.
    wp: [
      'memory',
      'wpExposedFiles',
      'wpVersionLeak',
      'wpXmlrpcExposed',
      'wpPluginCveCheck',
      'wpMalwarePatterns',
      'wpUserEnumerate',
      'wpAdminProtection',
      'wpPhpVersionEol',
      'wpThemeAbandonment',
      'wpBackupValidation',
      'webHeaders',
      'tlsSecurity',
      'cookieSecurity',
      'accessibility',
      'seo',
      'links',
      'performance',
      // liveCrawler: HTTP-only by default on Vercel (Playwright unavailable);
      // catches 404/500 + broken images + redirect chains + mixed-content
      // across the customer's site. Falls back to "no URL configured" if
      // targetUrl isn't set.
      'liveCrawler',
      'runtimeErrors',
      // explorer: clicks every button + form + dropdown via Playwright,
      // catches "button doesn't fire" and post-click JS errors. Skips
      // gracefully when Chromium isn't available (Vercel today; lights
      // up when Crontech worker is wired).
      'explorer',
      // visualRegression: full-page screenshot diffing against a stored
      // baseline, catches redesigns / broken layouts that no static or
      // DOM-level check can see. Needs Playwright + a writable baseline
      // dir; skips gracefully otherwise.
      'visualRegression',
      // interactiveElements: safe link/button liveness crawler — HTTP
      // HEAD-checks every internal link, click-tests every button with a
      // destructive-action skip list (delete/cancel/logout/...) so it
      // never fires real mutating actions against a live site. Skips
      // gracefully when Chromium isn't available.
      'interactiveElements',
      // apiHealth: hits every discovered API endpoint (OpenAPI spec >
      // HTML crawl > common-paths guesses) with valid + missing-param
      // requests, checks status/timing/content-type. Pure HTTP — no
      // Playwright, so unlike its siblings above it runs fine on Vercel
      // serverless too.
      'apiHealth',
      // performanceBudget: live TTFB/LCP/CLS/page-weight against the
      // real URL (median of 3 runs, cold-start warm-up first) — the
      // existing "performance" module never actually loads a page.
      'performanceBudget',
      // mobileRendering: overflow + unreadable-text checks across 5
      // device widths (390/414/768/1024/1280). Absolute checks, not a
      // diff — catches "broken right now," not just "changed."
      'mobileRendering',
      // formTesting: fills + submits SAFE forms (contact, newsletter,
      // search, feedback). Payment-shaped, auth-shaped, and CAPTCHA-
      // protected forms are detected and SKIPPED, never submitted or
      // bypassed — see form-testing.js header for the full safety scope.
      'formTesting',
      // consoleErrors: site-wide crawl aggregating console errors/
      // warnings across every page visited — runtimeErrors only looks
      // at one page in depth, this trades depth for breadth.
      'consoleErrors',
      // designSystemCompliance: audits LIVE computed styles for
      // near-duplicate colors, off-grid spacing, and type-scale drift.
      'designSystemCompliance',
      // crossBrowser: diffs page load / runtime errors / rendering
      // across Chromium, Firefox, and WebKit (Chromium is the reference).
      'crossBrowser',
    ],

    // Generic web URL suite — runs against any public site. Same engine
    // as the wp suite but without the WordPress-specific probes. Adds
    // runtime browser checks so we catch live JS errors, CSP violations,
    // hydration mismatches, and broken assets — the failures static
    // probing alone can't see.
    web: [
      'memory',
      'webHeaders',
      'tlsSecurity',
      'cookieSecurity',
      'accessibility',
      'seo',
      'links',
      'performance',
      'liveCrawler',     // 404 / 500 / broken-image / redirect-chain on the live URL
      'runtimeErrors',   // live JS errors / CSP violations (needs Crontech worker)
      'explorer',        // "button doesn't fire" detection (needs Crontech worker)
      'visualRegression', // full-page screenshot diff vs stored baseline (needs Crontech worker)
      'interactiveElements', // safe link liveness + destructive-skip button crawler (needs Crontech worker)
      'apiHealth',       // endpoint status/timing/content-type checks — pure HTTP, works on Vercel serverless
      'performanceBudget', // live TTFB/LCP/CLS/page-weight, median of 3 runs (needs Crontech worker)
      'mobileRendering', // overflow + tiny-text checks across 5 device widths (needs Crontech worker)
      'formTesting',     // safe-form fill+submit, skips payment/auth/CAPTCHA (needs Crontech worker)
      'consoleErrors',   // site-wide console error/warning aggregation across every crawled page (needs Crontech worker)
      'designSystemCompliance', // color/spacing/typography drift on live computed styles (needs Crontech worker)
      'crossBrowser',    // Chromium/Firefox/WebKit page-load + rendering diff (needs Crontech worker)
    ],
  },

  // Module-specific settings
  modules: {
    // liveCrawler defaults — tuned for the /api/web/scan and /api/wp/scan
    // serverless paths (60s budget). Local CLI invocations can override
    // any of these via `.gatetest/config.json`.
    liveCrawler: {
      maxPages: 25,              // breadth-first up to 25 internal pages
      timeout: 6000,             // 6s per HTTP request
      checkExternal: false,      // skip external links for serverless (saves budget)
      browser: false,            // default to HTTP-only; lights up to browser when Playwright available
      // Deep checks performed per page beyond raw status code:
      //   - missing/empty <title>
      //   - missing meta description
      //   - missing canonical
      //   - broken <script src>, <link rel=stylesheet>, <link rel=icon>
      //   - mixed content (http: asset on https: page)
      //   - anchor links to missing IDs (#section with no matching id)
      //   - empty-page heuristic (no <h1> / <p> / <main>)
      //   - response time > slowThresholdMs
      //   - missing security headers (per-page, deltas only — gate-fail
      //     style is reported by the dedicated webHeaders module)
      slowThresholdMs: 2500,
      checkSitemap: true,        // fetch /sitemap.xml — flag missing pages
      checkRobotsTxt: true,      // fetch /robots.txt — flag missing or wide-open
      checkFavicon: true,        // GET /favicon.ico — flag 404s
      checkCommonPaths: true,    // probe /, /404, /500, /admin, /api — flag inconsistencies
    },
    explorer: {
      // Autonomous interactive testing — clicks every button, fills forms,
      // exercises every keyboard path, watches for JS errors per click.
      // Browser-only; gracefully degrades when Chromium unavailable.
      maxInteractions: 100,
      timeout: 5000,
    },
    visual: {
      screenshotDir: '.gatetest/screenshots',
      baselineDir: '.gatetest/baselines',
      diffThreshold: 0.01,    // 1% pixel difference tolerance
      viewports: [
        { width: 320, height: 568, name: 'mobile-small' },
        { width: 375, height: 812, name: 'mobile-standard' },
        { width: 414, height: 896, name: 'mobile-large' },
        { width: 768, height: 1024, name: 'tablet-portrait' },
        { width: 1024, height: 768, name: 'tablet-landscape' },
        { width: 1280, height: 800, name: 'desktop-standard' },
        { width: 1920, height: 1080, name: 'desktop-large' },
        { width: 2560, height: 1440, name: 'desktop-ultrawide' },
      ],
    },
    accessibility: {
      standard: 'WCAG2AAA',
      includeWarnings: true,
      includeNotices: false,
    },
    security: {
      scanHeaders: true,
      scanDependencies: true,
      scanSecrets: true,
      scanSourceCode: true,
      owaspZapTarget: null,     // Set to URL for active scanning
      secretPatterns: [
        /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{8,}/gi,
        /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}/gi,
        /(?:token|bearer)\s*[:=]\s*['"][^'"]{8,}/gi,
        /(?:aws|amazon).{0,20}(?:key|secret|token).{0,20}['"][A-Za-z0-9/+=]{20,}/gi,
        /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
        /ghp_[A-Za-z0-9_]{36,}/g,        // GitHub personal access tokens
        /gho_[A-Za-z0-9_]{36,}/g,        // GitHub OAuth tokens
        /github_pat_[A-Za-z0-9_]{22,}/g, // GitHub fine-grained tokens
        /sk-[A-Za-z0-9]{32,}/g,          // OpenAI/Stripe keys
        /sk_live_[A-Za-z0-9]{24,}/g,     // Stripe live keys
      ],
    },
    performance: {
      budget: {
        js: 200 * 1024,
        css: 50 * 1024,
        images: 500 * 1024,
        fonts: 100 * 1024,
        total: 1000 * 1024,
      },
      lighthouseConfig: {
        extends: 'lighthouse:default',
        settings: {
          onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
          formFactor: 'desktop',
          throttling: {
            cpuSlowdownMultiplier: 1,
          },
        },
      },
    },
    seo: {
      validateStructuredData: true,
      validateOpenGraph: true,
      validateTwitterCards: true,
      validateCanonical: true,
      validateSitemap: true,
      validateRobotsTxt: true,
      maxTitleLength: 60,
      maxDescriptionLength: 160,
    },
    // The links module is static — it resolves internal references against
    // the tree and never opens a connection. `checkExternal`, `checkInternal`,
    // `timeout`, `retries` and `concurrency` described a live checker that was
    // never built and were read by nothing (KI #52); a key nothing reads is a
    // promise the product does not keep. `excludePatterns` is the one key the
    // module honours: link targets to skip, `paths` glob grammar.
    links: {
      excludePatterns: [],
    },
    compatibility: {
      browsers: [
        'chrome >= 120',
        'firefox >= 120',
        'safari >= 17',
        'edge >= 120',
        'ios_saf >= 17',
        'and_chr >= 120',
      ],
    },
    fakeFixDetector: {
      patternEngine: true,
      aiEngine: true,
      // `against`: optional git ref — diff HEAD against this (e.g. 'main')
      against: null,
      // `context`: optional string describing the bug being fixed, passed to AI
      context: null,
    },
    prSize: {
      // `against`: optional git ref — if unset, module auto-detects via
      // staged / working-tree / HEAD~1
      against: null,
      maxFilesChangedWarning: 50,
      maxFilesChangedError: 100,
      maxLinesChangedWarning: 500,
      maxLinesChangedError: 1000,
      maxLinesPerFileWarning: 300,
      maxLinesPerFileError: 500,
      maxTopLevelDirs: 3,
      excludePatterns: [],
    },
    prQuality: {
      // `against`: optional git ref — module falls back to origin/main → main → HEAD~1
      against: null,
      minSubjectLength: 8,
      maxSourceTestRatio: 5,
      minSourceFilesForTestCheck: 3,
    },
    codeQuality: {
      excludePaths: ['bin', 'scripts', 'src/reporters', 'src/hooks', 'src/ai-loop.js', 'src/app-server.js', 'src/scanners'],
      forbiddenPatterns: [
        { pattern: /console\.(log|debug|info)\(/g, message: 'console.log/debug/info found' },
        { pattern: /\bdebugger\b/g, message: 'debugger statement found' },
        { pattern: /\/\/\s*(TODO|FIXME|HACK|XXX)/gi, message: 'Unresolved TODO/FIXME/HACK/XXX comment' },
        { pattern: /(?<![\w.$])eval\s*\(/g, message: 'eval() usage detected' },
        { pattern: /new\s+Function\s*\(/g, message: 'Function constructor usage detected' },
        // safeIf shares ONE predicate with the security module's innerHTML
        // rule (src/core/inner-html-safety.js). Without it this rule failed
        // the gate on `el.innerHTML = ''` and on correctly-escaped output —
        // measured 2026-09-01, after the security module had already been
        // guarded and this second copy went on reporting the same line.
        {
          pattern: /\.innerHTML\s*=/g,
          message: 'innerHTML assignment detected — use textContent or sanitize',
          safeIf: innerHtmlAssignmentIsSafe,
        },
      ],
    },
  },

  // Reporting
  reporting: {
    outputDir: '.gatetest/reports',
    formats: ['json', 'html', 'console'],
    retainReports: 30,   // days
    timestamped: true,
  },

  // Scanning (continuous monitoring)
  scanning: {
    enabled: false,
    intervals: {
      dependencyAudit: '0 0 * * *',     // daily at midnight
      brokenLinks: '0 2 * * *',          // daily at 2am
      lighthouseAudit: '0 4 * * *',      // daily at 4am
      securityScan: '0 0 * * 0',         // weekly on Sunday
      loadTest: '0 6 * * 0',             // weekly on Sunday at 6am
      complianceScan: '0 0 1 * *',       // monthly on 1st
    },
    uptimeCheckInterval: 60,   // seconds
    errorRateWindow: 300,      // seconds (5 minutes)
    errorRateThreshold: 0.001, // 0.1%
  },

  // Gate enforcement
  gate: {
    blockOnFailure: true,
    autoFix: true,
    autoRollback: true,
    rollbackWindow: 900,  // seconds (15 minutes)
  },

  // Incremental scan — used by --since <ref> / --pr to skip unchanged files.
  // skipList: modules that must scan the whole tree (cross-file graph analysis
  //   can't be scoped to a changed-file subset without producing false negatives).
  // alwaysRunList: modules that must run even when no files in their scope changed
  //   (e.g. secretRotation tracks git history; prSize measures the whole diff).
  // sourceExtensions: file extensions that qualify as "source" for the diff filter;
  //   non-listed extensions (images, binaries) are never flagged as "changed".
  incremental: {
    skipList: [
      'importCycle',
      'spineHealth',
      'deadCode',
      'crossFileTaint',
      'openapiDrift',
      'aiReview',
      'agentic',
      'architectureDrift',
    ],
    alwaysRunList: [
      'secretRotation',
      'prSize',
      'prQuality',
      'ciSecurity',
      'secrets',
    ],
    sourceExtensions: [
      '.js', '.jsx', '.mjs', '.cjs',
      '.ts', '.tsx', '.mts', '.cts',
      '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs', '.kt', '.swift',
      '.json', '.yaml', '.yml', '.toml', '.env', '.md', '.sh', '.bash',
      '.tf', '.hcl', '.dockerfile', 'dockerfile',
      '.sql', '.graphql',
      // The gate's own policy file: extensionless, so it is matched by name.
      // Without it a PR that only adds a suppression is "no source changed"
      // and the policy-change finding is scoped out (move 26).
      '.gatetestignore',
    ],
  },

  // Monorepo path filters (src/core/scan-paths.js): globs relative to the
  // project root; a bare directory means everything under it; exclude
  // wins. Empty = no filter. Applied at BaseModule._collectFiles and to
  // findings at the runner, and reported as scope in every summary.
  paths: {
    include: [],
    exclude: [],
  },

  // Finding suppression (KI #112 G4, widened issue #657): the SAME line
  // syntax as a repo-root `.gatetestignore` (`module:rule` | `module` |
  // `*:rule` | `module:rule@glob` | `path/glob/**`), fed to the same parser
  // (src/core/ignore-file.js — one definition, no second matcher) by
  // src/core/runner.js. Lets a `.gatetest.json`-templating build pipeline
  // suppress findings without also hand-maintaining a second file. Accepts
  // a top-level array OR a nested `{ paths: [...] }` object — both read by
  // `runner.js`'s `_configIgnoreLines`, both rendered as bare path-glob
  // lines. The default is the array shape; `_deepMerge` (below) preserves
  // whichever shape the customer's file actually uses.
  ignore: [],
};

/**
 * Top-level `.gatetest.json` keys the product actually consumes.
 *
 * `_deepMerge` accepts ANY key, so an unrecognised one lands in the config
 * object and is then read by nobody — configuration that looks live and is
 * decorative. Found 2026-08-26 on a protected platform whose config pinned
 * `aiReview.model` at the ROOT: the key had been inert since it was written,
 * because module config lives under `modules.<name>`. Same failure shape as a
 * CI workflow that can never fire — it looks configured, it is not
 * (Forbidden #16: never silently fail).
 *
 * Not every key here is read by THIS process, and that is deliberate:
 * `owner` / `admin` / `mode` are consumed by the husky pre-push hook (shell,
 * greps the raw file) and by the website's repo-mode detection; `telemetry`
 * by scan-telemetry.js. They are legitimate, so they must not warn.
 */
const KNOWN_ROOT_KEYS = new Set([
  ...Object.keys(DEFAULT_CONFIG),
  // Read outside this process — see the doc block above.
  'owner', 'admin', 'mode', 'telemetry',
  // Descriptive / provenance only; deliberately no-ops.
  '$schema', 'version', 'name', 'description', 'notes', 'gatetest_source',
  // Protection-marker keys (integrations/scripts/install.sh writes these —
  // see PROTECTED PLATFORMS in CLAUDE.md). `gatetest_source` is above;
  // these three are the rest of the marker block install.sh generates.
  // They exist to be read by our own tooling (a future session checking
  // "is this repo protected?"), not by a scan — legitimate no-ops here.
  'protected', 'do_not_remove', 'integration_version',
]);

/**
 * "Did you mean X?" for a root key that is not read — keyed on the exact
 * unknown key. Kept deliberately small and explicit: a guess that is WRONG
 * is worse than "no equivalent in this version", so this only names a
 * substitute when the mapping is genuinely close (the same concept, a
 * different key name), never a fuzzy string match.
 *
 * `severity` has no entry on purpose — there is no per-module severity
 * override mechanism in this version (only the field-measured demotions in
 * rule-demotion.js, which are not user-configurable), so a customer setting
 * it gets an honest "no equivalent" rather than a guess.
 */
const KEY_HINTS = {
  gating: 'gate',
  output: 'reporting',
  artifacts: 'reporting.outputDir',
};

class GateTestConfig {
  constructor(projectRoot) {
    this.projectRoot = projectRoot || process.cwd();
    this.configPath = path.join(this.projectRoot, '.gatetest', 'config.json');
    this.config = this._loadConfig();
  }

  _loadConfig() {
    let fileConfig = {};
    let sourcePath = null;

    // Priority 1: .gatetest.json at project root (user-facing config)
    const rootConfigPath = path.join(this.projectRoot, '.gatetest.json');
    if (fs.existsSync(rootConfigPath)) {
      try {
        const raw = fs.readFileSync(rootConfigPath, 'utf-8');
        fileConfig = JSON.parse(raw);
        sourcePath = rootConfigPath;
      } catch (err) { // error-ok — malformed config warns and falls back to defaults
        console.error(`[GateTest] Warning: Failed to parse ${rootConfigPath}: ${err.message}`);
      }
    }
    // Priority 2: .gatetest/config.json (legacy path)
    else if (fs.existsSync(this.configPath)) {
      try {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        fileConfig = JSON.parse(raw);
        sourcePath = this.configPath;
      } catch (err) { // error-ok — malformed config warns and falls back to defaults
        console.error(`[GateTest] Warning: Failed to parse ${this.configPath}: ${err.message}`);
      }
    }

    this.unknownKeyHints = {};
    this.unknownKeys = sourcePath ? this._reportUnknownKeys(fileConfig, sourcePath) : [];

    return this._deepMerge(DEFAULT_CONFIG, fileConfig);
  }

  /**
   * Report `.gatetest.json` keys nothing will ever read. Warns, never throws —
   * a stale key must not break a customer's scan.
   *
   * The module-name hint is the whole value here: a root-level `aiReview` is
   * one word away from `modules.aiReview`, and today the difference between
   * the two is completely silent. Returns the offending keys so callers (and
   * tests) can assert on them without capturing stderr.
   *
   * A key starting with `$` (e.g. `$comment`, `$schema`) is documentation by
   * convention, not configuration — never reported, whatever it's named.
   * Sets `this.unknownKeyHints`, a `{key: hint|null}` map (`hint` is the
   * known key a customer probably meant, or `null` for "no equivalent in
   * this version") — the same data the `config:unknown-keys` check
   * (src/core/runner.js) reports as a three-state, never-blocking finding.
   */
  _reportUnknownKeys(fileConfig, sourcePath) {
    this.unknownKeyHints = {};
    if (!fileConfig || typeof fileConfig !== 'object' || Array.isArray(fileConfig)) return [];
    const unknown = Object.keys(fileConfig).filter((key) => !key.startsWith('$') && !KNOWN_ROOT_KEYS.has(key));
    if (unknown.length === 0) return [];

    let moduleNames;
    try {
      moduleNames = new Set(Object.keys(require('./registry').BUILT_IN_MODULES));
    } catch (err) { // error-ok — the "did you mean" hint is a nicety; the warning ships without it
      moduleNames = new Set();
    }

    const hintFor = (key) => (moduleNames.has(key) ? `modules.${key}` : (KEY_HINTS[key] || null));
    const described = unknown.map((key) => {
      const hint = hintFor(key);
      this.unknownKeyHints[key] = hint;
      if (moduleNames.has(key)) return `${key} (module config belongs under "modules.${key}")`;
      return hint ? `${key} (did you mean "${hint}"?)` : `${key} (no equivalent in this version)`;
    });

    console.error(
      `[GateTest] Warning: ${sourcePath} sets ${unknown.length} key(s) GateTest does not read: `
      + `${described.join(', ')}. They have no effect on this scan.`
    );
    return unknown;
  }

  /**
   * The `config:unknown-keys` finding (KI #112, issue #633's "13 unread
   * keys" report) — an INFO-severity, never-blocking, three-state check:
   * `null` when every root key is one this version reads (nothing to say,
   * so nothing is emitted — Doctrine #1's "clean" state), otherwise an
   * object naming every unrecognised key and, per key, the known key a
   * customer probably meant (or "no equivalent in this version"). One
   * definition — src/core/runner.js reads this, not a second computation,
   * so the console/PR-comment/JSON-report copies can never disagree.
   * @returns {{name:string, passed:boolean, severity:string, message:string, keys:string[], hints:Object}|null}
   */
  getUnknownKeysCheck() {
    if (!Array.isArray(this.unknownKeys) || this.unknownKeys.length === 0) return null;
    const hints = this.unknownKeyHints || {};
    const parts = this.unknownKeys.map((key) => (
      hints[key] ? `${key} (did you mean "${hints[key]}"?)` : `${key} (no equivalent in this version)`
    ));
    return {
      name: 'config:unknown-keys',
      passed: false,
      severity: 'info',
      message: `.gatetest.json sets ${this.unknownKeys.length} key(s) this version does not read: ${parts.join(', ')}. They have no effect on this scan.`,
      keys: [...this.unknownKeys],
      hints: { ...hints },
    };
  }

  _deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (
        source[key] &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        !(source[key] instanceof RegExp)
      ) {
        result[key] = this._deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  get(keyPath) {
    return keyPath.split('.').reduce((obj, key) => obj?.[key], this.config);
  }

  /**
   * Dot-path setter, the write twin of get(). Creates intermediate objects
   * as needed: set('modules.liveCrawler.cookie', 'x').
   *
   * NOTE this existed as an ASSUMED API long before it existed as a real
   * one — website/app/api/web/scan/route.ts guarded `typeof config.set ===
   * "function"` and silently fell through when it wasn't, which meant the
   * hosted URL scan ran the whole web suite with NO targetUrl configured
   * (every URL-driven module no-op'd; findings came only from the separate
   * live probe + runtime worker). Found 2026-07-25 wiring authed crawls.
   */
  set(keyPath, value) {
    const keys = keyPath.split('.');
    let obj = this.config;
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (typeof obj[keys[i]] !== 'object' || obj[keys[i]] === null) {
        obj[keys[i]] = {};
      }
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
  }

  getThreshold(name) {
    return this.config.thresholds[name];
  }

  getModuleConfig(moduleName) {
    return this.config.modules[moduleName] || {};
  }

  getSuite(suiteName) {
    // 'smart' is dynamically computed in GateTest.runSuite() via smart-suite-selector.
    // If someone calls getSuite('smart') directly (not via runSuite), fall back to quick
    // as the safe baseline — all baseline modules (syntax, secrets, memory) are in quick.
    if (suiteName === 'smart') return this.config.suites.quick;
    return this.config.suites[suiteName] || this.config.suites.standard;
  }

  /**
   * What this suite deliberately does NOT run, and where it runs instead.
   * Always an array (empty for suites that defer nothing) so callers can
   * render it without a null check. See SUITE_DEFERRALS above.
   */
  getSuiteDeferrals(suiteName) {
    return SUITE_DEFERRALS[suiteName] || [];
  }

  save() {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }
}

module.exports = { GateTestConfig, DEFAULT_CONFIG, SUITE_DEFERRALS };
