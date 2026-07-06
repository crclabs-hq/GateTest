/**
 * Remote MCP endpoint — POST /api/mcp  (the hosted mcp.gatetest.ai transport).
 *
 * Runs the transport-agnostic MCP core (website/app/lib/mcp-remote-core.cjs) as
 * a Next.js route on Vercel, IN this repo, deployed with gatetest.ai. This is
 * the deliberately-isolated home for the endpoint: it shares nothing with the
 * Jarvis / Vapron / Gluecron machines (Craig 2026-07-07 — no cross-contamination
 * between agents and sites). The Bun/Hono wrapper in packages/mcp-remote is the
 * optional dedicated-box alternative; both drive the same core.
 *
 * Gives claude.ai web/mobile, Claude Desktop, Cursor, Windsurf, and any
 * no-terminal user GateTest tools with zero install. Free tools (scan_url,
 * scan_repo, list_modules, get_badge) need no key; premium tools require an
 * Authorization: Bearer gtmcp_... subscription key.
 *
 * MCP Streamable HTTP: request/response JSON-RPC over POST. Streaming tools are
 * not offered here (none of the remote tools stream) — a request/response server
 * is spec-compliant; GET returns 405.
 */

import { NextRequest, NextResponse } from "next/server";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createMcpCore } = require("@/app/lib/mcp-remote-core.cjs");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300; // fix_issue opens a PR — generous ceiling

// One core per warm instance. apiBase defaults to gatetest.ai (this same
// deployment), so the tools proxy the site's own /api routes.
const core = createMcpCore({
  apiBase: process.env.NEXT_PUBLIC_BASE_URL || "https://gatetest.ai",
});

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-GateTest-Key, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// Some clients probe GET /api/mcp for an SSE server-push channel. We serve
// request/response only, which the spec lets a server signal with 405.
export async function GET() {
  return NextResponse.json(
    { ok: true, server: "gatetest-remote-mcp", transport: "streamable-http (request/response)" },
    { status: 405, headers: CORS_HEADERS },
  );
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // Honour the client's session id, mint one on first contact.
  const sessionId = req.headers.get("Mcp-Session-Id") || crypto.randomUUID();

  // Plain header bag for the core's case-insensitive extractKey().
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });

  const messages = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];
  for (const message of messages) {
    const res = await core.handleRpc(message, { headers, sessionId });
    if (res !== null) responses.push(res);
  }

  const outHeaders = { ...CORS_HEADERS, "Mcp-Session-Id": sessionId };

  // Pure-notification batch → 202 Accepted, no body (per spec).
  if (responses.length === 0) {
    return new NextResponse(null, { status: 202, headers: outHeaders });
  }
  return NextResponse.json(Array.isArray(body) ? responses : responses[0], { headers: outHeaders });
}
