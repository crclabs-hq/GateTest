/**
 * GateTest Gluecron Bridge — concrete HostBridge implementation for
 * Gluecron.com (our own git host, competitor replacement for GitHub).
 *
 * ZERO TOLERANCE FOR ACCESS FAILURES.
 * If a customer pays for GateTest, we access their repo on Gluecron. Period.
 *
 * Resilience features mirror GitHubBridge:
 *   - Automatic retry with exponential backoff (2s, 4s, 8s, 16s)
 *   - Circuit breaker: detects Gluecron outages, backs off gracefully
 *   - Rate limit awareness: reads X-RateLimit headers if present
 *   - Health check: verify Gluecron is reachable before starting a scan
 *
 * Uses Node.js built-in https module — no external dependencies.
 *
 * Extends `HostBridge` — host-agnostic contract (src/core/host-bridge.js).
 * The report markdown + reportResults/postGateResult convenience methods
 * live on the base class and are shared with GitHubBridge.
 *
 * Wire contract: see the Bible (CLAUDE.md) and Gluecron.com/GATETEST_HOOK.md.
 *
 * Env vars:
 *   GLUECRON_BASE_URL   — e.g. https://gluecron.com
 *   GLUECRON_API_TOKEN  — PAT with `repo` scope, format `glc_<64hex>`
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { HostBridge, registerBridge } = require('./host-bridge');

const USER_AGENT = 'GateTest/1.2.0 (+gluecron-bridge)';

// Retry configuration — mirrors GitHubBridge exactly so operational
// behaviour is identical across hosts.
const RETRY_CONFIG = {
  maxRetries: 4,
  baseDelayMs: 2000,    // 2s, 4s, 8s, 16s
  maxDelayMs: 30000,    // Cap at 30s
  retryableStatuses: [408, 429, 500, 502, 503, 504],
};

// Circuit breaker configuration
const CIRCUIT_BREAKER = {
  failureThreshold: 5,
  resetTimeMs: 60000,
  halfOpenRequests: 1,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared circuit-breaker state for this process. Separate from GitHub's
// so an outage on one host doesn't trip the other.
const circuitState = {
  status: 'closed',
  failures: 0,
  lastFailureTime: null,
  lastSuccessTime: null,
};

const rateLimitState = {
  remaining: null,
  limit: null,
  resetTime: null,
};

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

  return true;
}

function recordSuccess() {
  circuitState.failures = 0;
  circuitState.status = 'closed';
  circuitState.lastSuccessTime = Date.now();
}

function recordFailure() {
  circuitState.failures++;
  circuitState.lastFailureTime = Date.now();

  if (circuitState.failures >= CIRCUIT_BREAKER.failureThreshold) {
    circuitState.status = 'open';
  }
}

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

async function respectRateLimit() {
  if (rateLimitState.remaining !== null && rateLimitState.remaining <= 5) {
    if (rateLimitState.resetTime) {
      const waitMs = Math.max(0, (rateLimitState.resetTime * 1000) - Date.now() + 1000);
      if (waitMs > 0 && waitMs < 120000) {
        await sleep(waitMs);
        return waitMs;
      }
    }
  }
  return 0;
}

/**
 * Resolve token from env — no config-file fallback, Gluecron is env-only.
 */
function resolveToken() {
  return process.env.GLUECRON_API_TOKEN || null;
}

/**
 * Resolve base URL. Defaults to https://gluecron.com if unset so a bridge
 * instance is always usable; overrideable for staging / self-hosted.
 */
function resolveBaseUrl(override) {
  const raw = override || process.env.GLUECRON_BASE_URL || 'https://gluecron.com';
  return raw.replace(/\/+$/, ''); // strip trailing slash for clean concat
}

/**
 * Single HTTPS/HTTP request (no retry). Uses URL parsing so we don't
 * assume hostname/port/protocol — Gluecron is Crontech-hosted today
 * but could move.
 */
function rawRequest(method, baseUrl, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlPath, baseUrl);
    const handler = parsed.protocol === 'http:' ? http : https;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
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

    const req = handler.request(options, (res) => {
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

        updateRateLimit(res.headers);
        resolve({ statusCode: res.statusCode, headers: res.headers, data });
      });
    });

    req.on('error', (err) => reject(new Error(`Gluecron API request failed: ${err.message}`)));
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error(`Gluecron API request timed out: ${method} ${urlPath}`));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Resilient request with retry + circuit breaker + rate-limit awareness.
 */
async function apiRequest(method, baseUrl, urlPath, token, body) {
  if (!circuitAllows()) {
    const waitSec = Math.ceil(
      (CIRCUIT_BREAKER.resetTimeMs - (Date.now() - circuitState.lastFailureTime)) / 1000
    );
    throw new Error(
      `[GateTest] Gluecron API circuit breaker is OPEN — ${circuitState.failures} consecutive failures. ` +
      `Retrying in ${waitSec}s. Gluecron may be experiencing an outage.`
    );
  }

  await respectRateLimit();

  let lastError = null;
  let lastResponse = null;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const res = await rawRequest(method, baseUrl, urlPath, token, body);
      lastResponse = res;

      if (res.statusCode >= 200 && res.statusCode < 400) {
        recordSuccess();
        return res;
      }

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

  if (lastResponse) {
    return lastResponse;
  }
  throw lastError || new Error(
    `[GateTest] Gluecron API request failed after ${RETRY_CONFIG.maxRetries + 1} attempts`
  );
}


class GluecronBridge extends HostBridge {
  static get hostName() { return 'gluecron'; }

  /**
   * @param {object} options
   * @param {string} [options.token]      - Gluecron PAT (glc_<64hex>). Falls back to GLUECRON_API_TOKEN.
   * @param {string} [options.baseUrl]    - Override base URL. Falls back to GLUECRON_BASE_URL.
   * @param {string} [options.projectRoot]
   */
  constructor(options = {}) {
    super(options);
    this.token = options.token || resolveToken();
    this.baseUrl = resolveBaseUrl(options.baseUrl);
  }

  // ---------------------------------------------------------------------------
  // Health check & diagnostics
  // ---------------------------------------------------------------------------

  /**
   * Ping the unauthenticated /api/hooks/ping endpoint AND (if token is
   * present) verify auth via /api/v2/user. Returns a combined status.
   */
  async healthCheck() {
    const start = Date.now();
    try {
      const pingRes = await rawRequest('GET', this.baseUrl, '/api/hooks/ping', null, null);
      const pingLatency = Date.now() - start;

      let authOk = false;
      let authError = null;
      if (this.token) {
        try {
          const userRes = await rawRequest('GET', this.baseUrl, '/api/v2/user', this.token, null);
          authOk = userRes.statusCode === 200;
          if (!authOk) {
            authError = `auth probe returned HTTP ${userRes.statusCode}`;
          }
        } catch (err) {
          authError = err.message;
        }
      }

      return {
        available: pingRes.statusCode === 200,
        authenticated: authOk,
        authError,
        latencyMs: pingLatency,
        statusCode: pingRes.statusCode,
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
        authenticated: false,
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
   * Verify the current token is valid. Hits GET /api/v2/user.
   */
  async verifyAuth() {
    if (!this.token) {
      throw new Error(
        '[GateTest] No Gluecron token configured. Set GLUECRON_API_TOKEN ' +
        '(format: glc_<64hex>, scope: repo).'
      );
    }
    const res = await this._api('GET', '/api/v2/user');
    if (res.statusCode === 200) {
      // Gluecron v2 returns `username`; support `login` too for forward-compat.
      const login = res.data.login || res.data.username;
      return { type: 'user', login, id: res.data.id };
    }
    throw new Error(`[GateTest] Gluecron authentication failed (HTTP ${res.statusCode})`);
  }

  getAccessStatus() {
    return {
      circuitBreaker: { ...circuitState },
      rateLimit: { ...rateLimitState },
      retryConfig: { ...RETRY_CONFIG },
    };
  }

  resetCircuitBreaker() {
    circuitState.status = 'closed';
    circuitState.failures = 0;
    circuitState.lastFailureTime = null;
  }

  // ---------------------------------------------------------------------------
  // Repository operations
  // ---------------------------------------------------------------------------

  async getDefaultBranch(owner, repo) {
    const res = await this._api('GET', `/api/v2/repos/${owner}/${repo}`);
    if (res.statusCode !== 200) {
      throw this._apiError('getDefaultBranch', res);
    }
    const defaultBranch = res.data.defaultBranch || res.data.default_branch;
    // Gluecron returns the repo shape with defaultBranch + owner.login.
    // Fetch the tip SHA by reading the tree (first-class GET is sufficient
    // because the tree response includes a `sha` per the wire contract).
    const treeRes = await this._api(
      'GET',
      `/api/v2/repos/${owner}/${repo}/tree/${encodeURIComponent(defaultBranch)}?recursive=1`
    );
    if (treeRes.statusCode !== 200) {
      throw this._apiError('getDefaultBranch (tree)', treeRes);
    }
    return {
      name: defaultBranch,
      sha: treeRes.data.sha || (treeRes.data.tree && treeRes.data.tree[0] && treeRes.data.tree[0].sha) || null,
    };
  }

  /**
   * Create a new branch ref.
   * Gluecron accepts `{ ref: "refs/heads/<name>", sha }` (matches GitHub shape).
   */
  async createBranch(owner, repo, branchName, baseSha) {
    const res = await this._api('POST', `/api/v2/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });
    if (res.statusCode !== 201) {
      throw this._apiError('createBranch', res);
    }
    return res.data;
  }

  /**
   * accessRepo / cloneRepo / pull / push — Gluecron exposes its tree
   * and contents APIs for remote scans rather than local git. We stub
   * them with a clear message pointing callers at the API helpers.
   *
   * TODO(host-parity): GitHubBridge implements these via local git clone;
   * this is an intentional, permanent gap (Gluecron has no git-clone
   * transport), not a missing feature to build. Flagged per the Bible's
   * host-parity convention (CLAUDE.md → STRATEGIC DIRECTION).
   */
  async accessRepo(owner, repo, _destDir, _options) {
    throw new Error(
      `[GateTest] GluecronBridge.accessRepo is not supported — use ` +
      `fetchTree/fetchBlob via website/app/lib/gluecron-client.ts to ` +
      `pull ${owner}/${repo} over HTTP. Local clone is out of scope for ` +
      `the serverless website path.`
    );
  }

  async cloneRepo(owner, repo) {
    throw new Error(
      `[GateTest] GluecronBridge.cloneRepo is not supported — use the ` +
      `Gluecron REST API (GET /api/v2/repos/${owner}/${repo}/tree/:ref).`
    );
  }

  async pull() {
    throw new Error('[GateTest] GluecronBridge.pull is not supported — use the REST API.');
  }

  async push() {
    throw new Error('[GateTest] GluecronBridge.push is not supported — use the REST API.');
  }

  // ---------------------------------------------------------------------------
  // Pull request operations
  // ---------------------------------------------------------------------------

  /**
   * Create a pull request.
   *
   * IMPORTANT: Gluecron uses `baseBranch` / `headBranch` in the body, NOT
   * GitHub's `base` / `head`. Callers should pass `options.base` /
   * `options.head` (to stay compatible with GitHubBridge's signature) and
   * we translate here.
   */
  async createPullRequest(owner, repo, options) {
    const body = {
      title: options.title,
      body: options.body || '',
      headBranch: options.headBranch || options.head,
      baseBranch: options.baseBranch || options.base,
    };
    if (options.draft !== undefined) {
      body.draft = options.draft;
    }
    const res = await this._api('POST', `/api/v2/repos/${owner}/${repo}/pulls`, body);
    if (res.statusCode !== 201) {
      throw this._apiError('createPullRequest', res);
    }
    return res.data;
  }

  async getPullRequest(owner, repo, prNumber) {
    const res = await this._api('GET', `/api/v2/repos/${owner}/${repo}/pulls/${prNumber}`);
    if (res.statusCode !== 200) {
      throw this._apiError('getPullRequest', res);
    }
    return res.data;
  }

  async updatePullRequest(owner, repo, prNumber, updates) {
    const res = await this._api('PATCH', `/api/v2/repos/${owner}/${repo}/pulls/${prNumber}`, updates);
    if (res.statusCode !== 200) {
      throw this._apiError('updatePullRequest', res);
    }
    return res.data;
  }

  /**
   * Add a comment to a PR. Gluecron's endpoint is
   * POST /api/v2/repos/:owner/:repo/pulls/:number/comments.
   */
  async addPrComment(owner, repo, prNumber, body) {
    const res = await this._api(
      'POST',
      `/api/v2/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      { body }
    );
    if (res.statusCode !== 201) {
      throw this._apiError('addPrComment', res);
    }
    return res.data;
  }

  async listPrComments(owner, repo, prNumber, options = {}) {
    const perPage = options.perPage || 100;
    const page = options.page || 1;
    const res = await this._api(
      'GET',
      `/api/v2/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=${perPage}&page=${page}`
    );
    if (res.statusCode !== 200) {
      throw this._apiError('listPrComments', res);
    }
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // Commits & statuses
  // ---------------------------------------------------------------------------

  async getCommit(owner, repo, sha) {
    const res = await this._api('GET', `/api/v2/repos/${owner}/${repo}/commits/${sha}`);
    if (res.statusCode !== 200) {
      throw this._apiError('getCommit', res);
    }
    return res.data;
  }

  async listCommits(owner, repo, options = {}) {
    const params = new URLSearchParams();
    if (options.sha) params.set('sha', options.sha);
    if (options.path) params.set('path', options.path);
    params.set('per_page', String(options.perPage || 30));
    params.set('page', String(options.page || 1));
    const res = await this._api('GET', `/api/v2/repos/${owner}/${repo}/commits?${params.toString()}`);
    if (res.statusCode !== 200) {
      throw this._apiError('listCommits', res);
    }
    return res.data;
  }

  /**
   * Gluecron doesn't expose a git-tree-commit create endpoint the same way
   * GitHub does — file writes go through PUT /contents. Callers doing
   * multi-file commits should upsert each file on a branch and open a PR.
   *
   * TODO(host-parity): intentional gap, not a missing feature to build —
   * see the note above accessRepo/cloneRepo/pull/push.
   */
  async createCommit() {
    throw new Error(
      '[GateTest] GluecronBridge.createCommit is not supported — upsert files ' +
      'via PUT /api/v2/repos/:owner/:repo/contents/:path on a branch, then ' +
      'open a PR.'
    );
  }

  /**
   * Set a commit status.
   * Body: { state, context, description, target_url? } matches the wire contract.
   */
  async setCommitStatus(owner, repo, sha, state, description, options = {}) {
    this._validateCommitState(state);

    const body = {
      state,
      description: (description || '').slice(0, 140),
      context: options.context || 'gatetest',
    };
    if (options.targetUrl) {
      body.target_url = options.targetUrl;
    }

    const res = await this._api('POST', `/api/v2/repos/${owner}/${repo}/statuses/${sha}`, body);
    if (res.statusCode !== 201) {
      throw this._apiError('setCommitStatus', res);
    }
    return res.data;
  }

  async getCombinedStatus(owner, repo, ref) {
    const res = await this._api('GET', `/api/v2/repos/${owner}/${repo}/commits/${ref}/status`);
    if (res.statusCode !== 200) {
      throw this._apiError('getCombinedStatus', res);
    }
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------

  /**
   * Gluecron push events land at /api/events/push on the website side —
   * they are NOT served by a long-lived Node server from this bridge.
   * For completeness we still provide a stub that callers can use for
   * local-dev tooling; it behaves the same as GitHubBridge's server but
   * validates Gluecron's X-Signal-Signature header (sha256=<hex>).
   */
  createWebhookServer(handlers, options = {}) {
    const localHttp = require('http');
    const crypto = require('crypto');

    const server = localHttp.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }

      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const event = req.headers['x-signal-event'] || req.headers['x-gluecron-event'];

        if (options.secret) {
          const signature = req.headers['x-signal-signature'];
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
          Promise.resolve(handler(payload, event)).catch((err) => {
            console.error(`[GateTest] Gluecron webhook handler error (${event}):`, err.message);
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true, event }));
      });
    });

    return server;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  _api(method, urlPath, body) {
    return apiRequest(method, this.baseUrl, urlPath, this.token, body);
  }

  _apiError(operation, res) {
    const msg = res.data && res.data.message ? res.data.message : JSON.stringify(res.data);
    return new Error(`[GateTest] Gluecron ${operation} failed (HTTP ${res.statusCode}): ${msg}`);
  }
}

// Auto-register so createBridge('gluecron', options) works without extra wiring.
registerBridge(GluecronBridge.hostName, GluecronBridge);

module.exports = {
  GluecronBridge,
  resolveToken,
  resolveBaseUrl,
  apiRequest,
  // Exposed for tests and diagnostics
  circuitState,
  rateLimitState,
  RETRY_CONFIG,
  CIRCUIT_BREAKER,
};
