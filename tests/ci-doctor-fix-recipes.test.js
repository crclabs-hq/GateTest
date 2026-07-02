"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
} = require("../website/app/lib/ci-doctor/fix-recipes.js");

// Helper — apply a FixProposal's first fileEdit to a sample yaml and
// return what the patched yaml looks like. Mirrors what the (future)
// applier will do.
function applyFirstEdit(proposal, yaml) {
  const edit = proposal.fileEdits[0];
  if (edit.skipIfPresent && edit.skipIfPresent.test(yaml)) return yaml; // no-op
  return yaml.replace(edit.findRegex, edit.replace);
}

// ---------------------------------------------------------------------------
// Shape / registry
// ---------------------------------------------------------------------------

test("RECIPE_REGISTRY: maps every known autoFixable class", () => {
  const expected = [
    "node-oom",
    "runner-timeout",
    "github-token-permissions",
    "ci-disk-full",
    "next-build-cache-stale",
    "dep-lockfile-drift",
    "lint-error",
    "test-snapshot-mismatch",
    "action-version-broken",
  ];
  for (const cls of expected) {
    assert.equal(typeof RECIPE_REGISTRY[cls], "function", `missing recipe: ${cls}`);
    assert.equal(typeof getRecipe(cls), "function");
  }
});

test("getRecipe: unknown class → null", () => {
  assert.equal(getRecipe("non-existent"), null);
  assert.equal(getRecipe(""), null);
});

test("proposeFixForFinding: returns null when finding is not autoFixable", () => {
  const finding = { class: "node-oom", autoFixable: false };
  assert.equal(proposeFixForFinding(finding, { workflowPaths: [".github/workflows/ci.yml"] }), null);
});

test("proposeFixForFinding: returns null when finding is null", () => {
  assert.equal(proposeFixForFinding(null, {}), null);
});

test("proposeFixForFinding: returns proposal when class + context are good", () => {
  const finding = { class: "node-oom", autoFixable: true };
  const p = proposeFixForFinding(finding, { workflowPaths: [".github/workflows/ci.yml"] });
  assert.ok(p);
  assert.equal(p.class, "node-oom");
});

// ---------------------------------------------------------------------------
// node-oom
// ---------------------------------------------------------------------------

test("recipeNodeOom: patches a build step with NODE_OPTIONS", () => {
  const yaml = [
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Checkout",
    "        uses: actions/checkout@v4",
    "      - name: Build",
    "        run: npm run build",
    "",
  ].join("\n");
  const p = recipeNodeOom({ workflowPaths: [".github/workflows/ci.yml"] });
  const patched = applyFirstEdit(p, yaml);
  assert.match(patched, /NODE_OPTIONS: --max-old-space-size=8192/);
  assert.match(patched, /\(NODE_OPTIONS bumped by CI Doctor\)/);
});

test("recipeNodeOom: heap override is honoured", () => {
  const yaml = "      - name: Build\n        run: next build\n";
  const p = recipeNodeOom({ workflowPaths: [".github/workflows/ci.yml"], heapMb: 4096 });
  const patched = applyFirstEdit(p, yaml);
  assert.match(patched, /--max-old-space-size=4096/);
});

test("recipeNodeOom: idempotent — already-patched yaml is unchanged", () => {
  const yaml = [
    "      - name: Build",
    "        env:",
    "          NODE_OPTIONS: --max-old-space-size=8192",
    "        run: npm run build",
  ].join("\n");
  const p = recipeNodeOom({ workflowPaths: [".github/workflows/ci.yml"] });
  const patched = applyFirstEdit(p, yaml);
  assert.equal(patched, yaml);
});

test("recipeNodeOom: returns null without workflowPaths", () => {
  assert.equal(recipeNodeOom({}), null);
  assert.equal(recipeNodeOom(), null);
  assert.equal(recipeNodeOom({ workflowPaths: [] }), null);
});

// ---------------------------------------------------------------------------
// runner-timeout
// ---------------------------------------------------------------------------

test("recipeRunnerTimeoutExtend: inserts timeout-minutes on the named job", () => {
  const yaml = [
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm test",
  ].join("\n");
  const p = recipeRunnerTimeoutExtend({
    workflowPaths: [".github/workflows/ci.yml"],
    jobName: "test",
    newMinutes: 30,
  });
  const patched = applyFirstEdit(p, yaml);
  assert.match(patched, /timeout-minutes: 30/);
});

test("recipeRunnerTimeoutExtend: idempotent when timeout already set", () => {
  const yaml = [
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 60",
    "    steps:",
    "      - run: npm test",
  ].join("\n");
  const p = recipeRunnerTimeoutExtend({
    workflowPaths: [".github/workflows/ci.yml"],
    jobName: "test",
  });
  const patched = applyFirstEdit(p, yaml);
  assert.equal(patched, yaml);
});

test("recipeRunnerTimeoutExtend: returns null without jobName", () => {
  assert.equal(recipeRunnerTimeoutExtend({ workflowPaths: [".github/workflows/ci.yml"] }), null);
});

// ---------------------------------------------------------------------------
// github-token-permissions
// ---------------------------------------------------------------------------

test("recipeGithubTokenPermissions: adds a permissions block", () => {
  const yaml = [
    "jobs:",
    "  release:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
  ].join("\n");
  const p = recipeGithubTokenPermissions({
    workflowPaths: [".github/workflows/ci.yml"],
    jobName: "release",
    scopes: { contents: "write", "pull-requests": "write" },
  });
  const patched = applyFirstEdit(p, yaml);
  assert.match(patched, /permissions:/);
  assert.match(patched, /contents: write/);
  assert.match(patched, /pull-requests: write/);
});

test("recipeGithubTokenPermissions: idempotent", () => {
  const yaml = [
    "jobs:",
    "  release:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "    steps:",
    "      - uses: actions/checkout@v4",
  ].join("\n");
  const p = recipeGithubTokenPermissions({
    workflowPaths: [".github/workflows/ci.yml"],
    jobName: "release",
    scopes: { contents: "write" },
  });
  const patched = applyFirstEdit(p, yaml);
  assert.equal(patched, yaml);
});

test("recipeGithubTokenPermissions: returns null without scopes", () => {
  assert.equal(
    recipeGithubTokenPermissions({
      workflowPaths: [".github/workflows/ci.yml"],
      jobName: "release",
    }),
    null
  );
});

// ---------------------------------------------------------------------------
// ci-disk-full
// ---------------------------------------------------------------------------

test("recipeDiskFullPrune: inserts pruning step at top of job steps", () => {
  const yaml = [
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
  ].join("\n");
  const p = recipeDiskFullPrune({
    workflowPaths: [".github/workflows/ci.yml"],
    jobName: "build",
  });
  const patched = applyFirstEdit(p, yaml);
  assert.match(patched, /Free disk space \(CI Doctor\)/);
  assert.match(patched, /docker system prune/);
});

test("recipeDiskFullPrune: idempotent", () => {
  const yaml = [
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Free disk space (CI Doctor)",
    "        run: |",
    "          sudo rm -rf /usr/share/dotnet",
  ].join("\n");
  const p = recipeDiskFullPrune({
    workflowPaths: [".github/workflows/ci.yml"],
    jobName: "build",
  });
  const patched = applyFirstEdit(p, yaml);
  assert.equal(patched, yaml);
});

// ---------------------------------------------------------------------------
// next-build-cache-stale
// ---------------------------------------------------------------------------

test("recipeNextCacheStale: inserts rm -rf .next before next build", () => {
  const yaml = [
    "      - name: Build",
    "        run: next build",
  ].join("\n") + "\n";
  const p = recipeNextCacheStale({ workflowPaths: [".github/workflows/ci.yml"] });
  const patched = applyFirstEdit(p, yaml);
  assert.match(patched, /Clear stale Next\.js build cache \(CI Doctor\)/);
  assert.match(patched, /rm -rf \.next/);
});

// ---------------------------------------------------------------------------
// dep-lockfile-drift
// ---------------------------------------------------------------------------

test("recipeLockfileDrift: produces an npm install command by default", () => {
  const p = recipeLockfileDrift({ workspaceRoot: "/repo" });
  assert.ok(p);
  assert.equal(p.commands.length, 1);
  assert.match(p.commands[0].cmd, /npm install --package-lock-only/);
});

test("recipeLockfileDrift: honours packageManager: pnpm", () => {
  const p = recipeLockfileDrift({ workspaceRoot: "/repo", packageManager: "pnpm" });
  assert.match(p.commands[0].cmd, /pnpm install --lockfile-only/);
});

test("recipeLockfileDrift: honours packageManager: yarn", () => {
  const p = recipeLockfileDrift({ workspaceRoot: "/repo", packageManager: "yarn" });
  assert.match(p.commands[0].cmd, /yarn install/);
});

test("recipeLockfileDrift: requires workspaceRoot", () => {
  assert.equal(recipeLockfileDrift({}), null);
});

// ---------------------------------------------------------------------------
// lint-error
// ---------------------------------------------------------------------------

test("recipeLintAutoFix: runs eslint --fix and prettier --write by default", () => {
  const p = recipeLintAutoFix({ workspaceRoot: "/repo" });
  assert.ok(p);
  assert.equal(p.commands.length, 2);
  assert.match(p.commands[0].cmd, /eslint . --fix/);
  assert.match(p.commands[1].cmd, /prettier --write/);
});

test("recipeLintAutoFix: respects hasEslint / hasPrettier flags", () => {
  const p = recipeLintAutoFix({ workspaceRoot: "/repo", hasPrettier: false });
  assert.equal(p.commands.length, 1);
  assert.match(p.commands[0].cmd, /eslint/);
});

test("recipeLintAutoFix: returns null if both linters are absent", () => {
  assert.equal(
    recipeLintAutoFix({ workspaceRoot: "/repo", hasEslint: false, hasPrettier: false }),
    null
  );
});

// ---------------------------------------------------------------------------
// test-snapshot-mismatch
// ---------------------------------------------------------------------------

test("recipeSnapshotUpdate: ALWAYS sets requiresHumanReview", () => {
  const p = recipeSnapshotUpdate({ workspaceRoot: "/repo" });
  assert.equal(p.requiresHumanReview, true);
});

test("recipeSnapshotUpdate: defaults to vitest -u", () => {
  const p = recipeSnapshotUpdate({ workspaceRoot: "/repo" });
  assert.match(p.commands[0].cmd, /vitest run -u/);
});

test("recipeSnapshotUpdate: honours jest", () => {
  const p = recipeSnapshotUpdate({ workspaceRoot: "/repo", testRunner: "jest" });
  assert.match(p.commands[0].cmd, /jest -u/);
});

// ---------------------------------------------------------------------------
// action-version-broken
// ---------------------------------------------------------------------------

test("recipeActionVersionBump: rewrites action ref to KNOWN_GOOD", () => {
  const yaml = "      - uses: actions/checkout@v99";
  const p = recipeActionVersionBump({
    workflowPaths: [".github/workflows/ci.yml"],
    actionName: "actions/checkout",
  });
  const patched = applyFirstEdit(p, yaml);
  assert.match(patched, new RegExp(`actions/checkout@${KNOWN_GOOD_ACTIONS["actions/checkout"]}\\b`));
});

test("recipeActionVersionBump: idempotent on already-good ref", () => {
  const yaml = "      - uses: actions/checkout@v4";
  const p = recipeActionVersionBump({
    workflowPaths: [".github/workflows/ci.yml"],
    actionName: "actions/checkout",
  });
  const patched = applyFirstEdit(p, yaml);
  assert.equal(patched, yaml);
});

test("recipeActionVersionBump: returns null for unknown action", () => {
  assert.equal(
    recipeActionVersionBump({
      workflowPaths: [".github/workflows/ci.yml"],
      actionName: "third-party/random-action",
    }),
    null
  );
});

test("recipeActionVersionBump: REQUIRES human review (action upgrades can change behaviour)", () => {
  const p = recipeActionVersionBump({
    workflowPaths: [".github/workflows/ci.yml"],
    actionName: "actions/checkout",
  });
  assert.equal(p.requiresHumanReview, true);
});

test("KNOWN_GOOD_ACTIONS: includes the canonical GitHub-published actions", () => {
  // Smoke-test that the static action list is non-empty and includes
  // the actions every node project uses.
  assert.ok(KNOWN_GOOD_ACTIONS["actions/checkout"]);
  assert.ok(KNOWN_GOOD_ACTIONS["actions/setup-node"]);
  assert.ok(KNOWN_GOOD_ACTIONS["actions/cache"]);
  assert.ok(KNOWN_GOOD_ACTIONS["actions/upload-artifact"]);
});

// ---------------------------------------------------------------------------
// End-to-end: classification → proposal
// ---------------------------------------------------------------------------

test("integration: classification → proposeFixForFinding produces a fix", () => {
  // Simulate a classification finding from v0.1
  const finding = {
    class: "node-oom",
    confidence: "high",
    autoFixable: true,
    evidence: "FATAL ERROR: JavaScript heap out of memory",
    lineNumber: 42,
    suggestedFix: "...",
  };
  const proposal = proposeFixForFinding(finding, {
    workflowPaths: [".github/workflows/ci.yml"],
    heapMb: 8192,
  });
  assert.ok(proposal);
  assert.equal(proposal.class, "node-oom");
  assert.equal(proposal.fileEdits.length, 1);
  assert.match(proposal.commitMessage, /NODE_OPTIONS/);
});
