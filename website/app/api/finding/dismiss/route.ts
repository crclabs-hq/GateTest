/**
 * POST /api/finding/dismiss
 *
 * Customer-supplied feedback that a specific finding is noise / intended
 * / not actionable. Persisted to finding_dismissals (see
 * finding-feedback-store.ts) so the confidence-calibrator trainer can
 * re-weight rules over time.
 *
 *   POST /api/finding/dismiss
 *     body: {
 *       scanId?: string,            // Stripe PI or queue id (optional)
 *       rule:    string,            // required — e.g. "security:eval"
 *       file?:   string,
 *       line?:   number,
 *       reason?: "false-positive" | "intended" | "wont-fix" | "test-only" | "deprecated" | "other",
 *       comment?: string,           // free-text, ≤500 chars
 *     }
 *   →
 *     200 { ok: true, id }
 *     400 { ok: false, error }  — validation failure
 *     503 { ok: false, error }  — DATABASE_URL unset / persistence unavailable
 */

import { NextRequest, NextResponse } from "next/server";
import { recordDismissal, clientIp, VALID_REASONS } from "@/app/lib/finding-feedback-store";

export async function POST(req: NextRequest) {
  let body: {
    scanId?: string;
    rule?: string;
    file?: string;
    line?: number;
    reason?: string;
    comment?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  if (!body || typeof body.rule !== "string" || !body.rule.trim()) {
    return NextResponse.json(
      { ok: false, error: "missing required field: rule" },
      { status: 400 },
    );
  }

  if (body.reason && !VALID_REASONS.has(body.reason)) {
    return NextResponse.json(
      {
        ok: false,
        error: `invalid reason — expected one of: ${Array.from(VALID_REASONS).join(", ")}`,
      },
      { status: 400 },
    );
  }

  if (body.comment && body.comment.length > 500) {
    return NextResponse.json(
      { ok: false, error: "comment too long (max 500 chars)" },
      { status: 400 },
    );
  }

  const ip = clientIp(req.headers);

  const result = await recordDismissal({
    scanId: body.scanId,
    rule: body.rule,
    file: body.file,
    line: body.line,
    reason: body.reason,
    comment: body.comment,
    ip,
  });

  if (!result.ok) {
    const status = result.reason?.startsWith("persistence unavailable") ? 503 : 400;
    return NextResponse.json(
      { ok: false, error: result.reason || "failed to record dismissal" },
      { status },
    );
  }

  return NextResponse.json({ ok: true, id: result.id });
}
