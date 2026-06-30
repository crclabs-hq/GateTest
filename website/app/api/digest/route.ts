/**
 * POST /api/digest — trigger weekly digest delivery on-demand.
 *
 * Admin-only (GATETEST_ADMIN_PASSWORD). Used by:
 *   - .github/workflows/digest-weekly.yml  (weekly cron via curl)
 *   - Admin panel manual trigger
 *
 * Body (optional JSON):
 *   { repo_url?: string }   — when set, send digest only for that repo
 *                             (useful for debugging / per-customer re-send)
 *
 * Response:
 *   { sent, failed, skipped, results }
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ADMIN_PASSWORD = process.env.GATETEST_ADMIN_PASSWORD || "";

function isAuthorized(req: NextRequest): boolean {
  if (!ADMIN_PASSWORD) return false;
  // Support both Bearer token and Basic auth (for curl convenience)
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7) === ADMIN_PASSWORD;
  }
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
      return decoded.split(":").slice(1).join(":") === ADMIN_PASSWORD;
    } catch {
      return false;
    }
  }
  return false;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let repoUrl: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    repoUrl = typeof body.repo_url === "string" ? body.repo_url : null;
  } catch {
    // body parse failure is fine — treat as "all repos"
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runWeeklyDigests, sendRepoDigest } = require("@/app/lib/weekly-digest");
  const sql = getDb();

  try {
    if (repoUrl) {
      // Single-repo mode — useful for testing and per-customer re-sends
      const result = await sendRepoDigest({ repoUrl, sql });
      return NextResponse.json({
        sent:    result.email.ok || result.slack.ok ? 1 : 0,
        failed:  result.email.ok || result.slack.ok ? 0 : 1,
        skipped: 0,
        results: [{ repoUrl, ...result }],
      });
    }

    const summary = await runWeeklyDigests(sql);
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[GateTest] digest run failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Allow GET so the cron workflow can do a quick health-check
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, note: "POST to trigger digest delivery" });
}
