/**
 * CI Doctor — fix recipe library.
 *
 * Each recipe takes a classification finding (from failure-classifier.js)
 * and a workspace root. It returns a `FixProposal`:
 *
 *   {
 *     class: string,             // matches the classification class
 *     description: string,       // one-liner for the PR commit message
 *     confidence: "high"|"medium"|"low",
 *     fileEdits: Array<{
 *       path: string,            // workspace-relative
 *       findRegex: RegExp,       // pattern to match (multiline)
 *       replace: string,         // replacement (supports $1, $2 capture refs)
 *       skipIfPresent?: RegExp,  // skip the edit if this pattern already exists
 *     }>,
 *     commands: Array<{
 *       cmd: string,             // command string
 *       cwd: string,             // workspace-relative
 *       expectedExitCode?: number, // default 0
 *     }>,
 *     commitMessage: string,     // suggested git commit
 *     requiresHumanReview: boolean, // some fixes (e.g. action SHA bumps) need eyes
 *   }
 *
 * Or returns `null` when the classifier got it right but the recipe
 * cannot synthesise a fix from the available context (e.g. "action
 * version broken" but the classifier didn't capture the action name).
 *
 * Design constraints:
 *
 *   - Recipes are PURE LOGIC. They build proposals; they do not touch
 *     the filesystem, run commands, or open PRs. v0.3 is the applier.
 *
 *   - Idempotency. Every recipe checks `skipIfPresent` so re-running
 *     after a successful fix is a no-op rather than a duplicate edit.
 *
 *   - Boss-Rule respect. Recipes that would touch secrets, pricing,
 *     or third-party APIs return `requiresHumanReview: true` so the
 *     applier surfaces them to Craig instead of auto-merging.
 *
 *   - Workflow YAML is mutated with line-anchored regex, not a YAML
 *     parser. We avoid a YAML dep until there's a recipe that
 *     genuinely needs semantic-tree mutation (currently none do —
 *     all our recipes are "insert this block before/after that line").
 */

"use strict";

// ---------------------------------------------------------------------------
// Helpers — shared regex shapes for workflow YAML patching
// ---------------------------------------------------------------------------

// Matches a step in a GitHub Actions workflow that runs a given command.
// Captures the indentation of the `- name:` line and the body of the step
// up to (but excluding) the next sibling step.
function matchStepRunning(commandFragment) {
  // (^\s*-\s+name:.*\n) captures the step header; following lines at deeper
  // indent are part of the step; we stop at the next line at the same indent
  // starting with `- ` or at end of file.
  const escaped = commandFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^([ \\t]+)-\\s+name:[^\\n]*\\n(?:\\2[ \\t]+[^\\n]*\\n)*?\\2[ \\t]+run:[^\\n]*${escaped}[^\\n]*\\n)`,
    "m"
  );
}

// ---------------------------------------------------------------------------
// Recipe: node-oom → bump NODE_OPTIONS heap on the failing step
// ---------------------------------------------------------------------------

function recipeNodeOom({ workflowPaths, heapMb = 8192 } = {}) {
  if (!Array.isArray(workflowPaths) || workflowPaths.length === 0) return null;
  const fileEdits = [];
  for (const path of workflowPaths) {
    fileEdits.push({
      path,
      // Find a step that runs "next build" / "npm run build" / "tsc"
      // and inject an env block bumping NODE_OPTIONS. We only patch the
      // FIRST matching step to keep the change surgical.
      findRegex: /^(\s+)-\s+name:[^\n]*[Bb]uild[^\n]*\n(\s+run:[^\n]*\n)/m,
      replace: `$1- name: Build (NODE_OPTIONS bumped by CI Doctor)\n$1  env:\n$1    NODE_OPTIONS: --max-old-space-size=${heapMb}\n$2`,
      skipIfPresent: /NODE_OPTIONS:\s*--max-old-space-size=\d+/,
    });
  }
  return {
    class: "node-oom",
    description: `Bump NODE_OPTIONS heap to ${heapMb}MB on the build step`,
    confidence: "high",
    fileEdits,
    commands: [],
    commitMessage: `fix(ci): bump NODE_OPTIONS heap to ${heapMb}MB to resolve OOM`,
    requiresHumanReview: false,
  };
}

// ---------------------------------------------------------------------------
// Recipe: runner-timeout → bump timeout-minutes on the failing job
// ---------------------------------------------------------------------------

function recipeRunnerTimeoutExtend({ workflowPaths, jobName, newMinutes = 60 } = {}) {
  if (!Array.isArray(workflowPaths) || workflowPaths.length === 0) return null;
  if (!jobName) return null;
  const fileEdits = [];
  for (const path of workflowPaths) {
    fileEdits.push({
      path,
      // Find the named job and either bump an existing timeout-minutes or
      // insert one after the `runs-on:` line.
      findRegex: new RegExp(
        `(^[ \\t]+${jobName}:\\s*\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+runs-on:[^\\n]*\\n)`,
        "m"
      ),
      replace: `$1    timeout-minutes: ${newMinutes}\n`,
      skipIfPresent: new RegExp(`${jobName}:[\\s\\S]+?timeout-minutes:`, "m"),
    });
  }
  return {
    class: "runner-timeout",
    description: `Extend timeout-minutes on job '${jobName}' to ${newMinutes}`,
    confidence: "medium",
    fileEdits,
    commands: [],
    commitMessage: `fix(ci): extend ${jobName} timeout to ${newMinutes} minutes`,
    requiresHumanReview: false,
  };
}

// ---------------------------------------------------------------------------
// Recipe: github-token-permissions → add permissions block
// ---------------------------------------------------------------------------

function recipeGithubTokenPermissions({ workflowPaths, jobName, scopes } = {}) {
  if (!Array.isArray(workflowPaths) || workflowPaths.length === 0) return null;
  if (!jobName || !scopes || typeof scopes !== "object") return null;
  const scopeLines = Object.entries(scopes)
    .map(([k, v]) => `      ${k}: ${v}`)
    .join("\n");
  const fileEdits = [];
  for (const path of workflowPaths) {
    fileEdits.push({
      path,
      // Insert a `permissions:` block after `runs-on:` on the named job
      findRegex: new RegExp(
        `(^[ \\t]+${jobName}:\\s*\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+runs-on:[^\\n]*\\n)`,
        "m"
      ),
      replace: `$1    permissions:\n${scopeLines}\n`,
      skipIfPresent: new RegExp(`${jobName}:[\\s\\S]+?permissions:`, "m"),
    });
  }
  return {
    class: "github-token-permissions",
    description: `Add GITHUB_TOKEN permissions to job '${jobName}': ${Object.keys(scopes).join(", ")}`,
    confidence: "high",
    fileEdits,
    commands: [],
    commitMessage: `fix(ci): grant ${jobName} the GITHUB_TOKEN scopes it needs`,
    requiresHumanReview: false,
  };
}

// ---------------------------------------------------------------------------
// Recipe: ci-disk-full → add a cache-pruning step early in the job
// ---------------------------------------------------------------------------

function recipeDiskFullPrune({ workflowPaths, jobName } = {}) {
  if (!Array.isArray(workflowPaths) || workflowPaths.length === 0) return null;
  if (!jobName) return null;
  const pruneStep = [
    "      - name: Free disk space (CI Doctor)",
    "        run: |",
    "          sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc",
    "          sudo rm -rf /opt/hostedtoolcache",
    "          docker system prune -a -f >/dev/null 2>&1 || true",
  ].join("\n");
  const fileEdits = [];
  for (const path of workflowPaths) {
    fileEdits.push({
      path,
      // Insert the pruning step at the top of the named job's `steps:` list
      findRegex: new RegExp(
        `(^[ \\t]+${jobName}:\\s*\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+steps:\\s*\\n)`,
        "m"
      ),
      replace: `$1${pruneStep}\n`,
      skipIfPresent: /Free disk space \(CI Doctor\)/,
    });
  }
  return {
    class: "ci-disk-full",
    description: `Add early disk-pruning step to job '${jobName}'`,
    confidence: "high",
    fileEdits,
    commands: [],
    commitMessage: `fix(ci): prune disk early in ${jobName} to avoid ENOSPC`,
    requiresHumanReview: false,
  };
}

// ---------------------------------------------------------------------------
// Recipe: next-build-cache-stale → add `rm -rf .next` before the build step
// ---------------------------------------------------------------------------

function recipeNextCacheStale({ workflowPaths } = {}) {
  if (!Array.isArray(workflowPaths) || workflowPaths.length === 0) return null;
  const clearStep = [
    "      - name: Clear stale Next.js build cache (CI Doctor)",
    "        run: rm -rf .next",
  ].join("\n");
  const fileEdits = [];
  for (const path of workflowPaths) {
    fileEdits.push({
      path,
      // Insert the clear step just before the next build step
      findRegex: /^(\s+)(-\s+name:[^\n]*[Bb]uild[^\n]*\n\s+run:[^\n]*next build[^\n]*\n)/m,
      replace: `${clearStep}\n$1$2`,
      skipIfPresent: /Clear stale Next\.js build cache \(CI Doctor\)/,
    });
  }
  return {
    class: "next-build-cache-stale",
    description: "Clear .next/ directory before next build to avoid stale cache",
    confidence: "medium",
    fileEdits,
    commands: [],
    commitMessage: "fix(ci): clear stale .next cache before build",
    requiresHumanReview: false,
  };
}

// ---------------------------------------------------------------------------
// Recipe: dep-lockfile-drift → regenerate lockfile
// ---------------------------------------------------------------------------

function recipeLockfileDrift({ workspaceRoot, packageManager = "npm" } = {}) {
  if (!workspaceRoot) return null;
  const cmd =
    packageManager === "pnpm" ? "pnpm install --lockfile-only"
    : packageManager === "yarn" ? "yarn install --mode update-lockfile"
    : "npm install --package-lock-only";
  return {
    class: "dep-lockfile-drift",
    description: `Regenerate ${packageManager} lockfile to match package.json`,
    confidence: "high",
    fileEdits: [],
    commands: [
      { cmd, cwd: workspaceRoot, expectedExitCode: 0 },
    ],
    commitMessage: `fix(deps): regenerate lockfile after package.json drift`,
    requiresHumanReview: false,
  };
}

// ---------------------------------------------------------------------------
// Recipe: lint-error → run eslint --fix and prettier --write
// ---------------------------------------------------------------------------

function recipeLintAutoFix({ workspaceRoot, hasEslint = true, hasPrettier = true } = {}) {
  if (!workspaceRoot) return null;
  const commands = [];
  if (hasEslint) {
    commands.push({ cmd: "npx eslint . --fix", cwd: workspaceRoot, expectedExitCode: 0 });
  }
  if (hasPrettier) {
    commands.push({ cmd: "npx prettier --write .", cwd: workspaceRoot, expectedExitCode: 0 });
  }
  if (commands.length === 0) return null;
  return {
    class: "lint-error",
    description: "Run ESLint --fix and prettier --write to resolve auto-fixable lint issues",
    confidence: "high",
    fileEdits: [],
    commands,
    commitMessage: "fix(lint): apply eslint --fix and prettier --write",
    requiresHumanReview: false,
  };
}

// ---------------------------------------------------------------------------
// Recipe: test-snapshot-mismatch → update snapshots
// ---------------------------------------------------------------------------

function recipeSnapshotUpdate({ workspaceRoot, testRunner = "vitest" } = {}) {
  if (!workspaceRoot) return null;
  const cmd =
    testRunner === "jest" ? "npx jest -u"
    : testRunner === "ava" ? "npx ava --update-snapshots"
    : "npx vitest run -u";
  return {
    class: "test-snapshot-mismatch",
    description: `Update ${testRunner} snapshots — REQUIRES human review of the diff`,
    confidence: "medium",
    fileEdits: [],
    commands: [
      { cmd, cwd: workspaceRoot, expectedExitCode: 0 },
    ],
    commitMessage: "test: update snapshots",
    // Snapshot updates can silently bless a real regression — never
    // auto-merge. Surface the diff for human review.
    requiresHumanReview: true,
  };
}

// ---------------------------------------------------------------------------
// Recipe: action-version-broken → bump action ref to a known-good version
// ---------------------------------------------------------------------------

const KNOWN_GOOD_ACTIONS = {
  "actions/checkout": "v4",
  "actions/setup-node": "v4",
  "actions/setup-python": "v5",
  "actions/setup-go": "v5",
  "actions/cache": "v4",
  "actions/upload-artifact": "v4",
  "actions/download-artifact": "v4",
  "github/codeql-action/upload-sarif": "v3",
  "github/codeql-action/init": "v3",
  "github/codeql-action/analyze": "v3",
  "docker/setup-buildx-action": "v3",
  "docker/build-push-action": "v6",
  "docker/login-action": "v3",
};

function recipeActionVersionBump({ workflowPaths, actionName } = {}) {
  if (!Array.isArray(workflowPaths) || workflowPaths.length === 0) return null;
  if (!actionName || !KNOWN_GOOD_ACTIONS[actionName]) return null;
  const ref = KNOWN_GOOD_ACTIONS[actionName];
  const fileEdits = [];
  const escaped = actionName.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  for (const path of workflowPaths) {
    fileEdits.push({
      path,
      findRegex: new RegExp(`uses:\\s*${escaped}@[^\\s\\n]+`, "g"),
      replace: `uses: ${actionName}@${ref}`,
      skipIfPresent: new RegExp(`uses:\\s*${escaped}@${ref}(?!\\S)`),
    });
  }
  return {
    class: "action-version-broken",
    description: `Bump ${actionName} to known-good ${ref}`,
    confidence: "medium",
    fileEdits,
    commands: [],
    commitMessage: `fix(ci): bump ${actionName} to ${ref}`,
    requiresHumanReview: true, // action upgrades can change behaviour
  };
}

// ---------------------------------------------------------------------------
// Recipe registry — class → recipe builder
// ---------------------------------------------------------------------------

const RECIPE_REGISTRY = {
  "node-oom": recipeNodeOom,
  "runner-timeout": recipeRunnerTimeoutExtend,
  "github-token-permissions": recipeGithubTokenPermissions,
  "ci-disk-full": recipeDiskFullPrune,
  "next-build-cache-stale": recipeNextCacheStale,
  "dep-lockfile-drift": recipeLockfileDrift,
  "lint-error": recipeLintAutoFix,
  "test-snapshot-mismatch": recipeSnapshotUpdate,
  "action-version-broken": recipeActionVersionBump,
};

/**
 * Look up the recipe for a given failure class.
 *
 * @param {string} className
 * @returns {function|null}
 */
function getRecipe(className) {
  return RECIPE_REGISTRY[className] || null;
}

/**
 * Build a fix proposal for a classification finding, given a context.
 *
 * @param {object} finding   from classifyCIFailures()
 * @param {object} context   shared context for all recipes
 * @returns {object|null}    FixProposal or null
 */
function proposeFixForFinding(finding, context = {}) {
  if (!finding || !finding.autoFixable) return null;
  const builder = getRecipe(finding.class);
  if (!builder) return null;
  try {
    return builder(context);
  } catch {
    return null;
  }
}

module.exports = {
  recipeNodeOom,
  recipeRunnerTimeoutExtend,
  recipeGithubTokenPermissions,
  recipeDiskFullPrune,
  recipeNextCacheStale,
  recipeLockfileDrift,
  recipeLintAutoFix,
  recipeSnapshotUpdate,
  recipeActionVersionBump,
  RECIPE_REGISTRY,
  KNOWN_GOOD_ACTIONS,
  getRecipe,
  proposeFixForFinding,
  // Exported for tests
  matchStepRunning,
};
