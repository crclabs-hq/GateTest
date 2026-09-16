/**
 * Scan Run API — Runs the scan and returns results directly.
 *
 * POST /api/scan/run
 * Body: { sessionId, repoUrl, tier }
 *
 * NO WEBHOOK DEPENDENCY. The client calls this directly after checkout.
 * Returns the scan result in one response. Simple. Fast. Reliable.
 *
 * Also updates Stripe payment intent metadata and captures payment.
 *
 * Honesty contract: every module listed in scan-modules/index.ts does real
 * work. Modules that cannot run return status "skipped" with a reason —
 * never a fake pass.
 */

import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { isAdminRequest } from "@/app/lib/admin-auth";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};

const _scanRunLimiter = createLimiter(PRESETS.scanRun);
import { loadRepoFiles, resolveRepoAuth } from "@/app/lib/gluecron-client";
import { runEngineForTier, CLI_ENGINE_TIERS } from "@/app/lib/scan-engine-dispatch";
import { TIERS } from "@/app/lib/scan-modules";
// Wire contract reference: Gluecron.com/GATETEST_HOOK.md — each repo keeps its
// own copy per the HTTP-only coupling rule.
import { sendGluecronCallback } from "@/app/lib/gluecron-callback";
import { extractIssuesFromModules } from "@/app/lib/issue-extractor";
import { recordScanBatch } from "@/app/lib/scan-telemetry-store";

// Tier-1 Items 2+4 — Shadow Scan Preview + Tiered Feature Redaction.
// `shadowFor` maps the paid tier to the tier we actually run (quick → quick_shadow);
// `redactScanResult` post-processes the scan output to redact details for
// modules outside the customer's paid tier and emit a shadowSummary upsell hook.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  computeShadowTier: shadowFor,
  redactScanResult,
  summariseShadowResult,
} = require("@lib/scan-redaction") as {
  computeShadowTier: (paidTier: string) => string;
  redactScanResult: (opts: {
    result: { modules: Array<Record<string, unknown>>; totalIssues: number };
    paidTier: string;
    tierModules: string[];
  }) => {
    modules: Array<Record<string, unknown>>;
    totalIssues: number;
    shadowSummary: {
      hiddenIssues: number;
      hiddenModules: number;
      paidModules: number;
      paidIssues: number;
      upgradeHint: string;
    };
  };
  summariseShadowResult: (s: Record<string, unknown>) => string;
};

/** Safe set of tier names — anything outside this set falls back to "quick".
 *  Excludes synthetic `quick_shadow` since it's selected internally, not by
 *  paid customers. */
const KNOWN_TIERS = new Set(
  Object.keys(TIERS).filter((t) => t !== "quick_shadow")
);

// 5-minute function budget — needs Vercel Pro; Hobby cap is 60s.
export const maxDuration = 300;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
/** In-memory quick tier: a small, fast sample is the point (free funnel). */
const QUICK_MAX_FILES = 60;
/** CLI-engine tiers: the whole repo, bounded by the engine's own time budget. */
const ENGINE_MAX_FILES = 4000;
const PRIORITY_FILES = new Set([
  "package.json", "pnpm-workspace.yaml", "pnpm-workspace.yml", "lerna.json",
  "tsconfig.json", ".gatetest.json", ".gatetestignore", "pyproject.toml",
  "go.mod", "Cargo.toml", "Gemfile", "composer.json", "pom.xml", "build.gradle",
]);
const prioritizeManifest = (p: string): boolean => PRIORITY_FILES.has(p.split("/").pop() ?? "");
// Leave 30s headroom for Stripe metadata writes and response serialisation.
const SCAN_TIME_BUDGET_MS = 260_000;

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
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
        catch { resolve({}); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

interface ModuleResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  checks: number;
  issues: number;
  duration: number;
  details?: string[];
  skipped?: string;
}

interface ScanRepoResult {
  modules: ModuleResult[];
  totalIssues: number;
  duration: number;
  authSource?: string | null;
  error?: string;
  /** honesty fields — how much of the repo the engine actually saw */
  filesAnalysed?: number;
  filesInRepo?: number;
  coverageTruncated?: boolean;
  engine?: "cli" | "runTier";
}

async function scanRepo(owner: string, repo: string, tier: string): Promise<ScanRepoResult> {
  const startTime = Date.now();
  const deadline = startTime + SCAN_TIME_BUDGET_MS;
  // Normalise tier — unknown strings fall back to "quick" explicitly rather
  // than relying on runTier's silent TIERS[tier] || TIERS.quick fallback.
  const normalisedTier = KNOWN_TIERS.has(tier) ? tier : "quick";
  // Tier-1 Item 2+4 — Shadow-preview tier resolution. For $29 customers
  // we run the full static-scan suite (modulo Anthropic-cost modules)
  // and redact details for modules outside their paid tier. The customer
  // sees counts + module names as an upsell mechanic, with NO extra
  // Anthropic spend.
  const shadowTier: string = shadowFor(normalisedTier);

  // Resolve Gluecron auth. Gluecron is PAT-only; resolveRepoAuth pings
  // the repo endpoint to confirm the token has access before we attempt
  // the tree fetch.
  const auth = await resolveRepoAuth(owner, repo);
  // A missing token is not fatal for a PUBLIC repo — fetchTree/fetchBlob fall
  // back to the anonymous public archive (repo-snapshot.js). Private repos
  // still surface the tree-read failure below with the real cause.
  const token = auth.token || "";

  // Whole repo in one archive read (credentialed → anonymous → per-blob API).
  // Until 2026-08-18 this read a 50-file, 12-extension SAMPLE through N
  // Contents-API calls, so a paid Full/Forensic scan of a 2,000-file repo
  // analysed ~2.5% of it and could report "clean". Workspace manifests are
  // loaded first so monorepo discovery (dead-code-index.js) still works when
  // the cap applies. A missing token is not fatal for a public repo.
  const engineTier = CLI_ENGINE_TIERS.has(shadowTier);
  let loaded;
  try {
    loaded = await loadRepoFiles(owner, repo, "HEAD", token, {
      maxFiles: engineTier ? ENGINE_MAX_FILES : QUICK_MAX_FILES,
      prioritize: prioritizeManifest,
      deadlineMs: deadline,
    });
  } catch (err) {
    return {
      modules: [],
      totalIssues: 0,
      duration: Date.now() - startTime,
      authSource: auth.source,
      error: `Cannot access ${owner}/${repo} (${err instanceof Error ? err.message : "tree read failed"})${auth.error ? ` — ${auth.error}` : ""}`,
    };
  }
  const { paths: files, fileContents } = loaded;
  if (files.length === 0) {
    return {
      modules: [],
      totalIssues: 0,
      duration: Date.now() - startTime,
      authSource: auth.source,
      error: `Cannot access ${owner}/${repo} — empty tree`,
    };
  }
  if (loaded.warning) console.warn(`[scan/run] ${owner}/${repo}: ${loaded.warning}`);
  if (Date.now() > deadline) {
    return { modules: [], totalIssues: 0, duration: Date.now() - startTime, authSource: auth.source, error: "scan timed out fetching repository" };
  }

  // Engine selection lives in ONE place (scan-engine-dispatch.ts) so the
  // worker tick, the Stripe job and this route cannot drift apart again.
  const { modules, totalIssues, engineUsed } = await runEngineForTier({
    tier: shadowTier,
    owner,
    repo,
    files,
    fileContents,
    token,
    deadlineMs: deadline,
  });
  if (engineTier && engineUsed !== "cli") {
    console.warn(`[scan/run] ${owner}/${repo} (${shadowTier}): CLI engine unavailable — served in-memory ${modules.length}-module fallback`);
  }

  return {
    modules,
    totalIssues,
    duration: Date.now() - startTime,
    authSource: auth.source,
    filesAnalysed: fileContents.length,
    filesInRepo: files.length,
    coverageTruncated: loaded.truncated,
    engine: engineUsed,
  };
}

export async function POST(req: NextRequest) {
  // Outer guard — Node 24 changed unhandledRejection from 'warn' to 'throw'.
  // Any await that escapes the inner try/catch blocks (e.g. an unexpected throw
  // from extractIssuesFromModules or the final NextResponse.json call) must not
  // crash the Vercel function. This outer try/catch is the last resort; the
  // inner guards below are the first line of defence.
  try {
  return await _postImpl(req);
  } catch (outerErr) { // error-ok — outermost guard; inner guards should catch first
    const msg = outerErr instanceof Error ? outerErr.message : String(outerErr);
    console.error("[GateTest] scan/run POST crashed unexpectedly:", msg);
    return NextResponse.json(
      { status: "failed", error: "Scan failed — please try again or contact support." },
      { status: 500 }
    );
  }
}

async function _postImpl(req: NextRequest): Promise<ReturnType<typeof NextResponse.json>> {
  let input: {
    sessionId?: string;
    repoUrl?: string;
    tier?: string;
    source?: string;
    sha?: string;
    ref?: string;
  };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { sessionId, repoUrl, source, sha, ref } = input;
  // Tier from URL/body is UNTRUSTED — a customer can edit the URL to claim
  // a higher tier than they paid for. The authoritative tier is the one
  // stamped on the Stripe payment intent at checkout. We override `tier`
  // below once we've fetched the PI metadata. Admin and non-Stripe paths
  // continue to honour the input tier as before.
  let tier = input.tier;

  if (!repoUrl) {
    return NextResponse.json({ error: "Missing repo URL" }, { status: 400 });
  }

  // Accept gluecron.com URLs first; fall back to github.com for URLs
  // still in customer bookmarks during the migration window.
  const gluecronMatch = repoUrl.match(/gluecron\.com\/([^/]+)\/([^/?#]+)/);
  const githubMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  const repoMatch = gluecronMatch || githubMatch;
  if (!repoMatch) {
    return NextResponse.json({ error: "Invalid repo URL (expected github.com/<owner>/<repo> or gluecron.com/<owner>/<repo>)" }, { status: 400 });
  }

  const owner = repoMatch[1];
  const repo = repoMatch[2].replace(/\.git$/, "");

  // Admin bypass: if the request carries a valid admin cookie, we skip all
  // Stripe interaction entirely. Admin scans never create or capture charges.
  const isAdmin = isAdminRequest(req);

  // Rate-limit AFTER body parsing + admin check, BEFORE any Gluecron/Stripe calls.
  // Admin requests bypass the limiter — they are internal and authenticated.
  if (!isAdmin) {
    const _rlScanRun = await _scanRunLimiter.guard(req);
    if (!_rlScanRun.allowed) {
      return NextResponse.json(_rlScanRun.body, {
        status: _rlScanRun.status ?? 429,
        headers: _rlScanRun.headers as Record<string, string>,
      });
    }
  }

  // ── Payment verification (REQUIRED for non-admin) + idempotency guard
  // + authoritative tier resolution ─────────────────────────────────
  // /api/scan/run has no free tier — every non-admin call must resolve to
  // a real, completed Stripe payment. Previously this whole block only ran
  // when a `sessionId` happened to be present in the request body, and a
  // lookup failure silently fell through to running the scan anyway —
  // meaning simply omitting `sessionId`, or any Stripe API hiccup, let a
  // request run any tier (including the $399 Forensic tier) for free.
  // Fixed: sessionId is required, the Stripe payment intent must show
  // `succeeded`, and any verification failure (missing session, unpaid,
  // lookup error) now rejects the request instead of proceeding.
  //
  // This PI-fetch is ALSO used to resolve the authoritative tier. The URL
  // `tier` param is untrusted (customer can edit it); the PI metadata's
  // `tier` was stamped at checkout creation and cannot be tampered with.
  // If the URL claims a different tier than the customer paid for, we
  // log the attempt and silently honour the paid tier.
  //
  // Usage-ledger identity (usage-ledger.js): the checkout e-mail is the
  // canonical key (hashed before storage); the checkout session id is the
  // fallback so the row is never lost.
  let ledgerEmail: string | null = null;
  let ledgerStripeCustomerId: string | null = null;
  if (!isAdmin) {
    if (!sessionId) {
      return NextResponse.json(
        { error: "Missing sessionId — a completed checkout session is required to run a scan" },
        { status: 402 }
      );
    }
    if (!STRIPE_SECRET_KEY) {
      // Can't verify payment without Stripe configured — fail closed
      // rather than silently running paid work for free.
      return NextResponse.json({ error: "Payment verification unavailable" }, { status: 503 });
    }
    try {
      const existing = (await stripeApi(
        "GET",
        `/v1/checkout/sessions/${sessionId}`
      )) as {
        payment_intent?: string;
        // Customer identity for the usage ledger — hashed before storage.
        customer?: string | null;
        customer_email?: string | null;
        customer_details?: { email?: string | null } | null;
      };
      if (!existing.payment_intent) {
        return NextResponse.json({ error: "Invalid or incomplete checkout session" }, { status: 402 });
      }
      ledgerEmail = existing.customer_details?.email || existing.customer_email || null;
      ledgerStripeCustomerId = typeof existing.customer === "string" ? existing.customer : null;

      const pi = (await stripeApi(
        "GET",
        `/v1/payment_intents/${existing.payment_intent}`
      )) as { metadata?: Record<string, string>; status?: string };

      if (pi.status !== "succeeded") {
        return NextResponse.json({ error: "Payment not completed" }, { status: 402 });
      }

      // Authoritative tier override — silently corrects URL manipulation.
      const paidTier = pi.metadata?.tier;
      if (paidTier && paidTier !== tier) {
        console.warn(
          `[GateTest] Tier mismatch on session ${sessionId.slice(0, 12)}... — URL claimed ${tier || "<none>"}, paid ${paidTier}. Using paid tier.`
        );
        tier = paidTier;
      }

      const prevStatus = pi.metadata?.scan_status;
      if (prevStatus === "complete" || prevStatus === "failed") {
        // Already processed — return the cached state derived from
        // metadata rather than re-running the scan or re-capturing.
        return NextResponse.json({
          status: prevStatus,
          modules: [],
          totalModules: Number(pi.metadata?.total_modules || 0),
          completedModules: Number(pi.metadata?.total_modules || 0),
          totalIssues: Number(pi.metadata?.total_issues || 0),
          totalFixed: 0,
          duration: Number(pi.metadata?.scan_duration || 0),
          repoUrl,
          tier,
          cached: true,
        });
      }
    } catch (err) { // error-ok — logged below; request is rejected, not silently allowed through
      console.error("[GateTest] Payment verification failed:", err);
      return NextResponse.json({ error: "Could not verify payment — please try again" }, { status: 503 });
    }
  }

  // Run the scan — wrap in try/catch so any unexpected throw from scanRepo
  // (e.g. an unhandled rejection inside a module) returns a 500 JSON response
  // instead of crashing the Vercel function (Node 24 unhandledRejection = throw).
  let result: Awaited<ReturnType<typeof scanRepo>>;
  try {
    result = await scanRepo(owner, repo, tier || "quick");
  } catch (err) { // error-ok — top-level scan crash guard; preserves Stripe hold for customer retry
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[GateTest] scanRepo crashed unexpectedly:", msg);
    // Fire-and-forget audit write for the crash. Failure to write the audit
    // entry must never block the response.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { recordEventIfConfigured } = require("@/app/lib/audit-log-store");
    void recordEventIfConfigured({
      actor: isAdmin ? "admin" : (sessionId || "anonymous"),
      action: "scan.crashed",
      resourceType: "scan",
      resourceId: `${owner}/${repo}`,
      metadata: { tier: tier || "quick", source: source || "web", error: msg.slice(0, 200) },
    });
    return NextResponse.json(
      { status: "failed", error: "Scan failed — please try again or contact support." },
      { status: 500 }
    );
  }

  // Audit-log the scan outcome (completion or in-band failure). Fire-and-
  // forget — never blocks the customer's response.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { recordEventIfConfigured } = require("@/app/lib/audit-log-store");
  void recordEventIfConfigured({
    actor: isAdmin ? "admin" : (sessionId || "anonymous"),
    action: result.error ? "scan.failed" : "scan.completed",
    resourceType: "scan",
    resourceId: `${owner}/${repo}`,
    metadata: {
      tier: tier || "quick",
      source: source || "web",
      sha: sha || null,
      totalIssues: result.totalIssues,
      moduleCount: result.modules?.length || 0,
      error: result.error ? String(result.error).slice(0, 200) : null,
    },
  });

  // Usage ledger — this scan in the customer's own meter (surface 'web').
  // Deterministic tiers carry ai_calls 0; the AI module's cost/tokens ride
  // on its module result when it ran. Best-effort by contract: the helper
  // never throws and a failure is one warning, never a failed scan.
  if (!result.error) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ledger = require("@/app/lib/usage-ledger") as {
        recordUsageIfConfigured: (event: Record<string, unknown>) => Promise<number | null>;
        resolveAccountKey: (ids: Record<string, unknown>) => string | null;
        aiTotalsFromModules: (modules: unknown) => { aiCalls: number; tokensIn: number; tokensOut: number; usd: number };
        countBlockingFindings: (scanResult: unknown) => number;
      };
      const ai = ledger.aiTotalsFromModules(result.modules);
      await ledger.recordUsageIfConfigured({
        accountKey: ledger.resolveAccountKey({
          email: ledgerEmail,
          stripeCustomerId: ledgerStripeCustomerId,
          checkoutSessionId: sessionId,
          fallback: isAdmin ? "admin" : null,
        }),
        surface: "web",
        repo: `${owner}/${repo}`,
        suite: tier || "quick",
        tier: tier || "quick",
        scanId: sessionId || null,
        modulesRun: result.modules?.length || 0,
        findingsTotal: result.totalIssues,
        findingsBlocking: ledger.countBlockingFindings(result),
        aiCalls: ai.aiCalls,
        tokensIn: ai.tokensIn,
        tokensOut: ai.tokensOut,
        usdEstimated: ai.usd,
        keyOwner: "gatetest",
      });
    } catch (ledgerErr) { // error-ok — the ledger is observability; the scan result is already final
      console.warn("[GateTest] usage ledger write failed (scan/run, continuing):", ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr));
    }
  }

  // If we have a session ID AND this is NOT an admin request, update Stripe
  // and capture payment. Admins never touch billing.
  if (!isAdmin && sessionId && STRIPE_SECRET_KEY) {
    try {
      const session = (await stripeApi("GET", `/v1/checkout/sessions/${sessionId}`)) as {
        payment_intent?: string;
      };

      if (session.payment_intent) {
        // Store result in Stripe metadata
        const moduleData = result.modules.map((m) =>
          `${m.name}:${m.status}:${m.checks}:${m.issues}:${m.duration}`
        ).join("|");

        const chunks: string[] = [];
        let current = "";
        for (const entry of moduleData.split("|")) {
          if ((current + "|" + entry).length > 490) { chunks.push(current); current = entry; }
          else { current = current ? current + "|" + entry : entry; }
        }
        if (current) chunks.push(current);

        const params = new URLSearchParams({
          "metadata[scan_status]": result.error ? "failed" : "complete",
          "metadata[total_issues]": String(result.totalIssues),
          "metadata[total_modules]": String(result.modules.length),
          "metadata[scan_duration]": String(result.duration),
          "metadata[scan_completed]": new Date().toISOString(),
          "metadata[modules_list]": result.modules.map((m) => m.name).join(","),
        });
        chunks.forEach((chunk, i) => params.set(`metadata[modules_${i}]`, chunk));

        await stripeApi("POST", `/v1/payment_intents/${session.payment_intent}`, params.toString());

        // No capture/cancel call — payment captures at checkout under the
        // new per-scan upfront model (Craig 2026-05-18). Scan failures are
        // a support touchpoint, not an automatic refund trigger.
      }
    } catch (err) { // error-ok — Stripe metadata update is best-effort; scan result already computed
      console.error("[GateTest] Stripe update failed:", err);
    }
  }

  // Async scan-result callback to Gluecron. Fires only when the inbound
  // request was originated by Gluecron (source === "gluecron") AND both
  // env vars are configured. Failure here MUST NOT break the sync response.
  if (
    source === "gluecron" &&
    process.env.GLUECRON_CALLBACK_URL &&
    process.env.GLUECRON_CALLBACK_SECRET
  ) {
    try {
      await sendGluecronCallback({
        repository: `${owner}/${repo}`,
        sha: sha || "",
        ref,
        scanResult: result,
      });
    } catch (err) { // error-ok — callback failure must not break the synchronous scan response
      console.error("[GateTest] Gluecron callback failed:", err);
    }
  }

  // Tier-1 Items 2+4 — Shadow Preview / Tiered Redaction.
  // For $29 customers we ran the FULL static-scan suite (minus AI-cost
  // modules). Now we redact the details for modules outside their paid
  // tier so they see counts + module names (with an upsell hint) but
  // not the full findings. Paid Full / Scan+Fix / Forensic tiers see
  // everything verbatim — redaction is a no-op when paidTier === full.
  const paidTier = tier || "quick";
  const paidTierModules: string[] = TIERS[paidTier] || TIERS.quick;
  const redacted = redactScanResult({
    result: {
      modules: result.modules as unknown as Array<Record<string, unknown>>,
      totalIssues: result.totalIssues,
    },
    paidTier,
    tierModules: paidTierModules,
  });
  // Log the redaction outcome for ops visibility (non-PII summary string).
  if (redacted.shadowSummary.hiddenIssues > 0) {
    // code-quality-ok — operational status log, not debug leftover
    console.log(
      `[GateTest] ${summariseShadowResult(redacted.shadowSummary)}`
    );
  }

  // Flywheel: record this scan's anonymized finding signal directly into the
  // central store (server-side — no local buffer/upload hop). Module names +
  // counts + gate status only, never code/paths/findings. Awaited but guarded
  // so a DB hiccup can never break the scan response; a no-op when DATABASE_URL
  // is unset (today, pre-Vapron).
  try {
    await recordScanBatch([{
      source: "website",
      suite: tier || "quick",
      gateStatus: result.totalIssues === 0 && !result.error ? "PASSED" : "BLOCKED",
      durationMs: result.duration,
      totalErrors: result.totalIssues,
      totalWarnings: 0,
      modules: (result.modules || []).map((m) => ({
        name: m.name,
        errors: m.status === "failed" ? m.issues : 0,
        warnings: 0,
        soft: 0,
        status: m.status === "failed" || m.status === "skipped" ? m.status : "ok",
      })),
    }]);
  } catch (err) { // error-ok — telemetry must never break the scan response
    console.error("[GateTest] scan telemetry record failed (non-blocking):", err instanceof Error ? err.message : String(err));
  }

  // Build structured fixable-issue list from REDACTED module details — the
  // customer can only fix what they can see. Shared extractor handles
  // Dockerfile, package.json sub-keys, and all severity-prefix variants.
  // failedOnly: false — include skipped modules' details so nothing is lost.
  const { fixable: fixableIssues } = extractIssuesFromModules(
    redacted.modules.map((m) => ({
      name: m.name as string,
      status: m.status as string,
      details: (m.details as string[]) || undefined,
    })),
    { failedOnly: false }
  );

  return NextResponse.json({
    status: result.error ? "failed" : "complete",
    modules: redacted.modules,
    totalModules: redacted.modules.length,
    completedModules: redacted.modules.length,
    totalIssues: redacted.totalIssues,
    totalFixed: 0,
    duration: result.duration,
    repoUrl,
    tier: paidTier,
    admin: isAdmin,
    authSource: result.authSource,
    error: result.error,
    fixableIssues,
    shadowSummary: redacted.shadowSummary,
    // Honesty: how much of the repository the engine actually analysed.
    coverage: {
      filesAnalysed: result.filesAnalysed ?? null,
      filesInRepo: result.filesInRepo ?? null,
      truncated: result.coverageTruncated ?? false,
      engine: result.engine ?? null,
    },
  });
}
