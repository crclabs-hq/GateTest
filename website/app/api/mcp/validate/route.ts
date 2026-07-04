/**
 * MCP API Key Validation — GET /api/mcp/validate?key=gtmcp_xxx
 *
 * Used by the MCP server process (bin/gatetest-mcp.mjs) to verify that
 * a GATETEST_API_KEY belongs to an active $29/mo MCP subscription.
 *
 * Design:
 * - No auth required — the key itself is the secret (same model as Stripe's
 *   publishable key exposure).
 * - Always returns 200 with { valid: boolean } — never 4xx/5xx for bad keys
 *   so network errors are distinguishable from "invalid key" responses.
 * - Single indexed DB query (<5ms on Neon). MCP server caches result for
 *   1 hour so this is called at most once per hour per running process.
 */

import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const key = new URL(req.url).searchParams.get("key") ?? "";

  // Fast reject — all valid keys start with gtmcp_ and are 70 chars total.
  if (!key.startsWith("gtmcp_") || key.length < 70) {
    return NextResponse.json({ valid: false });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { findByApiKey } = require("@/app/lib/mcp-subscription-store");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/app/lib/db");

    const row = await findByApiKey(getDb(), key);
    return NextResponse.json({ valid: row?.status === "active" });
  } catch (err) {
    // DB unreachable — fail-safe: return invalid rather than 500 so the MCP
    // server falls back gracefully (stale cache or false rather than crashing).
    console.error("[mcp/validate] DB error:", err instanceof Error ? err.message : "unknown");
    return NextResponse.json({ valid: false });
  }
}
