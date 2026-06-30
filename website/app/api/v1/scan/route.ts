/**
 * Public Scan API v1 — external platforms call this directly.
 *
 * POST /api/v1/scan
 *   Auth:     Authorization: Bearer gt_live_...   (or X-API-Key header)
 *   Headers:  Idempotency-Key: <unique-string>    (optional, 24h dedupe)
 *
 *   Mode A — GitHub repo:
 *     Body:   { repo_url: string, tier: "quick" | "full" }
 *
 *   Mode B — Direct file upload (no GitHub required):
 *     Body:   { files: [{ path: string, content: string }], tier: "quick" | "full", project?: string }
 *
 *   Returns:  { status, modules[], totalIssues, totalModules, duration, ... }
 */

import { NextRequest, NextResponse } from "next/server";
import {
  authenticateApiKey,
  checkRateLimit,
  findIdempotentCall,
  recordApiCall,
} from "@/app/lib/api-key";
import { runScan, runScanDirect } from "@/app/lib/scan-executor";
import { notifyScanComplete } from "@/app/lib/slack-notifier";

const ALLOWED_TIERS = new Set(["quick", "full", "smart"]);

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
  let body: {
    repo_url?: string;
    repoUrl?: string;
    files?: Array<{ path: string; content: string }>;
    project?: string;
    tier?: string;
    slack_webhook?: string;
    webhook_url?: string;
  };
  try {
    body = await req.json();
  } catch {
    await recordApiCall({ apiKeyId: key.id, statusCode: 400, durationMs: Date.now() - started });
    return problem(400, "Invalid JSON body");
  }

  const repoUrl      = (body.repo_url || body.repoUrl || "").trim();
  const directFiles  = body.files;
  const project      = (body.project || "").trim();
  const tier         = (body.tier || "quick").trim();
  const slackWebhook = (body.slack_webhook || body.webhook_url || process.env.SLACK_WEBHOOK_URL || "").trim();
  const isDirectMode = Array.isArray(directFiles) && directFiles.length > 0;

  if (!repoUrl && !isDirectMode) {
    await recordApiCall({ apiKeyId: key.id, statusCode: 400, durationMs: Date.now() - started });
    return problem(400, "Provide either repo_url (GitHub) or files[] (direct upload)");
  }
  if (repoUrl && !isDirectMode && !/github\.com\/[^/]+\/[^/?#]+/.test(repoUrl)) {
    await recordApiCall({ apiKeyId: key.id, repoUrl, statusCode: 400, durationMs: Date.now() - started });
    return problem(400, "repo_url must be a github.com URL");
  }
  if (isDirectMode) {
    const MAX_DIRECT_FILES = 100;
    const MAX_FILE_SIZE = 500 * 1024;
    if (directFiles.length > MAX_DIRECT_FILES) {
      await recordApiCall({ apiKeyId: key.id, statusCode: 400, durationMs: Date.now() - started });
      return problem(400, `Too many files (max ${MAX_DIRECT_FILES})`);
    }
    for (const f of directFiles) {
      if (!f.path || typeof f.path !== "string") {
        await recordApiCall({ apiKeyId: key.id, statusCode: 400, durationMs: Date.now() - started });
        return problem(400, "Each file must have a path (string)");
      }
      if (typeof f.content !== "string") {
        await recordApiCall({ apiKeyId: key.id, statusCode: 400, durationMs: Date.now() - started });
        return problem(400, `File ${f.path}: content must be a string`);
      }
      if (f.content.length > MAX_FILE_SIZE) {
        await recordApiCall({ apiKeyId: key.id, statusCode: 400, durationMs: Date.now() - started });
        return problem(400, `File ${f.path}: exceeds ${MAX_FILE_SIZE} byte limit`);
      }
    }
  }
  if (!ALLOWED_TIERS.has(tier)) {
    await recordApiCall({ apiKeyId: key.id, repoUrl: repoUrl || project, tier, statusCode: 400, durationMs: Date.now() - started });
    return problem(400, `tier must be one of: ${[...ALLOWED_TIERS].join(", ")} — "smart" selects the 15-25 most relevant modules automatically based on git diff`);
  }

  const scanLabel = isDirectMode ? (project || "direct-upload") : repoUrl;

  // ── 3. Tier entitlement check ────────────────────
  if (key.tier_allowed === "quick" && tier === "full") {
    await recordApiCall({ apiKeyId: key.id, repoUrl: scanLabel, tier, statusCode: 403, durationMs: Date.now() - started });
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
    await recordApiCall({ apiKeyId: key.id, repoUrl: scanLabel, tier, statusCode: rate.status, durationMs: Date.now() - started, idempotencyKey });
    return res;
  }

  // ── 6. Run the scan ──────────────────────────────
  let result;
  try {
    if (isDirectMode) {
      result = await runScanDirect(directFiles, tier, project || undefined);
    } else {
      result = await runScan(repoUrl, tier);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    await recordApiCall({ apiKeyId: key.id, repoUrl: scanLabel, tier, statusCode: 500, durationMs: Date.now() - started, idempotencyKey });
    return problem(500, `Scan crashed: ${msg}`);
  }

  const statusCode = result.error ? 502 : 200;

  await recordApiCall({
    apiKeyId: key.id,
    repoUrl: scanLabel,
    tier,
    statusCode,
    issuesFound: result.totalIssues,
    durationMs: Date.now() - started,
    idempotencyKey,
  });

  const payload = {
    status: result.error ? "failed" : "complete",
    ...(isDirectMode ? { project: project || "direct-upload", mode: "direct" } : { repo_url: repoUrl }),
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
  };

  // Notify Slack asynchronously — never block the API response
  if (slackWebhook && !result.error) {
    void notifyScanComplete(payload, {
      webhookUrl: slackWebhook,
      scanUrl: repoUrl ? `${process.env.NEXT_PUBLIC_BASE_URL || "https://gatetest.ai"}/scan/status?repo=${encodeURIComponent(repoUrl)}` : undefined,
    }).catch(() => { /* best-effort — slack errors never surface to the API caller */ });
  }

  return NextResponse.json(payload, { status: statusCode });
}

export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/v1/scan",
    auth: "Authorization: Bearer gt_live_... OR X-API-Key",
    modes: {
      github: {
        body: { repo_url: "https://github.com/owner/repo", tier: "quick | full" },
      },
      direct: {
        body: {
          files: [{ path: "src/index.ts", content: "..." }],
          tier: "quick | full",
          project: "my-project (optional label)",
        },
      },
    },
    docs: "https://gatetest.io/docs/api",
  });
}
