"use strict";

/**
 * Public-repo snapshot — read a whole public GitHub repository with ONE
 * unauthenticated HTTPS request, no git-host credential involved.
 *
 * WHY THIS EXISTS (KI #100 / #101, 2026-08-18): the free-scan funnel read a
 * PUBLIC repo through `git/trees` + up to 60 Contents-API calls, every one of
 * them authenticated with the box's PAT. When that PAT went 401 the whole top
 * of the funnel died — for every repo on earth — even though nothing about a
 * public repository requires a credential to read. A credential must never be
 * a single point of failure for reading data that is public by definition.
 *
 * `https://codeload.github.com/{owner}/{repo}/tar.gz/{ref}` serves the archive
 * anonymously (it is what "Download ZIP" and `gh repo clone` fall back to),
 * is NOT metered against the 60-req/hour anonymous API budget the way
 * `api.github.com` calls are, and hands back paths AND contents together —
 * so a caller gets the ENTIRE tree in one round-trip instead of a 60-file
 * sample. Faster, more complete, and credential-free.
 *
 * Node has gzip built in (`zlib`) and tar is a 512-byte-block format simple
 * enough to read in ~40 lines, so this adds no dependency (Boss Rule #2).
 *
 * Bounded on purpose: `maxBytes` caps the compressed download, `maxFileBytes`
 * skips single huge files, `maxFiles` caps the number of text files kept, and
 * `deadlineMs` bounds wall-clock. Binary files (NUL byte in the first 8 KiB)
 * are recorded in `paths` but not in `contents`, exactly like the Contents-API
 * path which returned "" for them. When a cap is hit `truncated` is set and
 * `warning` says so — never silent partial coverage (Bible Forbidden #16).
 */

const zlib = require("node:zlib");

const DEFAULT_MAX_BYTES = 40 * 1024 * 1024; // compressed archive cap
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // single-file cap (matches GitHub Contents API's 1 MB)
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_DEADLINE_MS = 20_000;
const BLOCK = 512;

function tarballUrl(owner, repo, ref, token) {
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  const f = encodeURIComponent(ref || "HEAD");
  // With a credential, use the API archive endpoint — it serves PRIVATE repos
  // too and 302s to a signed codeload URL (fetch drops the Authorization
  // header on that cross-origin hop, which is exactly right). Without one,
  // go straight to codeload: anonymous, unmetered, public repos only.
  return token
    ? `https://api.github.com/repos/${o}/${r}/tarball/${f}`
    : `https://codeload.github.com/${o}/${r}/tar.gz/${f}`;
}

/** Read a NUL-terminated ASCII field from a tar header. */
function field(buf, off, len) {
  const end = buf.indexOf(0, off);
  const stop = end === -1 || end > off + len ? off + len : end;
  return buf.toString("utf8", off, stop);
}

function octal(buf, off, len) {
  const raw = field(buf, off, len).trim();
  if (!raw) return 0;
  const n = parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

function looksBinary(buf) {
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  return probe.indexOf(0) !== -1;
}

/**
 * Parse a POSIX/GNU tar buffer into { path → Buffer } for regular files.
 * Handles ustar `prefix`, GNU long names (`L`), and PAX extended headers
 * (`x`) well enough for GitHub archives, which use the latter for long paths.
 * Strips the leading `{repo}-{sha}/` component GitHub adds to every entry.
 */
function parseTar(buf, { maxFileBytes, maxFiles }) {
  const entries = new Map();
  const allPaths = [];
  let truncated = false;
  let off = 0;
  let pendingLongName = null;
  let paxPath = null;

  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    let name = field(header, 0, 100);
    const magic = field(header, 257, 6);
    if (magic.startsWith("ustar")) {
      const prefix = field(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    const data = buf.subarray(dataStart, Math.min(dataEnd, buf.length));
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "L") { pendingLongName = data.toString("utf8").replace(/\0+$/, ""); continue; }
    if (type === "x" || type === "g") {
      // PAX: records of the form "<len> key=value\n"
      const text = data.toString("utf8");
      const m = /(?:^|\n)\d+ path=([^\n]*)/.exec(text);
      if (m && type === "x") paxPath = m[1];
      continue;
    }
    if (pendingLongName) { name = pendingLongName; pendingLongName = null; }
    if (paxPath) { name = paxPath; paxPath = null; }
    if (type !== "0" && type !== "\0" && type !== "7") continue; // dirs, links, etc.

    // Drop the archive's top-level "{repo}-{ref}/" directory.
    const slash = name.indexOf("/");
    const rel = slash === -1 ? name : name.slice(slash + 1);
    if (!rel) continue;
    allPaths.push(rel);
    if (size > maxFileBytes) continue;
    if (looksBinary(data)) continue;
    if (entries.size >= maxFiles) { truncated = true; continue; }
    entries.set(rel, Buffer.from(data));
  }
  return { entries, allPaths, truncated };
}

/**
 * Download + parse a public repo snapshot.
 *
 * @returns {Promise<{ paths: string[], contents: Map<string,string>, truncated: boolean, warning: string|null, source: 'tarball' }>}
 * @throws Error with a caller-facing message when the archive is unavailable
 *   (private repo / no such repo → 404; upstream outage; caps exceeded).
 */
async function fetchPublicRepoSnapshot(owner, repo, ref = "HEAD", opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    token = "",
    maxBytes = DEFAULT_MAX_BYTES,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
    deadlineMs = DEFAULT_DEADLINE_MS,
  } = opts;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`invalid repository name ${owner}/${repo}`);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deadlineMs);
  let res;
  try {
    const headers = { "User-Agent": "GateTest", Accept: "application/octet-stream" };
    if (token) headers.Authorization = `Bearer ${token}`;
    res = await fetchImpl(tarballUrl(owner, repo, ref, token), {
      headers,
      redirect: "follow",
      signal: ac.signal,
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(token
          ? `archive for ${owner}/${repo}@${ref} not found (404) — the repository does not exist, the ref is wrong, or the credential cannot see it`
          : `public archive for ${owner}/${repo}@${ref} not found (404) — the repository is private, does not exist, or the ref is wrong`);
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`archive for ${owner}/${repo}@${ref} refused (HTTP ${res.status}) — GateTest's git-host credential was rejected or rate-limited; this is our configuration, not your repository`);
      }
      throw new Error(`public archive for ${owner}/${repo}@${ref} unavailable (HTTP ${res.status})`);
    }
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > maxBytes) {
      throw new Error(`public archive for ${owner}/${repo} is ${declared} bytes compressed — over the ${maxBytes}-byte snapshot cap`);
    }
    // Stream so an oversize body without content-length is stopped early.
    const chunks = [];
    let total = 0;
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          ac.abort();
          throw new Error(`public archive for ${owner}/${repo} exceeded the ${maxBytes}-byte snapshot cap`);
        }
        chunks.push(Buffer.from(value));
      }
    } else {
      const ab = await res.arrayBuffer();
      total = ab.byteLength;
      if (total > maxBytes) throw new Error(`public archive for ${owner}/${repo} exceeded the ${maxBytes}-byte snapshot cap`);
      chunks.push(Buffer.from(ab));
    }
    const gz = Buffer.concat(chunks, total);
    let tar;
    try {
      tar = zlib.gunzipSync(gz, { maxOutputLength: maxBytes * 8 });
    } catch (err) {
      throw new Error(`public archive for ${owner}/${repo} could not be decompressed (${err && err.message ? err.message : "gunzip failed"})`);
    }
    const { entries, allPaths, truncated } = parseTar(tar, { maxFileBytes, maxFiles });
    const contents = new Map();
    for (const [p, b] of entries) contents.set(p, b.toString("utf8"));
    const warning = truncated
      ? `Repository has more than ${maxFiles} text files — snapshot kept the first ${maxFiles}; scans may miss findings in the remainder.`
      : null;
    return { paths: allPaths, contents, truncated, warning, source: token ? "tarball-auth" : "tarball" };
  } finally {
    clearTimeout(timer);
  }
}

// ── gitlab.com support (board item, PR #599 follow-up: "GitLab URLs are ─────
// recognised but not fetched") ──────────────────────────────────────────────
// isGitRepoUrl (scan-worker.js) has recognised gitlab.com URLs since #599;
// nothing downstream knew how to fetch one, so every such scan retried and
// dead-lettered. This is the fetch: gitlab.com's own archive endpoint,
// unauthenticated, PUBLIC projects only — no dependency, no credential
// (Boss Rule #2). Self-hosted GitLab is out of scope: `isGitlabProjectPath`
// only validates the PATH, the caller is responsible for having matched the
// hostname against exactly "gitlab.com" first (scan-executor.ts), so a
// self-hosted instance never reaches this function in the first place.
//
// GitLab's archive wraps entries in the same shape GitHub's tarball does —
// one top-level "{project}-{sha}/" directory — so the existing `parseTar`
// handles both formats unmodified; only the request URL and error wording
// differ, which is why this stays a sibling function rather than a
// parameter added to `fetchPublicRepoSnapshot` (whose owner/repo split
// doesn't fit an arbitrary-depth `group/subgroup/project` path anyway).

function gitlabTarballUrl(projectPath, ref) {
  return `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectPath)}/repository/archive.tar.gz?sha=${encodeURIComponent(ref)}`;
}

/** Every path segment must be a safe git-host slug — same shape check as
 *  owner/repo above, applied per segment so a subgroup path can't smuggle
 *  `..` or a query string into the URL we build. */
function isValidGitlabProjectPath(projectPath) {
  if (typeof projectPath !== "string" || !projectPath) return false;
  const segments = projectPath.split("/");
  if (segments.length < 2) return false; // at minimum <namespace>/<project>
  // "." and ".." are valid matches of the charset below but must still be
  // rejected — otherwise "../evil/x" smuggles a traversal segment past a
  // charset check the same way the owner/repo validation above guards against.
  return segments.every((s) => s !== "." && s !== ".." && /^[A-Za-z0-9_.-]+$/.test(s));
}

/** Attach the HTTP status to a thrown Error so callers can tell "the host
 *  said no" (401/403/404 → gluecron-client.ts/scan-executor.ts report
 *  `gitlab:not-accessible`, never retried) apart from a network failure
 *  (no `.httpStatus` → the normal retry/dead-letter classification in
 *  scan-queue-store.js applies, same as any other host). */
function httpError(message, status) {
  const err = new Error(message);
  err.httpStatus = status;
  return err;
}

/**
 * Download + parse a PUBLIC gitlab.com project's archive. `ref` must
 * already be a real branch/tag/sha — unlike GitHub's codeload, GitLab's
 * archive endpoint has no "HEAD" alias, so the caller (gluecron-client.ts's
 * `loadGitlabRepoFiles`) resolves the default branch before calling this.
 *
 * @returns {Promise<{ paths: string[], contents: Map<string,string>, truncated: boolean, warning: string|null, source: 'gitlab-tarball' }>}
 * @throws Error — `.httpStatus` set for a host-refused request (401/403/404),
 *   unset for a network/decompression/cap failure.
 */
async function fetchPublicGitlabSnapshot(projectPath, ref, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    maxBytes = DEFAULT_MAX_BYTES,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
    deadlineMs = DEFAULT_DEADLINE_MS,
  } = opts;
  if (!isValidGitlabProjectPath(projectPath)) {
    throw new Error(`invalid gitlab project path ${projectPath}`);
  }
  if (!ref || typeof ref !== "string") {
    throw new Error(`fetchPublicGitlabSnapshot: a resolved ref is required for ${projectPath}`);
  }
  const target = `${projectPath}@${ref}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deadlineMs);
  try {
    const headers = { "User-Agent": "GateTest", Accept: "application/octet-stream" };
    const res = await fetchImpl(gitlabTarballUrl(projectPath, ref), {
      headers,
      redirect: "follow",
      signal: ac.signal,
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw httpError(`public archive for ${target} not found (404) — the project is private, does not exist, or the ref is wrong`, 404);
      }
      if (res.status === 401 || res.status === 403) {
        throw httpError(`public archive for ${target} refused (HTTP ${res.status}) — the project is private or access-restricted`, res.status);
      }
      throw httpError(`public archive for ${target} unavailable (HTTP ${res.status})`, res.status);
    }
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > maxBytes) {
      throw new Error(`public archive for ${target} is ${declared} bytes compressed — over the ${maxBytes}-byte snapshot cap`);
    }
    // Stream so an oversize body without content-length is stopped early.
    const chunks = [];
    let total = 0;
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          ac.abort();
          throw new Error(`public archive for ${target} exceeded the ${maxBytes}-byte snapshot cap`);
        }
        chunks.push(Buffer.from(value));
      }
    } else {
      const ab = await res.arrayBuffer();
      total = ab.byteLength;
      if (total > maxBytes) throw new Error(`public archive for ${target} exceeded the ${maxBytes}-byte snapshot cap`);
      chunks.push(Buffer.from(ab));
    }
    const gz = Buffer.concat(chunks, total);
    let tar;
    try {
      tar = zlib.gunzipSync(gz, { maxOutputLength: maxBytes * 8 });
    } catch (err) {
      throw new Error(`public archive for ${target} could not be decompressed (${err && err.message ? err.message : "gunzip failed"})`);
    }
    const { entries, allPaths, truncated } = parseTar(tar, { maxFileBytes, maxFiles });
    const contents = new Map();
    for (const [p, b] of entries) contents.set(p, b.toString("utf8"));
    const warning = truncated
      ? `Repository has more than ${maxFiles} text files — snapshot kept the first ${maxFiles}; scans may miss findings in the remainder.`
      : null;
    return { paths: allPaths, contents, truncated, warning, source: "gitlab-tarball" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  fetchPublicRepoSnapshot,
  parseTar,
  tarballUrl,
  fetchPublicGitlabSnapshot,
  gitlabTarballUrl,
  isValidGitlabProjectPath,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
};
