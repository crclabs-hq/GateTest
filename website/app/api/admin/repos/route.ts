/**
 * GET /api/admin/repos
 *
 * Fetches all GitHub repos accessible to the configured token, then
 * enriches each with its latest workflow run status. Returns a unified
 * list so the admin Watchdog panel can show which repos are red and queue
 * GateTest scans on them.
 *
 * Auth: same two-method check as all other /api/admin/* routes.
 * Token: GATETEST_GITHUB_TOKEN or GITHUB_TOKEN (read:repo + workflow scope).
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import {
  getAdminConfig,
  getAdminUser,
  SESSION_COOKIE_NAME,
} from "@/app/lib/admin-session";
import { ADMIN_COOKIE_NAME } from "@/app/lib/admin-auth";
import { getBestGitHubToken } from "@/app/lib/admin-github-profiles";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function isAuthenticatedAdmin(): Promise<boolean> {
  const store = await cookies();
  const adminStatus = getAdminConfig();
  if (adminStatus.ok && adminStatus.config) {
    const sessionCookie = store.get(SESSION_COOKIE_NAME)?.value;
    if (getAdminUser(sessionCookie, adminStatus.config)) return true;
  }
  const adminPassword = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (adminPassword) {
    const passwordCookie = store.get(ADMIN_COOKIE_NAME)?.value || "";
    const expected = crypto
      .createHmac("sha256", adminPassword)
      .update("gatetest-admin-v1")
      .digest("hex");
    if (
      passwordCookie &&
      passwordCookie.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(passwordCookie), Buffer.from(expected))
    )
      return true;
  }
  return false;
}

// Use getBestGitHubToken from admin-github-profiles for multi-account support.
// Owner is unknown at this point so we get the default/first token.

async function githubFetch(path: string, token: string) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "GateTest-Admin/1.0",
    },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

interface WorkflowRun {
  conclusion: string | null;
  status: string;
  created_at: string;
  html_url: string;
  head_branch: string;
  name: string;
}

interface RepoInfo {
  id: number;
  full_name: string;
  name: string;
  html_url: string;
  private: boolean;
  pushed_at: string;
  pushedAgeDays: number | null;
  default_branch: string;
  latestRun: WorkflowRun | null;
  latestRunAgeDays: number | null;
  ciStatus: "passing" | "failing" | "pending" | "none" | "stale";
}

export async function GET() {
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = await getBestGitHubToken();
  if (!token) {
    return NextResponse.json(
      { error: "No GitHub token configured. Add one in Admin → Connected Accounts, or set GATETEST_GITHUB_TOKEN in Vercel env vars." },
      { status: 503 }
    );
  }

  // Fetch repos accessible to the token. Try user repos first, then org.
  let repos: Array<{ id: number; full_name: string; name: string; html_url: string; private: boolean; pushed_at: string; default_branch: string }> = [];

  const userRepos = await githubFetch("/user/repos?type=owner&sort=pushed&per_page=100", token);
  if (Array.isArray(userRepos)) repos = userRepos;

  // Also pull org repos if the token owner belongs to orgs
  const orgs = await githubFetch("/user/orgs", token);
  if (Array.isArray(orgs)) {
    const orgRepoFetches = await Promise.all(
      orgs.slice(0, 5).map((o: { login: string }) =>
        githubFetch(`/orgs/${o.login}/repos?sort=pushed&per_page=50`, token)
      )
    );
    for (const batch of orgRepoFetches) {
      if (Array.isArray(batch)) repos.push(...batch);
    }
  }

  // Deduplicate by id
  const seen = new Set<number>();
  repos = repos.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  // Sort by most recently pushed
  repos.sort((a, b) => new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime());

  // Enrich with latest workflow run (parallel, capped at 30 repos to avoid rate-limit).
  // We deliberately filter by the repo's default branch so a long-stale CI run on
  // some abandoned feature branch can't masquerade as "current repo health" —
  // that was the bug that caused April-dated "failing" rows to show up months
  // later and the watchdog to try and fix code that had already moved on.
  const now = Date.now();
  const STALE_RUN_DAYS = 30;
  const INACTIVE_PUSH_DAYS = 60;
  const enriched: RepoInfo[] = await Promise.all(
    repos.slice(0, 50).map(async (repo) => {
      const branch = encodeURIComponent(repo.default_branch || "main");
      const runs = await githubFetch(
        `/repos/${repo.full_name}/actions/runs?per_page=1&branch=${branch}&exclude_pull_requests=true`,
        token
      );
      const latestRun: WorkflowRun | null =
        Array.isArray(runs?.workflow_runs) && runs.workflow_runs.length > 0
          ? runs.workflow_runs[0]
          : null;

      const latestRunAgeDays = latestRun
        ? Math.floor((now - new Date(latestRun.created_at).getTime()) / 86_400_000)
        : null;
      const pushedAgeDays = repo.pushed_at
        ? Math.floor((now - new Date(repo.pushed_at).getTime()) / 86_400_000)
        : null;

      let ciStatus: RepoInfo["ciStatus"] = "none";
      if (latestRun) {
        if (latestRun.status === "in_progress" || latestRun.status === "queued") {
          ciStatus = "pending";
        } else if (latestRun.conclusion === "success") {
          ciStatus = "passing";
        } else if (
          latestRun.conclusion === "failure" ||
          latestRun.conclusion === "timed_out" ||
          latestRun.conclusion === "action_required"
        ) {
          ciStatus = "failing";
        }
      }

      // Freshness gate. Anything older than STALE_RUN_DAYS is reported as
      // "stale" so the operator can't accidentally batch-fix code that hasn't
      // been touched in months. A genuinely inactive repo (no push in
      // INACTIVE_PUSH_DAYS) collapses to "stale" even if it never had CI.
      const isStaleRun = latestRunAgeDays !== null && latestRunAgeDays > STALE_RUN_DAYS;
      const isInactive = pushedAgeDays !== null && pushedAgeDays > INACTIVE_PUSH_DAYS;
      if (isStaleRun || (ciStatus === "none" && isInactive)) {
        ciStatus = "stale";
      }

      return {
        id: repo.id,
        full_name: repo.full_name,
        name: repo.name,
        html_url: repo.html_url,
        private: repo.private,
        pushed_at: repo.pushed_at,
        pushedAgeDays,
        default_branch: repo.default_branch,
        latestRun,
        latestRunAgeDays,
        ciStatus,
      };
    })
  );

  const failing = enriched.filter((r) => r.ciStatus === "failing").length;
  const passing = enriched.filter((r) => r.ciStatus === "passing").length;
  const stale = enriched.filter((r) => r.ciStatus === "stale").length;

  return NextResponse.json({
    repos: enriched,
    total: enriched.length,
    failing,
    passing,
    stale,
    freshness: {
      staleRunDays: STALE_RUN_DAYS,
      inactivePushDays: INACTIVE_PUSH_DAYS,
    },
    generated_at: new Date().toISOString(),
  });
}
