/**
 * POST /api/telemetry/scan
 *
 * Central ingest for anonymized per-scan finding signal. CLI/MCP machines
 * flush their local buffer here (see src/core/telemetry-uploader.js); the
 * body is { records: [...] } where each record is module names + integer
 * counts + gate status. NEVER code, paths, finding text, or repo identity.
 *
 * Defense in depth: the recorder already strips PII, and sanitizeRecord here
 * REJECTS any record carrying a path/content/message-shaped key. The store
 * degrades softly when DATABASE_URL is unset (returns 503 so the client keeps
 * buffering) — which is exactly today's state while gatetest.ai is stale.
 *
 *   200 { ok: true, accepted, rejected }   — persisted (client drops the batch)
 *   400 { ok: false, error }               — malformed / all records rejected
 *   429                                     — rate limited
 *   503 { ok: false, error }               — persistence unavailable (keep buffering)
 */

import { NextRequest, NextResponse } from "next/server";
import { recordScanBatch } from "@/app/lib/scan-telemetry-store";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};

const _telemetryLimiter = createLimiter(PRESETS.telemetry);

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const _rl = await _telemetryLimiter.guard(req);
  if (!_rl.allowed) {
    return NextResponse.json(_rl.body ?? { ok: false, error: "rate limited" }, {
      status: _rl.status ?? 429,
      headers: _rl.headers as Record<string, string>,
    });
  }

  let body: { records?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const records = Array.isArray(body?.records) ? body.records : null;
  if (!records || records.length === 0) {
    return NextResponse.json({ ok: false, error: "records[] required" }, { status: 400 });
  }

  const result = await recordScanBatch(records);

  if (result.ok) {
    return NextResponse.json({ ok: true, accepted: result.accepted, rejected: result.rejected });
  }

  // Persistence not wired yet (pre-Vapron) → 503 so the client keeps buffering.
  if (result.reason === "persistence-unavailable" || result.reason === "persistence-failed") {
    return NextResponse.json({ ok: false, error: "persistence unavailable" }, { status: 503 });
  }

  // Everything else (empty / all-rejected / batch-too-large / forbidden shape)
  // is the client's fault — 400 so it doesn't retry the same bad payload.
  return NextResponse.json({ ok: false, error: result.reason || "rejected" }, { status: 400 });
}
