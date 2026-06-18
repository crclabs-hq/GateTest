/**
 * HN-launch dashboard — poll endpoint.
 *
 * GET /api/admin/hn-launch/poll?storyId=<id>&since=<unix>&limit=<n>
 *
 * Workflow: Craig posts a Show HN, copies the item id from the URL,
 * pastes it into the dashboard. Browser polls this endpoint every 60s.
 *
 * Per request we:
 *   1. Fetch the story tree from HN Algolia (free, no auth)
 *   2. Flatten into a chronological comment list
 *   3. Filter to comments newer than `since` AND not yet seen client-side
 *   4. Cap at `limit` to bound Claude spend per poll cycle (default 5)
 *   5. Bootstrap Craig's voice from his HN history once per session
 *   6. Draft a reply for each new comment via Claude
 *   7. Return the structured drafts — client renders + tracks seen IDs
 *
 * Boss-Rule respect:
 *   - Admin-only (gatetest_admin cookie)
 *   - Every reply is a DRAFT with the [DRAFT — REVIEW BEFORE POSTING]
 *     banner. We never post anywhere.
 *   - Claude budget: hard cap at 5 drafts / poll. Comment volume above
 *     that gets surfaced with empty draft + "over per-poll cap" reason
 *     so the operator manually triggers a follow-up poll.
 */

import { NextRequest, NextResponse } from "next/server";

const {
  pollForNewComments,
  fetchAuthorRecentComments,
  resolveStoryId,
} = require("@/app/lib/hn-reply-assistant/watcher.js") as {
  pollForNewComments: (args: {
    storyId: number | string;
    seenCommentIds?: Set<number>;
    authorFilter?: string;
    _fetch?: typeof fetch;
  }) => Promise<{
    newComments: Array<{
      id: number;
      author: string;
      text: string;
      parentAuthor: string | null;
      parentText: string | null;
      createdAtUnix: number | null;
      storyId: number | null;
    }>;
    allCommentsCount: number;
    storyMeta: { id: number; title: string | null; author: string | null; points: number | null; url: string | null; createdAtUnix: number | null } | null;
    error?: string;
  }>;
  fetchAuthorRecentComments: (args: {
    author: string;
    limit?: number;
    _fetch?: typeof fetch;
  }) => Promise<Array<{ text: string; createdAtUnix: number | null; objectId: string | null }>>;
  resolveStoryId: (input: number | string) => number | null;
};

const { draftReply } = require("@/app/lib/hn-reply-assistant/drafter.js") as {
  draftReply: (args: {
    comment: { id: number; author: string; text: string; parentAuthor?: string | null; parentText?: string | null };
    voiceExamples?: Array<{ text: string }>;
    productContext?: Record<string, unknown>;
    _anthropicCall?: (args: { systemPrompt: string; userPrompt: string }) => Promise<{ text: string; model: string }>;
  }) => Promise<{ draft: string; model: string; comment: { id: number; author: string; textSnippet: string } }>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const HN_AUTHOR = "McCracken49";
const DEFAULT_LIMIT = 5;
const HARD_LIMIT = 10;

async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const cookie = req.cookies.get("gatetest_admin")?.value;
  return Boolean(cookie);
}

export async function GET(req: NextRequest) {
  try {
    if (!(await isAdminRequest(req))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const storyIdRaw = searchParams.get("storyId") || searchParams.get("story") || "";
    const sinceParam = searchParams.get("since") || "0";
    const limitParam = searchParams.get("limit");
    const seenParam = searchParams.get("seen") || "";

    const storyId = resolveStoryId(storyIdRaw);
    if (!storyId) {
      return NextResponse.json(
        { error: "missing-or-invalid-storyId", hint: "Pass ?storyId=<HN item id> or the full HN URL" },
        { status: 400 }
      );
    }

    const sinceUnix = Number.isFinite(Number(sinceParam)) ? Number(sinceParam) : 0;
    let limit = limitParam ? Math.max(1, Math.min(HARD_LIMIT, Number(limitParam) || DEFAULT_LIMIT)) : DEFAULT_LIMIT;
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;

    const seenCommentIds = new Set<number>(
      seenParam
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    );

    // Step 1: fetch story tree + delta
    const pollResult = await pollForNewComments({ storyId, seenCommentIds });
    if (pollResult.error) {
      return NextResponse.json({
        error: pollResult.error,
        storyMeta: pollResult.storyMeta,
        newComments: [],
        drafts: [],
      }, { status: 502 });
    }

    // Filter by since AND skip our own replies (we don't draft responses to ourselves)
    const fresh = pollResult.newComments
      .filter((c) => (c.createdAtUnix || 0) >= sinceUnix)
      .filter((c) => c.author !== HN_AUTHOR);

    // Cap at limit to bound Claude spend per poll
    const toDraft = fresh.slice(0, limit);
    const overCapCount = Math.max(0, fresh.length - limit);

    // Step 2: bootstrap voice (once per request — Algolia is cached enough)
    let voiceExamples: Array<{ text: string }> = [];
    if (toDraft.length > 0) {
      try {
        const voice = await fetchAuthorRecentComments({ author: HN_AUTHOR, limit: 15 });
        voiceExamples = voice.map((v) => ({ text: v.text }));
      } catch {
        // No voice examples is fine — drafter falls back to style rules
      }
    }

    // Step 3: draft each new comment
    const drafts: Array<{
      commentId: number;
      author: string;
      authorProfileUrl: string;
      createdAtUnix: number | null;
      text: string;
      parentAuthor: string | null;
      parentText: string | null;
      hnReplyUrl: string;
      hnItemUrl: string;
      draft: string;
      model: string | null;
      error?: string;
    }> = [];

    for (const comment of toDraft) {
      let draftRes;
      try {
        draftRes = await draftReply({
          comment: {
            id: comment.id,
            author: comment.author,
            text: comment.text,
            parentAuthor: comment.parentAuthor,
            parentText: comment.parentText,
          },
          voiceExamples,
          productContext: {},
        });
      } catch (err) {
        drafts.push({
          commentId: comment.id,
          author: comment.author,
          authorProfileUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(comment.author)}`,
          createdAtUnix: comment.createdAtUnix,
          text: comment.text,
          parentAuthor: comment.parentAuthor,
          parentText: comment.parentText,
          hnReplyUrl: `https://news.ycombinator.com/reply?id=${comment.id}`,
          hnItemUrl: `https://news.ycombinator.com/item?id=${comment.id}`,
          draft: "",
          model: null,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      drafts.push({
        commentId: comment.id,
        author: comment.author,
        authorProfileUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(comment.author)}`,
        createdAtUnix: comment.createdAtUnix,
        text: comment.text,
        parentAuthor: comment.parentAuthor,
        parentText: comment.parentText,
        hnReplyUrl: `https://news.ycombinator.com/reply?id=${comment.id}`,
        hnItemUrl: `https://news.ycombinator.com/item?id=${comment.id}`,
        draft: draftRes.draft,
        model: draftRes.model,
      });
    }

    return NextResponse.json({
      ok: true,
      polledAt: new Date().toISOString(),
      storyMeta: pollResult.storyMeta,
      stats: {
        totalCommentsInThread: pollResult.allCommentsCount,
        freshSinceParam: fresh.length,
        drafted: drafts.length,
        overPerPollCap: overCapCount,
        voiceExamplesUsed: voiceExamples.length,
      },
      drafts,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "poll-failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
