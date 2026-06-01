/**
 * HN-launch dashboard — manual draft endpoint.
 *
 * POST /api/admin/hn-launch/draft
 *
 * Re-draft a SINGLE comment on demand. Lets the operator regenerate a
 * draft when the first attempt missed the mark — different tone,
 * different angle, etc.
 *
 * Body: { commentId, commentText, commentAuthor, parentText?, parentAuthor?, hint? }
 * The `hint` is a freeform instruction passed to Claude alongside the
 * normal prompt — e.g. "more technical" or "shorter — one paragraph".
 */

import { NextRequest, NextResponse } from "next/server";

const { draftReply } = require("@/app/lib/hn-reply-assistant/drafter.js") as {
  draftReply: (args: {
    comment: { id: number; author: string; text: string; parentAuthor?: string | null; parentText?: string | null };
    voiceExamples?: Array<{ text: string }>;
    productContext?: Record<string, unknown>;
  }) => Promise<{ draft: string; model: string; comment: { id: number; author: string; textSnippet: string } }>;
};

const { fetchAuthorRecentComments } = require("@/app/lib/hn-reply-assistant/watcher.js") as {
  fetchAuthorRecentComments: (args: { author: string; limit?: number }) => Promise<Array<{ text: string }>>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const HN_AUTHOR = "McCracken49";

async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const cookie = req.cookies.get("gatetest_admin")?.value;
  return Boolean(cookie);
}

export async function POST(req: NextRequest) {
  try {
    if (!(await isAdminRequest(req))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "invalid-body" }, { status: 400 });
    }
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "invalid-body" }, { status: 400 });
    }
    const { commentId, commentText, commentAuthor, parentText, parentAuthor, hint } = body as {
      commentId?: number; commentText?: string; commentAuthor?: string;
      parentText?: string; parentAuthor?: string; hint?: string;
    };
    if (!commentId || !commentText || !commentAuthor) {
      return NextResponse.json({ error: "missing-comment-fields" }, { status: 400 });
    }

    let voiceExamples: Array<{ text: string }> = [];
    try {
      const voice = await fetchAuthorRecentComments({ author: HN_AUTHOR, limit: 15 });
      voiceExamples = voice.map((v) => ({ text: v.text }));
    } catch { /* ok — fall through to style rules */ }

    const hintedText = hint
      ? `${commentText}\n\n[OPERATOR HINT: ${hint}]`
      : commentText;

    const draftRes = await draftReply({
      comment: {
        id: commentId,
        author: commentAuthor,
        text: hintedText,
        parentAuthor: parentAuthor || null,
        parentText: parentText || null,
      },
      voiceExamples,
      productContext: {},
    });

    return NextResponse.json({
      ok: true,
      commentId,
      draft: draftRes.draft,
      model: draftRes.model,
      hint: hint || null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "draft-failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
