/**
 * Scan executor — shared scan-runner used by the webhook async handler.
 *
 * Delegates the actual module execution to the unified module registry in
 * app/lib/scan-modules — the same code path that /api/scan/run uses. That
 * way there's exactly one place where modules are defined and honesty
 * rules (real work or honest skip) are enforced.
 *
 * Idempotency: the caller passes a jobId (derived from the Stripe session id)
 * and we check whether the payment intent metadata already records this job
 * before capturing/cancelling. This guarantees a Stripe webhook retry cannot
 * double-capture a customer.
 */

import https from "https";
import { getDb } from "./db";
import { loadRepoFiles, resolveRepoAuth } from "./gluecron-client";
import { type RepoFile, TIERS } from "./scan-modules";
import { runEngineForTier, CLI_ENGINE_TIERS, type RankedFinding, type FindingSummary } from "./scan-engine-dispatch";
import { changedLines, lineInChange } from "./changed-lines";

/** Safe set of tier names — anything outside this set falls back to "quick". */
const KNOWN_TIERS = new Set(Object.keys(TIERS));

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
/** In-memory quick tier: a small, fast sample is the point (free funnel). */
const QUICK_MAX_FILES = 60;
/** CLI-engine tiers: the whole repo, bounded by the engine's own budget. */
const ENGINE_MAX_FILES = 4000;
/** Wall-clock budget for one hosted engine run (worker tick / Stripe job). */
const ENGINE_TIME_BUDGET_MS = 240_000;

/** Files that must be present for monorepo/workspace discovery and the
 *  modules that read conventions — loaded first when any cap applies. */
const PRIORITY_FILES = new Set([
  "package.json", "pnpm-workspace.yaml", "pnpm-workspace.yml", "lerna.json",
  "tsconfig.json", ".gatetest.json", ".gatetestignore", "pyproject.toml",
  "go.mod", "Cargo.toml", "Gemfile", "composer.json", "pom.xml", "build.gradle",
]);
const prioritizeManifest = (p: string): boolean => PRIORITY_FILES.has(p.split("/").pop() ?? "");

interface ScanModuleResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  checks: number;
  issues: number;
  duration: number;
  details?: string[];
  skipped?: string;
  /** Real USD cost incurred running this module (e.g. aiReview's Claude spend). Omitted/0 for free modules. */
  costUsd?: number;
}

export interface ScanResult {
  status: "complete" | "failed";
  modules: ScanModuleResult[];
  totalModules: number;
  completedModules: number;
  totalIssues: number;
  totalFixed: number;
  duration: number;
  authSource?: string | null;
  error?: string;
  /** honesty fields — how much of the repo the engine actually saw */
  filesAnalysed?: number;
  filesInRepo?: number;
  coverageTruncated?: boolean;
  engine?: "cli" | "runTier";
  /** ranked + cross-module-deduped findings (CLI engine tiers) */
  findings?: Array<RankedFinding & { inDiff?: boolean; inChangedFile?: boolean }>;
  findingSummary?: FindingSummary | null;
  /** number of files this push/PR changed vs baseRef (null = no base known) */
  changedFiles?: number | null;
  baseRef?: string | null;
}

function stripeApi(
  method: string,
  path: string,
  body?: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: "api.stripe.com",
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };
    if (body) {
      options.headers = {
        ...options.headers,
        "Content-Length": String(Buffer.byteLength(body)),
      };
    }
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        } catch {
          resolve({});
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Stripe request timed out"));
    });
    if (body) req.write(body);
    req.end();
  });
}

function emptyResult(startTime: number, error: string, authSource?: string | null): ScanResult {
  return {
    status: "failed",
    modules: [],
    totalModules: 0,
    completedModules: 0,
    totalIssues: 0,
    totalFixed: 0,
    duration: Date.now() - startTime,
    authSource: authSource ?? null,
    error,
  };
}

/**
 * Execute a scan from directly-provided files (no GitHub fetch).
 * Used by platforms like Zoobicon that POST file contents to the API.
 */
export async function runScanDirect(
  files: RepoFile[],
  tier: string,
  projectName?: string
): Promise<ScanResult> {
  const startTime = Date.now();

  if (!files || files.length === 0) {
    return emptyResult(startTime, "No files provided");
  }

  const normalisedTier = KNOWN_TIERS.has(tier) ? tier : "quick";
  const capped = files.slice(0, CLI_ENGINE_TIERS.has(normalisedTier) ? ENGINE_MAX_FILES : QUICK_MAX_FILES);
  const filePaths = capped.map((f) => f.path);

  const { modules, totalIssues } = await runEngineForTier({
    tier: normalisedTier,
    owner: projectName || "direct",
    repo: projectName || "upload",
    files: filePaths,
    fileContents: capped,
    deadlineMs: startTime + ENGINE_TIME_BUDGET_MS,
  });

  return {
    status: "complete",
    modules,
    totalModules: modules.length,
    completedModules: modules.length,
    totalIssues,
    totalFixed: 0,
    duration: Date.now() - startTime,
    authSource: "direct",
  };
}

/**
 * Execute the scan for a repo + tier. Returns a ScanResult (never throws).
 */
export async function runScan(
  repoUrl: string,
  tier: string,
  opts: { ref?: string; baseRef?: string } = {}
): Promise<ScanResult> {
  const startTime = Date.now();
  // Scan the commit that was pushed, not whatever HEAD is by the time the
  // worker gets to the job — a status posted on SHA X must describe SHA X.
  const ref = opts.ref && /^[A-Za-z0-9._\/-]+$/.test(opts.ref) ? opts.ref : "HEAD";
  const baseRef = opts.baseRef && /^[0-9a-f]{40}$/i.test(opts.baseRef) && opts.baseRef !== ref ? opts.baseRef : null;

  // Accept Gluecron URLs first; fall back to GitHub URLs so customer-supplied
  // links work in either form during the migration window.
  const gluecronMatch = repoUrl.match(/gluecron\.com\/([^/]+)\/([^/?#]+)/);
  const githubMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  const repoMatch = gluecronMatch || githubMatch;
  if (!repoMatch) {
    return emptyResult(startTime, "Invalid repository URL (expected github.com/<owner>/<repo> or gluecron.com/<owner>/<repo>)");
  }

  const owner = repoMatch[1];
  const repo = repoMatch[2].replace(/\.git$/, "");

  const auth = await resolveRepoAuth(owner, repo);
  // A missing token is not fatal for a PUBLIC repo — loadRepoFiles reads the
  // anonymous archive. Private repos surface the real read failure below.
  const token = auth.token || "";
  const normalisedTier = KNOWN_TIERS.has(tier) ? tier : "quick";
  const engineTier = CLI_ENGINE_TIERS.has(normalisedTier);
  const deadlineMs = startTime + ENGINE_TIME_BUDGET_MS;

  // Whole repo in one archive read (credentialed → anonymous → per-blob API).
  // The 50-file sample this used to take meant a paid Full scan of a
  // 2,000-file repo analysed ~2.5% of it; the engine now sees the repo.
  let loaded;
  try {
    loaded = await loadRepoFiles(owner, repo, ref, token, {
      maxFiles: engineTier ? ENGINE_MAX_FILES : QUICK_MAX_FILES,
      prioritize: prioritizeManifest,
      deadlineMs,
    });
  } catch (err) {
    return emptyResult(
      startTime,
      `Cannot access repository ${owner}/${repo} (${err instanceof Error ? err.message : "tree read failed"})${auth.error ? ` — ${auth.error}` : ""}`,
      auth.source
    );
  }
  const { paths: files, fileContents } = loaded;
  if (files.length === 0) {
    return emptyResult(
      startTime,
      `Cannot access repository ${owner}/${repo} — empty tree returned`,
      auth.source
    );
  }
  if (loaded.warning) {
    // eslint-disable-next-line no-console
    console.warn(`[scan-executor] ${owner}/${repo}: ${loaded.warning}`);
  }

  // "Is this finding in code THIS change touched?" — the loudest complaint
  // about quality gates is failing on old code counted as new. When the
  // event carried a base commit, load its tree too (one more archive read)
  // and diff by content. Attribution is LINE-level (changed-lines.js): a
  // finding is `inDiff` when it sits on a line the change inserted or
  // modified, `inChangedFile` when the file moved at all. File-level alone
  // was the same complaint one level down — touch one line of a 900-line
  // file and every old finding in it read as new (2026-09-05).
  // gate-verdict.js enforces on `inDiff` in strict/admin mode: a blocking
  // finding on a line this change did not touch is reported, not enforced.
  // With no base (first push, force-push, unreadable base) the whole repo
  // is enforced and the verdict says so.
  let changedFiles: Map<string, ReturnType<typeof changedLines>> | null = null;
  if (baseRef && engineTier) {
    try {
      const baseLoaded = await loadRepoFiles(owner, repo, baseRef, token, {
        maxFiles: ENGINE_MAX_FILES,
        prioritize: prioritizeManifest,
        deadlineMs,
      });
      const baseByPath = new Map(baseLoaded.fileContents.map((f) => [f.path, f.content]));
      changedFiles = new Map();
      for (const f of fileContents) {
        const before = baseByPath.get(f.path);
        if (before === undefined || before !== f.content) changedFiles.set(f.path, changedLines(before, f.content));
      }
    } catch (err) { // error-ok — attribution is a refinement; a base read failure must not fail the scan
      console.warn(`[scan-executor] ${owner}/${repo}: base ${baseRef.slice(0, 7)} unreadable, findings not attributed:`, err instanceof Error ? err.message : String(err));
      changedFiles = null;
    }
  }
  const attribute = (f: RankedFinding) => {
    if (!changedFiles) return f;
    const lines = f.file ? changedFiles.get(f.file) : undefined;
    const inChangedFile = lines !== undefined;
    return { ...f, inChangedFile, inDiff: inChangedFile && lineInChange(lines, f.line) };
  };

  const { modules, totalIssues, engineUsed, findings, findingSummary } = await runEngineForTier({
    tier: normalisedTier,
    owner,
    repo,
    files,
    fileContents,
    token,
    deadlineMs,
  });
  if (engineTier && engineUsed !== "cli") {
    // eslint-disable-next-line no-console
    console.warn(`[scan-executor] ${owner}/${repo} (${normalisedTier}): CLI engine unavailable — served in-memory ${modules.length}-module fallback`);
  }

  return {
    status: "complete",
    modules,
    totalModules: modules.length,
    completedModules: modules.length,
    totalIssues,
    totalFixed: 0,
    duration: Date.now() - startTime,
    authSource: auth.source,
    filesAnalysed: fileContents.length,
    filesInRepo: files.length,
    coverageTruncated: loaded.truncated,
    engine: engineUsed,
    findings: findings ? findings.map(attribute) : findings,
    findingSummary,
    changedFiles: changedFiles ? changedFiles.size : null,
    baseRef,
  };
}

/**
 * Run a scan job and update Stripe, idempotently. Safe to call multiple times
 * with the same jobId — the second call is a no-op because metadata.scan_job_id
 * is already recorded on the payment intent.
 */
export async function runScanJob(params: {
  jobId: string;
  paymentIntentId: string;
  repoUrl: string;
  tier: string;
  scanId?: string;
  customerEmail?: string;
  tierPriceUsd?: number;
}): Promise<{ skipped: boolean; reason?: string; result?: ScanResult }> {
  const { jobId, paymentIntentId, repoUrl, tier, scanId, customerEmail, tierPriceUsd } = params;

  if (!STRIPE_SECRET_KEY) {
    return { skipped: true, reason: "stripe_not_configured" };
  }

  // Idempotency check — has this exact job already been processed?
  try {
    const pi = (await stripeApi(
      "GET",
      `/v1/payment_intents/${paymentIntentId}`
    )) as { metadata?: Record<string, string>; status?: string };
    const existingJob = pi.metadata?.scan_job_id;
    const terminalStatuses = ["succeeded", "canceled"];
    if (
      existingJob === jobId ||
      (pi.status && terminalStatuses.includes(pi.status))
    ) {
      return { skipped: true, reason: "already_processed" };
    }
  } catch (err) { // error-ok — idempotency check failure must not block the scan
    console.error("[GateTest] Idempotency check failed:", err);
    // Proceed — we'd rather run the scan than double-cancel a live hold.
  }

  // Stamp the job id FIRST. If anything below fails, a retry will still see
  // this stamp and skip. We re-stamp the final status at the end.
  try {
    await stripeApi(
      "POST",
      `/v1/payment_intents/${paymentIntentId}`,
      new URLSearchParams({
        "metadata[scan_job_id]": jobId,
        "metadata[scan_status]": "running",
      }).toString()
    );
  } catch (err) { // error-ok — job-stamp failure is not fatal; scan still runs
    console.error("[GateTest] Failed to stamp job id:", err);
  }

  let result: ScanResult;
  try {
    result = await runScan(repoUrl, tier);
  } catch (err) {
    result = {
      status: "failed",
      modules: [],
      totalModules: 0,
      completedModules: 0,
      totalIssues: 0,
      totalFixed: 0,
      duration: 0,
      error: `Scan crashed: ${(err as Error).message}`,
    };
  }

  // Write results to Stripe metadata.
  try {
    const modulesSummary = result.modules
      .map((m) => `${m.name}:${m.status}:${m.checks}:${m.issues}:${m.duration}`)
      .join("|");

    const updateParams = new URLSearchParams({
      "metadata[scan_job_id]": jobId,
      "metadata[scan_status]": result.status,
      "metadata[total_issues]": String(result.totalIssues),
      "metadata[total_modules]": String(result.totalModules),
      "metadata[total_fixed]": String(result.totalFixed),
      "metadata[scan_duration]": String(result.duration),
      "metadata[scan_completed]": new Date().toISOString(),
      "metadata[modules_list]": result.modules.map((m) => m.name).join(","),
    });

    const chunks: string[] = [];
    let current = "";
    for (const entry of modulesSummary.split("|")) {
      if ((current + "|" + entry).length > 490) {
        chunks.push(current);
        current = entry;
      } else {
        current = current ? current + "|" + entry : entry;
      }
    }
    if (current) chunks.push(current);
    chunks.forEach((chunk, i) => {
      updateParams.set(`metadata[modules_${i}]`, chunk);
    });

    if (result.error) {
      updateParams.set("metadata[scan_error]", result.error.slice(0, 500));
    }

    await stripeApi(
      "POST",
      `/v1/payment_intents/${paymentIntentId}`,
      updateParams.toString()
    );
  } catch (err) { // error-ok — metadata update is best-effort; capture/cancel still proceeds
    console.error("[GateTest] Stripe metadata update failed:", err);
  }

  // Update the database with scan results
  if (scanId) {
    try {
      const sql = getDb();
      const score = result.totalIssues === 0
        ? 100
        : Math.max(0, 100 - result.totalIssues * 5);
      const dbStatus = result.status === "complete" && !result.error ? "completed" : "failed";
      const resultsJson = JSON.stringify(result.modules);
      const modulesRun = result.modules.map((m) => m.name);
      const summaryText = result.error || `${result.totalModules} modules, ${result.totalIssues} issues`;
      const durationMs = result.duration;

      await sql`UPDATE scans SET
        status = ${dbStatus},
        results = ${resultsJson}::jsonb,
        score = ${score},
        duration_ms = ${durationMs},
        modules_run = ${modulesRun},
        completed_at = NOW(),
        started_at = COALESCE(started_at, created_at),
        summary = ${summaryText}
      WHERE id = ${scanId}`;

      // Update customer stats
      if (customerEmail && result.status === "complete" && !result.error) {
        const spent = tierPriceUsd || 0;
        await sql`UPDATE customers SET
          total_scans = total_scans + 1,
          total_spent_usd = total_spent_usd + ${spent}
        WHERE email = ${customerEmail}`;
      }
    } catch (dbErr) { // error-ok — DB update is best-effort; Stripe metadata is the source of truth
      console.error("[GateTest] DB update failed (scan-executor):", dbErr);
    }
  }

  // No capture/cancel call — payment captures at checkout under the
  // per-scan upfront model (Craig 2026-05-18). Scan failures are
  // a support touchpoint, not an automatic refund trigger. The
  // metadata update above records scan outcome for support-side
  // dispute defence.

  return { skipped: false, result };
}
