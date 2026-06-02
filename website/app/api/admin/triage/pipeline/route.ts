/**
 * POST /api/admin/triage/pipeline
 *
 * Orchestrator endpoint for the deploy-pipeline trace flow.
 *
 * Given a repo URL and a live URL, gathers four stage summaries IN
 * PARALLEL — source HEAD (GitHub branch tip), CI (latest workflow
 * run on the default branch), Deploy (latest GitHub Deployment for
 * the default branch + its latest status), and Live (the live URL's
 * response headers + embedded SHA marker if present) — hands them
 * to the pure correlator at app/lib/pipeline-trace/correlator.js,
 * and returns the verdict + a renderable markdown block.
 *
 * Auth: gatetest_admin cookie — same two-method check as every
 * other /api/admin/* route. Returns 401 if not authenticated.
 *
 * This is fundamentally different from /api/admin/triage which
 * triages bugs across source/server/browser. This one traces the
 * deploy chain to localise WHERE the latest update is stuck.
 *
 * Tolerant of per-stage failure: a failed gatherer returns
 * { ok: false, error } so the correlator can reason about partial
 * signals. We never bail the whole trace because one stage 5xx'd.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import {
  getAdminConfig,
  getAdminUser,
  SESSION_COOKIE_NAME,
} from "@/app/lib/admin-session";
import { ADMIN_COOKIE_NAME } from "@/app/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// ----------------------------------------------------------------------------
// Types — mirror the correlator's public surface. Replicated here as TS
// interfaces because the correlator ships as a .js module; keeping them
// local avoids a typedef-chasing dependency at build time. Kept verbatim
// in sync with the correlator's spec.
// ----------------------------------------------------------------------------

type StageState = "ok" | "stale" | "behind" | "failing" | "missing" | "unknown";

interface StageReport {
  stage: "source" | "ci" | "deploy" | "live";
  ok: boolean;
  state?: StageState;
  sha: string | null;
  shortSha: string | null;
  timestamp: string | null;
  ageMinutes: number | null;
  conclusion?: string | null;
  url?: string | null;
  error?: string;
  details?: string[];
}

interface PipelineVerdict {
  stuckAt: "source" | "ci" | "deploy" | "live" | "none" | "unknown";
  confidence: "low" | "medium" | "high";
  summary: string;
  reasons: string[];
}

interface CommitDelta {
  behind: number;
  commits: Array<{ sha: string; message: string; author?: string }>;
}

interface TraceInput {
  source: StageReport;
  ci: StageReport;
  deploy: StageReport;
  live: StageReport;
}

// ----------------------------------------------------------------------------
// Correlator import — .js module loaded via require. eslint config
// already exempts app/api/**/route.ts from no-require-imports, so no
// inline disable directive is needed.
// ----------------------------------------------------------------------------

const { trace, renderTraceMarkdown } = require("@/app/lib/pipeline-trace/correlator.js") as {
  trace: (input: TraceInput) => { verdict: PipelineVerdict; stages: StageReport[] };
  renderTraceMarkdown: (
    verdict: PipelineVerdict,
    stages: StageReport[]
  ) => string;
};

// ----------------------------------------------------------------------------
// Auth — copied verbatim from /api/admin/repos/route.ts so every admin
// surface uses the same canonical check.
// ----------------------------------------------------------------------------

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

function githubToken(): string {
  return (
    process.env.GATETEST_GITHUB_TOKEN ||
    process.env.GITHUB_TOKEN ||
    ""
  );
}

async function githubFetch(path: string, token: string): Promise<{
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
}> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "GateTest-PipelineTrace/1.0",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data: null,
        error: `HTTP ${res.status}`,
      };
    }
    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, data: null, error: msg };
  }
}

// ----------------------------------------------------------------------------
// Input validation + normalisation
// ----------------------------------------------------------------------------

interface RepoParts {
  owner: string;
  repo: string;
}

function parseRepoUrl(input: string): RepoParts | null {
  const v = (input || "").trim();
  if (!v) return null;
  // owner/repo shorthand
  const shortMatch = v.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2].replace(/\.git$/, "") };
  }
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!/github\.com$/i.test(u.hostname)) return null;
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length < 2) return null;
    return { owner: segs[0], repo: segs[1].replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

function isValidLiveUrl(input: string): boolean {
  const v = (input || "").trim();
  if (!v) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Helper — derive age in minutes from an ISO timestamp.
// ----------------------------------------------------------------------------

function ageMinutesFrom(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 60_000));
}

// ----------------------------------------------------------------------------
// Stage 1 — Source HEAD
// ----------------------------------------------------------------------------

interface SourceCtx {
  defaultBranch: string;
}

async function gatherSource(
  parts: RepoParts,
  token: string,
  now: number
): Promise<{ stage: StageReport; ctx: SourceCtx | null }> {
  const baseFail: StageReport = {
    stage: "source",
    ok: false,
    sha: null,
    shortSha: null,
    timestamp: null,
    ageMinutes: null,
  };

  // Resolve default branch
  const repoRes = await githubFetch(
    `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}`,
    token
  );
  if (!repoRes.ok) {
    return {
      stage: { ...baseFail, error: repoRes.error || `repo lookup failed (HTTP ${repoRes.status})` },
      ctx: null,
    };
  }
  const repoData = repoRes.data as { default_branch?: string } | null;
  const defaultBranch = repoData?.default_branch || "main";

  const branchRes = await githubFetch(
    `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/branches/${encodeURIComponent(defaultBranch)}`,
    token
  );
  if (!branchRes.ok) {
    return {
      stage: { ...baseFail, error: branchRes.error || `branch lookup failed (HTTP ${branchRes.status})` },
      ctx: { defaultBranch },
    };
  }
  const branchData = branchRes.data as
    | {
        commit?: {
          sha?: string;
          html_url?: string;
          commit?: { committer?: { date?: string } };
        };
      }
    | null;

  const sha = branchData?.commit?.sha || null;
  const timestamp = branchData?.commit?.commit?.committer?.date || null;
  const url = branchData?.commit?.html_url || null;

  return {
    stage: {
      stage: "source",
      ok: true,
      sha,
      shortSha: sha ? sha.slice(0, 7) : null,
      timestamp,
      ageMinutes: ageMinutesFrom(timestamp, now),
      url,
      details: [`branch: ${defaultBranch}`],
    },
    ctx: { defaultBranch },
  };
}

// ----------------------------------------------------------------------------
// Stage 2 — CI (with failed-job peek when conclusion = failure)
// ----------------------------------------------------------------------------

type CIRun = {
  id?: number;
  head_sha?: string;
  created_at?: string;
  conclusion?: string | null;
  status?: string;
  html_url?: string;
  name?: string;
};

type CIJob = {
  name?: string;
  conclusion?: string;
  steps?: Array<{ name?: string; conclusion?: string }>;
};

async function gatherCI(
  parts: RepoParts,
  defaultBranch: string,
  token: string,
  now: number
): Promise<StageReport> {
  const baseFail: StageReport = {
    stage: "ci",
    ok: false,
    sha: null,
    shortSha: null,
    timestamp: null,
    ageMinutes: null,
  };

  const branch = encodeURIComponent(defaultBranch);
  const res = await githubFetch(
    `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/actions/runs?branch=${branch}&per_page=1`,
    token
  );
  if (!res.ok) {
    return { ...baseFail, error: res.error || `HTTP ${res.status}` };
  }
  const data = res.data as { workflow_runs?: CIRun[] } | null;
  const runs = Array.isArray(data?.workflow_runs) ? data!.workflow_runs : [];
  if (runs.length === 0) {
    return {
      stage: "ci",
      ok: true,
      sha: null,
      shortSha: null,
      timestamp: null,
      ageMinutes: null,
      details: ["no workflow runs found"],
    };
  }
  const run = runs[0];
  const sha = run.head_sha || null;
  const timestamp = run.created_at || null;
  const details: string[] = run.name ? [`workflow: ${run.name}`] : [];

  // When CI failed, fetch the first few failed job names + their failed step.
  if (run.conclusion === "failure" && typeof run.id === "number") {
    const jobsRes = await githubFetch(
      `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/actions/runs/${run.id}/jobs?filter=latest&per_page=10`,
      token
    );
    if (jobsRes.ok) {
      const jobsData = jobsRes.data as { jobs?: CIJob[] } | null;
      const failedJobs = (jobsData?.jobs || []).filter((j) => j.conclusion === "failure");
      for (const job of failedJobs.slice(0, 3)) {
        details.push(`✗ job: ${job.name || "unknown"}`);
        const failedStep = (job.steps || []).find((s) => s.conclusion === "failure");
        if (failedStep?.name) details.push(`  step: ${failedStep.name}`);
      }
    }
  }

  return {
    stage: "ci",
    ok: true,
    sha,
    shortSha: sha ? sha.slice(0, 7) : null,
    timestamp,
    ageMinutes: ageMinutesFrom(timestamp, now),
    conclusion: run.conclusion ?? null,
    state: (run.status as StageState | undefined) ?? undefined,
    url: run.html_url || null,
    details,
  };
}

// ----------------------------------------------------------------------------
// Stage 3 — Deploy
// ----------------------------------------------------------------------------

async function gatherDeploy(
  parts: RepoParts,
  defaultBranch: string,
  token: string,
  now: number
): Promise<StageReport> {
  const baseFail: StageReport = {
    stage: "deploy",
    ok: false,
    sha: null,
    shortSha: null,
    timestamp: null,
    ageMinutes: null,
  };

  const ref = encodeURIComponent(defaultBranch);
  const res = await githubFetch(
    `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/deployments?ref=${ref}&per_page=5`,
    token
  );
  if (!res.ok) {
    return { ...baseFail, error: res.error || `HTTP ${res.status}` };
  }
  const deployments = (Array.isArray(res.data) ? res.data : []) as Array<{
    id?: number;
    sha?: string;
    created_at?: string;
    environment?: string;
  }>;
  if (deployments.length === 0) {
    return {
      stage: "deploy",
      ok: true,
      sha: null,
      shortSha: null,
      timestamp: null,
      ageMinutes: null,
      details: ["no deployments registered on default branch"],
    };
  }

  // Pull latest status for each deployment in parallel
  const statusFetches = await Promise.all(
    deployments.map((d) =>
      typeof d.id === "number"
        ? githubFetch(
            `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/deployments/${d.id}/statuses?per_page=1`,
            token
          )
        : Promise.resolve({ ok: false, status: 0, data: null })
    )
  );

  type DeploymentStatus = {
    state?: string;
    environment_url?: string;
    target_url?: string;
    log_url?: string;
  };

  const enriched = deployments.map((d, i) => {
    const sf = statusFetches[i];
    const statusList = sf.ok && Array.isArray(sf.data) ? (sf.data as DeploymentStatus[]) : [];
    const latestStatus = statusList[0] || null;
    return { deployment: d, latestStatus };
  });

  // Pick most recent successful, else most recent overall.
  const successful = enriched.filter(
    (e) => (e.latestStatus?.state || "").toLowerCase() === "success"
  );
  const chosen = successful[0] || enriched[0];

  const sha = chosen.deployment.sha || null;
  const timestamp = chosen.deployment.created_at || null;
  const state = chosen.latestStatus?.state || null;
  const envUrl = chosen.latestStatus?.environment_url || null;
  const targetUrl = chosen.latestStatus?.target_url || null;
  const environment = chosen.deployment.environment || null;

  const details: string[] = [];
  if (environment) details.push(`environment: ${environment}`);
  if (state) details.push(`status: ${state}`);

  return {
    stage: "deploy",
    ok: true,
    sha,
    shortSha: sha ? sha.slice(0, 7) : null,
    timestamp,
    ageMinutes: ageMinutesFrom(timestamp, now),
    state: (state as StageState | null) || undefined,
    url: envUrl || targetUrl || environment || null,
    details,
  };
}

// ----------------------------------------------------------------------------
// Stage 4 — Live URL probe (with cache diagnosis + service-worker detection)
// ----------------------------------------------------------------------------

// Cache diagnosis: reads CDN/edge response headers and produces human-readable
// explanations of WHY the browser may be seeing stale content.
function diagnoseCacheHeaders(headers: Headers): string[] {
  const diagnoses: string[] = [];
  const cc = (headers.get("cache-control") || "").toLowerCase();
  const age = headers.get("age");
  const vercelCache = headers.get("x-vercel-cache");
  const cfCache = headers.get("cf-cache-status");
  const cdnCache = headers.get("cdn-cache-status") || headers.get("x-cache-status");
  const ageNum = age !== null ? Number(age) : NaN;

  // CDN-specific status first (most informative).
  if (vercelCache) {
    const hit = vercelCache.toUpperCase() === "HIT";
    diagnoses.push(`⚡ Vercel edge cache: ${vercelCache}${hit ? " — browser is getting a cached response" : ""}`);
  }
  if (cfCache) {
    const hit = cfCache.toUpperCase() === "HIT";
    diagnoses.push(`☁ Cloudflare cache: ${cfCache}${hit ? " — browser is getting a cached response" : ""}`);
  }
  if (cdnCache) {
    diagnoses.push(`CDN cache: ${cdnCache}`);
  }

  // Age header: tells us how old the cached copy is.
  if (!Number.isNaN(ageNum) && ageNum > 0) {
    diagnoses.push(`⏱ Age: ${ageNum}s — this response was cached ${formatAgeHuman(ageNum)} ago`);
  }

  // Cache-Control directive diagnosis.
  if (!cc) {
    diagnoses.push("⚠ Cache-Control: MISSING — browser and CDN may cache HTML indefinitely");
  } else if (cc.includes("no-store")) {
    diagnoses.push("✓ Cache-Control: no-store (caching disabled)");
  } else if (cc.includes("no-cache")) {
    diagnoses.push("○ Cache-Control: no-cache (must revalidate before serving)");
  } else if (cc.includes("max-age=0") || cc.includes("s-maxage=0")) {
    diagnoses.push("○ Cache-Control: max-age=0 (always revalidate)");
  } else {
    const maxAgeMatch = cc.match(/max-age=(\d+)/);
    const sMaxAgeMatch = cc.match(/s-maxage=(\d+)/);
    const ttl = sMaxAgeMatch ? Number(sMaxAgeMatch[1]) : maxAgeMatch ? Number(maxAgeMatch[1]) : null;
    if (ttl !== null && ttl > 0) {
      diagnoses.push(`⚠ Cache-Control: max-age=${ttl}s (CDN/browser may serve this for ${formatAgeHuman(ttl)})`);
    }
  }

  return diagnoses;
}

const SHA_RE_40 = /\b([a-f0-9]{40})\b/i;

function extractSha(body: string): { sha: string | null; nextBuildId: string | null } {
  // Priority 1: <meta name="commit" content="<40-hex>">
  const meta1 = body.match(/<meta\s+name=["']commit["']\s+content=["']([a-f0-9]{40})["']/i);
  if (meta1) return { sha: meta1[1], nextBuildId: null };
  // Priority 2: <meta name="git-sha" content="<40-hex>">
  const meta2 = body.match(/<meta\s+name=["']git-sha["']\s+content=["']([a-f0-9]{40})["']/i);
  if (meta2) return { sha: meta2[1], nextBuildId: null };
  // Priority 3: <meta name="version" content="<40-hex>">
  const meta3 = body.match(/<meta\s+name=["']version["']\s+content=["']([a-f0-9]{40})["']/i);
  if (meta3) return { sha: meta3[1], nextBuildId: null };
  // Priority 5: <!-- commit: <sha> -->
  const comment = body.match(/<!--\s*commit:\s*([a-f0-9]{40})\s*-->/i);
  if (comment) return { sha: comment[1], nextBuildId: null };
  // Priority 6: JSON-shaped "commit":"...", "buildId":"...", "version":"..."
  const jsonCommit = body.match(/"commit"\s*:\s*"([a-f0-9]{40})"/i);
  if (jsonCommit) return { sha: jsonCommit[1], nextBuildId: null };
  const jsonBuildId40 = body.match(/"buildId"\s*:\s*"([a-f0-9]{40})"/i);
  if (jsonBuildId40) return { sha: jsonBuildId40[1], nextBuildId: null };
  const jsonVersion = body.match(/"version"\s*:\s*"([a-f0-9]{40})"/i);
  if (jsonVersion) return { sha: jsonVersion[1], nextBuildId: null };
  // Priority 4: Next.js build ID (NOT a commit SHA, but the closest available)
  const nextBuild = body.match(/_next\/static\/([A-Za-z0-9_-]+)\//);
  if (nextBuild && nextBuild[1] !== "chunks" && nextBuild[1] !== "css" && nextBuild[1] !== "media") {
    return { sha: null, nextBuildId: nextBuild[1] };
  }
  // Last-ditch JSON buildId of any shape
  const jsonBuildIdAny = body.match(/"buildId"\s*:\s*"([A-Za-z0-9_-]+)"/i);
  if (jsonBuildIdAny) return { sha: null, nextBuildId: jsonBuildIdAny[1] };
  return { sha: null, nextBuildId: null };
}

function formatAgeHuman(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

async function gatherLive(liveUrl: string, now: number): Promise<StageReport> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000);

  const baseFail: StageReport = {
    stage: "live",
    ok: false,
    sha: null,
    shortSha: null,
    timestamp: null,
    ageMinutes: null,
    url: liveUrl,
  };

  try {
    const res = await fetch(liveUrl, {
      redirect: "follow",
      headers: {
        "user-agent": "GateTest-PipelineTrace/1.0",
        "cache-control": "no-cache",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const details: string[] = [`status: ${res.status}`];

    // Raw header collection (informational).
    const headerKeys = [
      "server",
      "x-powered-by",
      "x-vercel-id",
      "x-served-by",
      "etag",
      "last-modified",
    ];
    for (const k of headerKeys) {
      const v = res.headers.get(k);
      if (v) details.push(`${k}: ${v}`);
    }

    // Cache diagnosis (most actionable info first).
    const cacheDiagnoses = diagnoseCacheHeaders(res.headers);
    details.push(...cacheDiagnoses);

    if (!res.ok) {
      return {
        ...baseFail,
        error: `HTTP ${res.status}`,
        details,
      };
    }

    const body = await res.text();
    const { sha, nextBuildId } = extractSha(body);
    if (!sha && nextBuildId) {
      details.push(`nextBuildId: ${nextBuildId}`);
    }

    // Service worker detection — if the page registers a SW, the browser may
    // serve stale cached responses even in incognito mode if the SW was
    // installed in a prior session.
    const swPatterns = [
      /navigator\.serviceWorker\.register\s*\(/i,
      /['"](?:sw|service-worker|workbox(?:-precache)?(?:-v\d+)?)\.js['"]/i,
    ];
    if (swPatterns.some((re) => re.test(body))) {
      details.push(
        "⚠ service-worker: REGISTERED — SW may intercept requests and serve stale content, even in incognito"
      );
    }

    const lastModified = res.headers.get("last-modified");
    const ageHeader = res.headers.get("age");
    let timestamp: string | null = null;
    if (lastModified) {
      const parsed = Date.parse(lastModified);
      if (!Number.isNaN(parsed)) timestamp = new Date(parsed).toISOString();
    }
    let ageMin: number | null = null;
    if (ageHeader) {
      const ageSec = Number(ageHeader);
      if (Number.isFinite(ageSec)) ageMin = Math.floor(ageSec / 60);
    }
    if (ageMin === null) ageMin = ageMinutesFrom(timestamp, now);

    return {
      stage: "live",
      ok: true,
      sha,
      shortSha: sha ? sha.slice(0, 7) : null,
      timestamp,
      ageMinutes: ageMin,
      url: liveUrl,
      details,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    return { ...baseFail, error: msg };
  }
}

// ----------------------------------------------------------------------------
// Route handler
// ----------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = githubToken();
  if (!token) {
    return NextResponse.json(
      {
        error: "no-github-token",
        message:
          "No GitHub token configured. Set GATETEST_GITHUB_TOKEN or GITHUB_TOKEN in Vercel env vars.",
      },
      { status: 503 }
    );
  }

  const startedAt = Date.now();

  let body: { repoUrl?: string; liveUrl?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "invalid-json", message: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const repoRaw = String(body?.repoUrl || "");
  const parts = parseRepoUrl(repoRaw);
  if (!parts) {
    return NextResponse.json(
      {
        error: "invalid-repoUrl",
        message:
          "repoUrl is required — pass either 'owner/repo' or a full https://github.com/owner/repo URL.",
      },
      { status: 400 }
    );
  }
  const repoUrlNormalised = `https://github.com/${parts.owner}/${parts.repo}`;

  const liveUrlRaw = String(body?.liveUrl || "").trim();
  if (!isValidLiveUrl(liveUrlRaw)) {
    return NextResponse.json(
      {
        error: "invalid-liveUrl",
        message: "liveUrl is required and must be an http(s) URL.",
      },
      { status: 400 }
    );
  }

  const now = Date.now();

  try {
    // Source must complete first so CI + Deploy know the default branch.
    // But fan everything else out in parallel — including the live probe
    // (which doesn't need the default branch) AND the source fetch — by
    // racing the live probe alongside the chained CI/Deploy sequence.
    const sourcePromise = gatherSource(parts, token, now);
    const livePromise = gatherLive(liveUrlRaw, now);

    // Wait for source so we have defaultBranch for CI + Deploy gatherers.
    const sourceSettled = await sourcePromise;
    const defaultBranch = sourceSettled.ctx?.defaultBranch || "main";

    const [ciSettled, deploySettled, liveSettled] = await Promise.allSettled([
      gatherCI(parts, defaultBranch, token, now),
      gatherDeploy(parts, defaultBranch, token, now),
      livePromise,
    ]);

    const unwrap = (
      settled: PromiseSettledResult<StageReport>,
      stage: StageReport["stage"]
    ): StageReport => {
      if (settled.status === "fulfilled") return settled.value;
      const msg =
        settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason);
      return {
        stage,
        ok: false,
        sha: null,
        shortSha: null,
        timestamp: null,
        ageMinutes: null,
        error: msg,
      };
    };

    const sourceStage = sourceSettled.stage;
    const deployStage = unwrap(deploySettled, "deploy");

    const stagesInput: TraceInput = {
      source: sourceStage,
      ci: unwrap(ciSettled, "ci"),
      deploy: deployStage,
      live: unwrap(liveSettled, "live"),
    };

    // Commit delta: list commits stuck between deploy SHA and source HEAD.
    // Only computed when both SHAs are known and differ.
    let commitDelta: CommitDelta | null = null;
    if (
      sourceStage.sha &&
      deployStage.sha &&
      sourceStage.sha !== deployStage.sha
    ) {
      const compareRes = await githubFetch(
        `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/compare/${deployStage.sha}...${sourceStage.sha}`,
        token
      );
      if (compareRes.ok) {
        const cd = compareRes.data as {
          ahead_by?: number;
          commits?: Array<{
            sha?: string;
            commit?: { message?: string; author?: { name?: string } };
          }>;
        } | null;
        const rawCommits = cd?.commits || [];
        commitDelta = {
          behind: cd?.ahead_by ?? rawCommits.length,
          commits: rawCommits.slice(0, 5).map((c) => ({
            sha: (c.sha || "").slice(0, 7),
            message: (c.commit?.message || "").split("\n")[0].slice(0, 72),
            author: c.commit?.author?.name,
          })),
        };
        // Inject commit delta into deploy stage details for the markdown.
        if (commitDelta.behind > 0) {
          deployStage.details = deployStage.details || [];
          deployStage.details.push(
            `⚠ ${commitDelta.behind} commit(s) behind source HEAD:`
          );
          for (const c of commitDelta.commits) {
            deployStage.details.push(`  [${c.sha}] ${c.message}${c.author ? ` — ${c.author}` : ""}`);
          }
          if (commitDelta.behind > 5) {
            deployStage.details.push(`  … and ${commitDelta.behind - 5} more`);
          }
        }
      }
    }

    const { verdict, stages } = trace(stagesInput);
    const markdown = renderTraceMarkdown(verdict, stages);

    return NextResponse.json({
      ok: true,
      tracedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      inputs: { repoUrl: repoUrlNormalised, liveUrl: liveUrlRaw },
      verdict,
      stages,
      commitDelta,
      markdown,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[GateTest] pipeline trace POST crashed:", message);
    return NextResponse.json(
      { error: "pipeline-trace-failed", message },
      { status: 500 }
    );
  }
}
