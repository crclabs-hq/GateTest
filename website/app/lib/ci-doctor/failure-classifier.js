/**
 * CI Doctor — failure classifier.
 *
 * Craig 2026-05-29: "we need to be the mastermind behind CI, we need to
 * study it, know how it works, even read the code to make sure that we
 * can fix everything that needs fixing. We can't be a blocker for
 * customers."
 *
 * This module is the foundation. It reads raw CI log text (from GitHub
 * Actions, GitLab CI, Vercel, CircleCI — anything that produces a text
 * log) and returns the structured failure classifications it can
 * recognise. Each classification carries an `autoFixable` flag and a
 * `suggestedFix` so the orchestrator (next file in this directory) can
 * actually apply the fix and re-trigger CI.
 *
 * The classifier is pure logic — no network calls, no file I/O. That
 * makes it trivial to unit-test against fixture logs and trivial to
 * extend by adding entries to the RULES array.
 *
 * Confidence levels:
 *   - "high"   — pattern is unambiguous (exit code 137 = OOM, etc.)
 *   - "medium" — pattern is strong but context-dependent
 *   - "low"    — pattern is suggestive; the orchestrator should verify
 *
 * autoFixable:
 *   - true  — we have a known recipe to fix this class
 *   - false — needs human review (e.g. genuine logic test failure)
 *
 * Conservative bias: when in doubt, classify as `low` confidence and
 * mark non-auto-fixable. False positives are worse than missing a class
 * because they waste an auto-fix attempt and erode customer trust.
 */

"use strict";

/**
 * Each rule is matched against the FULL log text. When a rule matches,
 * we emit a finding with the matched line number for traceability.
 *
 * Order matters slightly: when two rules could fire on the same line we
 * prefer the more specific one (e.g. exit-137-OOM beats generic process-killed).
 * The classifier handles this by checking `priority` (higher wins per line).
 */
const RULES = [
  // ---------------------------------------------------------------------
  // Dependency / install failures
  // ---------------------------------------------------------------------
  {
    class: "dep-lockfile-drift",
    priority: 95,
    confidence: "high",
    autoFixable: true,
    patterns: [
      /npm error code EUSAGE/i,
      /npm error.*lock file/i,
      /package-lock\.json.*out of (sync|date)/i,
      /lockfile.*needs to be updated/i,
      /pnpm-lock\.yaml is not up to date/i,
      /yarn\.lock.*does not match/i,
    ],
    suggestedFix:
      "Run `npm install` (or `pnpm install` / `yarn install`) locally and commit the regenerated lockfile. CI runs in `--frozen-lockfile` / `npm ci` mode, which rejects any drift between manifest and lockfile.",
  },
  {
    class: "dep-network-blip",
    priority: 90,
    confidence: "high",
    autoFixable: true,
    patterns: [
      /ETIMEDOUT.*registry\.npmjs\.org/i,
      /ENOTFOUND.*registry\.npmjs\.org/i,
      /connect ECONNREFUSED.*registry/i,
      /Cannot connect to.*registry/i,
      /503 Service Unavailable.*npm/i,
      /Could not resolve host: registry/i,
      /\bECONNRESET\b.*npm/i,
    ],
    suggestedFix:
      "Transient network blip to the package registry. Auto-fix: re-run the workflow with retry. Permanent fix: add a 3-attempt retry-with-backoff wrapper around `npm install` in the workflow (see `scripts/install-workspaces.sh` for the canonical pattern).",
  },
  {
    class: "dep-peer-conflict",
    priority: 85,
    confidence: "medium",
    autoFixable: false,
    patterns: [
      /npm ERR! peer dep missing/i,
      /could not resolve dependency/i,
      /npm error ERESOLVE/i,
      /unable to resolve dependency tree/i,
    ],
    suggestedFix:
      "Peer dependency conflict. Investigate which package introduced the conflict (often a major-version bump). Options: pin the conflicting package to a compatible range, add a `overrides` block to package.json, or upgrade the consumer to match the new peer range.",
  },
  {
    class: "dep-native-build-fail",
    priority: 80,
    confidence: "medium",
    autoFixable: false,
    patterns: [
      /node-gyp.*failed/i,
      /gyp ERR!/i,
      /cannot find module.*sharp/i,
      /libvips.*not found/i,
      /Python.*not found.*gyp/i,
      /MSBuild.*not found/i,
    ],
    suggestedFix:
      "Native module build failure (often sharp / canvas / sqlite3 / bcrypt). Common fixes: install platform-specific build tooling (python3, make, g++ on Linux; xcode-select on macOS), or switch to a prebuilt alternative (e.g. `@img/sharp-linux-x64`).",
  },

  // ---------------------------------------------------------------------
  // Build / compile failures
  // ---------------------------------------------------------------------
  {
    class: "typescript-error",
    priority: 95,
    confidence: "high",
    autoFixable: true,
    patterns: [
      /error TS\d{4}:/,
      /Found \d+ error[s]? in \d+ file[s]?/i,
    ],
    suggestedFix:
      "TypeScript compile error. Auto-fix: run the AI fix loop on the specific files reported (`gatetest --fix --module typescriptStrictness`). Common shapes: implicit-any after dep upgrade, missing type imports, strict-null violations on a freshly-introduced optional.",
  },
  {
    class: "node-oom",
    priority: 99,
    confidence: "high",
    autoFixable: true,
    patterns: [
      /JavaScript heap out of memory/i,
      /FATAL ERROR.*Mark-Compact/i,
      /Allocation failed.*heap/i,
      /process.exit\(137\)/,
      /exit code 137/,
    ],
    suggestedFix:
      "Node ran out of memory. Auto-fix: add `NODE_OPTIONS: --max-old-space-size=4096` (or 8192) to the failing step's `env` block. Permanent fix: investigate whether the build can be split (turbopack / webpack worker / next build with `experimental.workerThreads`).",
  },
  {
    class: "next-build-cache-stale",
    priority: 80,
    confidence: "medium",
    autoFixable: true,
    patterns: [
      /Cannot find module.*\.next\//i,
      /ENOENT.*\.next\/server\//i,
      /Module not found.*after.*install/i,
    ],
    suggestedFix:
      "Next.js build cache appears stale or partially copied. Auto-fix: add a `rm -rf .next` step before `next build` in the workflow, or invalidate the cache key in the `actions/cache` step (bump a version suffix in the key).",
  },
  {
    class: "missing-env-var",
    priority: 90,
    confidence: "high",
    autoFixable: false, // Adding a real env var requires Craig's auth (Boss Rule #2 / #6)
    patterns: [
      /process\.env\.([A-Z_]+) is undefined/,
      /Required environment variable (\w+) is not set/i,
      /Missing.*environment variable[: ]+(\w+)/i,
      /Cannot read.*env\.(\w+)/i,
    ],
    suggestedFix:
      "A required environment variable is missing. We do NOT auto-add env vars — touching secrets / config is Boss Rule territory. Action: surface the missing variable name to the operator and offer to draft the workflow `env:` block addition for review.",
  },

  // ---------------------------------------------------------------------
  // Test failures
  // ---------------------------------------------------------------------
  {
    class: "test-failure",
    priority: 90,
    confidence: "medium",
    autoFixable: true,
    patterns: [
      /\bAssertionError\b/,
      /(\d+) test[s]? failed/i,
      /FAIL\s+(src|tests|__tests__|spec)\//,
      /Test Suites: \d+ failed/i,
      /# fail (?!0\b)\d+/, // node:test summary "# fail N" where N != 0
    ],
    suggestedFix:
      "Test failure. Auto-fix: run the AI fix loop on the failing test file + the source under test. If a test is genuinely catching a real regression, the loop produces a code fix rather than weakening the test.",
  },
  {
    class: "test-snapshot-mismatch",
    priority: 92,
    confidence: "high",
    autoFixable: true,
    patterns: [
      /Snapshot[s]? failed/i,
      /\d+ snapshot[s]? obsolete/i,
      /Snapshot name:/,
    ],
    suggestedFix:
      "Snapshot mismatch. Auto-fix: re-run with snapshot update flag (`vitest -u` / `jest -u`) and commit the updated snapshots, BUT only after AI review of the diff to ensure the new snapshot isn't masking a real regression.",
  },
  {
    class: "test-flaky-timer",
    priority: 70,
    confidence: "low",
    autoFixable: true,
    patterns: [
      /Test timed out in \d+ms/i,
      /Timeout - Async callback was not invoked/i,
      /Exceeded timeout of \d+ms/i,
    ],
    suggestedFix:
      "Test timeout — usually a flaky test relying on real timers or unmocked network. Auto-fix: add `vi.useFakeTimers()` / `jest.useFakeTimers()` to the test setup, or mock the slow dependency. Don't simply bump the timeout — that hides the real issue.",
  },

  // ---------------------------------------------------------------------
  // Lint / formatter
  // ---------------------------------------------------------------------
  {
    class: "lint-error",
    priority: 80,
    confidence: "high",
    autoFixable: true,
    patterns: [
      /\d+ problem[s]? \(\d+ error[s]?,/i,
      /eslint.*exited with code [1-9]/i,
      /prettier --check.*failed/i,
      /Code style issues found/i,
    ],
    suggestedFix:
      "Lint / format error. Auto-fix: run `eslint --fix` and `prettier --write` then commit. Most lint rule violations are mechanically fixable; the few that aren't (e.g. `no-unused-vars` on a hard-to-resolve case) get the AI fix loop.",
  },

  // ---------------------------------------------------------------------
  // CI infrastructure failures (not the code's fault)
  // ---------------------------------------------------------------------
  {
    class: "runner-timeout",
    priority: 99,
    confidence: "high",
    autoFixable: true,
    patterns: [
      /The job .*exceeded the maximum execution time/i,
      /Operation timed out/i,
      /Hosted runner.*timeout/i,
      /Job timed out after/i,
    ],
    suggestedFix:
      "Workflow exceeded the runner timeout. Auto-fix: bump the `timeout-minutes` on the slow job. Investigate: which step is slow? Common culprits: unbounded test loop, unfinished crawler, OOM-then-swap thrashing.",
  },
  {
    class: "runner-lost-connection",
    priority: 99,
    confidence: "high",
    autoFixable: true,
    patterns: [
      /lost communication with the server/i,
      /The runner has received a shutdown signal/i,
      /Connection reset.*runner/i,
    ],
    suggestedFix:
      "Runner infrastructure issue, not the code. Auto-fix: re-trigger the workflow. If it recurs three times in a row, investigate runner health or switch to a different runner image.",
  },
  {
    class: "ci-disk-full",
    priority: 95,
    confidence: "high",
    autoFixable: true,
    patterns: [
      /No space left on device/i,
      /\bENOSPC\b/,
      /disk quota exceeded/i,
    ],
    suggestedFix:
      "CI runner ran out of disk. Auto-fix: add an early step that prunes `/tmp`, `~/.cache`, `node_modules/.cache`, and `~/.npm/_cacache`. Vercel-specific: enable the `nodeModulesCache` setting OR exclude large dev-only deps from the install.",
  },

  // ---------------------------------------------------------------------
  // GitHub Actions specific
  // ---------------------------------------------------------------------
  {
    class: "action-version-broken",
    priority: 90,
    confidence: "medium",
    autoFixable: true,
    patterns: [
      /Cannot find action/i,
      /does not exist on the marketplace/i,
      /The action.*was not found/i,
      /Unable to resolve action/i,
    ],
    suggestedFix:
      "A referenced action is missing or its ref is broken. Auto-fix: bump the action to its latest stable major (`actions/checkout@v4` etc.) and commit. Best practice: pin to SHA, not tag, so this can't happen via a silent tag move.",
  },
  {
    class: "github-token-permissions",
    priority: 88,
    confidence: "high",
    autoFixable: true,
    patterns: [
      /Resource not accessible by integration/i,
      /Permission to .* denied/i,
      /403.*GitHub.*token/i,
      /\bGITHUB_TOKEN\b.*permission/i,
    ],
    suggestedFix:
      "GITHUB_TOKEN lacks the scope a step requires. Auto-fix: add a `permissions:` block to the workflow (or the failing job) that grants the missing scope (e.g. `pull-requests: write`, `contents: write`, `security-events: write`). Bias toward job-level permissions over workflow-level.",
  },
  {
    class: "git-push-rejected",
    priority: 85,
    confidence: "high",
    autoFixable: false, // pushing to a branch needs caller intent
    patterns: [
      /\[rejected\].*non-fast-forward/i,
      /Updates were rejected because the remote contains work/i,
      /failed to push some refs/i,
    ],
    suggestedFix:
      "Push rejected — usually because the branch moved between checkout and push. Investigate: was there a parallel commit? Auto-fix candidates: rebase + force-push-with-lease, OR open the change as a PR instead of pushing to a shared branch.",
  },

  // ---------------------------------------------------------------------
  // Vercel-specific
  // ---------------------------------------------------------------------
  {
    class: "vercel-function-too-large",
    priority: 90,
    confidence: "high",
    autoFixable: false, // needs architectural review
    patterns: [
      /Function.*size exceeds/i,
      /Serverless Function.*exceeds.*limit/i,
      /Function size.*exceed/i,
      /Serverless Function.*too large/i,
      /Function.*exceeds.*compressed/i,
    ],
    suggestedFix:
      "Serverless function exceeds Vercel's size limit (50MB compressed). Investigate: which deps are huge? `next-bundle-analyzer` or `du -sh node_modules/* | sort -h` finds the culprit. Common fixes: dynamic-import heavy deps, split the function, externalise the dep to an Edge Function with smaller runtime.",
  },
  {
    class: "vercel-build-fail",
    priority: 80,
    confidence: "medium",
    autoFixable: false,
    patterns: [
      /Build Failed.*vercel/i,
      /Error: Command "npm run build" exited with/i,
      /vercel build.*failed/i,
    ],
    suggestedFix:
      "Vercel build script failed. Read the lines immediately preceding this one — they contain the underlying error (TypeScript / missing env var / OOM). Re-classify against those patterns.",
  },
];

/**
 * Classify a CI log into one or more failure findings.
 *
 * @param {string} logText  raw CI log (UTF-8)
 * @returns {Array<{
 *   class: string,
 *   confidence: "high" | "medium" | "low",
 *   autoFixable: boolean,
 *   evidence: string,
 *   lineNumber: number,
 *   suggestedFix: string,
 * }>}  sorted by (priority desc, lineNumber asc), de-duplicated by class
 */
function classifyCIFailures(logText) {
  if (typeof logText !== "string" || logText.length === 0) return [];

  const lines = logText.split(/\r?\n/);
  const findings = [];
  const seenClasses = new Set();

  // Track per-line best match (priority-resolved) to avoid double-counting
  // a single line under multiple loose patterns.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let bestForLine = null;
    for (const rule of RULES) {
      for (const re of rule.patterns) {
        if (re.test(line)) {
          if (!bestForLine || rule.priority > bestForLine.priority) {
            bestForLine = { rule, matchedRegex: re };
          }
          break; // first matching pattern in this rule is enough
        }
      }
    }
    if (bestForLine && !seenClasses.has(bestForLine.rule.class)) {
      seenClasses.add(bestForLine.rule.class);
      findings.push({
        class: bestForLine.rule.class,
        confidence: bestForLine.rule.confidence,
        autoFixable: bestForLine.rule.autoFixable,
        evidence: line.slice(0, 300),
        lineNumber: i + 1,
        suggestedFix: bestForLine.rule.suggestedFix,
        priority: bestForLine.rule.priority,
      });
    }
  }

  // Sort by priority desc, then by line number asc
  findings.sort((a, b) => b.priority - a.priority || a.lineNumber - b.lineNumber);
  // Drop the internal priority field from public output
  return findings.map(({ priority: _priority, ...rest }) => rest);
}

/**
 * Convenience: get just the top finding (highest priority, earliest line).
 *
 * @param {string} logText
 * @returns {object|null}
 */
function topFailure(logText) {
  const all = classifyCIFailures(logText);
  return all.length > 0 ? all[0] : null;
}

/**
 * The list of failure classes the doctor knows. Useful for docs / UI.
 *
 * @returns {Array<string>}
 */
function knownClasses() {
  return RULES.map((r) => r.class);
}

module.exports = {
  classifyCIFailures,
  topFailure,
  knownClasses,
  // Exported for tests / external rule extension
  RULES,
};
