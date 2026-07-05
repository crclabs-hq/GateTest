"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyFixProposal,
  applyEdit,
  validateProposal,
} = require("../website/app/lib/ci-doctor/applier.js");

// ---------------------------------------------------------------------------
// In-memory fs adapter for tests
// ---------------------------------------------------------------------------

function makeFs(initial = {}) {
  // Normalize to forward-slashes so path.join() on Windows doesn't break lookups
  const norm = (p) => p.replace(/\\/g, '/');
  const files = new Map(Object.entries(initial).map(([k, v]) => [norm(k), v]));
  return {
    files,
    existsSync: (p) => files.has(norm(p)),
    readFileSync: (p) => {
      const np = norm(p);
      if (!files.has(np)) {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      }
      return files.get(np);
    },
    writeFileSync: (p, data) => { files.set(norm(p), data); },
  };
}

function makeExec(responses = []) {
  let i = 0;
  const calls = [];
  return {
    calls,
    run: async (cmd, opts) => {
      calls.push({ cmd, cwd: opts.cwd });
      return responses[Math.min(i++, responses.length - 1)] || { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

// ---------------------------------------------------------------------------
// validateProposal
// ---------------------------------------------------------------------------

test("validateProposal: rejects nullish / missing class / wrong arrays", () => {
  assert.equal(validateProposal(null).ok, false);
  assert.equal(validateProposal({}).ok, false);
  assert.equal(validateProposal({ class: "x" }).ok, false);
  assert.equal(validateProposal({ class: "x", fileEdits: [] }).ok, false);
  assert.equal(validateProposal({ class: "x", fileEdits: [], commands: [] }).ok, true);
});

// ---------------------------------------------------------------------------
// applyEdit (unit)
// ---------------------------------------------------------------------------

test("applyEdit: idempotent — skipIfPresent matches → skipped-already-present", () => {
  const fs = makeFs({ "/repo/x.yml": "NODE_OPTIONS: --max-old-space-size=8192" });
  const r = applyEdit({
    edit: {
      path: "x.yml",
      findRegex: /run: build/,
      replace: "run: patched-build",
      skipIfPresent: /NODE_OPTIONS:\s*--max-old-space-size=\d+/,
    },
    workspaceRoot: "/repo",
    fs,
    dryRun: false,
  });
  assert.equal(r.outcome, "skipped-already-present");
});

test("applyEdit: missing file → no-match", () => {
  const fs = makeFs({});
  const r = applyEdit({
    edit: { path: "x.yml", findRegex: /a/, replace: "b" },
    workspaceRoot: "/repo",
    fs,
    dryRun: false,
  });
  assert.equal(r.outcome, "no-match");
  assert.match(r.error, /does not exist/);
});

test("applyEdit: regex doesn't match → no-match (file unchanged)", () => {
  const fs = makeFs({ "/repo/x.yml": "different content" });
  const r = applyEdit({
    edit: { path: "x.yml", findRegex: /not-there/, replace: "X" },
    workspaceRoot: "/repo",
    fs,
    dryRun: false,
  });
  assert.equal(r.outcome, "no-match");
  // File untouched
  assert.equal(fs.files.get("/repo/x.yml"), "different content");
});

test("applyEdit: successful match writes the file", () => {
  const fs = makeFs({ "/repo/x.yml": "OLD" });
  const r = applyEdit({
    edit: { path: "x.yml", findRegex: /OLD/, replace: "NEW" },
    workspaceRoot: "/repo",
    fs,
    dryRun: false,
  });
  assert.equal(r.outcome, "applied");
  assert.equal(fs.files.get("/repo/x.yml"), "NEW");
});

test("applyEdit: dryRun=true does NOT write", () => {
  const fs = makeFs({ "/repo/x.yml": "OLD" });
  const r = applyEdit({
    edit: { path: "x.yml", findRegex: /OLD/, replace: "NEW" },
    workspaceRoot: "/repo",
    fs,
    dryRun: true,
  });
  assert.equal(r.outcome, "applied");
  assert.equal(fs.files.get("/repo/x.yml"), "OLD");
});

// ---------------------------------------------------------------------------
// applyFixProposal — happy path
// ---------------------------------------------------------------------------

test("applyFixProposal: applies a simple file edit successfully", async () => {
  const fs = makeFs({ "/repo/ci.yml": "        run: npm run build\n" });
  const exec = makeExec([]);
  const r = await applyFixProposal({
    proposal: {
      class: "node-oom",
      description: "Bump heap",
      commitMessage: "fix(ci): bump heap",
      fileEdits: [{
        path: "ci.yml",
        findRegex: /        run: npm run build/,
        replace: "        env:\n          NODE_OPTIONS: --max-old-space-size=8192\n        run: npm run build",
      }],
      commands: [],
    },
    workspaceRoot: "/repo",
    _fs: fs,
    _exec: exec,
  });
  assert.equal(r.status, "applied");
  assert.equal(r.summary.editsApplied, 1);
  assert.match(fs.files.get("/repo/ci.yml"), /NODE_OPTIONS: --max-old-space-size=8192/);
});

test("applyFixProposal: runs commands sequentially", async () => {
  const fs = makeFs({});
  const exec = makeExec([
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
  ]);
  const r = await applyFixProposal({
    proposal: {
      class: "lint-error",
      description: "Lint fix",
      commitMessage: "fix(lint): apply auto-fix",
      fileEdits: [],
      commands: [
        { cmd: "eslint . --fix", cwd: "." },
        { cmd: "prettier --write .", cwd: "." },
      ],
    },
    workspaceRoot: "/repo",
    _fs: fs,
    _exec: exec,
  });
  assert.equal(r.status, "applied");
  assert.equal(r.summary.commandsOk, 2);
  assert.equal(exec.calls.length, 2);
  assert.equal(exec.calls[0].cwd.replace(/\\/g, '/'), "/repo");
});

// ---------------------------------------------------------------------------
// applyFixProposal — error paths
// ---------------------------------------------------------------------------

test("applyFixProposal: requiresHumanReview → needs-review (no edits, no commands)", async () => {
  const fs = makeFs({ "/repo/ci.yml": "        run: npm run build" });
  const exec = makeExec([]);
  const r = await applyFixProposal({
    proposal: {
      class: "test-snapshot-mismatch",
      description: "Update snapshots",
      commitMessage: "test: update snapshots",
      requiresHumanReview: true,
      fileEdits: [{ path: "ci.yml", findRegex: /run/, replace: "RUN" }],
      commands: [{ cmd: "vitest -u", cwd: "." }],
    },
    workspaceRoot: "/repo",
    _fs: fs,
    _exec: exec,
  });
  assert.equal(r.status, "needs-review");
  assert.equal(r.edits.length, 0);
  assert.equal(exec.calls.length, 0);
  // File untouched
  assert.equal(fs.files.get("/repo/ci.yml"), "        run: npm run build");
});

test("applyFixProposal: autoApplyReviewRequired=true overrides the gate", async () => {
  const fs = makeFs({ "/repo/x.yml": "before" });
  const exec = makeExec([]);
  const r = await applyFixProposal({
    proposal: {
      class: "action-version-broken",
      description: "Bump action",
      commitMessage: "fix(ci): bump action",
      requiresHumanReview: true,
      fileEdits: [{ path: "x.yml", findRegex: /before/, replace: "after" }],
      commands: [],
    },
    workspaceRoot: "/repo",
    autoApplyReviewRequired: true,
    _fs: fs,
    _exec: exec,
  });
  assert.equal(r.status, "applied");
  assert.equal(fs.files.get("/repo/x.yml"), "after");
});

test("applyFixProposal: first command exit-mismatch stops subsequent commands", async () => {
  const fs = makeFs({});
  const exec = makeExec([
    { exitCode: 1, stdout: "", stderr: "boom" },
    { exitCode: 0, stdout: "ok", stderr: "" }, // should not run
  ]);
  const r = await applyFixProposal({
    proposal: {
      class: "lint-error",
      description: "Lint fix",
      commitMessage: "fix(lint)",
      fileEdits: [],
      commands: [
        { cmd: "eslint . --fix", cwd: "." },
        { cmd: "prettier --write .", cwd: "." },
      ],
    },
    workspaceRoot: "/repo",
    _fs: fs,
    _exec: exec,
  });
  assert.equal(r.status, "error");
  assert.equal(r.commands[0].outcome, "exit-mismatch");
  assert.equal(r.commands[1].outcome, "skipped-due-to-prior-failure");
  assert.equal(exec.calls.length, 1, "second command must NOT execute after first failure");
});

test("applyFixProposal: all edits idempotent → status no-op", async () => {
  const fs = makeFs({ "/repo/x.yml": "ALREADY_HERE" });
  const exec = makeExec([]);
  const r = await applyFixProposal({
    proposal: {
      class: "node-oom",
      description: "n/a",
      commitMessage: "n/a",
      fileEdits: [{
        path: "x.yml",
        findRegex: /never/,
        replace: "X",
        skipIfPresent: /ALREADY_HERE/,
      }],
      commands: [],
    },
    workspaceRoot: "/repo",
    _fs: fs,
    _exec: exec,
  });
  assert.equal(r.status, "no-op");
  assert.equal(r.summary.editsSkipped, 1);
});

test("applyFixProposal: invalid proposal returns status:error", async () => {
  const r = await applyFixProposal({
    proposal: { class: "x" }, // missing fileEdits/commands
    workspaceRoot: "/repo",
    _fs: makeFs(),
    _exec: makeExec(),
  });
  assert.equal(r.status, "error");
  assert.match(r.error, /fileEdits|commands/);
});

test("applyFixProposal: missing workspaceRoot returns status:error", async () => {
  const r = await applyFixProposal({
    proposal: { class: "x", fileEdits: [], commands: [] },
    _fs: makeFs(),
    _exec: makeExec(),
  });
  assert.equal(r.status, "error");
  assert.match(r.error, /workspaceRoot/);
});

test("applyFixProposal: dryRun does not touch files or run commands", async () => {
  const fs = makeFs({ "/repo/x.yml": "OLD" });
  const exec = makeExec();
  const r = await applyFixProposal({
    proposal: {
      class: "node-oom",
      description: "n/a",
      commitMessage: "n/a",
      fileEdits: [{ path: "x.yml", findRegex: /OLD/, replace: "NEW" }],
      commands: [{ cmd: "echo hi", cwd: "." }],
    },
    workspaceRoot: "/repo",
    dryRun: true,
    _fs: fs,
    _exec: exec,
  });
  assert.equal(r.status, "applied");
  assert.equal(r.dryRun, true);
  // File NOT modified
  assert.equal(fs.files.get("/repo/x.yml"), "OLD");
  // Exec NOT called
  assert.equal(exec.calls.length, 0);
});

test("applyFixProposal: command honors absolute cwd", async () => {
  const fs = makeFs();
  const exec = makeExec([{ exitCode: 0, stdout: "ok", stderr: "" }]);
  await applyFixProposal({
    proposal: {
      class: "lint-error",
      description: "n/a",
      commitMessage: "n/a",
      fileEdits: [],
      commands: [{ cmd: "noop", cwd: "/absolute/path" }],
    },
    workspaceRoot: "/repo",
    _fs: fs,
    _exec: exec,
  });
  assert.equal(exec.calls[0].cwd, "/absolute/path");
});

test("applyFixProposal: summary tallies match outcomes", async () => {
  const fs = makeFs({
    "/repo/a.yml": "ALREADY",
    "/repo/b.yml": "TARGET",
    // c.yml missing → no-match
  });
  const exec = makeExec([
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 7, stdout: "", stderr: "fail" },
  ]);
  const r = await applyFixProposal({
    proposal: {
      class: "lint-error",
      description: "mixed",
      commitMessage: "mixed",
      fileEdits: [
        { path: "a.yml", findRegex: /TARGET/, replace: "X", skipIfPresent: /ALREADY/ },
        { path: "b.yml", findRegex: /TARGET/, replace: "X" },
        { path: "c.yml", findRegex: /TARGET/, replace: "X" },
      ],
      commands: [
        { cmd: "first", cwd: "." },
        { cmd: "second", cwd: "." },
      ],
    },
    workspaceRoot: "/repo",
    _fs: fs,
    _exec: exec,
  });
  // a.yml skipped, b.yml applied, c.yml no-match (counted as errored)
  assert.equal(r.summary.editsApplied, 1);
  assert.equal(r.summary.editsSkipped, 1);
  assert.equal(r.summary.editsErrored, 1);
  // First command ok, second exit-mismatch
  assert.equal(r.summary.commandsOk, 1);
  assert.equal(r.summary.commandsFailed, 1);
  // Overall status: error (commands failed)
  assert.equal(r.status, "error");
});

// ---------------------------------------------------------------------------
// End-to-end: recipe → proposal → apply
// ---------------------------------------------------------------------------

test("integration: lockfile-drift recipe → applier → npm install command runs", async () => {
  // eslint-disable-next-line global-require
  const { recipeLockfileDrift } = require("../website/app/lib/ci-doctor/fix-recipes.js");
  const proposal = recipeLockfileDrift({ workspaceRoot: "/repo" });
  const exec = makeExec([{ exitCode: 0, stdout: "added 1 package", stderr: "" }]);
  const r = await applyFixProposal({
    proposal,
    workspaceRoot: "/repo",
    _fs: makeFs(),
    _exec: exec,
  });
  assert.equal(r.status, "applied");
  assert.equal(exec.calls.length, 1);
  assert.match(exec.calls[0].cmd, /npm install/);
});
