/**
 * Gluecron client — HTTP wrapper the website-side routes use to talk to
 * Gluecron (our own git host). This REPLACES the GitHub App integration
 * (`github-app.ts`) for every path that was previously minting GitHub
 * installation tokens — health check, scan/run, scan/fix, scan-executor.
 *
 * Public surface mirrors `github-app.ts` so callers swap with a minimal
 * diff (just change the import). That's deliberate: the point of the
 * HostBridge + gluecron-client split is that callers shouldn't have to
 * care which host they're talking to beyond the import line.
 *
 * Auth: a single PAT carried in the `GLUECRON_API_TOKEN` env var (format:
 * `glc_<64hex>`, `repo` scope). No JWT, no installation tokens — Gluecron
 * is PAT-first by design.
 *
 * Base URL: `GLUECRON_BASE_URL` (defaults to https://gluecron.com).
 *
 * Wire contract endpoints used here:
 *   GET  /api/v2/repos/:owner/:repo            — metadata / access probe
 *   GET  /api/v2/repos/:owner/:repo/tree/:ref  — recursive tree
 *   GET  /api/v2/repos/:owner/:repo/contents/:path — base64 file contents
 *   POST /api/v2/repos/:owner/:repo/statuses/:sha  — commit status
 *   POST /api/v2/repos/:owner/:repo/pulls/:number/comments — PR comment
 *   POST /api/v2/repos/:owner/:repo/git/refs   — create branch
 *   PUT  /api/v2/repos/:owner/:repo/contents/:path — upsert file
 *   POST /api/v2/repos/:owner/:repo/pulls      — open PR (baseBranch/headBranch)
 *
 * This file is deliberately self-contained — no import of `github-app.ts`.
 */

import https from "https";
import http from "http";
import { URL } from "url";

const DEFAULT_BASE_URL = "https://gluecron.com";

function getBaseUrl(): string {
  const raw = process.env.GLUECRON_BASE_URL || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function getToken(): string {
  return process.env.GLUECRON_API_TOKEN || "";
}

function getGithubToken(): string {
  return process.env.GITHUB_TOKEN || process.env.GATETEST_GITHUB_TOKEN || "";
}

export function isGitHubToken(token: string): boolean {
  if (!token) return false;
  const ghToken = getGithubToken();
  return (
    !getToken() ||
    token.startsWith("ghp_") ||
    token.startsWith("gho_") ||
    token.startsWith("github_pat_") ||
    (ghToken !== "" && token === ghToken)
  );
}

/**
 * GitHub REST API wrapper — mirrors gluecronApi signature.
 * Used as a fallback when the resolved token is a GitHub PAT.
 */
export async function githubRestApi(
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>
): Promise<GluecronApiResponse> {
  const payload = body ? JSON.stringify(body) : undefined;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "GateTest/1.2.0",
    Accept: "application/vnd.github.v3+json",
  };
  if (payload) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    body: payload,
  });
  let data: Record<string, unknown>;
  try {
    data = await res.json() as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { status: res.status, data };
}

/**
 * Get the default branch name of a repo.
 */
export async function getDefaultBranch(
  owner: string,
  repo: string,
  token: string
): Promise<string> {
  if (isGitHubToken(token) && token) {
    const res = await githubRestApi("GET", `/repos/${owner}/${repo}`, token);
    if (res.status === 200) {
      return (res.data.default_branch as string) || "main";
    }
  }
  const res = await gluecronApi("GET", `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  if (res.status === 200) {
    return (res.data.defaultBranch as string) || (res.data.default_branch as string) || "main";
  }
  return "main";
}

/**
 * Get the SHA at the tip of a branch.
 */
export async function getBranchSha(
  owner: string,
  repo: string,
  branch: string,
  token: string
): Promise<string | null> {
  if (isGitHubToken(token) && token) {
    const res = await githubRestApi("GET", `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
    if (res.status === 200) {
      return ((res.data as { object?: { sha?: string } }).object?.sha) || null;
    }
  }
  const res = await gluecronApi("GET", `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree/${encodeURIComponent(branch)}?recursive=0`);
  if (res.status === 200) {
    return (res.data.sha as string) || null;
  }
  return null;
}

export interface GluecronApiResponse {
  status: number;
  data: Record<string, unknown>;
}

export function httpsJsonRequest(
  baseUrl: string,
  options: https.RequestOptions,
  body?: string
): Promise<GluecronApiResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(options.path || "/", baseUrl);
    const handler = parsed.protocol === "http:" ? http : https;
    const reqOpts: https.RequestOptions = {
      ...options,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path: parsed.pathname + parsed.search,
    };
    const req = handler.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode || 0, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode || 0, data: { raw } });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Gluecron HTTP helper analogous to `githubApi`.
 *
 * @param method  HTTP method ("GET" | "POST" | "PUT" | "PATCH" | "DELETE")
 * @param path    Path relative to base URL (must start with "/api/...")
 * @param body    Optional JSON body
 * @returns       { status, data }
 */
export async function gluecronApi(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<GluecronApiResponse> {
  const token = getToken();
  const baseUrl = getBaseUrl();
  const payload = body ? JSON.stringify(body) : undefined;
  const headers: Record<string, string> = {
    "User-Agent": "GateTest/1.2.0 (+gluecron)",
    Accept: "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }
  return httpsJsonRequest(baseUrl, { path, method, headers }, payload);
}

// ── Auth resolution ────────────────────────────────────
// Replaces `resolveGithubToken`. Since Gluecron is PAT-only, this is much
// simpler: confirm the token is present, then ping the repo to confirm
// access. Returns a shape compatible with TokenResolution so call sites
// can swap with minimal diffs.

export type GluecronAuthSource = "gluecron" | "github-pat" | "none";

export interface GluecronTokenResolution {
  token: string | null;
  source: GluecronAuthSource;
  error?: string;
}

/**
 * Resolve a Gluecron token for a specific repo.
 *
 * 1. If GLUECRON_API_TOKEN is unset, return { token: null, error }.
 * 2. Otherwise ping GET /api/v2/repos/{owner}/{repo} to confirm access.
 *    On 200, return the token.
 *    On 401/403, return { token: null, error: "token lacks access..." }.
 *    On 404,     return { token: null, error: "repo not found / private..." }.
 *    On other,   return { token: null, error: "probe failed HTTP N" }.
 */
export async function resolveRepoAuth(
  owner: string,
  repo: string
): Promise<GluecronTokenResolution> {
  // Try Gluecron first
  const glcToken = getToken();
  if (glcToken) {
    try {
      const res = await gluecronApi(
        "GET",
        `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      );
      if (res.status === 200) {
        return { token: glcToken, source: "gluecron" };
      }
    } catch {
      // Gluecron unreachable — fall through to GitHub
    }
  }

  // Fallback to GitHub PAT (works while Gluecron is offline or during migration)
  const githubToken = process.env.GITHUB_TOKEN || process.env.GATETEST_GITHUB_TOKEN || "";
  if (githubToken) {
    return { token: githubToken, source: "github-pat" };
  }

  // No auth available
  return {
    token: null,
    source: "none",
    error: glcToken
      ? `Gluecron could not access ${owner}/${repo}. Set GITHUB_TOKEN as fallback.`
      : "No git host token configured. Set GLUECRON_API_TOKEN or GITHUB_TOKEN.",
  };
}

// ── High-level helpers ─────────────────────────────────
// These wrap the raw endpoints so callers in scan/run, scan/fix, and
// scan-executor don't have to remember the exact path shapes.

interface GluecronTreeResponse {
  tree?: Array<{ path: string; type: string; sha?: string; size?: number }>;
  truncated?: boolean;
  totalCount?: number;
}

/**
 * Fetch recursive tree of a ref, returning array of blob paths.
 * `token` is accepted for API parity with the GitHub helpers but the
 * actual auth comes from GLUECRON_API_TOKEN — a future refactor may
 * thread token-per-call through, today it's env-global.
 */
export interface FetchTreeResult {
  paths: string[];
  truncated: boolean;
  warning: string | null;
}

const TREE_SIZE_WARN_THRESHOLD = 50_000;

/**
 * Detailed tree fetch — returns paths PLUS truncation metadata so
 * callers can surface a "we may have missed files" warning to the
 * customer instead of silently losing coverage.
 *
 * Manifest #19 / Known Issue #24 fix: GitHub's git/trees endpoint
 * returns up to ~100k entries in one shot; beyond that it sets
 * `truncated: true`. Previously we read the partial list as if it
 * were the full tree — silently dropping files. Now we detect that
 * state and surface it explicitly. Callers should at minimum log the
 * warning; ideally they fall back to per-directory traversal (out of
 * scope for the MVP fix — flagged for future work).
 */
export async function fetchTreeWithMetadata(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<FetchTreeResult> {
  const isGitHub =
    !getToken() ||
    token.startsWith("ghp_") ||
    token.startsWith("gho_") ||
    token === (process.env.GITHUB_TOKEN || "") ||
    token === (process.env.GATETEST_GITHUB_TOKEN || "");

  if (isGitHub && token) {
    try {
      const ghRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "GateTest",
            Accept: "application/vnd.github.v3+json",
          },
        },
      );
      if (ghRes.ok) {
        const ghData = (await ghRes.json()) as {
          tree?: Array<{ path: string; type: string }>;
          truncated?: boolean;
        };
        const paths = (ghData.tree || [])
          .filter((f) => f.type === "blob")
          .map((f) => f.path);
        const truncated = ghData.truncated === true;
        let warning: string | null = null;
        if (truncated) {
          warning = `Repository tree exceeded GitHub's single-response limit (~100k entries). Returned ${paths.length} files; more exist but were not enumerated. Scans may miss findings in unenumerated paths.`;
          // eslint-disable-next-line no-console
          console.warn(`[fetchTree] ${owner}/${repo}@${ref}: ${warning}`);
        } else if (paths.length > TREE_SIZE_WARN_THRESHOLD) {
          warning = `Repository has ${paths.length} files — large repos may exceed Vercel function memory + time budgets. Consider scoping via .gatetestignore.`;
        }
        return { paths, truncated, warning };
      }
    } catch {
      /* fall through to gluecron */
    }
  }

  const res = await gluecronApi(
    "GET",
    `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree/${encodeURIComponent(ref)}?recursive=1`,
  );
  if (res.status !== 200) return { paths: [], truncated: false, warning: null };
  const payload = res.data as unknown as GluecronTreeResponse & { truncated?: boolean };
  if (!payload.tree) return { paths: [], truncated: false, warning: null };
  const paths = payload.tree.filter((f) => f.type === "blob").map((f) => f.path);
  const truncated = payload.truncated === true;
  let warning: string | null = null;
  if (truncated) {
    warning = `Gluecron tree response truncated — ${paths.length} paths visible, more exist.`;
    // eslint-disable-next-line no-console
    console.warn(`[fetchTree] ${owner}/${repo}@${ref}: ${warning}`);
  } else if (paths.length > TREE_SIZE_WARN_THRESHOLD) {
    warning = `Repository has ${paths.length} files — consider scoping via .gatetestignore.`;
  }
  return { paths, truncated, warning };
}

export async function fetchTree(
  owner: string,
  repo: string,
  ref: string,
  token: string
): Promise<string[]> {
  const result = await fetchTreeWithMetadata(owner, repo, ref, token);
  return result.paths;
}

interface GluecronContentsResponse {
  content?: string;
  encoding?: string;
  sha?: string;
  size?: number;
  path?: string;
}

/**
 * Fetch a single blob, returning utf-8 decoded content.
 * Returns "" if the file can't be read (path not found, binary, etc.).
 */
export async function fetchBlob(
  owner: string,
  repo: string,
  filePath: string,
  ref: string,
  token: string
): Promise<string> {
  // GitHub fallback
  const isGitHub = !getToken() || token.startsWith("ghp_") || token.startsWith("gho_") || token === (process.env.GITHUB_TOKEN || "") || token === (process.env.GATETEST_GITHUB_TOKEN || "");
  if (isGitHub && token) {
    try {
      const ghRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`,
        { headers: { Authorization: `Bearer ${token}`, "User-Agent": "GateTest", Accept: "application/vnd.github.v3+json" } }
      );
      if (ghRes.ok) {
        const ghData = await ghRes.json() as { content?: string; encoding?: string };
        if (ghData.content && ghData.encoding === "base64") {
          return Buffer.from(ghData.content, "base64").toString("utf-8");
        }
      }
    } catch { /* fall through to gluecron */ }
  }

  const qs = ref ? `?ref=${encodeURIComponent(ref)}&encoding=base64` : `?encoding=base64`;
  const res = await gluecronApi(
    "GET",
    `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}${qs}`
  );
  if (res.status !== 200) return "";
  const payload = res.data as unknown as GluecronContentsResponse;
  if (!payload.content || payload.encoding !== "base64") return "";
  try {
    return Buffer.from(payload.content, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

/**
 * Resolve the tip SHA of a branch. Tries Gluecron's tree endpoint first
 * (which carries the branch-tip sha on the response per its wire contract),
 * then falls back to GitHub's git-ref endpoint. Returns null if neither
 * host can resolve it — caller should surface the error.
 */
export async function resolveBaseBranchSha(
  owner: string,
  repo: string,
  branch: string,
  token: string
): Promise<{ sha: string | null; defaultBranch: string; source: "gluecron" | "github" | "none" }> {
  // GitHub-first if the token is a GitHub credential
  if (isGitHubToken(token)) {
    try {
      const ghRepo = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "GateTest", Accept: "application/vnd.github.v3+json" },
      });
      if (ghRepo.ok) {
        const repoData = await ghRepo.json() as { default_branch?: string };
        const defaultBranch = branch || repoData.default_branch || "main";
        const ghRef = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(defaultBranch)}`,
          { headers: { Authorization: `Bearer ${token}`, "User-Agent": "GateTest", Accept: "application/vnd.github.v3+json" } }
        );
        if (ghRef.ok) {
          const refData = await ghRef.json() as { object?: { sha?: string } };
          if (refData.object?.sha) {
            return { sha: refData.object.sha, defaultBranch, source: "github" };
          }
        }
      }
    } catch { /* fall through to gluecron */ }
  }

  // Try Gluecron
  try {
    const repoRes = await gluecronApi(
      "GET",
      `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    );
    const defaultBranch =
      branch ||
      ((repoRes.data.defaultBranch as string) ||
        (repoRes.data.default_branch as string) ||
        "main");

    const treeMeta = await gluecronApi(
      "GET",
      `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree/${encodeURIComponent(defaultBranch)}?recursive=1`
    );
    const sha =
      (treeMeta.data.sha as string | undefined) ||
      ((treeMeta.data as { tree?: Array<{ sha?: string }> }).tree?.[0]?.sha) ||
      null;

    if (sha) return { sha, defaultBranch, source: "gluecron" };
  } catch { /* fall through */ }

  // Last-ditch GitHub attempt even without a recognised token shape — many
  // public repos can be read unauthenticated, and in that case we still
  // want to be able to compute a base SHA rather than failing the whole PR.
  try {
    const headers: Record<string, string> = { "User-Agent": "GateTest", Accept: "application/vnd.github.v3+json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const ghRepo = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (ghRepo.ok) {
      const repoData = await ghRepo.json() as { default_branch?: string };
      const defaultBranch = branch || repoData.default_branch || "main";
      const ghRef = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(defaultBranch)}`,
        { headers }
      );
      if (ghRef.ok) {
        const refData = await ghRef.json() as { object?: { sha?: string } };
        if (refData.object?.sha) {
          return { sha: refData.object.sha, defaultBranch, source: "github" };
        }
      }
    }
  } catch { /* fall through */ }

  return { sha: null, defaultBranch: branch || "main", source: "none" };
}

/**
 * Fetch a file's SHA (for upsert). Returns "" if the file does not exist
 * on that branch (caller will then PUT without a sha, creating the file).
 */
export async function fetchFileSha(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token: string
): Promise<string> {
  if (isGitHubToken(token)) {
    try {
      const ghRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        { headers: { Authorization: `Bearer ${token}`, "User-Agent": "GateTest", Accept: "application/vnd.github.v3+json" } }
      );
      if (ghRes.ok) {
        const ghData = await ghRes.json() as { sha?: string };
        return ghData.sha || "";
      }
      // 404 = file doesn't exist yet — caller treats empty sha as "create"

      if (ghRes.status === 404) return "";
    } catch { /* fall through to gluecron */ }
  }

  const qs = ref ? `?ref=${encodeURIComponent(ref)}&encoding=base64` : `?encoding=base64`;
  const res = await gluecronApi(
    "GET",
    `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}${qs}`
  );
  if (res.status !== 200) return "";
  const payload = res.data as unknown as GluecronContentsResponse;
  return payload.sha || "";
}

export type CommitState = "pending" | "success" | "failure" | "error";

/**
 * Post a commit status.
 */
export async function postStatus(
  owner: string,
  repo: string,
  sha: string,
  state: CommitState,
  context: string,
  description: string,
  _token: string,
  targetUrl?: string
): Promise<GluecronApiResponse> {
  const body: Record<string, unknown> = {
    state,
    context,
    description: (description || "").slice(0, 140),
  };
  if (targetUrl) body.target_url = targetUrl;
  return gluecronApi(
    "POST",
    `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(sha)}`,
    body
  );
}

/**
 * Post a comment on a pull request.
 */
export async function postPrComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  token: string
): Promise<GluecronApiResponse> {
  if (isGitHubToken(token)) {
    try {
      const ghRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "GateTest",
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body }),
        }
      );
      const data = await ghRes.json().catch(() => ({}));
      return { status: ghRes.status, data: data as Record<string, unknown> };
    } catch { /* fall through to gluecron */ }

  }
  return gluecronApi(
    "POST",
    `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/comments`,
    { body }
  );
}

/**
 * Create a branch off a base SHA.
 */
export async function createBranch(
  owner: string,
  repo: string,
  branchName: string,
  baseSha: string,
  token: string
): Promise<GluecronApiResponse> {
  if (isGitHubToken(token)) {
    try {
      const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "GateTest",
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
      });
      const data = await ghRes.json().catch(() => ({}));
      return { status: ghRes.status, data: data as Record<string, unknown> };
    } catch { /* fall through to gluecron */ }

  }
  return gluecronApi(
    "POST",
    `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
    {
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    }
  );
}

/**
 * Upsert a file on a branch. If `existingSha` is given, this is an update;
 * otherwise treat as a create.
 */
export async function upsertFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string,
  existingSha: string | null | undefined,
  token: string
): Promise<GluecronApiResponse> {
  const contentBase64 = Buffer.from(content).toString("base64");

  if (isGitHubToken(token)) {
    try {
      const body: Record<string, unknown> = { message, content: contentBase64, branch };
      if (existingSha) body.sha = existingSha;
      const ghRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "GateTest",
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );
      const data = await ghRes.json().catch(() => ({}));
      return { status: ghRes.status, data: data as Record<string, unknown> };
    } catch { /* fall through to gluecron */ }

  }

  const body: Record<string, unknown> = {
    message,
    content: contentBase64,

    branch,
  };
  if (existingSha) body.sha = existingSha;

  return gluecronApi(
    "PUT",
    `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    body
  );
}

/**
 * Open a pull request.
 *
 * NOTE: Gluecron takes `baseBranch` / `headBranch` in the body (NOT
 * GitHub's `base` / `head`). The GitHub fallback here translates to
 * GitHub's `head` / `base` shape transparently.

 */
export async function openPullRequest(
  owner: string,
  repo: string,
  title: string,
  body: string,
  headBranch: string,
  baseBranch: string,
  token: string
): Promise<GluecronApiResponse> {
  if (isGitHubToken(token)) {
    try {
      const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "GateTest",
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title, body, head: headBranch, base: baseBranch }),
      });
      const data = await ghRes.json().catch(() => ({}));
      return { status: ghRes.status, data: data as Record<string, unknown> };
    } catch { /* fall through to gluecron */ }

  }
  return gluecronApi(
    "POST",
    `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    {
      title,
      body,
      headBranch,
      baseBranch,
    }
  );
}

/**
 * Ping the unauthenticated /api/hooks/ping endpoint. Used by the admin
 * health check to separate "Gluecron is reachable" from "our token is
 * valid" — if ping works but /api/v2/user fails, we have an auth issue;
 * if ping fails we have a connectivity / outage issue.
 */
export async function pingGluecron(): Promise<GluecronApiResponse> {
  const baseUrl = getBaseUrl();
  return httpsJsonRequest(baseUrl, {
    path: "/api/hooks/ping",
    method: "GET",
    headers: {
      "User-Agent": "GateTest/1.2.0 (+gluecron-ping)",
      Accept: "application/json",
    },
  });
}
