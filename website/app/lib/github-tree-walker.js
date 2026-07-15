"use strict";

/**
 * Per-directory GitHub tree walker — fallback for repos whose
 * `git/trees?recursive=1` call hits GitHub's ~100k-entry truncation limit
 * (Known Issue #24). The recursive endpoint is one API call for the whole
 * tree but silently truncates past its cap; the Contents API
 * (`GET /repos/:owner/:repo/contents/:path`) never truncates a single
 * directory's listing but only returns one directory level per call, so
 * enumerating a whole tree this way means walking directory-by-directory.
 *
 * Deliberately bounded on two axes (call count AND wall-clock time) —
 * a truly enormous monorepo could still not be enumerable within a
 * serverless function's time or GitHub's rate-limit budget. When a budget
 * runs out mid-walk, this returns whatever was found so far with
 * `truncated: true` and an honest `warning` — it must never silently
 * claim completeness on a partial result.
 *
 * Plain CommonJS (not TypeScript) so it gets real behavioural tests with
 * an injectable `fetchImpl`, matching the pattern already established by
 * `github-callback.js` — `gluecron-client.ts`'s own directory-walk logic
 * can only be tested via source-text regex assertions (see
 * tests/github-hardening.test.js's own comment on why), which isn't
 * enough coverage for recursion/concurrency/budget logic like this.
 */

const DEFAULT_MAX_CALLS = 3000;
const DEFAULT_MAX_MS = 25000;
const DEFAULT_CONCURRENCY = 8;

/**
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} [opts.ref]
 * @param {string} opts.token
 * @param {function} [opts.fetchImpl] injectable fetch (tests / non-global-fetch runtimes)
 * @param {number} [opts.maxCalls]
 * @param {number} [opts.maxMs]
 * @param {number} [opts.concurrency]
 * @returns {Promise<{paths: string[], truncated: boolean, callsUsed: number, elapsedMs: number, warning: string|null}>}
 */
async function walkGithubTree({
  owner,
  repo,
  ref,
  token,
  fetchImpl,
  maxCalls = DEFAULT_MAX_CALLS,
  maxMs = DEFAULT_MAX_MS,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  const _fetch = fetchImpl || fetch;
  const startedAt = Date.now();
  const paths = [];
  let callsUsed = 0;
  let truncated = false;
  let abortedReason = null;

  async function fetchDir(dirPath) {
    callsUsed += 1;
    const encodedPath = dirPath
      ? dirPath.split('/').map(encodeURIComponent).join('/')
      : '';
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}${query}`;
    const res = await _fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'GateTest/1.2.0',
        Accept: 'application/vnd.github.v3+json',
      },
    });
    if (res.status === 403 || res.status === 429) {
      throw new Error(`rate-limited (HTTP ${res.status}) while listing "${dirPath || '/'}"`);
    }
    if (res.status !== 200) return [];
    let data;
    try {
      data = await res.json();
    } catch {
      return [];
    }
    // A path that resolves to a FILE (not a directory) returns a single
    // object, not an array — nothing to recurse into.
    if (!Array.isArray(data)) return [];
    return data;
  }

  const queue = ['']; // '' = repo root

  while (queue.length > 0) {
    if (Date.now() - startedAt > maxMs) {
      truncated = true;
      abortedReason = 'time budget exceeded';
      break;
    }
    if (callsUsed >= maxCalls) {
      truncated = true;
      abortedReason = 'call budget exceeded';
      break;
    }

    const batch = queue.splice(0, concurrency);
    let results;
    try {
      results = await Promise.all(batch.map((dirPath) => fetchDir(dirPath)));
    } catch (err) {
      truncated = true;
      abortedReason = err && err.message ? err.message : String(err);
      break;
    }

    for (const entries of results) {
      for (const entry of entries) {
        if (!entry || !entry.type || !entry.path) continue;
        if (entry.type === 'file') {
          paths.push(entry.path);
        } else if (entry.type === 'dir') {
          queue.push(entry.path);
        }
        // symlink / submodule entries are intentionally skipped — not
        // scannable source files in this repo's own tree.
      }
    }
  }

  return {
    paths,
    truncated,
    callsUsed,
    elapsedMs: Date.now() - startedAt,
    warning: truncated
      ? `Directory walk stopped early (${abortedReason}) after enumerating ${paths.length} file(s) across ${callsUsed} directory call(s) — more files may exist.`
      : null,
  };
}

module.exports = {
  walkGithubTree,
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_MS,
  DEFAULT_CONCURRENCY,
};
