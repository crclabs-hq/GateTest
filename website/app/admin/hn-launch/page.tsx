"use client";

/**
 * HN-launch dashboard — phone-friendly review surface.
 *
 * Workflow:
 *   1. Operator pastes their Show HN URL (or item id) into the box
 *   2. Page polls /api/admin/hn-launch/poll every 60s
 *   3. Each new comment lands in the queue with a Claude-drafted reply
 *      (banner-prefixed "[DRAFT — REVIEW BEFORE POSTING]")
 *   4. Operator hits "Copy + Open HN" — clipboard gets the draft,
 *      new tab opens the HN reply form, operator pastes + clicks
 *      Reply on HN
 *   5. Operator hits "Mark replied" — comment id moves to the seen
 *      set (localStorage), won't reappear
 *
 * Persistence is client-side only (localStorage). Comment IDs that
 * have already been handled never re-trigger a Claude draft.
 *
 * Boss-Rule respect: this surface NEVER posts to HN. It assists the
 * human who posts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Draft {
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
}

interface PollResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  polledAt?: string;
  storyMeta?: {
    id: number;
    title: string | null;
    author: string | null;
    points: number | null;
    url: string | null;
    createdAtUnix: number | null;
  } | null;
  stats?: {
    totalCommentsInThread: number;
    freshSinceParam: number;
    drafted: number;
    overPerPollCap: number;
    voiceExamplesUsed: number;
  };
  drafts: Draft[];
}

const SEEN_KEY = "gatetest:hn-launch:seenIds";
const STORY_KEY = "gatetest:hn-launch:storyId";
const POLL_INTERVAL_MS = 60_000;

function loadSeen(): Set<number> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((n): n is number => typeof n === "number"));
  } catch {
    return new Set();
  }
}

function persistSeen(seen: Set<number>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(seen)));
  } catch { /* quota — ignore */ }
}

function loadStoryId(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(STORY_KEY) || "";
}

function persistStoryId(value: string) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(STORY_KEY, value); } catch { /* ignore */ }
}

function timeAgo(unix: number | null): string {
  if (!unix) return "";
  const diffMin = (Date.now() / 1000 - unix) / 60;
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${Math.round(diffMin)}m ago`;
  if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)}h ago`;
  return `${Math.round(diffMin / (60 * 24))}d ago`;
}

export default function HnLaunchDashboard() {
  const [storyId, setStoryId] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [seen, setSeen] = useState<Set<number>>(new Set());
  const [polling, setPolling] = useState(false);
  const [autoPoll, setAutoPoll] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [storyMeta, setStoryMeta] = useState<PollResponse["storyMeta"]>(null);
  const [stats, setStats] = useState<PollResponse["stats"] | null>(null);
  const [copyToast, setCopyToast] = useState<number | null>(null);
  const [regenInFlight, setRegenInFlight] = useState<number | null>(null);
  const [hint, setHint] = useState<Record<number, string>>({});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setSeen(loadSeen());
    setStoryId(loadStoryId());
  }, []);

  const visibleDrafts = useMemo(
    () => drafts.filter((d) => !seen.has(d.commentId)),
    [drafts, seen]
  );

  const poll = useCallback(async () => {
    if (!storyId) return;
    setPolling(true);
    setError(null);
    try {
      const seenParam = Array.from(seen).join(",");
      const res = await fetch(
        `/api/admin/hn-launch/poll?storyId=${encodeURIComponent(storyId)}&seen=${encodeURIComponent(seenParam)}`,
        { credentials: "same-origin" }
      );
      const data: PollResponse = await res.json();
      if (!res.ok || data.error) {
        setError(data.message || data.error || `HTTP ${res.status}`);
        return;
      }
      setStoryMeta(data.storyMeta);
      setStats(data.stats || null);
      setLastPolledAt(data.polledAt || new Date().toISOString());
      // Merge new drafts on top of existing — dedupe by commentId
      setDrafts((prev) => {
        const byId = new Map(prev.map((d) => [d.commentId, d]));
        for (const d of data.drafts) byId.set(d.commentId, d);
        return Array.from(byId.values()).sort(
          (a, b) => (b.createdAtUnix || 0) - (a.createdAtUnix || 0)
        );
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPolling(false);
    }
  }, [storyId, seen]);

  // Auto-poll loop
  useEffect(() => {
    if (!autoPoll || !storyId) return;
    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoPoll, storyId, poll]);

  const handleStorySubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const raw = String(form.get("storyId") || "").trim();
    persistStoryId(raw);
    setStoryId(raw);
    setDrafts([]);
  };

  const handleCopy = async (draft: Draft) => {
    try {
      await navigator.clipboard.writeText(draft.draft);
      setCopyToast(draft.commentId);
      setTimeout(() => setCopyToast(null), 1500);
    } catch {
      setError("Clipboard write failed — long-press to copy manually");
    }
  };

  const handleMarkReplied = (commentId: number) => {
    const next = new Set(seen);
    next.add(commentId);
    setSeen(next);
    persistSeen(next);
  };

  const handleRegenerate = async (draft: Draft) => {
    setRegenInFlight(draft.commentId);
    try {
      const body = {
        commentId: draft.commentId,
        commentText: draft.text,
        commentAuthor: draft.author,
        parentText: draft.parentText,
        parentAuthor: draft.parentAuthor,
        hint: hint[draft.commentId] || undefined,
      };
      const res = await fetch("/api/admin/hn-launch/draft", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.message || data.error || `HTTP ${res.status}`);
        return;
      }
      setDrafts((prev) =>
        prev.map((d) => (d.commentId === draft.commentId ? { ...d, draft: data.draft, model: data.model } : d))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegenInFlight(null);
    }
  };

  const clearSeen = () => {
    setSeen(new Set());
    persistSeen(new Set());
  };

  return (
    <main className="min-h-screen bg-black text-white">
      <nav className="border-b border-white/[0.06] px-4 sm:px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-orange-500 flex items-center justify-center">
              <span className="text-white font-bold text-sm font-mono">Y</span>
            </div>
            <span className="text-lg font-bold tracking-tight">HN Launch Dashboard</span>
          </div>
          <a href="/admin" className="text-sm text-white/50 hover:text-white">Back to admin &rarr;</a>
        </div>
      </nav>

      <section className="px-4 sm:px-6 py-6 max-w-5xl mx-auto">
        <form onSubmit={handleStorySubmit} className="flex flex-col sm:flex-row gap-2 mb-4">
          <input
            name="storyId"
            type="text"
            defaultValue={storyId}
            placeholder="HN item id or full URL (e.g. 43210000 or https://news.ycombinator.com/item?id=43210000)"
            className="flex-1 px-3 py-2 bg-white/5 border border-white/15 rounded-lg text-sm focus:outline-none focus:border-orange-500"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-black font-semibold rounded-lg text-sm"
          >
            Watch this thread
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-3 text-xs text-white/50 mb-6">
          <button
            onClick={poll}
            disabled={!storyId || polling}
            className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-md text-white/80 hover:text-white hover:border-white/20 disabled:opacity-40"
          >
            {polling ? "Polling…" : "Poll now"}
          </button>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoPoll}
              onChange={(e) => setAutoPoll(e.target.checked)}
              className="accent-orange-500"
            />
            Auto-poll every 60s
          </label>
          <button
            onClick={clearSeen}
            className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-md text-white/60 hover:text-white/90"
          >
            Reset seen ({seen.size})
          </button>
          {lastPolledAt && (
            <span className="text-white/35">last poll {timeAgo(new Date(lastPolledAt).getTime() / 1000)}</span>
          )}
        </div>

        {storyMeta && (
          <div className="mb-6 rounded-xl border border-white/[0.08] p-4 bg-white/[0.02]">
            <div className="text-xs uppercase tracking-wider text-white/40 font-semibold mb-1">Watching</div>
            <div className="font-semibold text-white">{storyMeta.title || `Item #${storyMeta.id}`}</div>
            <div className="text-xs text-white/45 mt-1">
              by {storyMeta.author || "?"} &middot; {storyMeta.points ?? 0} pts &middot;{" "}
              {stats?.totalCommentsInThread ?? 0} comments &middot;{" "}
              {stats?.voiceExamplesUsed ?? 0} voice examples loaded
            </div>
          </div>
        )}

        {error && (
          <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </div>
        )}

        {stats && stats.overPerPollCap > 0 && (
          <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
            {stats.overPerPollCap} more comment(s) pending — hit Poll Now to draft them.
          </div>
        )}

        {visibleDrafts.length === 0 && storyId && !polling && (
          <div className="text-white/50 text-sm py-12 text-center">
            No new comments to reply to. The dashboard auto-polls every 60s.
          </div>
        )}

        {!storyId && (
          <div className="text-white/50 text-sm py-12 text-center">
            Paste the HN item id or URL above to start watching.
          </div>
        )}

        <div className="space-y-4">
          {visibleDrafts.map((d) => (
            <article key={d.commentId} className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 sm:p-5">
              <header className="flex items-center justify-between mb-3 text-xs text-white/45">
                <div className="flex items-center gap-2">
                  <a href={d.authorProfileUrl} target="_blank" rel="noreferrer" className="text-orange-300 hover:underline font-medium">
                    {d.author}
                  </a>
                  <span>&middot;</span>
                  <span>{timeAgo(d.createdAtUnix)}</span>
                  <span>&middot;</span>
                  <a href={d.hnItemUrl} target="_blank" rel="noreferrer" className="hover:text-white/80">
                    #{d.commentId}
                  </a>
                </div>
                <button
                  onClick={() => handleMarkReplied(d.commentId)}
                  className="text-white/40 hover:text-white/80"
                  title="Hide this card — don't redraft"
                >
                  Mark replied &times;
                </button>
              </header>

              {d.parentAuthor && d.parentText && (
                <div className="text-xs text-white/40 mb-2 italic border-l-2 border-white/10 pl-3">
                  Replying to <strong className="text-white/60">{d.parentAuthor}</strong>:{" "}
                  {d.parentText.slice(0, 200)}{d.parentText.length > 200 ? "…" : ""}
                </div>
              )}

              <div className="text-sm text-white/85 leading-relaxed mb-4 whitespace-pre-wrap break-words">
                {d.text}
              </div>

              <div className="rounded-lg bg-black/40 border border-orange-500/20 p-3 mb-3">
                <div className="text-[10px] uppercase tracking-wider text-orange-300 font-bold mb-2">
                  Claude draft ({d.model || "no model"})
                </div>
                <div className="text-sm text-white/90 leading-relaxed whitespace-pre-wrap break-words font-mono">
                  {d.error ? <span className="text-red-300">Draft failed: {d.error}</span> : d.draft}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  onClick={() => handleCopy(d)}
                  disabled={!d.draft}
                  className="flex-1 px-3 py-2 bg-white/10 hover:bg-white/15 text-white rounded-md text-sm font-medium border border-white/15"
                >
                  {copyToast === d.commentId ? "Copied ✓" : "Copy draft"}
                </button>
                <a
                  href={d.hnReplyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 px-3 py-2 bg-orange-500 hover:bg-orange-600 text-black rounded-md text-sm font-semibold text-center"
                >
                  Open HN reply form &rarr;
                </a>
              </div>

              <details className="mt-3">
                <summary className="text-xs text-white/40 cursor-pointer hover:text-white/60">
                  Regenerate with hint
                </summary>
                <div className="flex gap-2 mt-2">
                  <input
                    type="text"
                    value={hint[d.commentId] || ""}
                    onChange={(e) => setHint({ ...hint, [d.commentId]: e.target.value })}
                    placeholder="e.g. shorter, more technical, less defensive"
                    className="flex-1 px-2 py-1 bg-white/5 border border-white/10 rounded-md text-xs"
                  />
                  <button
                    onClick={() => handleRegenerate(d)}
                    disabled={regenInFlight === d.commentId}
                    className="px-3 py-1 bg-white/10 hover:bg-white/15 text-white rounded-md text-xs disabled:opacity-40"
                  >
                    {regenInFlight === d.commentId ? "…" : "Regenerate"}
                  </button>
                </div>
              </details>
            </article>
          ))}
        </div>

        <footer className="mt-12 text-xs text-white/35 text-center">
          Drafts are <strong>never</strong> auto-posted. The Copy button puts text on your clipboard;
          the Open HN button takes you to HN&apos;s reply form where YOU click submit.
        </footer>
      </section>
    </main>
  );
}
