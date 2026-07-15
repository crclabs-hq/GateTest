/**
 * GateTest GitHub Bridge - Resilient integration layer between GateTest and GitHub.
 *
 * ZERO TOLERANCE FOR ACCESS FAILURES.
 * If a customer pays for GateTest, we access their repo. Period.
 *
 * Resilience features:
 * - Automatic retry with exponential backoff (2s, 4s, 8s, 16s)
 * - Circuit breaker: detects GitHub outages, backs off gracefully
 * - Rate limit awareness: reads X-RateLimit headers, pauses before hitting limits
 * - Multi-strategy access: API → git clone → SSH fallback
 * - Health check: verify GitHub is reachable before starting a scan
 *
 * Uses Node.js built-in https module — no external dependencies.
 *
 * Extends `HostBridge` — the host-agnostic contract (see
 * src/core/host-bridge.js). Host-agnostic logic (report markdown, the
 * `reportResults`/`postGateResult` convenience methods) lives on the base;
 * this file only contains GitHub-specific primitives. The Gluecron
 * counterpart (src/core/gluecron-bridge.js, `GluecronBridge`) implements
 * the same contract — see that file for host-parity gaps.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { HostBridge, registerBridge } = require('./host-bridge');

const GITHUB_API_HOST = 'api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'GateTest/1.1.0';

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 4,
  baseDelayMs: 2000,    // 2s, 4s, 8s, 16s
  maxDelayMs: 30000,    // Cap at 30s
  retryableStatuses: [408, 429, 500, 502, 503, 504],
};

// Circuit breaker configuration
const CIRCUIT_BREAKER = {
  failureThreshold: 5,    // Open circuit after 5 consecutive failures
  resetTimeMs: 60000,     // Try again after 60s
  halfOpenRequests: 1,    // Allow 1 test request when half-open
};

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Circuit breaker state — shared across all requests in this process.
 */
const circuitState = {
  status: 'closed',       // closed (normal) | open (blocking) | half-open (testing)
  failures: 0,
  lastFailureTime: null,
  lastSuccessTime: null,
};

/**
 * Rate limit state — updated from GitHub response headers.
 */
const rateLimitState = {
  remaining: null,
  limit: null,
  resetTime: null,        // Unix timestamp when limit resets
};

/**
 * Check if the circuit breaker allows a request through.
 */
function circuitAllows() {
  if (circuitState.status === 'closed') return true;

  if (circuitState.status === 'open') {
    const elapsed = Date.now() - circuitState.lastFailureTime;
    if (elapsed >= CIRCUIT_BREAKER.resetTimeMs) {
      circuitState.status = 'half-open';
      return true;
    }
    return false;
  }

  // half-open: allow one test request
  return true;
}

/**
 * Record a successful API call — resets circuit breaker.
 */
function recordSuccess() {
  circuitState.failures = 0;
  circuitState.status = 'closed';
  circuitState.lastSuccessTime = Date.now();
}

/**
 * Record a failed API call — may trip the circuit breaker.
 */
function recordFailure() {
  circuitState.failures++;
  circuitState.lastFailureTime = Date.now();

  if (circuitState.failures >= CIRCUIT_BREAKER.failureThreshold) {
    circuitState.status = 'open';
  }
}

/**
 * Update rate limit state from response headers.
 */
function updateRateLimit(headers) {
  if (headers['x-ratelimit-remaining'] !== undefined) {
    rateLimitState.remaining = parseInt(headers['x-ratelimit-remaining'], 10);
  }
  if (headers['x-ratelimit-limit'] !== undefined) {
    rateLimitState.limit = parseInt(headers['x-ratelimit-limit'], 10);
  }
  if (headers['x-ratelimit-reset'] !== undefined) {
    rateLimitState.resetTime = parseInt(headers['x-ratelimit-reset'], 10);
  }
}

// Longest we'll block a CLI/Action invocation waiting out a GitHub rate
// limit reset. GitHub resets can be up to an hour out; blocking that long
// with zero feedback is bad UX, but the old `< 120000` cap silently skipped
// the wait entirely beyond 2 minutes — meaning the caller proceeded with
// almost no quota left and hammered 429s instead (Known Issue #25). Now:
// wait (with a console heads-up) up to this ceiling, and refuse fast with
// a clear reset time beyond it, instead of silently doing either extreme.
const RATE_LIMIT_MAX_WAIT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Wait if we're about to hit the rate limit.
 * Returns the number of ms waited (0 if no wait needed).
 * Throws if the reset is too far out to wait inline (see
 * RATE_LIMIT_MAX_WAIT_MS) — refusing fast beats silently hammering 429s.
 */
async function respectRateLimit() {
  if (rateLimitState.remaining !== null && rateLimitState.remaining <= 5) {
    if (rateLimitState.resetTime) {
      const waitMs = Math.max(0, (rateLimitState.resetTime * 1000) - Date.now() + 1000);
      if (waitMs <= 0) return 0;
      if (waitMs > RATE_LIMIT_MAX_WAIT_MS) {
        const resetIso = new Date(rateLimitState.resetTime * 1000).toISOString();
        throw new Error(
          `[GateTest] GitHub API rate limit nearly exhausted (${rateLimitState.remaining} remaining) ` +
          `and the reset is ${Math.ceil(waitMs / 60000)} minute(s) away (${resetIso}) — too long to ` +
          `wait inline. Refusing this request instead of hammering 429s; try again after the reset.`
        );
      }
      // eslint-disable-next-line no-console
      console.warn(`[GateTest] GitHub API rate limit nearly exhausted — waiting ${Math.ceil(waitMs / 1000)}s for reset...`);
      await sleep(waitMs);
      return waitMs;
    }
  }
  return 0;
}

/**
 * Resolves the GitHub token from environment or config file.
 * Priority: env GATETEST_GITHUB_TOKEN > .gatetest/config.json > GITHUB_TOKEN env
 */
function resolveToken(projectRoot) {
  if (process.env.GATETEST_GITHUB_TOKEN) {
    return process.env.GATETEST_GITHUB_TOKEN;
  }

  const configPath = path.join(projectRoot || process.cwd(), '.gatetest', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      if (config.github && config.github.token) {
        return config.github.token;
      }
    } catch (_) {
      // Fall through to next resolution strategy.
    }
  }

  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  return null;
}

/**
 * Single HTTPS request (no retry) against the GitHub REST API v3.
 */
function rawRequest(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: GITHUB_API_HOST,
      port: 443,
      path: urlPath,
      method,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
    };

    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    let payload = null;
    if (body !== undefined && body !== null) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let data = raw;
        try {
          data = JSON.parse(raw);
        } catch (_) {
          // Response may not be JSON (e.g. 204 No Content).
        }

        // Update rate limit tracking from every response
        updateRateLimit(res.headers);

        resolve({ statusCode: res.statusCode, headers: res.headers, data });
      });
    });

    req.on('error', (err) => reject(new Error(`GitHub API request failed: ${err.message}`)));
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error(`GitHub API request timed out: ${method} ${urlPath}`));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Resilient API request with retry, circuit breaker, and rate limit awareness.
 * This is the function all GitHubBridge methods should use.
 */
async function apiRequest(method, urlPath, token, body) {
  // Check circuit breaker
  if (!circuitAllows()) {
    const waitSec = Math.ceil((CIRCUIT_BREAKER.resetTimeMs - (Date.now() - circuitState.lastFailureTime)) / 1000);
    throw new Error(
      `[GateTest] GitHub API circuit breaker is OPEN — ${circuitState.failures} consecutive failures. ` +
      `Retrying in ${waitSec}s. GitHub may be experiencing an outage.`
    );
  }

  // Respect rate limits
  await respectRateLimit();

  let lastError = null;
  let lastResponse = null;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const res = await rawRequest(method, urlPath, token, body);
      lastResponse = res;

      // Success
      if (res.statusCode >= 200 && res.statusCode < 400) {
        recordSuccess();
        return res;
      }

      // Rate limited — wait for reset
      if (res.statusCode === 429) {
        recordFailure();
        const retryAfter = res.headers['retry-after']
          ? parseInt(res.headers['retry-after'], 10) * 1000
          : RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);

        const waitMs = Math.min(retryAfter, RETRY_CONFIG.maxDelayMs);
        if (attempt < RETRY_CONFIG.maxRetries) {
          await sleep(waitMs);
          continue;
        }
      }

      // Retryable server error (500, 502, 503, 504)
      if (RETRY_CONFIG.retryableStatuses.includes(res.statusCode)) {
        recordFailure();
        if (attempt < RETRY_CONFIG.maxRetries) {
          const delayMs = Math.min(
            RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt),
            RETRY_CONFIG.maxDelayMs
          );
          await sleep(delayMs);
          continue;
        }
      }

      // Non-retryable error (4xx client errors except 408/429)
      return res;

    } catch (err) {
      recordFailure();
      lastError = err;

      if (attempt < RETRY_CONFIG.maxRetries) {
        const delayMs = Math.min(
          RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt),
          RETRY_CONFIG.maxDelayMs
        );
        await sleep(delayMs);
        continue;
      }
    }
  }

  // All retries exhausted
  if (lastResponse) {
    return lastResponse;
  }
  throw lastError || new Error(`[GateTest] GitHub API request failed after ${RETRY_CONFIG.maxRetries + 1} attempts`);
}


class GitHubBridge extends HostBridge {
  static get hostName() { return 'github'; }

  /**
   * @param {object} options
   * @param {string} [options.token] - GitHub token (PAT or GitHub App installation token).
   * @param {string} [options.projectRoot] - Project root for config file resolution.
   */
  constructor(options = {}) {
    super(options);
    this.token = options.token || resolveToken(this.projectRoot);
  }

  // ---------------------------------------------------------------------------
  // Health check & diagnostics
  // ---------------------------------------------------------------------------

  /**
   * Check if GitHub API is reachable and responsive.
   * Returns { available, latencyMs, rateLimit, circuitBreaker }.
   * Call this BEFORE starting a paid scan to verify access.
   */
  async healthCheck() {
    const start = Date.now();
    try {
      const res = await rawRequest('GET', '/rate_limit', this.token, null);
      const latencyMs = Date.now() - start;

      return {
        available: res.statusCode === 200,
        latencyMs,
        statusCode: res.statusCode,
        rateLimit: {
          remaining: rateLimitState.remaining,
          limit: rateLimitState.limit,
          resetsAt: rateLimitState.resetTime
            ? new Date(rateLimitState.resetTime * 1000).toISOString()
            : null,
        },
        circuitBreaker: {
          status: circuitState.status,
          failures: circuitState.failures,
        },
      };
    } catch (err) {
      return {
        available: false,
        latencyMs: Date.now() - start,
        error: err.message,
        circuitBreaker: {
          status: circuitState.status,
          failures: circuitState.failures,
        },
      };
    }
  }

  /**
   * Get current circuit breaker and rate limit status.
   */
  getAccessStatus() {
    return {
      circuitBreaker: { ...circuitState },
      rateLimit: { ...rateLimitState },
      retryConfig: { ...RETRY_CONFIG },
    };
  }

  /**
   * Manually reset the circuit breaker (e.g. after confirming GitHub is back).
   */
  resetCircuitBreaker() {
    circuitState.status = 'closed';
    circuitState.failures = 0;
    circuitState.lastFailureTime = null;
  }

  // ---------------------------------------------------------------------------
  // Resilient repo access — multiple strategies
  // ---------------------------------------------------------------------------

  /**
   * Access a repository using the best available strategy.
   * Tries in order: API clone → HTTPS git clone → SSH clone.
   *
   * This is the method to use when a customer pays for a scan.
   * It WILL get their code, or clearly explain why it can't.
   *
   * @returns {{ strategy: string, localPath: string }}
   */
  async accessRepo(owner, repo, destDir, options = {}) {
    const strategies = [
      { name: 'https-clone', fn: () => this._cloneHttps(owner, repo, destDir, options) },
      { name: 'ssh-clone', fn: () => this._cloneSsh(owner, repo, destDir, options) },
      { name: 'api-download', fn: () => this._downloadViaApi(owner, repo, destDir, options) },
    ];

    const errors = [];

    for (const strategy of strategies) {
      try {
        await strategy.fn();
        return { strategy: strategy.name, localPath: destDir };
      } catch (err) {
        errors.push({ strategy: strategy.name, error: err.message });
      }
    }

    // All strategies failed — give a clear diagnostic
    const errorReport = errors.map(e => `  - ${e.strategy}: ${e.error}`).join('\n');
    throw new Error(
      `[GateTest] CANNOT ACCESS REPO ${owner}/${repo}\n` +
      `All access strategies failed:\n${errorReport}\n\n` +
      `Possible causes:\n` +
      `  - Repository is private and no valid token is configured\n` +
      `  - GitHub is experiencing an outage (check githubstatus.com)\n` +
      `  - Network connectivity issue\n` +
      `  - Token has insufficient permissions (needs 'repo' scope)\n\n` +
      `Run 'gatetest --health' to diagnose connectivity.`
    );
  }

  async _cloneHttps(owner, repo, destDir, options) {
    const url = this.token
      ? `https://x-access-token:${this.token}@github.com/${owner}/${repo}.git`
      : `https://github.com/${owner}/${repo}.git`;

    const args = ['clone', '--single-branch'];
    if (options.depth) args.push('--depth', String(options.depth));
    if (options.branch) args.push('--branch', options.branch);
    args.push(url, destDir);

    return this._git(args, options.cwd || this.projectRoot);
  }

  async _cloneSsh(owner, repo, destDir, options) {
    const url = `git@github.com:${owner}/${repo}.git`;
    const args = ['clone', '--single-branch'];
    if (options.depth) args.push('--depth', String(options.depth));
    if (options.branch) args.push('--branch', options.branch);
    args.push(url, destDir);

    return this._git(args, options.cwd || this.projectRoot);
  }

  async _downloadViaApi(owner, repo, destDir, options) {
    const branch = options.branch || 'main';
    const res = await this._api('GET', `/repos/${owner}/${repo}/tarball/${branch}`);

    if (res.statusCode === 302 && res.headers.location) {
      // GitHub redirects to a download URL
      const tarball = await this._downloadUrl(res.headers.location);
      fs.mkdirSync(destDir, { recursive: true });
      const tarPath = path.join(destDir, '__gatetest_download.tar.gz');
      fs.writeFileSync(tarPath, tarball);

      // Extract
      await this._git(['init'], destDir);
      const { execSync } = require('child_process');
      execSync(`tar -xzf "${tarPath}" --strip-components=1 -C "${destDir}"`, { timeout: 60000 });
      fs.unlinkSync(tarPath);
      return destDir;
    }

    throw new Error(`API download failed (HTTP ${res.statusCode})`);
  }

  _downloadUrl(url) {
    return new Promise((resolve, reject) => {
      const handler = url.startsWith('https') ? https : require('http');
      handler.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        // Follow one redirect
        if (res.statusCode === 302 && res.headers.location) {
          handler.get(res.headers.location, { headers: { 'User-Agent': USER_AGENT } }, (res2) => {
            const chunks = [];
            res2.on('data', c => chunks.push(c));
            res2.on('end', () => resolve(Buffer.concat(chunks)));
          }).on('error', reject);
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
  }

  // ---------------------------------------------------------------------------
  // Authentication helpers
  // ---------------------------------------------------------------------------

  /**
   * Verify the current token is valid by calling /user (PAT) or /app (App token).
   * Returns the authenticated identity or throws on failure.
   */
  async verifyAuth() {
    if (!this.token) {
      throw new Error('[GateTest] No GitHub token configured. Set GATETEST_GITHUB_TOKEN or add github.token to .gatetest/config.json');
    }

    // Try /user first (works for PATs and OAuth tokens).
    const res = await this._api('GET', '/user');
    if (res.statusCode === 200) {
      return { type: 'user', login: res.data.login, id: res.data.id };
    }

    // Fall back to /app (works for GitHub App installation tokens).
    const appRes = await this._api('GET', '/app');
    if (appRes.statusCode === 200) {
      return { type: 'app', name: appRes.data.name, id: appRes.data.id };
    }

    throw new Error(`[GateTest] GitHub authentication failed (HTTP ${res.statusCode})`);
  }

  // ---------------------------------------------------------------------------
  // Repository operations
  // ---------------------------------------------------------------------------

  /**
   * Clone a repository into a local directory.
   * Uses git CLI to leverage credential helpers and SSH keys.
   */
  cloneRepo(owner, repo, destDir, options = {}) {
    const url = `https://github.com/${owner}/${repo}.git`;
    const args = ['clone'];

    if (options.depth) {
      args.push('--depth', String(options.depth));
    }
    if (options.branch) {
      args.push('--branch', options.branch);
    }

    args.push(url, destDir);

    return this._git(args, options.cwd || this.projectRoot);
  }

  /**
   * Pull latest changes for the current branch.
   */
  pull(repoDir, options = {}) {
    const args = ['pull'];
    if (options.rebase) {
      args.push('--rebase');
    }
    return this._git(args, repoDir);
  }

  /**
   * Push local commits to the remote.
   */
  push(repoDir, options = {}) {
    const args = ['push'];
    if (options.remote) {
      args.push(options.remote);
    }
    if (options.branch) {
      args.push(options.branch);
    }
    if (options.setUpstream) {
      args.splice(1, 0, '-u');
    }
    return this._git(args, repoDir);
  }

  /**
   * Create a new branch on the remote via the GitHub API.
   * Branches from the given base SHA.
   */
  async createBranch(owner, repo, branchName, baseSha) {
    const res = await this._api('POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });

    if (res.statusCode !== 201) {
      throw this._apiError('createBranch', res);
    }
    return res.data;
  }

  /**
   * Get the default branch and its HEAD SHA for a repository.
   */
  async getDefaultBranch(owner, repo) {
    const res = await this._api('GET', `/repos/${owner}/${repo}`);
    if (res.statusCode !== 200) {
      throw this._apiError('getDefaultBranch', res);
    }
    const defaultBranch = res.data.default_branch;

    const refRes = await this._api('GET', `/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`);
    if (refRes.statusCode !== 200) {
      throw this._apiError('getDefaultBranch (ref)', refRes);
    }

    return {
      name: defaultBranch,
      sha: refRes.data.object.sha,
    };
  }

  // ---------------------------------------------------------------------------
  // Pull request operations
  // ---------------------------------------------------------------------------

  /**
   * Create a pull request.
   */
  async createPullRequest(owner, repo, options) {
    const body = {
      title: options.title,
      body: options.body || '',
      head: options.head,
      base: options.base,
    };
    if (options.draft !== undefined) {
      body.draft = options.draft;
    }

    const res = await this._api('POST', `/repos/${owner}/${repo}/pulls`, body);
    if (res.statusCode !== 201) {
      throw this._apiError('createPullRequest', res);
    }
    return res.data;
  }

  /**
   * Get a pull request by number.
   */
  async getPullRequest(owner, repo, prNumber) {
    const res = await this._api('GET', `/repos/${owner}/${repo}/pulls/${prNumber}`);
    if (res.statusCode !== 200) {
      throw this._apiError('getPullRequest', res);
    }
    return res.data;
  }

  /**
   * Update a pull request (title, body, state, base).
   */
  async updatePullRequest(owner, repo, prNumber, updates) {
    const res = await this._api('PATCH', `/repos/${owner}/${repo}/pulls/${prNumber}`, updates);
    if (res.statusCode !== 200) {
      throw this._apiError('updatePullRequest', res);
    }
    return res.data;
  }

  /**
   * Add a comment to a pull request (or issue).
   */
  async addPrComment(owner, repo, prNumber, body) {
    const res = await this._api('POST', `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      body,
    });
    if (res.statusCode !== 201) {
      throw this._apiError('addPrComment', res);
    }
    return res.data;
  }

  /**
   * Idempotent PR comment: find a prior bot comment matching `marker`
   * (an HTML-comment signature substring) and PATCH it in place; if no
   * match exists, POST a new comment.
   *
   * Without this, every push to a PR spawns a duplicate GateTest comment
   * (Known Issue #23). On a busy 30-commit PR the conversation tab fills
   * with 30 near-identical bot comments. PATCH-in-place keeps a single
   * up-to-date summary thread.
   *
   * @returns {Promise<{action: 'created'|'updated', commentId: number}>}
   */
  async upsertPrComment(owner, repo, prNumber, body, marker) {
    if (!marker || typeof marker !== 'string') {
      throw new Error('upsertPrComment requires a non-empty `marker` string to match prior comments');
    }
    // GitHub paginates comments at 100 per page. We scan up to 10 pages
    // (1000 comments) which is well above any realistic PR comment count.
    // First match wins — most-recent re-comments are rare; if multiple
    // exist (legacy state from before upsert shipped) we update the oldest
    // and leave the rest as orphans (cosmetic, not a correctness issue).
    for (let page = 1; page <= 10; page += 1) {
      const comments = await this.listPrComments(owner, repo, prNumber, { page, perPage: 100 });
      for (const c of comments) {
        if (c && typeof c.body === 'string' && c.body.includes(marker)) {
          const patchRes = await this._api(
            'PATCH',
            `/repos/${owner}/${repo}/issues/comments/${c.id}`,
            { body },
          );
          if (patchRes.statusCode !== 200) {
            throw this._apiError('upsertPrComment (PATCH)', patchRes);
          }
          return { action: 'updated', commentId: c.id };
        }
      }
      if (!comments || comments.length < 100) break;
    }
    // No prior comment with the marker — POST a fresh one.
    const created = await this.addPrComment(owner, repo, prNumber, body);
    return { action: 'created', commentId: created && created.id };
  }

  /**
   * Post an INLINE review comment on a specific line of a pull request's
   * diff. Distinct from `addPrComment` which posts to the conversation
   * tab — review comments appear ON THE DIFF and support GitHub's
   * "Suggested change" syntax (```suggestion ... ```), which renders a
   * one-click "Commit suggestion" button for the reviewer.
   *
   * https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request
   *
   * @param options { commitId, path, line, body, side?, startLine? }
   *   - commitId   — the head SHA of the PR (REQUIRED by GitHub)
   *   - path       — repo-relative file path (REQUIRED)
   *   - line       — last line of the range to anchor to (REQUIRED)
   *   - body       — markdown body, may contain a ```suggestion``` block
   *   - side       — 'RIGHT' (default, post-change) or 'LEFT' (pre-change)
   *   - startLine  — optional, for multi-line suggestions
   */
  async addPrReviewComment(owner, repo, prNumber, options) {
    const body = {
      body: options.body,
      commit_id: options.commitId,
      path: options.path,
      line: options.line,
      side: options.side || 'RIGHT',
    };
    if (options.startLine && options.startLine !== options.line) {
      body.start_line = options.startLine;
      body.start_side = options.side || 'RIGHT';
    }
    const res = await this._api(
      'POST',
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      body,
    );
    if (res.statusCode !== 201) {
      throw this._apiError('addPrReviewComment', res);
    }
    return res.data;
  }

  /**
   * List comments on a pull request.
   */
  async listPrComments(owner, repo, prNumber, options = {}) {
    const perPage = options.perPage || 100;
    const page = options.page || 1;
    const res = await this._api(
      'GET',
      `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=${perPage}&page=${page}`,
    );
    if (res.statusCode !== 200) {
      throw this._apiError('listPrComments', res);
    }
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // Commit operations
  // ---------------------------------------------------------------------------

  /**
   * Create a commit via the Git Data API (tree + commit).
   * Useful for creating commits without a local clone.
   */
  async createCommit(owner, repo, options) {
    const commitBody = {
      message: options.message,
      tree: options.tree,
      parents: options.parents,
    };
    if (options.author) {
      commitBody.author = options.author;
    }

    const res = await this._api('POST', `/repos/${owner}/${repo}/git/commits`, commitBody);
    if (res.statusCode !== 201) {
      throw this._apiError('createCommit', res);
    }
    return res.data;
  }

  /**
   * Get a single commit by SHA.
   */
  async getCommit(owner, repo, sha) {
    const res = await this._api('GET', `/repos/${owner}/${repo}/commits/${sha}`);
    if (res.statusCode !== 200) {
      throw this._apiError('getCommit', res);
    }
    return res.data;
  }

  /**
   * List commits on a branch or path.
   */
  async listCommits(owner, repo, options = {}) {
    const params = new URLSearchParams();
    if (options.sha) params.set('sha', options.sha);
    if (options.path) params.set('path', options.path);
    if (options.since) params.set('since', options.since);
    if (options.until) params.set('until', options.until);
    params.set('per_page', String(options.perPage || 30));
    params.set('page', String(options.page || 1));

    const res = await this._api('GET', `/repos/${owner}/${repo}/commits?${params.toString()}`);
    if (res.statusCode !== 200) {
      throw this._apiError('listCommits', res);
    }
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // Status checks
  // ---------------------------------------------------------------------------

  /**
   * Set a commit status (pending, success, failure, error).
   * This is the primary mechanism for reporting GateTest results back to GitHub.
   *
   * @param {string} owner - Repository owner.
   * @param {string} repo  - Repository name.
   * @param {string} sha   - Full commit SHA.
   * @param {'pending'|'success'|'failure'|'error'} state - Status state.
   * @param {string} description - Short description (max 140 chars).
   * @param {object} [options]
   * @param {string} [options.targetUrl] - URL to link from the status.
   * @param {string} [options.context]   - Status context name (default: 'gatetest').
   */
  async setCommitStatus(owner, repo, sha, state, description, options = {}) {
    this._validateCommitState(state);

    const body = {
      state,
      description: description.slice(0, 140),
      context: options.context || 'gatetest',
    };
    if (options.targetUrl) {
      body.target_url = options.targetUrl;
    }

    const res = await this._api('POST', `/repos/${owner}/${repo}/statuses/${sha}`, body);
    if (res.statusCode !== 201) {
      throw this._apiError('setCommitStatus', res);
    }
    return res.data;
  }

  /**
   * Get combined status for a ref (branch name, tag, or SHA).
   */
  async getCombinedStatus(owner, repo, ref) {
    const res = await this._api('GET', `/repos/${owner}/${repo}/commits/${ref}/status`);
    if (res.statusCode !== 200) {
      throw this._apiError('getCombinedStatus', res);
    }
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // Webhook handling
  // ---------------------------------------------------------------------------

  /**
   * Create an HTTP server that listens for GitHub webhook events.
   * Returns the server instance (caller must call .listen()).
   *
   * @param {object} handlers - Map of event names to handler functions.
   *   e.g. { push: (payload) => {}, pull_request: (payload) => {} }
   * @param {object} [options]
   * @param {string} [options.secret] - Webhook secret for signature verification.
   */
  createWebhookServer(handlers, options = {}) {
    const http = require('http');
    const crypto = require('crypto');

    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }

      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const event = req.headers['x-github-event'];

        // Verify webhook signature if secret is configured.
        if (options.secret) {
          const signature = req.headers['x-hub-signature-256'];
          const expected = 'sha256=' + crypto
            .createHmac('sha256', options.secret)
            .update(rawBody)
            .digest('hex');

          if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Invalid signature');
            return;
          }
        }

        let payload;
        try {
          payload = JSON.parse(rawBody.toString('utf-8'));
        } catch (_) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid JSON');
          return;
        }

        const handler = handlers[event];
        if (handler) {
          // Fire-and-forget; handler errors are logged but don't break the webhook response.
          Promise.resolve(handler(payload, event)).catch((err) => {
            console.error(`[GateTest] Webhook handler error (${event}):`, err.message);
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true, event }));
      });
    });

    return server;
  }

  // ---------------------------------------------------------------------------
  // Report posting — `postGateResult` and `reportResults` are inherited from
  // HostBridge. They are host-agnostic and delegate to this bridge's
  // `addPrComment` and `setCommitStatus` primitives above.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Wrapper around apiRequest that injects the instance token.
   */
  _api(method, urlPath, body) {
    return apiRequest(method, urlPath, this.token, body);
  }

  /**
   * Build a descriptive error from a failed API response.
   */
  _apiError(operation, res) {
    const msg = res.data && res.data.message ? res.data.message : JSON.stringify(res.data);
    return new Error(`[GateTest] ${operation} failed (HTTP ${res.statusCode}): ${msg}`);
  }

  /**
   * Run a git CLI command and return a promise with stdout.
   */
  _git(args, cwd) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, timeout: 120000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`[GateTest] git ${args[0]} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

}

// Auto-register this bridge under host name "github" so
// createBridge('github', options) works without extra wiring.
registerBridge(GitHubBridge.hostName, GitHubBridge);

module.exports = {
  GitHubBridge,
  resolveToken,
  apiRequest,
  // Exposed for testing and diagnostics
  circuitState,
  rateLimitState,
  RETRY_CONFIG,
  CIRCUIT_BREAKER,
  respectRateLimit,
  RATE_LIMIT_MAX_WAIT_MS,
};
