/**
 * Fetch + classify the arena repo's PR list for /testing (website/app/testing/page.tsx).
 *
 * 2026-09-25 fix: the box's GITHUB_TOKEN now gets refused (401) by GitHub
 * (owner item `box-github-token`). The arena repo is PUBLIC, so a refused
 * token must never read as "the repo hasn't been created" — it should fall
 * back to an anonymous read, exactly like `resolveBaseBranchSha` in
 * gluecron-client.ts already does for the tree/ref paths (issue #651, #729).
 * `githubGetWithAnonymousFallback` is that one definition; this module is
 * its only caller here, imported rather than re-derived.
 *
 * Kept separate from page.tsx (no JSX here) so the fetch/classify logic —
 * the actual bug surface — can be unit-tested without dragging in React
 * Server Component rendering or this app's design-system components.
 */
import { githubGetWithAnonymousFallback, getGithubToken } from "../lib/gluecron-client";

export const ARENA_REPO = process.env.ARENA_REPO || "crclabs-hq/gatetest-arena";

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  created_at: string;
  merged_at: string | null;
  html_url: string;
  user: { login: string } | null;
  body: string | null;
}

export type ArenaFetchResult =
  | { kind: "ok"; prs: PullRequest[] }
  | { kind: "not-found" }
  | { kind: "rate-limited"; resetAt: number | null }
  | { kind: "error"; reason: string };

// Last successfully fetched snapshot, kept so a transient live failure
// (rate limit, network blip, GitHub 5xx) shows the last honest read instead
// of an error page — the same "serve what we have, say why it's stale"
// shape as the credential-free snapshot memo in gluecron-client.ts.
let lastGoodSnapshot: { prs: PullRequest[]; fetchedAt: number } | null = null;

export function getLastGoodSnapshot(): { prs: PullRequest[]; fetchedAt: number } | null {
  return lastGoodSnapshot;
}

/** Test-only: clear the module-level cache between test cases. */
export function _resetArenaSnapshotForTest(): void {
  lastGoodSnapshot = null;
}

export async function fetchArenaPRs(repo: string = ARENA_REPO): Promise<ArenaFetchResult> {
  const token = getGithubToken();
  const path = `/repos/${repo}/pulls?state=all&per_page=100&sort=created&direction=desc`;

  try {
    const { res, usedAnonymous } = await githubGetWithAnonymousFallback(path, token);

    if (res.status === 404) return { kind: "not-found" };

    if (!res.ok) {
      // Unauthenticated GitHub reads are capped at 60/hour per IP. That is
      // an honest "come back later", not "the repo is missing" — must not
      // collapse into the same copy as a 404.
      if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
        const resetHeader = res.headers.get("x-ratelimit-reset");
        const resetAt = resetHeader ? Number(resetHeader) * 1000 : null;
        return { kind: "rate-limited", resetAt: Number.isFinite(resetAt) ? resetAt : null };
      }
      return { kind: "error", reason: `github-api-${res.status}` };
    }

    if (usedAnonymous) {
      // Server-side only — the box's own token is stale, never the customer's
      // or the repo's problem, and the anonymous retry already resolved it.
      // eslint-disable-next-line no-console
      console.warn(
        `[testing] GITHUB_TOKEN refused for ${repo} — served the public repo anonymously instead`,
      );
    }

    const prs = (await res.json()) as PullRequest[];
    lastGoodSnapshot = { prs, fetchedAt: Date.now() };
    return { kind: "ok", prs };
  } catch (err) {
    return { kind: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Human copy for why we're serving a cached snapshot instead of a live read. */
export function describeArenaFailure(result: Exclude<ArenaFetchResult, { kind: "ok" }>): string {
  if (result.kind === "not-found") return "GitHub could not find the arena repo on the latest read";
  if (result.kind === "rate-limited") return "GitHub's public rate limit was hit on the latest read";
  return `GitHub returned an error on the latest read (${result.reason})`;
}
