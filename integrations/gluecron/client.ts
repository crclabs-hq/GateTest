/**
 * GateTest ↔ Gluecron v2 — typed HTTP client.
 *
 * Thin wrapper over the v2 REST surface added in Gluecron PR #16:
 *
 *   GET  /api/v2/user
 *   GET  /api/v2/repos/:owner/:repo                  — meta (defaultBranch, owner.login)
 *   GET  /api/v2/repos/:owner/:repo/tree/:ref        — recursive tree (cap 50k)
 *   GET  /api/v2/repos/:owner/:repo/contents/:path   — ?encoding=base64
 *   POST /api/v2/repos/:owner/:repo/git/refs         — create branch ref
 *   PUT  /api/v2/repos/:owner/:repo/contents/:path   — create/update a file
 *   POST /api/v2/repos/:owner/:repo/pulls            — open a PR
 *   GET  /api/v2/repos/:owner/:repo/pulls/:number    — read a PR
 *   POST /api/v2/repos/:owner/:repo/pulls/:number/comments — PR review comment
 *   POST /api/v2/repos/:owner/:repo/statuses/:sha    — commit status (v2 alias)
 *   GET  /api/v2/repos/:owner/:repo/commits/:sha     — commit with diff
 *
 * Design goals:
 *   - Zero external deps — built on global `fetch` (Node 18+ / Bun / browsers).
 *   - Exponential backoff for 5xx + 429; surface 4xx as typed errors.
 *   - Never log Authorization headers — redacted at the emit boundary.
 */

import type {
  CommitStatusState,
  GluecronClientOptions,
  GluecronCommit,
  GluecronCommitStatusResult,
  GluecronContents,
  GluecronContentsBase64,
  GluecronErrorBody,
  GluecronFileUpsertResult,
  GluecronPrComment,
  GluecronPullRequest,
  GluecronRefCreateResult,
  GluecronRepoMeta,
  GluecronResponse,
  GluecronTreeResponse,
  GluecronUser,
} from './types';

const USER_AGENT = 'GateTest/1.2.0 (+gluecron-bridge)';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BASE_URL = 'https://gluecron.com';

const RETRY_CONFIG = {
  maxRetries: 4,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  retryableStatuses: new Set([408, 429, 500, 502, 503, 504]),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(raw: string | undefined): string {
  // Canonical name: GLUECRON_BASE_URL (per CLAUDE.md ENVIRONMENT VARIABLES
  // table and root .env.example). The legacy GLUECRON_API_URL alias has
  // been removed — if a deployment was using it, update to the canonical
  // name (no behaviour change beyond the variable name).
  const resolved = raw ?? process.env.GLUECRON_BASE_URL ?? DEFAULT_BASE_URL;
  return resolved.replace(/\/+$/, '');
}

function resolveToken(explicit?: string): string | null {
  if (explicit) return explicit;
  // Canonical name: GLUECRON_API_TOKEN. Legacy GLUECRON_TOKEN alias removed.
  return process.env.GLUECRON_API_TOKEN || null;
}

/** Redact secrets from a headers object for safe logging. */
export function redactHeaders(headers: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!v) {
      out[k] = v;
      continue;
    }
    if (/^authorization$/i.test(k) || /^x-.*-token$/i.test(k) || /^cookie$/i.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Typed error surfaced for non-retryable (4xx) responses. */
export class GluecronApiError extends Error {
  readonly statusCode: number;
  readonly operation: string;
  readonly body: GluecronErrorBody | string | null;

  constructor(operation: string, statusCode: number, body: GluecronErrorBody | string | null) {
    const detail =
      body && typeof body === 'object'
        ? body.error || body.message || JSON.stringify(body)
        : body || '';
    super(`[GateTest] Gluecron ${operation} failed (HTTP ${statusCode})${detail ? `: ${detail}` : ''}`);
    this.name = 'GluecronApiError';
    this.statusCode = statusCode;
    this.operation = operation;
    this.body = body;
  }
}

export class GluecronCircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GluecronCircuitOpenError';
  }
}

interface ApiRequestInit {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  /** When true, bypass retry loop — used by health probes. */
  noRetry?: boolean;
  /** Operation name for error messages. */
  operation?: string;
}

/**
 * Typed client wrapping the v2 REST surface.
 */
export class GluecronClient {
  readonly baseUrl: string;
  readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly redactAuth: boolean;

  constructor(options: GluecronClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = resolveToken(options.token);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.redactAuth = options.redactAuth !== false;
    if (!this.fetchImpl) {
      throw new Error(
        '[GateTest] GluecronClient requires a fetch implementation. ' +
          'Upgrade to Node 18+/Bun, or pass options.fetchImpl.',
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Low-level HTTP
  // ────────────────────────────────────────────────────────────────────────

  /** Single request, no retry. */
  async rawRequest<T = unknown>(init: ApiRequestInit): Promise<GluecronResponse<T>> {
    const url = new URL(init.path, this.baseUrl + '/').toString();
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let body: string | undefined;
    if (init.body !== undefined && init.body !== null) {
      body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: init.method,
        headers,
        body,
        signal: controller.signal,
      });
      const raw = await res.text();
      let data: T = raw as unknown as T;
      if (raw) {
        try {
          data = JSON.parse(raw) as T;
        } catch {
          // keep string
        }
      }
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      return { statusCode: res.status, headers: outHeaders, data, raw };
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw new Error(
          `[GateTest] Gluecron API request timed out after ${this.timeoutMs}ms: ${init.method} ${init.path}`,
        );
      }
      throw new Error(
        `[GateTest] Gluecron API request failed: ${init.method} ${init.path} — ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resilient request — retries on 5xx / 429 with exponential backoff.
   * 4xx responses short-circuit and throw a typed {@link GluecronApiError}.
   */
  async request<T = unknown>(init: ApiRequestInit): Promise<GluecronResponse<T>> {
    const op = init.operation ?? `${init.method} ${init.path}`;
    let lastErr: unknown = null;

    const attempts = init.noRetry ? 1 : RETRY_CONFIG.maxRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let res: GluecronResponse<T> | null = null;
      try {
        res = await this.rawRequest<T>(init);
      } catch (err) {
        lastErr = err;
      }

      if (res) {
        // 2xx / 3xx — success
        if (res.statusCode >= 200 && res.statusCode < 400) {
          return res;
        }

        // 4xx (except 408/429) — surface immediately
        if (res.statusCode >= 400 && res.statusCode < 500 && !RETRY_CONFIG.retryableStatuses.has(res.statusCode)) {
          throw new GluecronApiError(op, res.statusCode, (res.data as GluecronErrorBody) ?? res.raw);
        }

        // Retryable — fall through to backoff
        if (!RETRY_CONFIG.retryableStatuses.has(res.statusCode)) {
          // Non-retryable 5xx outside our set — surface.
          throw new GluecronApiError(op, res.statusCode, (res.data as GluecronErrorBody) ?? res.raw);
        }

        lastErr = new GluecronApiError(op, res.statusCode, (res.data as GluecronErrorBody) ?? res.raw);

        // Honour Retry-After on 429.
        if (res.statusCode === 429) {
          const retryAfter = Number(res.headers['retry-after']);
          if (Number.isFinite(retryAfter) && retryAfter > 0 && attempt < attempts - 1) {
            await sleep(Math.min(retryAfter * 1_000, RETRY_CONFIG.maxDelayMs));
            continue;
          }
        }
      }

      if (attempt < attempts - 1) {
        const delayMs = Math.min(
          RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt),
          RETRY_CONFIG.maxDelayMs,
        );
        await sleep(delayMs);
      }
    }

    if (lastErr instanceof Error) throw lastErr;
    throw new Error(`[GateTest] Gluecron ${op} failed after ${attempts} attempts`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // v2 endpoint helpers (typed)
  // ────────────────────────────────────────────────────────────────────────

  getAuthenticatedUser(): Promise<GluecronResponse<GluecronUser>> {
    return this.request<GluecronUser>({
      method: 'GET',
      path: '/api/v2/user',
      operation: 'getAuthenticatedUser',
    });
  }

  getRepo(owner: string, repo: string): Promise<GluecronResponse<GluecronRepoMeta>> {
    return this.request<GluecronRepoMeta>({
      method: 'GET',
      path: `/api/v2/repos/${enc(owner)}/${enc(repo)}`,
      operation: 'getRepo',
    });
  }

  getTreeRecursive(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<GluecronResponse<GluecronTreeResponse>> {
    return this.request<GluecronTreeResponse>({
      method: 'GET',
      path: `/api/v2/repos/${enc(owner)}/${enc(repo)}/tree/${enc(ref)}?recursive=1`,
      operation: 'getTreeRecursive',
    });
  }

  getTree(
    owner: string,
    repo: string,
    ref: string,
    pathPrefix?: string,
  ): Promise<GluecronResponse<GluecronTreeResponse | unknown>> {
    const qs = pathPrefix ? `?path=${encodeURIComponent(pathPrefix)}` : '';
    return this.request({
      method: 'GET',
      path: `/api/v2/repos/${enc(owner)}/${enc(repo)}/tree/${enc(ref)}${qs}`,
      operation: 'getTree',
    });
  }

  /** Read a file as base64 (safe for binary). */
  getFileBase64(
    owner: string,
    repo: string,
    filePath: string,
    ref?: string,
  ): Promise<GluecronResponse<GluecronContentsBase64>> {
    const qs = new URLSearchParams({ encoding: 'base64' });
    if (ref) qs.set('ref', ref);
    return this.request<GluecronContentsBase64>({
      method: 'GET',
      path: `/api/v2/repos/${enc(owner)}/${enc(repo)}/contents/${encPath(filePath)}?${qs.toString()}`,
      operation: 'getFileBase64',
    });
  }

  /** Read a file as utf8 text (may be truncated/null for binary). */
  getFileText(
    owner: string,
    repo: string,
    filePath: string,
    ref?: string,
  ): Promise<GluecronResponse<GluecronContents>> {
    const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    return this.request<GluecronContents>({
      method: 'GET',
      path: `/api/v2/repos/${enc(owner)}/${enc(repo)}/contents/${encPath(filePath)}${qs}`,
      operation: 'getFileText',
    });
  }

  /** Create a branch (ref must be `refs/heads/<name>` or `refs/tags/<name>`). */
  createRef(
    owner: string,
    repo: string,
    ref: string,
    sha: string,
  ): Promise<GluecronResponse<GluecronRefCreateResult>> {
    return this.request<GluecronRefCreateResult>({
      method: 'POST',
      path: `/api/v2/repos/${enc(owner)}/${enc(repo)}/git/refs`,
      body: { ref, sha },
      operation: 'createRef',
    });
  }

  /** Upsert a file at `filePath` on `branch`. `content` MUST be base64. */
  upsertFile(
    owner: string,
    repo: string,
    filePath: string,
    input: {
      branch: string;
      message: string;
      contentBase64: string;
      /** When updating, pass the prior blob SHA for optimistic concurrency. */
      sha?: string | null;
    },
  ): Promise<GluecronResponse<GluecronFileUpsertResult>> {
    return this.request<GluecronFileUpsertResult>({
      method: 'PUT',
      path: `/api/v2/repos/${enc(owner)}/${enc(repo)}/contents/${encPath(filePath)}`,
      body: {
        branch: input.branch,
        message: input.message,
        content: input.contentBase64,
        sha: input.sha ?? null,
      },
      operation: 'upsertFile',
    });
  }

  createPullRequest(
    owner: string,
    repo: string,
    input: { title: string; body?: string; headBranch: string; baseBranch: string },
  ): Promise<GluecronResponse<GluecronPullRequest>> {
    return this.request<GluecronPullRequest>({
      method: 'POST',
      path: `/api/v2/repos/${enc(owner)}/${enc(repo)}/pulls`,
      body: input,
      operation: 'createPullRequest',
    });
  }

  getPullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GluecronResponse<GluecronPullRequest>> {
    return this.request<GluecronPullRequest>({
      method: 'GET',
      path: `/api/v2/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`,
      operation: 'getPullRequest',
    });
  }

  addPullRequestComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<GluecronResponse<{ ok: boolean; comment: GluecronPrComment }>> {
    return this.request({
      method: 'POST',
      path: `/api/v2/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/comments`,
      body: { body },
      operation: 'addPullRequestComment',
    });
  }

  setCommitStatus(
    owner: string,
    repo: string,
    sha: string,
    input: {
      state: CommitStatusState;
      description?: string;
      context?: string;
      targetUrl?: string;
    },
  ): Promise<GluecronResponse<GluecronCommitStatusResult>> {
    const body: Record<string, unknown> = {
      state: input.state,
      description: (input.description ?? '').slice(0, 140),
      context: input.context ?? 'gatetest',
    };
    if (input.targetUrl) body.target_url = input.targetUrl;
    return this.request<GluecronCommitStatusResult>({
      method: 'POST',
      path: `/api/v2/repos/${enc(owner)}/${enc(repo)}/statuses/${enc(sha)}`,
      body,
      operation: 'setCommitStatus',
    });
  }

  getCommit(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<GluecronResponse<GluecronCommit>> {
    return this.request<GluecronCommit>({
      method: 'GET',
      path: `/api/v2/repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}`,
      operation: 'getCommit',
    });
  }

  /** Unauthenticated reachability probe. */
  ping(): Promise<GluecronResponse<unknown>> {
    return this.request({
      method: 'GET',
      path: '/api/hooks/ping',
      operation: 'ping',
      noRetry: true,
    });
  }
}

// ─── Path helpers ───────────────────────────────────────────────────────────

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Encode a file path for the `:path{.+$}` matcher. Preserves slashes,
 * escapes each segment.
 */
function encPath(filePath: string): string {
  return filePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}
