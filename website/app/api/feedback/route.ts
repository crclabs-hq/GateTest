/**
 * POST /api/feedback
 *
 * Customer feedback ingest for the two automated loops (Craig 2026-09-16,
 * "bad feedback must reach us before it reaches a review site"):
 *   - <ScanFeedback> — "Was this scan useful?" under every hosted result
 *   - <FindingWrong> — the "Wrong?" link on a finding row
 *
 *   body: {
 *     surface: string,            // required — "repo" | "web" | "wp" | "preview" | "finding" | …
 *     rating:  "up" | "down",     // required
 *     scanId?: string,
 *     tier?:   string,
 *     rule?:   string,            // finding surface: module or module:rule
 *     text?:   string,            // redacted (secrets, e-mails) and capped at 1,000 chars before storage
 *     page?:   string,            // path only; the query string is dropped
 *   }
 *   →
 *     200 { ok: true, stored: true, escalated: boolean, reason?, ref? }
 *     400 { ok: false, error }   — missing surface / rating, bad shape
 *     429 { error, retryAfter }  — per-IP limit (lib/rate-limit.js + Postgres count)
 *     503 { ok: false, error }   — DATABASE_URL unset
 *
 * Escalation (feedback-escalation.js): a down rating with text opens a
 * GitHub issue on our repository; a finding-wrong click opens or comments
 * on a "Possible false positive: <rule>" issue. It uses the server-side
 * git host credential github-app.ts already resolves for the webhook and
 * fix routes. When none is configured, or the call fails, the event is
 * still stored and the response says `escalated: false` with the reason —
 * the customer's request never fails because of our side.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";
import { resolveGithubToken } from "@/app/lib/github-app";
import { clientIp } from "@/app/lib/finding-feedback-store";

type Sql = ReturnType<typeof getDb>;

interface FeedbackEvent {
  surface: string;
  rating: "up" | "down";
  tier: string | null;
  scanId: string | null;
  rule: string | null;
  page: string | null;
  text: string | null;
  ip?: string;
}

interface Decision {
  kind: "none" | "issue" | "comment";
  reason?: string;
  title?: string;
  label?: string;
  issueNumber?: number;
}

interface EscalationOutcome {
  escalated: boolean;
  reason?: string;
  issueNumber?: number;
  ref?: string | null;
}

const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: {
    windowMs: number;
    maxRequests: number;
    dbBackedFn?: (key: string, windowMs: number) => Promise<{ count: number; ttl: number }>;
  }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};
const { validateFeedbackBody } = require("@/app/lib/feedback-redact") as {
  validateFeedbackBody: (body: unknown) => { ok: true; event: FeedbackEvent } | { ok: false; status: 400; error: string };
};
const { recordFeedback, markEscalated, countRecentByIp, findRecentEscalation } = require("@/app/lib/feedback-store") as {
  recordFeedback: (sql: Sql, event: FeedbackEvent) => Promise<string | null>;
  markEscalated: (sql: Sql, id: string | null, o: { issueNumber?: number; ref?: string | null }) => Promise<boolean>;
  countRecentByIp: (sql: Sql, ip: string, windowMs: number) => Promise<{ count: number; ttl: number }>;
  findRecentEscalation: (sql: Sql, rule: string, days: number) => Promise<{ issueNumber: number; ref: string | null } | null>;
};
const { escalationDecision, escalate, isIssueOpen, FEEDBACK_REPO, DEDUPE_DAYS } = require("@/app/lib/feedback-escalation") as {
  escalationDecision: (event: FeedbackEvent, prior?: { issueNumber: number } | null) => Decision;
  escalate: (o: { decision: Decision; event: FeedbackEvent; rowId: string | null; token: string | null }) => Promise<EscalationOutcome>;
  isIssueOpen: (o: { token: string; issueNumber: number }) => Promise<boolean>;
  FEEDBACK_REPO: { owner: string; repo: string };
  DEDUPE_DAYS: number;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Per-IP limit: the in-process bucket plus this IP's rows already in
// feedback_events, so the count survives cold starts. A DB miss throws and
// the limiter falls back to the in-process count rather than blocking.
const _feedbackLimiter = createLimiter({
  ...PRESETS.feedback,
  dbBackedFn: async (ip, windowMs) => {
    if (!process.env.DATABASE_URL) throw new Error("persistence unavailable");
    return countRecentByIp(getDb(), ip, windowMs);
  },
});

async function runEscalation(sql: Sql, event: FeedbackEvent, rowId: string | null): Promise<EscalationOutcome> {
  const first = escalationDecision(event, null);
  if (first.kind === "none") return { escalated: false, reason: first.reason };
  try {
    const auth = await resolveGithubToken(FEEDBACK_REPO.owner, FEEDBACK_REPO.repo);
    if (!auth.token) {
      const reason = auth.error || "no git host credential configured";
      console.warn(`[feedback] stored row ${rowId} but could not escalate: ${reason}`);
      return { escalated: false, reason };
    }
    let prior: { issueNumber: number } | null = null;
    if (event.surface === "finding" && event.rule) {
      const recent = await findRecentEscalation(sql, event.rule, DEDUPE_DAYS);
      if (recent && (await isIssueOpen({ token: auth.token, issueNumber: recent.issueNumber }))) prior = recent;
    }
    const decision = escalationDecision(event, prior);
    const outcome = await escalate({ decision, event, rowId, token: auth.token });
    if (outcome.escalated) await markEscalated(sql, rowId, { issueNumber: outcome.issueNumber, ref: outcome.ref });
    else console.warn(`[feedback] stored row ${rowId} but could not escalate: ${outcome.reason}`);
    return outcome;
  } catch (err) {
    const reason = `escalation failed: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[feedback] stored row ${rowId} but could not escalate: ${reason}`);
    return { escalated: false, reason };
  }
}

// auth-public — customer feedback ingest. The free funnel, the paid result
// page and the finding rows all post here without an account; the endpoint
// returns nobody's data and is per-IP rate limited above.
export async function POST(req: NextRequest) {
  const _rl = await _feedbackLimiter.guard(req);
  if (!_rl.allowed) {
    return NextResponse.json(_rl.body, { status: _rl.status ?? 429, headers: _rl.headers as Record<string, string> });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const validated = validateFeedbackBody(body);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { ok: false, error: "persistence unavailable (DATABASE_URL unset)" },
      { status: 503 },
    );
  }

  const event: FeedbackEvent = { ...validated.event, ip: clientIp(req.headers) };
  let sql: Sql;
  let rowId: string | null;
  try {
    sql = getDb();
    rowId = await recordFeedback(sql, event);
  } catch (err) {
    console.warn("[feedback] recordFeedback failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, error: "could not record feedback" }, { status: 500 });
  }

  const outcome = await runEscalation(sql, event, rowId);
  return NextResponse.json({
    ok: true,
    stored: true,
    id: rowId,
    escalated: outcome.escalated,
    ...(outcome.escalated ? { ref: outcome.ref ?? null } : { reason: outcome.reason }),
  });
}
