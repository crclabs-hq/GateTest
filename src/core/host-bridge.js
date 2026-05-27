/**
 * HostBridge — the abstract contract every git host integration implements.
 *
 * GateTest is moving Gluecron-first (see CLAUDE.md → STRATEGIC DIRECTION).
 * GitHub is a legacy integration; Gluecron is the future. Rather than
 * branching host-specific logic all over the codebase, the engine talks to
 * a HostBridge. Today there is one concrete implementation (GitHubBridge);
 * tomorrow there will be a GluecronBridge.
 *
 * This file defines:
 *   - The abstract surface every bridge must implement.
 *   - Host-agnostic helpers: commit-status state validation, the PR report
 *     markdown formatter, and the `reportResults` convenience method.
 *   - A small registry so `createBridge("github", opts)` returns the right
 *     implementation without callers importing host-specific modules.
 *
 * The contract uses GitHub's commit-status vocabulary as the canonical set
 * ('pending' | 'success' | 'failure' | 'error') because it is the most
 * widely-adopted status taxonomy. Non-GitHub bridges translate internally.
 *
 * TODO(gluecron): when Gluecron ships, add `GluecronBridge` extending this
 * class and `registerBridge('gluecron', GluecronBridge)` at module load.
 */

const CANONICAL_COMMIT_STATES = ['pending', 'success', 'failure', 'error'];

const MARKDOWN_FOOTER_VERSION = 'v1.5.0';

// Signature marker placed as the FIRST line of every GateTest PR comment.
// PR-comment posters list existing comments, look for this marker, and
// PATCH the matching comment in place rather than POSTing a new one on
// every push. Without this, busy PRs accumulate one duplicate GateTest
// comment per push (Known Issue #23). The version suffix lets us
// upgrade the marker without colliding with old comments — change it
// when the marker shape evolves.
const GATETEST_PR_COMMENT_MARKER = '<!-- gatetest-bot:gate-summary:v1 -->';

class NotImplemented extends Error {
  constructor(method, hostName) {
    super(
      `[HostBridge] ${method}() is not implemented${hostName ? ` for host "${hostName}"` : ''}.`,
    );
    this.name = 'NotImplemented';
    this.method = method;
  }
}

/**
 * Abstract base class. Concrete subclasses (e.g. GitHubBridge,
 * GluecronBridge) override the primitive methods below. Shared methods
 * (`postGateResult`, `reportResults`, `_formatGateResultMarkdown`) are
 * host-agnostic and should NOT be overridden without good reason.
 */
class HostBridge {
  /**
   * Identifier for this host — subclasses override.
   * e.g. 'github', 'gluecron'.
   */
  static get hostName() { return null; }

  get hostName() { return this.constructor.hostName; }

  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.options = options;
  }

  // ---------------------------------------------------------------------------
  // Identity / health — every bridge must implement
  // ---------------------------------------------------------------------------

  async healthCheck() { throw new NotImplemented('healthCheck', this.hostName); }
  async verifyAuth() { throw new NotImplemented('verifyAuth', this.hostName); }
  getAccessStatus() { throw new NotImplemented('getAccessStatus', this.hostName); }
  resetCircuitBreaker() { throw new NotImplemented('resetCircuitBreaker', this.hostName); }

  // ---------------------------------------------------------------------------
  // Repo access
  // ---------------------------------------------------------------------------

  async accessRepo(_owner, _repo, _destDir, _options) {
    throw new NotImplemented('accessRepo', this.hostName);
  }
  async cloneRepo(_owner, _repo, _destDir, _options) {
    throw new NotImplemented('cloneRepo', this.hostName);
  }
  async pull(_repoDir, _options) { throw new NotImplemented('pull', this.hostName); }
  async push(_repoDir, _options) { throw new NotImplemented('push', this.hostName); }
  async getDefaultBranch(_owner, _repo) {
    throw new NotImplemented('getDefaultBranch', this.hostName);
  }
  async createBranch(_owner, _repo, _branchName, _baseSha) {
    throw new NotImplemented('createBranch', this.hostName);
  }

  // ---------------------------------------------------------------------------
  // Pull / merge requests
  // ---------------------------------------------------------------------------

  async createPullRequest(_owner, _repo, _options) {
    throw new NotImplemented('createPullRequest', this.hostName);
  }
  async getPullRequest(_owner, _repo, _prNumber) {
    throw new NotImplemented('getPullRequest', this.hostName);
  }
  async updatePullRequest(_owner, _repo, _prNumber, _updates) {
    throw new NotImplemented('updatePullRequest', this.hostName);
  }
  async addPrComment(_owner, _repo, _prNumber, _body) {
    throw new NotImplemented('addPrComment', this.hostName);
  }
  async listPrComments(_owner, _repo, _prNumber, _options) {
    throw new NotImplemented('listPrComments', this.hostName);
  }

  // ---------------------------------------------------------------------------
  // Commits & statuses
  // ---------------------------------------------------------------------------

  async createCommit(_owner, _repo, _options) {
    throw new NotImplemented('createCommit', this.hostName);
  }
  async getCommit(_owner, _repo, _sha) {
    throw new NotImplemented('getCommit', this.hostName);
  }
  async listCommits(_owner, _repo, _options) {
    throw new NotImplemented('listCommits', this.hostName);
  }
  async setCommitStatus(_owner, _repo, _sha, _state, _description, _options) {
    throw new NotImplemented('setCommitStatus', this.hostName);
  }
  async getCombinedStatus(_owner, _repo, _ref) {
    throw new NotImplemented('getCombinedStatus', this.hostName);
  }

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------

  createWebhookServer(_handlers, _options) {
    throw new NotImplemented('createWebhookServer', this.hostName);
  }

  // ---------------------------------------------------------------------------
  // Shared reporting — host-agnostic. Concrete bridges should NOT override.
  // ---------------------------------------------------------------------------

  /**
   * Post a formatted GateTest report as a comment on a pull/merge request.
   * Delegates comment posting to the concrete `addPrComment` primitive.
   */
  async postGateResult(owner, repo, prNumber, summary) {
    const body = this._formatGateResultMarkdown(summary);
    return this.addPrComment(owner, repo, prNumber, body);
  }

  /**
   * Convenience method: set commit status AND post PR comment in one call.
   * Derives the commit-status state from `summary.status`.
   */
  async reportResults(owner, repo, prNumber, sha, summary) {
    const state = summary.status === 'passed' ? 'success' : 'failure';
    const description = summary.status === 'passed'
      ? `All ${summary.totalChecks} checks passed`
      : `${summary.failed} of ${summary.totalChecks} checks failed`;

    const [statusResult, commentResult] = await Promise.all([
      this.setCommitStatus(owner, repo, sha, state, description),
      this.postGateResult(owner, repo, prNumber, summary),
    ]);

    return { status: statusResult, comment: commentResult };
  }

  /**
   * Validate a canonical commit-status state. Throws on invalid values.
   */
  _validateCommitState(state) {
    if (!CANONICAL_COMMIT_STATES.includes(state)) {
      throw new Error(
        `[HostBridge] Invalid commit status state "${state}". ` +
        `Must be one of: ${CANONICAL_COMMIT_STATES.join(', ')}`,
      );
    }
  }

  /**
   * Format a GateTest summary object into a markdown PR/MR comment.
   * Host-agnostic — every bridge renders the same report.
   *
   * The first line is an HTML-comment signature marker. PR-comment posters
   * use it to find a prior GateTest comment and PATCH-in-place rather than
   * spawning a new comment on every push (idempotent commenting).
   */
  _formatGateResultMarkdown(summary) {
    const lines = [GATETEST_PR_COMMENT_MARKER];
    const icon = summary.status === 'passed' ? ':white_check_mark:' : ':x:';
    const title = summary.status === 'passed'
      ? 'GateTest Quality Gate — PASSED'
      : 'GateTest Quality Gate — FAILED';

    const duration = summary.duration >= 1000
      ? `${(summary.duration / 1000).toFixed(1)}s`
      : `${summary.duration}ms`;

    lines.push(`## ${icon} ${title}`);
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| **Total Checks** | ${summary.totalChecks} |`);
    lines.push(`| **Passed** | ${summary.passed} |`);
    lines.push(`| **Failed** | ${summary.failed} |`);
    lines.push(`| **Skipped** | ${summary.skipped} |`);
    lines.push(`| **Duration** | ${duration} |`);
    lines.push('');

    if (summary.modules && summary.modules.length > 0) {
      lines.push('### Module Results');
      lines.push('');
      lines.push('| Module | Status | Checks | Duration |');
      lines.push('|--------|--------|--------|----------|');
      for (const mod of summary.modules) {
        const modIcon = mod.status === 'passed' ? ':white_check_mark:'
          : mod.status === 'failed' ? ':x:'
          : ':fast_forward:';
        const modDuration = mod.duration >= 1000
          ? `${(mod.duration / 1000).toFixed(1)}s`
          : `${mod.duration}ms`;
        const checkCount = mod.checks !== undefined ? mod.checks : '-';
        lines.push(`| ${modIcon} ${mod.name} | ${mod.status} | ${checkCount} | ${modDuration} |`);
      }
      lines.push('');
    }

    if (summary.failures && summary.failures.length > 0) {
      lines.push('### Failures');
      lines.push('');
      for (const failure of summary.failures) {
        lines.push(`<details>`);
        lines.push(`<summary><b>${failure.module}</b>: ${failure.check}</summary>`);
        lines.push('');
        if (failure.expected !== undefined && failure.actual !== undefined) {
          lines.push(`- **Expected:** ${failure.expected}`);
          lines.push(`- **Actual:** ${failure.actual}`);
        }
        if (failure.file) {
          lines.push(`- **File:** \`${failure.file}\`${failure.line ? `:${failure.line}` : ''}`);
        }
        if (failure.message) {
          lines.push(`- **Details:** ${failure.message}`);
        }
        if (failure.suggestion) {
          lines.push(`- **Suggested fix:** ${failure.suggestion}`);
        }
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    }

    lines.push('---');
    lines.push(`<sub>Generated by <b>GateTest ${MARKDOWN_FOOTER_VERSION}</b> at ${new Date().toISOString()}</sub>`);

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Registry — `createBridge("github", opts)` / `createBridge("gluecron", opts)`
// ---------------------------------------------------------------------------

const bridgeRegistry = new Map();

/**
 * Register a bridge implementation under a host name. Later callers can
 * construct it via `createBridge(hostName, options)`.
 */
function registerBridge(hostName, BridgeClass) {
  if (!hostName || typeof hostName !== 'string') {
    throw new Error('[HostBridge] registerBridge requires a non-empty hostName');
  }
  if (typeof BridgeClass !== 'function') {
    throw new Error('[HostBridge] registerBridge requires a class');
  }
  bridgeRegistry.set(hostName.toLowerCase(), BridgeClass);
}

/**
 * Create a bridge for the named host. Throws if no implementation is
 * registered for that host (e.g. Gluecron isn't built yet).
 */
function createBridge(hostName, options = {}) {
  if (!hostName) {
    throw new Error('[HostBridge] createBridge requires a hostName');
  }
  const BridgeClass = bridgeRegistry.get(String(hostName).toLowerCase());
  if (!BridgeClass) {
    const known = Array.from(bridgeRegistry.keys()).join(', ') || 'none';
    throw new Error(
      `[HostBridge] No bridge registered for host "${hostName}". ` +
      `Known hosts: ${known}. Import the bridge module (e.g. ` +
      `require('./github-bridge')) before calling createBridge.`,
    );
  }
  return new BridgeClass(options);
}

/**
 * Return the list of host names that currently have a registered bridge.
 */
function listBridges() {
  return Array.from(bridgeRegistry.keys());
}

module.exports = {
  HostBridge,
  NotImplemented,
  CANONICAL_COMMIT_STATES,
  GATETEST_PR_COMMENT_MARKER,
  registerBridge,
  createBridge,
  listBridges,
};
