/**
 * POST /api/notify — "email me when it launches" signup.
 *
 * Body: { email: string, topic: "pentest" }
 *
 *   200 { ok: true }                      — recorded (idempotent on repeat)
 *   400 { ok: false, error }              — invalid email or unknown topic
 *   429                                    — rate limited (5/min per IP)
 *   503 { ok: false, error }              — persistence unavailable
 *
 * First consumer: the "Penetration Testing — coming soon" section
 * (Craig 2026-07-14). Emails land in notify_signups (Neon Postgres).
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addSignup, isValidEmail, VALID_TOPICS } = require("@/app/lib/notify-store") as {
  addSignup: (
    sql: unknown,
    opts: { email: string; topic: string }
  ) => Promise<{ ok: boolean; alreadySignedUp: boolean }>;
  isValidEmail: (email: unknown) => boolean;
  VALID_TOPICS: Set<string>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{
      allowed: boolean;
      status?: number;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};

const _notifyLimiter = createLimiter(PRESETS.notify);

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const _rl = await _notifyLimiter.guard(req);
  if (!_rl.allowed) {
    return NextResponse.json(_rl.body ?? { ok: false, error: "rate limited" }, {
      status: _rl.status ?? 429,
      headers: _rl.headers as Record<string, string>,
    });
  }

  let body: { email?: unknown; topic?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const topic = typeof body.topic === "string" ? body.topic : "";

  if (!isValidEmail(email)) {
    return NextResponse.json({ ok: false, error: "valid email required" }, { status: 400 });
  }
  if (!VALID_TOPICS.has(topic)) {
    return NextResponse.json({ ok: false, error: "unknown topic" }, { status: 400 });
  }

  try {
    const sql = getDb();
    await addSignup(sql, { email, topic });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[notify] signup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, error: "could not save signup — please try again" },
      { status: 503 }
    );
  }
}
