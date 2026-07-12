/**
 * Slack Slash Command Handler — /api/slack/events
 *
 * Handles Slack slash commands from the GateTest bot.
 * Configure the slash command endpoint in your Slack App settings:
 *   URL: https://gatetest.ai/api/slack/events
 *   Command: /gatetest
 *
 * Supported commands:
 *   /gatetest scan <github-url>    — trigger a scan (quick tier)
 *   /gatetest scan <url> full      — trigger a full scan
 *   /gatetest status               — platform health
 *   /gatetest help                 — usage guide
 *
 * Required env vars:
 *   SLACK_SIGNING_SECRET   — from Slack App settings → Basic Information
 *
 * Optional:
 *   SLACK_WEBHOOK_URL      — fallback channel for async result delivery
 *   NEXT_PUBLIC_BASE_URL   — used to build deep-links in responses
 */

import { NextRequest, NextResponse } from "next/server";
import {
  verifySlashSignature,
  parseSlashBody,
  slashResponse,
  notifyScanComplete,
  postToWebhook,
  buildScanCompleteBlocks,
} from "@/app/lib/slack-notifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const BASE_URL       = process.env.NEXT_PUBLIC_BASE_URL || "https://gatetest.ai";

// Respond immediately (within Slack's 3s window) then fire async work
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody  = await req.text();
  const timestamp = req.headers.get("x-slack-request-timestamp") || "";
  const signature = req.headers.get("x-slack-signature") || "";

  // ── 1. Verify signature ───────────────────────────────────────────────────
  if (SIGNING_SECRET && !verifySlashSignature(timestamp, rawBody, signature, SIGNING_SECRET)) {
    return NextResponse.json({ error: "Invalid Slack signature" }, { status: 401 });
  }

  const params = parseSlashBody(rawBody) as Record<string, string>;
  const text   = (params.text || "").trim().toLowerCase();
  const responseUrl = params.response_url || "";
  const userHandle  = params.user_name ? `@${params.user_name}` : "there";

  // ── 2. Route commands ─────────────────────────────────────────────────────

  // /gatetest help
  if (!text || text === "help") {
    return NextResponse.json(
      slashResponse(
        "*GateTest slash commands:*\n" +
        "`/gatetest scan <github-url>`  — Quick scan of a repo (4 core modules, ~8s)\n" +
        "`/gatetest scan <github-url> full`  — Full 120-module deep scan\n" +
        "`/gatetest scan <github-url> smart`  — Diff-aware smart scan (auto-selects relevant modules)\n" +
        "`/gatetest status`  — Platform health check\n" +
        "`/gatetest help`  — This message\n\n" +
        "_Results are posted to this channel when the scan completes._"
      )
    );
  }

  // /gatetest status
  if (text === "status") {
    const healthUrl = `${BASE_URL}/api/v1/health`;
    let statusText = "Platform status: checking…";
    try {
      const res = await fetch(healthUrl);
      const data = await res.json() as { status: string; version: string };
      statusText = data.status === "ok"
        ? `:white_check_mark: GateTest is *healthy* (${data.version})`
        : `:warning: GateTest returned status: ${data.status}`;
    } catch {
      statusText = ":warning: Could not reach GateTest platform";
    }
    return NextResponse.json(slashResponse(statusText));
  }

  // /gatetest scan <url> [tier]
  if (text.startsWith("scan ")) {
    const parts   = text.replace("scan ", "").trim().split(/\s+/);
    const rawUrl  = parts[0] || "";
    const tierArg = (parts[1] || "quick").replace(/^(--tier=?)?/, "");
    const tier    = ["quick", "full", "smart"].includes(tierArg) ? tierArg : "quick";

    if (!rawUrl.includes("github.com")) {
      return NextResponse.json(
        slashResponse(`:warning: Please provide a github.com URL.\nExample: \`/gatetest scan https://github.com/owner/repo\``)
      );
    }

    // Acknowledge immediately — scan is async
    const ackText = `:mag: Hey ${userHandle}! Scanning *${rawUrl}* (${tier} tier).\nResults will post here when complete — usually under 60s.`;

    // Fire the scan async after we've responded to Slack
    void runScanAndReply(rawUrl, tier, responseUrl, userHandle);

    return NextResponse.json(slashResponse(ackText, true /* in_channel */));
  }

  return NextResponse.json(
    slashResponse(`:thinking_face: Unknown command: \`${text}\`. Try \`/gatetest help\`.`)
  );
}

// ── Async scan + reply ────────────────────────────────────────────────────────

async function runScanAndReply(
  repoUrl: string,
  tier: string,
  responseUrl: string,
  userHandle: string
): Promise<void> {
  let result: Record<string, unknown>;
  try {
    const apiKey = process.env.GATETEST_INTERNAL_API_KEY;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const scanRes = await fetch(`${BASE_URL}/api/v1/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ repo_url: repoUrl, tier }),
      signal: AbortSignal.timeout(180_000), // 3 min hard ceiling
    });
    result = await scanRes.json() as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (responseUrl) {
      await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slashResponse(`:x: Scan failed: ${msg}`, true)),
      });
    }
    return;
  }

  // Build a rich reply and POST it back to Slack via response_url
  if (responseUrl) {
    const scanUrl = result.repo_url
      ? `${BASE_URL}/scan/status?repo=${encodeURIComponent(String(result.repo_url))}`
      : undefined;

    const blocks = buildScanCompleteBlocks(
      result as Parameters<typeof buildScanCompleteBlocks>[0],
      { scanUrl, mention: `Results for ${userHandle}` }
    );
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "in_channel",
        text: `GateTest scan complete for ${repoUrl}`,
        blocks,
      }),
    });
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/slack/events",
    description: "Slack slash command handler for /gatetest",
    commands: ["/gatetest scan <github-url> [quick|full|smart]", "/gatetest status", "/gatetest help"],
    setup: "Configure slash command in Slack App settings → Slash Commands → Request URL: /api/slack/events",
    env_required: "SLACK_SIGNING_SECRET",
  });
}
