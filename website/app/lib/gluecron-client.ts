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
      // error-ok — Gluecron unreachable — fall through to GitHub
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

// ── Credential-free public snapshot (KI #100/#101 root-cause fix) ─────────
// When every git-host credential fails (or none is configured), a PUBLIC repo
// is still readable anonymously as a tarball — see repo-snapshot.js. This is
// the LAST resort, tried after GitHub-token and Gluecron paths, so private
// repos and configured hosts behave exactly as before.
//
// The memo below is a correctness-neutral cache, not state: fetchTree and the
// N fetchBlob calls that follow it within one scan must not each re-download
// the archive. Losing the memo (cold start, TTL expiry) only costs a repeat
// download; the answer never changes. Bounded: 16 entries, 2-minute TTL.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const repoSnapshot = require("./repo-snapshot") as {
  fetchPublicRepoSnapshot: (
    owner: string,
    repo: string,
    ref?: string,
    opts?: { token?: string; maxFiles?: number },
  ) => Promise<{ paths: string[]; contents: Map<string, string>; truncated: boolean; warning: string | null; source: string }>;
};
type Snapshot = Awaited<ReturnType<typeof repoSnapshot.fetchPublicRepoSnapshot>>;
const SNAPSHOT_TTL_MS = 120_000;
const SNAPSHOT_MEMO_MAX = 16;
const snapshotMemo = new Map<string, { expires: number; promise: Promise<Snapshot> }>();

function publicSnapshot(owner: string, repo: string, ref: string): Promise<Snapshot> {
  const key = `${owner}/${repo}@${ref || "HEAD"}`;
  const now = Date.now();
  const hit = snapshotMemo.get(key);
  if (hit && hit.expires > now) return hit.promise;
  if (snapshotMemo.size >= SNAPSHOT_MEMO_MAX) {
    const oldest = [...snapshotMemo.entries()].sort((a, b) => a[1].expires - b[1].expires)[0];
    if (oldest) snapshotMemo.delete(oldest[0]);
  }
  const promise = repoSnapshot.fetchPublicRepoSnapshot(owner, repo, ref || "HEAD");
  snapshotMemo.set(key, { expires: now + SNAPSHOT_TTL_MS, promise });
  // A failed download must not be memoised — the next caller should retry.
  promise.catch(() => snapshotMemo.delete(key));
  return promise;
}

/**
 * Name the cause of a failed GitHub tree read in terms the reader can act on,
 * and — critically — say WHOSE fault it is. A 401 is our credential, not the
 * customer's repo; sending them to check their URL wastes their time and hides
 * an outage from us.
 */
export function describeGithubTreeFailure(status: number): string {
  if (status === 401)
    return "GateTest's git-host credential was rejected (401 Bad credentials) — this is our configuration, not your repository";
  if (status === 403)
    return "GitHub refused the request (403) — GateTest's credential lacks access or the API rate limit is exhausted";
  if (status === 404)
    return "GitHub returned 404 — the repository does not exist, is private, or GateTest's credential cannot see it";
  if (status >= 500) return `GitHub is returning ${status} — upstream outage, not a problem with your repository`;
  return `GitHub returned ${status}`;
}

/** Compose the final "we could not read the tree" message from both attempts. */
function treeUnreadable(
  owner: string,
  repo: string,
  githubFailure: string | null,
  fallbackFailure: string,
): string {
  const cause = githubFailure ? `${githubFailure}; fallback ${fallbackFailure}` : fallbackFailure;
  return `Could not read the file tree for ${owner}/${repo}: ${cause}`;
}

/**
 * Detailed tree fetch — returns paths PLUS truncation metadata so
 * callers can surface a "we may have missed files" warning to the
 * customer instead of silently losing coverage.
 *
 * Manifest #19 / Known Issue #24 fix: GitHub's git/trees endpoint
 * returns up to ~100k entries in one shot; beyond that it sets
 * `truncated: true`. Previously we read the partial list as if it
 * were the full tree — silently dropping files. Now we detect that
 * state and fall back to `github-tree-walker.js`'s per-directory
 * Contents-API walk, which never truncates a single directory but is
 * itself budget-bounded (call count + wall-clock time) so a truly
 * enormous monorepo can't hang a serverless function or exhaust the
 * rate limit — if even the fallback can't finish, the honest partial
 * result and warning are what's returned, never silent completeness.
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

  // Why the tree fetch failed, if it did. An unreadable tree and a genuinely
  // empty repo are DIFFERENT states, and conflating them told customers
  // "your repo appears to be empty" when the real cause was our own dead
  // credential — a lie that survived 10 days in production because the
  // message pointed the reader at the wrong system (Bible Forbidden #16).
  let githubFailure: string | null = null;

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
      if (!ghRes.ok) {
        githubFailure = describeGithubTreeFailure(ghRes.status);
        // eslint-disable-next-line no-console
        console.error(
          `[fetchTree] ${owner}/${repo}@${ref}: GitHub ${ghRes.status} — ${githubFailure}`,
        );
      }
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
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { walkGithubTree } = require("./github-tree-walker");
          const walked = await walkGithubTree({ owner, repo, ref, token });
          if (walked.truncated) {
            warning = `Repository tree exceeded GitHub's single-response limit (~100k entries), and the per-directory fallback walk also hit its own budget (${walked.callsUsed} directory calls, ${walked.elapsedMs}ms). Enumerated ${walked.paths.length} file(s); more exist but were not found. Scans may miss findings in unenumerated paths.`;
          } else {
            warning = `Repository tree exceeded GitHub's single-response limit (~100k entries) — recovered the full tree via a per-directory fallback walk (${walked.callsUsed} directory calls). All ${walked.paths.length} file(s) enumerated.`;
          }
          // eslint-disable-next-line no-console
          console.warn(`[fetchTree] ${owner}/${repo}@${ref}: ${warning}`);
          return { paths: walked.paths, truncated: walked.truncated, warning };
        } else if (paths.length > TREE_SIZE_WARN_THRESHOLD) {
          warning = `Repository has ${paths.length} files — large repos may exceed Vercel function memory + time budgets. Consider scoping via .gatetestignore.`;
        }
        return { paths, truncated, warning };
      }
    } catch (err) {
      githubFailure = `GitHub API unreachable (${err instanceof Error ? err.message : "network error"})`;
      // eslint-disable-next-line no-console
      console.error(`[fetchTree] ${owner}/${repo}@${ref}: ${githubFailure}`);
      /* fall through to gluecron */
    }
  }

  let gluecronFailure: string | null = null;
  let payload: (GluecronTreeResponse & { truncated?: boolean }) | null = null;
  if (!getToken()) gluecronFailure = "no Gluecron token configured";
  else try {
    const res = await gluecronApi(
      "GET",
      `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree/${encodeURIComponent(ref)}?recursive=1`,
    );
    if (res.status !== 200) gluecronFailure = `git host returned ${res.status}`;
    else {
      payload = res.data as unknown as GluecronTreeResponse & { truncated?: boolean };
      if (!payload.tree) { gluecronFailure = "git host returned no tree"; payload = null; }
    }
  } catch (err) {
    gluecronFailure = `git host unreachable (${err instanceof Error ? err.message : "network error"})`;
  }
  if (!payload) {
    // Both credentialed hosts failed. A PUBLIC repo is still readable
    // anonymously — try the archive before giving up. Throwing is the honest
    // outcome when that fails too: callers already wrap this in try/catch and
    // surface the reason, whereas returning [] silently becomes "this repo is
    // empty" downstream. A genuinely empty repo still returns 200 with an
    // empty tree above and is unaffected.
    try {
      const snap = await publicSnapshot(owner, repo, ref);
      // eslint-disable-next-line no-console
      console.warn(
        `[fetchTree] ${owner}/${repo}@${ref}: served from anonymous public archive (${snap.paths.length} paths) — git-host credentials failed: ${githubFailure || "no GitHub token"}; ${gluecronFailure}`,
      );
      return { paths: snap.paths, truncated: snap.truncated, warning: snap.warning };
    } catch (snapErr) {
      const snapMsg = snapErr instanceof Error ? snapErr.message : "public archive unavailable";
      throw new Error(treeUnreadable(owner, repo, githubFailure, `${gluecronFailure}; ${snapMsg}`));
    }
  }
  const paths = (payload.tree || []).filter((f) => f.type === "blob").map((f) => f.path);
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
    } catch { /* error-ok — GitHub attempt failed — the Gluecron path below is next */ }
  }

  // Gluecron is PAT-only (resolveRepoAuth never selects it without a token),
  // so an unauthenticated round-trip per blob would be 60 wasted requests per
  // scan — skip straight to the public snapshot when there is no token.
  if (getToken()) {
    try {
      const qs = ref ? `?ref=${encodeURIComponent(ref)}&encoding=base64` : `?encoding=base64`;
      const res = await gluecronApi(
        "GET",
        `/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath
          .split("/")
          .map(encodeURIComponent)
          .join("/")}${qs}`
      );
      if (res.status === 200) {
        const payload = res.data as unknown as GluecronContentsResponse;
        if (payload.content && payload.encoding === "base64") {
          return Buffer.from(payload.content, "base64").toString("utf-8");
        }
      }
    } catch {
      /* error-ok — fall through to the public snapshot */
    }
  }
  // Every credentialed path failed — serve the blob from the anonymous public
  // archive (memoised per repo, so this is a Map lookup after the first call).
  try {
    const snap = await publicSnapshot(owner, repo, ref || "HEAD");
    return snap.contents.get(filePath) || "";
  } catch {
    return "";
  }
}

// ── Whole-repo loader ─────────────────────────────────────────────────────
// Every scan path used to read a 50–60 file SAMPLE of a repo through N
// per-blob API calls, so a $399 Forensic scan of a 2,000-file repo analysed
// ~2.5% of it and could report "clean". One archive download hands back the
// entire tree with contents; the per-blob API is now the fallback, not the
// default. Order: credentialed archive (private repos too) → anonymous
// archive (public repos, dead credential) → tree + capped blob reads.

export interface RepoFilesResult {
  /** every path in the tree (including binaries and files not loaded) */
  paths: string[];
  /** text files actually loaded, after `filter`, up to `maxFiles` */
  fileContents: Array<{ path: string; content: string }>;
  source: "archive" | "archive-anonymous" | "api";
  truncated: boolean;
  warning: string | null;
}

export interface LoadRepoFilesOptions {
  /** cap on loaded text files (default 4000 — the engine, not the wire, is the limit now) */
  maxFiles?: number;
  /** cap on per-blob API reads when the archive path is unavailable (default 200) */
  maxBlobReads?: number;
  /** keep only these paths (default: everything except node_modules/.next/dist/vendor/lockfiles) */
  filter?: (path: string) => boolean;
  /** paths to load first when a cap applies (workspace manifests, files being fixed…) */
  prioritize?: (path: string) => boolean;
  /** wall-clock deadline (Date.now()-relative) — API blob reads stop when reached */
  deadlineMs?: number;
}

const DEFAULT_EXCLUDED_SEGMENTS = ["node_modules/", ".next/", "dist/", "vendor/", ".git/"];
const DEFAULT_EXCLUDED_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.map$/;

export function defaultRepoFileFilter(p: string): boolean {
  if (DEFAULT_EXCLUDED_SEGMENTS.some((seg) => p === seg.slice(0, -1) || p.startsWith(seg) || p.includes(`/${seg}`))) return false;
  if (DEFAULT_EXCLUDED_FILES.test(p)) return false;
  return true;
}

const archiveMemo = new Map<string, { expires: number; promise: Promise<Snapshot> }>();
function archiveSnapshot(owner: string, repo: string, ref: string, token: string, maxFiles: number): Promise<Snapshot> {
  const key = `${owner}/${repo}@${ref}#${token ? "auth" : "anon"}#${maxFiles}`;
  const now = Date.now();
  const hit = archiveMemo.get(key);
  if (hit && hit.expires > now) return hit.promise;
  if (archiveMemo.size >= SNAPSHOT_MEMO_MAX) {
    const oldest = [...archiveMemo.entries()].sort((a, b) => a[1].expires - b[1].expires)[0];
    if (oldest) archiveMemo.delete(oldest[0]);
  }
  const promise = repoSnapshot.fetchPublicRepoSnapshot(owner, repo, ref, { token, maxFiles });
  archiveMemo.set(key, { expires: now + SNAPSHOT_TTL_MS, promise });
  promise.catch(() => archiveMemo.delete(key));
  return promise;
}

function orderForLoad(paths: string[], filter: (p: string) => boolean, prioritize?: (p: string) => boolean): string[] {
  const kept = paths.filter(filter);
  if (!prioritize) return kept;
  const first: string[] = [];
  const rest: string[] = [];
  for (const p of kept) (prioritize(p) ? first : rest).push(p);
  return [...first, ...rest];
}

/**
 * Load a repository's file tree AND text contents in as few requests as
 * possible. Never throws for "we could read the tree but a blob failed";
 * throws only when the tree itself is unreadable (same contract as
 * fetchTree, so callers keep their existing error handling).
 */
export async function loadRepoFiles(
  owner: string,
  repo: string,
  ref: string,
  token: string,
  opts: LoadRepoFilesOptions = {},
): Promise<RepoFilesResult> {
  const {
    maxFiles = 4000,
    maxBlobReads = 200,
    filter = defaultRepoFileFilter,
    prioritize,
    deadlineMs,
  } = opts;
  const failures: string[] = [];

  // 1 + 2: archive (credentialed, then anonymous). GitHub-hosted only —
  // Gluecron repos have no codeload equivalent yet (TODO(host-parity)).
  const attempts: Array<{ tok: string; source: RepoFilesResult["source"] }> = token
    ? [{ tok: token, source: "archive" }, { tok: "", source: "archive-anonymous" }]
    : [{ tok: "", source: "archive-anonymous" }];
  for (const attempt of attempts) {
    try {
      // maxFiles caps TEXT files kept by the archive reader; ask for headroom
      // so a filter that drops vendor dirs still leaves `maxFiles` to load.
      const snap = await archiveSnapshot(owner, repo, ref || "HEAD", attempt.tok, Math.max(maxFiles * 3, maxFiles + 2000));
      const ordered = orderForLoad(snap.paths, filter, prioritize);
      const fileContents: Array<{ path: string; content: string }> = [];
      let loadable = 0;
      for (const p of ordered) {
        const c = snap.contents.get(p);
        if (!c) continue;
        loadable++;
        if (fileContents.length < maxFiles) fileContents.push({ path: p, content: c });
      }
      const truncated = snap.truncated || loadable > fileContents.length;
      const warning = truncated
        ? `Repository has more text files than the ${maxFiles}-file scan cap — analysed the first ${fileContents.length}; findings in the remainder are not reported.`
        : snap.warning;
      return { paths: snap.paths, fileContents, source: attempt.source, truncated, warning };
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }

  // 3: tree + capped blob reads (the historical path).
  const tree = await fetchTreeWithMetadata(owner, repo, ref || "HEAD", token);
  const ordered = orderForLoad(tree.paths, filter, prioritize);
  const toRead = ordered.slice(0, Math.min(maxBlobReads, maxFiles));
  const fileContents: Array<{ path: string; content: string }> = [];
  const CONCURRENCY = 8;
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      if (deadlineMs && Date.now() > deadlineMs) return;
      const i = cursor++;
      if (i >= toRead.length) return;
      const p = toRead[i];
      try {
        const content = await fetchBlob(owner, repo, p, ref || "HEAD", token);
        if (content) fileContents.push({ path: p, content });
      } catch {
        /* error-ok — a single unreadable blob is not fatal */
      }
    }
  });
  await Promise.all(workers);
  const truncated = tree.truncated || ordered.length > toRead.length;
  const warning = truncated
    ? `Archive read unavailable (${failures.join("; ") || "no archive attempt"}) — fell back to per-file reads capped at ${toRead.length} of ${ordered.length} files; findings in the remainder are not reported.`
    : tree.warning;
  return { paths: tree.paths, fileContents, source: "api", truncated, warning };
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
    } catch { /* error-ok — GitHub attempt failed — the Gluecron path below is next */ }
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
  } catch { /* error-ok — Gluecron unreachable — the unauthenticated GitHub attempt below is next */ }

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
  } catch { /* error-ok — no base SHA from any host — the caller receives source: none */ }

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
    } catch { /* error-ok — GitHub attempt failed — the Gluecron path below is next */ }
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
    } catch { /* error-ok — GitHub attempt failed — the Gluecron path below is next */ }

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
    } catch { /* error-ok — GitHub attempt failed — the Gluecron path below is next */ }

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
    } catch { /* error-ok — GitHub attempt failed — the Gluecron path below is next */ }

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
    } catch { /* error-ok — GitHub attempt failed — the Gluecron path below is next */ }

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
