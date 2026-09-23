/**
 * Admin top-bar build facts — the deployed commit vs `origin/main`, and how
 * stale the running build is (issue #691, sidebar/top-bar item 1; reused by
 * the Overview dashboard, item 2 — "live commit vs origin/main and last
 * deploy time (the readiness-probe facts)"). One definition, imported by
 * both (Doctrine #4).
 *
 * The deployed commit + build time are read the same way
 * `/api/platform-status` and `public-status-collect.ts` already do:
 * `GIT_COMMIT` env (a deploy platform may inject its own) else the git SHA
 * `scripts/generate-build-info.js` bakes into `app/data/build-info.json` at
 * build time.
 *
 * `origin/main`'s current tip is read from the GitHub REST "compare" API —
 * best-effort, bounded by a short timeout, and NEVER allowed to fail the
 * caller: a network hiccup or rate limit yields `unknown`, not a thrown
 * error (Doctrine #1 — three-state, never a silent wrong answer).
 */

import buildInfo from "@/app/data/build-info.json";

export interface BuildStatus {
  deployedCommit: string;
  deployedShortCommit: string;
  builtAt: string | null;
  buildAgeSeconds: number | null;
  /** 24h ceiling, matching the worker-heartbeat staleness rule (#688). */
  buildStale: boolean | null;
  main: {
    /** "ahead" | "behind" | "identical" | "diverged" | "unknown" */
    status: "ahead" | "behind" | "identical" | "diverged" | "unknown";
    behindBy: number | null;
    commit: string | null;
    checked: boolean;
    reason?: string;
  };
  checkedAt: string;
}

const COMPARE_TIMEOUT_MS = 2500;
const BUILD_STALE_SECONDS = 24 * 60 * 60;

function repoSlug(): string {
  return process.env.GATETEST_REPO || "crclabs-hq/GateTest";
}

function deployedCommit(): string {
  return process.env.GIT_COMMIT ?? buildInfo.commit ?? "unknown";
}

async function compareToMain(commit: string): Promise<BuildStatus["main"]> {
  if (!commit || commit === "unknown") {
    return { status: "unknown", behindBy: null, commit: null, checked: false, reason: "deployed commit unknown" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPARE_TIMEOUT_MS);
  try {
    const token = process.env.GITHUB_TOKEN || process.env.GATETEST_GITHUB_TOKEN || "";
    const res = await fetch(`https://api.github.com/repos/${repoSlug()}/compare/main...${commit}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "GateTest-Admin/1.0",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      return { status: "unknown", behindBy: null, commit: null, checked: false, reason: `GitHub API ${res.status}` };
    }
    const body = (await res.json()) as {
      status?: string;
      behind_by?: number;
      ahead_by?: number;
      base_commit?: { sha?: string };
    };
    const mainSha = body.base_commit?.sha ?? null;
    // GitHub's compare direction here is base(main)...head(deployed): a
    // deployed commit that is "ahead" of main (status: "ahead") means
    // deployed has commits main doesn't — the ordinary case right after a
    // merge into main hasn't been picked up by main's OWN history yet, or
    // this deployment is running a feature branch. "behind" means main has
    // moved past what's deployed — the case operators care about.
    const status =
      body.status === "ahead" || body.status === "behind" || body.status === "identical" || body.status === "diverged"
        ? body.status
        : "unknown";
    return {
      status,
      behindBy: typeof body.behind_by === "number" ? body.behind_by : null,
      commit: mainSha,
      checked: true,
    };
  } catch (err) {
    return {
      status: "unknown",
      behindBy: null,
      commit: null,
      checked: false,
      reason: err instanceof Error ? err.message : "compare failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function getBuildStatus(): Promise<BuildStatus> {
  const commit = deployedCommit();
  const builtAt = buildInfo.builtAt ?? null;
  const now = Date.now();
  const builtAtMs = builtAt ? Date.parse(builtAt) : NaN;
  const buildAgeSeconds = Number.isFinite(builtAtMs) ? Math.max(0, Math.floor((now - builtAtMs) / 1000)) : null;

  const main = await compareToMain(commit);

  return {
    deployedCommit: commit,
    deployedShortCommit: commit === "unknown" ? "unknown" : commit.slice(0, 7),
    builtAt,
    buildAgeSeconds,
    buildStale: buildAgeSeconds === null ? null : buildAgeSeconds > BUILD_STALE_SECONDS,
    main,
    checkedAt: new Date().toISOString(),
  };
}

export { BUILD_STALE_SECONDS };
