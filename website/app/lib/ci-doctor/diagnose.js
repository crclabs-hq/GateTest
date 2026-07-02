/**
 * CI Doctor — diagnose orchestrator (v0.4b).
 *
 * One entry point that ties together every brick we've shipped so far:
 *
 *   classify (v0.1) + propose (v0.2) + apply (v0.3) + fetch (v0.4a)
 *
 * Inputs:
 *   - owner / repo (target repo on GitHub)
 *   - either `runId` (a workflow run id) OR `prNumber` (we resolve
 *     it to the latest run's id internally)
 *
 * Outputs:
 *   {
 *     run:       { id, name, conclusion, htmlUrl, headSha },
 *     jobs: [
 *       {
 *         name, conclusion,
 *         findings: [ ...classifier output... ],
 *         proposals: [ ...recipe output... ],
 *         applies:   [ ...applier output, only when apply=true... ],
 *       },
 *     ],
 *     summary: {
 *       jobsAnalysed, findings, proposals,
 *       proposalsAutoApplied, proposalsNeedingReview,
 *       proposalsErrored,
 *     },
 *   }
 *
 * Defaults to DRY-RUN. The applier is only invoked when `apply: true`.
 * Proposals that are `requiresHumanReview: true` are NOT auto-applied
 * unless the caller passes `autoApplyReviewRequired: true`. This keeps
 * snapshot blesses and action-version bumps under human oversight by
 * default.
 */

"use strict";

const { fetchWorkflowRun, listJobs, fetchFailedJobLogs, GH_API } = require("./github-actions-fetcher.js");
const { classifyCIFailures } = require("./failure-classifier.js");
const { proposeFixForFinding } = require("./fix-recipes.js");
const { applyFixProposal } = require("./applier.js");

const DEFAULT_AUTH = {};

/**
 * Resolve a PR number to the most recent workflow run on its head SHA.
 *
 * @returns {Promise<number|null>}
 */
async function resolveRunIdForPR({ owner, repo, prNumber, token, _fetch }) {
  const fetchImpl = _fetch || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) throw new Error("resolveRunIdForPR: no fetch available");

  const prRes = await fetchImpl(`${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: token ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } : { Accept: "application/vnd.github+json" },
  });
  if (!prRes || !prRes.ok) {
    throw new Error(`resolveRunIdForPR: PR ${prNumber} not accessible (status ${prRes ? prRes.status : "n/a"})`);
  }
  const pr = await prRes.json();
  const sha = pr && pr.head && pr.head.sha;
  if (!sha) return null;

  const runsRes = await fetchImpl(`${GH_API}/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=50`, {
    headers: token ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } : { Accept: "application/vnd.github+json" },
  });
  if (!runsRes || !runsRes.ok) return null;
  const data = await runsRes.json();
  const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
  if (runs.length === 0) return null;

  // Prefer the most recently updated failed run; fall back to any most
  // recent run if no failure (the diagnose call will then exit early
  // with a clean report).
  runs.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const failed = runs.find((r) => r.conclusion === "failure" || r.conclusion === "cancelled");
  return failed ? failed.id : runs[0].id;
}

/**
 * Build the per-finding context object the recipe builders consume.
 *
 * Some recipes need workflow paths to patch (node-oom, runner-timeout),
 * others need the workspace root for commands (lockfile-drift, lint).
 * The caller passes their environment-specific values via
 * `recipeContext`; we merge with sensible defaults per class.
 *
 * Anything the caller doesn't pre-supply for a particular class becomes
 * the responsibility of the operator to specify in the PR. We surface
 * missing-context failures as `proposal: null` with `error: "missing-context"`.
 */
function buildRecipeContext({ finding, workspaceRoot, recipeContext, job }) {
  const base = {
    workspaceRoot,
    ...(recipeContext || {}),
  };

  // Auto-derive a sensible jobName for permission / timeout recipes
  if (job && job.name && !base.jobName) base.jobName = sanitiseJobName(job.name);

  return base;
}

/**
 * GitHub Actions job names can contain spaces and special chars. The
 * recipe regexes treat the job name as a YAML identifier — strip any
 * suffix added by matrix expansion and lowercase to be safe.
 */
function sanitiseJobName(name) {
  if (!name) return name;
  // Matrix job names look like "test (node-22, ubuntu-latest)" — take
  // the prefix before the paren.
  const m = name.match(/^([A-Za-z0-9_-]+)/);
  return m ? m[1] : name;
}

/**
 * Run the full diagnose flow.
 *
 * @param {object} args
 * @param {string} args.owner                                  GitHub org or user
 * @param {string} args.repo                                   repo name
 * @param {number|string} [args.runId]                         workflow run id (if known)
 * @param {number} [args.prNumber]                             PR number (if runId not supplied)
 * @param {string} [args.workspaceRoot]                        only needed when apply: true
 * @param {object} [args.recipeContext]                        extra context for recipe builders
 * @param {boolean} [args.apply=false]                         actually apply fixes
 * @param {boolean} [args.dryRun=true]                         when apply=false, applier runs in dryRun
 * @param {boolean} [args.autoApplyReviewRequired=false]       force-apply human-review proposals
 * @param {string} [args.token]                                GitHub token
 * @param {function} [args._fetch]
 * @param {object} [args._fs]
 * @param {object} [args._exec]
 * @returns {Promise<object>}
 */
async function diagnose({
  owner,
  repo,
  runId,
  prNumber,
  workspaceRoot,
  recipeContext,
  apply = false,
  autoApplyReviewRequired = false,
  token,
  _fetch,
  _fs,
  _exec,
} = {}) {
  if (!owner || !repo) {
    return { error: "owner-and-repo-required", run: null, jobs: [] };
  }
  let resolvedRunId = runId;
  if (!resolvedRunId && prNumber) {
    resolvedRunId = await resolveRunIdForPR({ owner, repo, prNumber, token, _fetch });
  }
  if (!resolvedRunId) {
    return { error: "no-runId", run: null, jobs: [] };
  }

  const run = await fetchWorkflowRun({ owner, repo, runId: resolvedRunId, token, _fetch });
  const jobs = await listJobs({ owner, repo, runId: resolvedRunId, token, _fetch });
  const failedLogsMap = await fetchFailedJobLogs({ owner, repo, runId: resolvedRunId, token, _fetch });

  const jobReports = [];
  let totalFindings = 0;
  let totalProposals = 0;
  let totalAutoApplied = 0;
  let totalNeedsReview = 0;
  let totalErrored = 0;

  for (const job of jobs) {
    if (job.conclusion !== "failure" && job.conclusion !== "cancelled") continue;
    const logText = failedLogsMap.get(job.name) || "";
    const findings = classifyCIFailures(logText);
    totalFindings += findings.length;

    const proposals = [];
    const applies = [];
    for (const finding of findings) {
      const ctx = buildRecipeContext({ finding, workspaceRoot, recipeContext, job });
      const proposal = proposeFixForFinding(finding, ctx);
      proposals.push({
        forClass: finding.class,
        proposal,
        error: proposal ? null : "no-recipe-or-missing-context",
      });
      if (proposal) totalProposals += 1;

      if (apply && proposal && workspaceRoot) {
        const applyResult = await applyFixProposal({
          proposal,
          workspaceRoot,
          autoApplyReviewRequired,
          dryRun: false,
          _fs,
          _exec,
        });
        applies.push({ forClass: finding.class, applyResult });
        if (applyResult.status === "applied" || applyResult.status === "no-op") totalAutoApplied += 1;
        else if (applyResult.status === "needs-review") totalNeedsReview += 1;
        else if (applyResult.status === "error") totalErrored += 1;
      } else if (proposal && proposal.requiresHumanReview) {
        totalNeedsReview += 1;
      }
    }

    jobReports.push({
      name: job.name,
      conclusion: job.conclusion,
      logBytes: logText.length,
      findings,
      proposals,
      applies,
    });
  }

  return {
    run: {
      id: run.id,
      name: run.name,
      conclusion: run.conclusion,
      htmlUrl: run.htmlUrl,
      headSha: run.headSha,
    },
    jobs: jobReports,
    summary: {
      jobsAnalysed: jobReports.length,
      findings: totalFindings,
      proposals: totalProposals,
      proposalsAutoApplied: totalAutoApplied,
      proposalsNeedingReview: totalNeedsReview,
      proposalsErrored: totalErrored,
    },
    appliedMode: Boolean(apply && workspaceRoot),
  };
}

/**
 * Render a diagnose() report as customer-facing markdown — for the PR
 * description, for the CLI output, or for the operator dashboard.
 */
function renderReport(report) {
  if (!report || report.error) {
    return `## CI Doctor report\n\n_Error: ${(report && report.error) || "unknown"}_\n`;
  }
  const lines = [];
  lines.push("## CI Doctor report");
  lines.push("");
  lines.push(`**Run:** [${report.run.name} #${report.run.id}](${report.run.htmlUrl}) — \`${report.run.conclusion}\``);
  lines.push(`**Head SHA:** \`${report.run.headSha}\``);
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("| --- | --- |");
  lines.push(`| Jobs analysed | ${report.summary.jobsAnalysed} |`);
  lines.push(`| Findings | ${report.summary.findings} |`);
  lines.push(`| Proposals | ${report.summary.proposals} |`);
  lines.push(`| Auto-applied | ${report.summary.proposalsAutoApplied} |`);
  lines.push(`| Needs review | ${report.summary.proposalsNeedingReview} |`);
  lines.push(`| Errored | ${report.summary.proposalsErrored} |`);
  lines.push("");
  for (const job of report.jobs) {
    lines.push(`### Job: \`${job.name}\` — \`${job.conclusion}\``);
    if (job.findings.length === 0) {
      lines.push("_No findings classified — log may need manual review._");
      continue;
    }
    for (let i = 0; i < job.findings.length; i++) {
      const f = job.findings[i];
      const prop = job.proposals[i] && job.proposals[i].proposal;
      lines.push("");
      lines.push(`- **${f.class}** (confidence: ${f.confidence}, line ${f.lineNumber})`);
      lines.push(`  - Evidence: \`${(f.evidence || "").slice(0, 200)}\``);
      lines.push(`  - Suggested fix: ${f.suggestedFix}`);
      if (prop) {
        lines.push(`  - Proposal: ${prop.description}${prop.requiresHumanReview ? " _(requires human review)_" : ""}`);
      } else {
        lines.push(`  - Proposal: none (missing recipe or context)`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

module.exports = {
  diagnose,
  renderReport,
  resolveRunIdForPR,
  buildRecipeContext,
  sanitiseJobName,
};
