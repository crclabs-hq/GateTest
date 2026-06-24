/**
 * CI Doctor — CLI arg parser.
 *
 * Pulled out as a separate module so it's unit-testable without
 * spawning a process. The thin bin/gatetest-doctor.js script wires
 * parseDoctorArgs() to the diagnose() orchestrator.
 *
 * Supported flags:
 *
 *   --owner <name>        GitHub org / user (required)
 *   --repo <name>         GitHub repo name (required)
 *   --pr <number>         resolve PR's head SHA → latest failed run
 *   --run <id>            workflow run id (use either --pr or --run)
 *   --workspace <path>    workspace root for `--apply` mode (default: cwd)
 *   --workflow <paths>    CSV of workflow YAML paths to patch
 *                         (default: .github/workflows/ci.yml)
 *   --apply               actually apply fixes (default: dry-run)
 *   --autoreview          force-apply requiresHumanReview proposals
 *   --token <value>       GitHub PAT (else falls through to env)
 *   --json                emit the report as JSON (else markdown)
 *   --help / -h           print usage
 */

"use strict";

const DEFAULT_WORKFLOW_PATHS = [".github/workflows/ci.yml"];

const USAGE = `
Usage: gatetest-doctor --owner <name> --repo <name> (--pr <n> | --run <id>) [flags]

Required:
  --owner <name>       GitHub org or user
  --repo <name>        Repository name
  --pr <number>        Resolve PR head SHA to latest failed run; or
  --run <id>           Workflow run id

Optional:
  --workspace <path>   Workspace root for --apply (default: cwd)
  --workflow <paths>   Comma-separated workflow YAML paths
                       (default: .github/workflows/ci.yml)
  --apply              Apply fixes (default is dry-run)
  --autoreview         Force-apply requiresHumanReview proposals
                       (snapshot blesses, action upgrades)
  --token <value>      GitHub token (else env)
  --json               Emit JSON instead of markdown
  --help, -h           Show this usage

Examples:
  gatetest-doctor --owner crclabs-hq --repo GateTest --pr 42
  gatetest-doctor --owner x --repo y --run 12345 --apply
`.trim();

function parseDoctorArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const out = {
    owner: null,
    repo: null,
    prNumber: null,
    runId: null,
    workspaceRoot: null,
    workflowPaths: null,
    apply: false,
    autoApplyReviewRequired: false,
    token: null,
    json: false,
    help: false,
    errors: [],
  };

  while (args.length > 0) {
    const a = args.shift();
    switch (a) {
      case "--owner": out.owner = args.shift() || null; break;
      case "--repo": out.repo = args.shift() || null; break;
      case "--pr": {
        const v = args.shift();
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) out.errors.push(`--pr: not a positive integer: ${v}`);
        else out.prNumber = n;
        break;
      }
      case "--run": {
        const v = args.shift();
        if (!v) out.errors.push("--run: missing value");
        else out.runId = v;
        break;
      }
      case "--workspace": out.workspaceRoot = args.shift() || null; break;
      case "--workflow": {
        const v = args.shift();
        if (v) out.workflowPaths = v.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      }
      case "--apply": out.apply = true; break;
      case "--autoreview": out.autoApplyReviewRequired = true; break;
      case "--token": out.token = args.shift() || null; break;
      case "--json": out.json = true; break;
      case "--help":
      case "-h": out.help = true; break;
      default:
        // ignore unknown flags rather than erroring — caller may pass
        // pass-through args; let the CLI shim decide.
        if (a && a.startsWith("--")) out.errors.push(`unknown flag: ${a}`);
    }
  }

  // Validation — only when not requesting help
  if (!out.help) {
    if (!out.owner) out.errors.push("--owner is required");
    if (!out.repo) out.errors.push("--repo is required");
    if (!out.prNumber && !out.runId) out.errors.push("either --pr or --run is required");
    if (out.prNumber && out.runId) out.errors.push("pass --pr OR --run, not both");
  }

  if (out.workflowPaths === null) out.workflowPaths = DEFAULT_WORKFLOW_PATHS.slice();
  return out;
}

module.exports = {
  parseDoctorArgs,
  USAGE,
  DEFAULT_WORKFLOW_PATHS,
};
