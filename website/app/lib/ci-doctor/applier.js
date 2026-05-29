/**
 * CI Doctor — applier (v0.3).
 *
 * Reads a `FixProposal` from the recipe library (v0.2) and applies it
 * to a workspace: edits files, runs commands, and produces an
 * `ApplyResult` describing what changed and what to do next.
 *
 * This module does NOT:
 *   - Open PRs (that's the orchestrator / CLI's job — keeps git
 *     mechanics separable from fix mechanics)
 *   - Apply a `requiresHumanReview: true` proposal unless the caller
 *     explicitly passes `autoApplyReviewRequired: true`
 *   - Touch the filesystem when called with a fake `_fs` adapter
 *   - Execute real commands when called with a fake `_exec` adapter
 *
 * This module DOES:
 *   - Apply file edits idempotently (skipIfPresent → no-op)
 *   - Stop the apply at the first command failure (don't run command 2
 *     after command 1 errored unexpectedly)
 *   - Capture before/after content for every edited file so the caller
 *     can produce a unified diff for the PR description
 *   - Return a structured ApplyResult with success/error breakdown
 *
 * ApplyResult shape:
 *
 *   {
 *     status: "applied" | "no-op" | "needs-review" | "error",
 *     proposal: { class, description, commitMessage },
 *     edits: Array<{
 *       path: string,
 *       outcome: "applied" | "skipped-already-present" | "no-match" | "error",
 *       beforeBytes: number,
 *       afterBytes: number,
 *       error?: string,
 *     }>,
 *     commands: Array<{
 *       cmd: string,
 *       cwd: string,
 *       outcome: "ok" | "exit-mismatch" | "error" | "skipped-due-to-prior-failure",
 *       exitCode?: number,
 *       error?: string,
 *     }>,
 *     summary: { editsApplied, editsSkipped, commandsOk, commandsFailed }
 *   }
 */

"use strict";

const path = require("path");

/**
 * @typedef {object} FsAdapter
 * @property {(path: string) => boolean} existsSync
 * @property {(path: string, encoding: string) => string} readFileSync
 * @property {(path: string, data: string) => void} writeFileSync
 */

/**
 * @typedef {object} ExecAdapter
 * @property {(cmd: string, opts: { cwd: string }) => Promise<{ exitCode: number, stdout: string, stderr: string }>} run
 */

const DEFAULT_FS = (() => {
  try {
    return require("fs"); // eslint-disable-line global-require
  } catch {
    return null;
  }
})();

const DEFAULT_EXEC = {
  async run(cmd, { cwd }) {
    // eslint-disable-next-line global-require
    const cp = require("child_process");
    return new Promise((resolve) => {
      const child = cp.exec(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      });
      // Soft cap: nothing should run > 5 min in the applier. Real-world
      // recipes (lockfile regen / eslint --fix) finish in seconds.
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignored */ }
      }, 5 * 60 * 1000);
      child.on("exit", () => clearTimeout(timer));
    });
  },
};

/**
 * Validate a proposal has the minimum shape we need.
 */
function validateProposal(proposal) {
  if (!proposal || typeof proposal !== "object") {
    return { ok: false, reason: "proposal-missing" };
  }
  if (typeof proposal.class !== "string" || !proposal.class) {
    return { ok: false, reason: "class-missing" };
  }
  if (!Array.isArray(proposal.fileEdits)) {
    return { ok: false, reason: "fileEdits-not-array" };
  }
  if (!Array.isArray(proposal.commands)) {
    return { ok: false, reason: "commands-not-array" };
  }
  return { ok: true };
}

/**
 * Apply a single file edit. Pure logic given fs adapter — returns the
 * outcome without touching anything if `dryRun` is true.
 */
function applyEdit({ edit, workspaceRoot, fs, dryRun }) {
  const fullPath = path.isAbsolute(edit.path)
    ? edit.path
    : path.join(workspaceRoot, edit.path);

  if (!fs.existsSync(fullPath)) {
    return {
      path: edit.path,
      outcome: "no-match",
      error: "file does not exist",
      beforeBytes: 0,
      afterBytes: 0,
    };
  }

  let before;
  try {
    before = fs.readFileSync(fullPath, "utf8");
  } catch (err) {
    return {
      path: edit.path,
      outcome: "error",
      error: `read failed: ${err.message || String(err)}`,
      beforeBytes: 0,
      afterBytes: 0,
    };
  }

  // Idempotency check — if the desired state is already present, skip.
  if (edit.skipIfPresent && edit.skipIfPresent.test(before)) {
    return {
      path: edit.path,
      outcome: "skipped-already-present",
      beforeBytes: before.length,
      afterBytes: before.length,
    };
  }

  const after = before.replace(edit.findRegex, edit.replace);
  if (after === before) {
    return {
      path: edit.path,
      outcome: "no-match",
      error: "findRegex did not match",
      beforeBytes: before.length,
      afterBytes: before.length,
    };
  }

  if (!dryRun) {
    try {
      fs.writeFileSync(fullPath, after);
    } catch (err) {
      return {
        path: edit.path,
        outcome: "error",
        error: `write failed: ${err.message || String(err)}`,
        beforeBytes: before.length,
        afterBytes: before.length,
      };
    }
  }

  return {
    path: edit.path,
    outcome: "applied",
    beforeBytes: before.length,
    afterBytes: after.length,
  };
}

/**
 * Run a single command via the exec adapter.
 */
async function runCommand({ command, workspaceRoot, exec, dryRun }) {
  const cwd = command.cwd && path.isAbsolute(command.cwd)
    ? command.cwd
    : path.join(workspaceRoot, command.cwd || ".");

  if (dryRun) {
    return {
      cmd: command.cmd,
      cwd,
      outcome: "ok",
      exitCode: 0,
      dryRun: true,
    };
  }

  let result;
  try {
    result = await exec.run(command.cmd, { cwd });
  } catch (err) {
    return {
      cmd: command.cmd,
      cwd,
      outcome: "error",
      error: err.message || String(err),
    };
  }

  const expected = typeof command.expectedExitCode === "number" ? command.expectedExitCode : 0;
  if (result.exitCode !== expected) {
    return {
      cmd: command.cmd,
      cwd,
      outcome: "exit-mismatch",
      exitCode: result.exitCode,
      error: `expected exit ${expected}, got ${result.exitCode}: ${(result.stderr || "").slice(0, 500)}`,
    };
  }
  return {
    cmd: command.cmd,
    cwd,
    outcome: "ok",
    exitCode: result.exitCode,
  };
}

/**
 * Apply a FixProposal end-to-end.
 *
 * @param {object} args
 * @param {object} args.proposal                     a FixProposal from recipes
 * @param {string} args.workspaceRoot                absolute path
 * @param {boolean} [args.autoApplyReviewRequired]   override the human-review gate
 * @param {boolean} [args.dryRun]                    plan without touching anything
 * @param {FsAdapter} [args._fs]                     injectable fs for tests
 * @param {ExecAdapter} [args._exec]                 injectable exec for tests
 * @returns {Promise<object>}                        ApplyResult
 */
async function applyFixProposal({
  proposal,
  workspaceRoot,
  autoApplyReviewRequired = false,
  dryRun = false,
  _fs,
  _exec,
} = {}) {
  const fs = _fs || DEFAULT_FS;
  const exec = _exec || DEFAULT_EXEC;
  if (!fs) throw new Error("applyFixProposal: no fs adapter available");

  const v = validateProposal(proposal);
  if (!v.ok) {
    return {
      status: "error",
      proposal: null,
      edits: [],
      commands: [],
      summary: { editsApplied: 0, editsSkipped: 0, commandsOk: 0, commandsFailed: 0 },
      error: v.reason,
    };
  }

  if (proposal.requiresHumanReview && !autoApplyReviewRequired) {
    return {
      status: "needs-review",
      proposal: {
        class: proposal.class,
        description: proposal.description,
        commitMessage: proposal.commitMessage,
      },
      edits: [],
      commands: [],
      summary: { editsApplied: 0, editsSkipped: 0, commandsOk: 0, commandsFailed: 0 },
      message: "proposal flagged requiresHumanReview — surface to operator instead of auto-applying",
    };
  }

  if (!workspaceRoot || typeof workspaceRoot !== "string") {
    return {
      status: "error",
      proposal: { class: proposal.class },
      edits: [],
      commands: [],
      summary: { editsApplied: 0, editsSkipped: 0, commandsOk: 0, commandsFailed: 0 },
      error: "workspaceRoot is required",
    };
  }

  // Phase 1 — file edits
  const editResults = [];
  for (const edit of proposal.fileEdits) {
    editResults.push(applyEdit({ edit, workspaceRoot, fs, dryRun }));
  }

  // Phase 2 — commands. Stop at first hard failure ("error" / "exit-mismatch").
  const commandResults = [];
  let priorFailure = false;
  for (const command of proposal.commands) {
    if (priorFailure) {
      commandResults.push({
        cmd: command.cmd,
        cwd: command.cwd,
        outcome: "skipped-due-to-prior-failure",
      });
      continue;
    }
    const r = await runCommand({ command, workspaceRoot, exec, dryRun });
    commandResults.push(r);
    if (r.outcome === "error" || r.outcome === "exit-mismatch") {
      priorFailure = true;
    }
  }

  const editsApplied = editResults.filter((e) => e.outcome === "applied").length;
  const editsSkipped = editResults.filter((e) => e.outcome === "skipped-already-present").length;
  const editsErrored = editResults.filter((e) => e.outcome === "error" || e.outcome === "no-match").length;
  const commandsOk = commandResults.filter((c) => c.outcome === "ok").length;
  const commandsFailed = commandResults.filter((c) => c.outcome === "error" || c.outcome === "exit-mismatch").length;

  let status;
  if (commandsFailed > 0) {
    status = "error";
  } else if (editsApplied === 0 && proposal.fileEdits.length > 0 && editsSkipped === proposal.fileEdits.length) {
    status = "no-op"; // everything was idempotently already present
  } else if (editsApplied === 0 && proposal.fileEdits.length > 0 && editsErrored === proposal.fileEdits.length) {
    status = "error";
  } else {
    status = "applied";
  }

  return {
    status,
    proposal: {
      class: proposal.class,
      description: proposal.description,
      commitMessage: proposal.commitMessage,
    },
    edits: editResults,
    commands: commandResults,
    summary: {
      editsApplied,
      editsSkipped,
      editsErrored,
      commandsOk,
      commandsFailed,
    },
    dryRun: Boolean(dryRun),
  };
}

module.exports = {
  applyFixProposal,
  applyEdit,
  runCommand,
  validateProposal,
};
