/**
 * Public Scan API v1 — external platforms call this directly.
 *
 * POST /api/v1/scan
 *   Auth:     Authorization: Bearer gt_live_...   (or X-API-Key header)
 *   Headers:  Idempotency-Key: <unique-string>    (optional, 24h dedupe)
 *   Body:     { repo_url: string, tier: "quick" | "full" }
 *   Returns:  { status, modules[], totalIssues, totalModules, duration, ... }
 *
 * No Stripe. No cookies. API customers are pre-authorized by their key, which
 * records tier_allowed and rate_limit_per_hour. Honest module contract is
 * enforced via the shared runTier() registry.
 *
 * Rate limit: rolling 1-hour window, counted from api_calls table.
 *
 * Edge cases handled:
 *   - Missing/invalid key      → 401 with descriptive error
 *   - Revoked key              → 403
 *   - Rate-limited             → 429 with Retry-After hint
 *   - Tier not allowed on key  → 403
 *   - Malformed repo URL       → 400
 *   - Idempotent replay        → returns cached envelope (no re-scan)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  authenticateApiKey,
  checkRateLimit,
  findIdempotentCall,
  recordApiCall,
} from "@/app/lib/api-key";
import { runScan } from "@/app/lib/scan-executor";

// Public API scan — synchronous, returns the full envelope. Same budget as
// the website-driven scan path so behaviour is consistent across surfaces.
export const maxDuration = 60;

const ALLOWED_TIERS = new Set(["quick", "full"]);

function problem(status: number, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...extra }, { status });
}

export async function POST(req: NextRequest) {
  const started = Date.now();

  // ── 1. Authenticate ───────────────────────────────
  const auth = await authenticateApiKey(req);
  if (!auth.ok) return problem(auth.status, auth.error);
  const key = auth.key;

  // ── 2. Parse body ────────────────────────────────
  let body: { repo_url?: string; repoUrl?: string; tier?: string };
  try {
    body = await req.json();
  } catch {
    await recordApiCall({ apiKeyId: key.id, statusCode: 400, durationMs: Date.now() - started });
    return problem(400, "Invalid JSON body");
  }

  const repoUrl = (body.repo_url || body.repoUrl || "").trim();
  const tier = (body.tier || "quick").trim();

  if (!repoUrl) {
    await recordApiCall({ apiKeyId: key.id, statusCode: 400, durationMs: Date.now() - started });
    return problem(400, "Missing repo_url");
  }
  if (!/github\.com\/[^/]+\/[^/?#]+/.test(repoUrl)) {
    await recordApiCall({ apiKeyId: key.id, repoUrl, statusCode: 400, durationMs: Date.now() - started });
    return problem(400, "repo_url must be a github.com URL");
  }
  if (!ALLOWED_TIERS.has(tier)) {
    await recordApiCall({ apiKeyId: key.id, repoUrl, tier, statusCode: 400, durationMs: Date.now() - started });
    return problem(400, `tier must be one of: ${[...ALLOWED_TIERS].join(", ")}`);
  }

  // ── 3. Tier entitlement check ────────────────────
  // tier_allowed = "quick" only allows quick. "full" allows both.
  if (key.tier_allowed === "quick" && tier === "full") {
    await recordApiCall({ apiKeyId: key.id, repoUrl, tier, statusCode: 403, durationMs: Date.now() - started });
    return problem(403, "Your API key is not entitled to tier=full. Contact support to upgrade.");
  }

  // ── 4. Idempotency replay ────────────────────────
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() || undefined;
  if (idempotencyKey) {
    const prev = await findIdempotentCall(key.id, idempotencyKey);
    if (prev && prev.status_code >= 200 && prev.status_code < 300) {
      return NextResponse.json(
        {
          replayed: true,
          idempotency_key: idempotencyKey,
          previous_call_at: prev.created_at,
          repo_url: prev.repo_url,
          tier: prev.tier,
          totalIssues: prev.issues_found,
          note: "This call was already processed. Submit a different Idempotency-Key to rescan.",
        },
        { status: 200 }
      );
    }
  }

  // ── 5. Rate limit ────────────────────────────────
  const rate = await checkRateLimit(key);
  if (rate) {
    const res = problem(rate.status, rate.error, {
      rate_limit_per_hour: key.rate_limit_per_hour,
    });
    res.headers.set("Retry-After", "300");
    await recordApiCall({ apiKeyId: key.id, repoUrl, tier, statusCode: rate.status, durationMs: Date.now() - started, idempotencyKey });
    return res;
  }

  // ── 6. Run the scan ──────────────────────────────
  let result;
  try {
    result = await runScan(repoUrl, tier);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    await recordApiCall({ apiKeyId: key.id, repoUrl, tier, statusCode: 500, durationMs: Date.now() - started, idempotencyKey });
    return problem(500, `Scan crashed: ${msg}`);
  }

  const statusCode = result.error ? 502 : 200;

  await recordApiCall({
    apiKeyId: key.id,
    repoUrl,
    tier,
    statusCode,
    issuesFound: result.totalIssues,
    durationMs: Date.now() - started,
    idempotencyKey,
  });

  return NextResponse.json(
    {
      status: result.error ? "failed" : "complete",
      repo_url: repoUrl,
      tier,
      modules: result.modules,
      totalModules: result.modules.length,
      completedModules: result.modules.length,
      totalIssues: result.totalIssues,
      duration: result.duration,
      authSource: result.authSource,
      error: result.error,
      key: {
        name: key.name,
        prefix: key.key_prefix,
      },
    },
    { status: statusCode }
  );
}

export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/v1/scan",
    auth: "Authorization: Bearer gt_live_... OR X-API-Key",
    body: { repo_url: "https://github.com/owner/repo", tier: "quick | full" },
    docs: "https://gatetest.ai/docs/api",
  });
}
