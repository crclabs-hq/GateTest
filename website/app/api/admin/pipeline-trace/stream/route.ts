/**
 * GET /api/admin/pipeline-trace/stream
 *
 * Server-Sent Events stream of live scan execution events.
 * Admin-only. Streams the last 20 scans on connect, then polls for new
 * rows every 3 seconds. Closes automatically after 55 seconds to bound
 * each connection; LiveScanFeed reconnects on the `close` event and shows
 * the reconnect (and any `error` event) in its header.
 *
 * Event types:
 *   scan   — a scan row (id, repo_url, tier, status, score, duration_ms, created_at)
 *   error  — non-fatal server error (message field)
 *   close  — graceful stream end (reason field)
 *   : ping — heartbeat comment (no data, keeps connection alive)
 */

import { NextRequest } from "next/server";
import { requireAdminRoute } from "@/app/lib/admin-guard";
import { getDb } from "@/app/lib/db";

export const dynamic = "force-dynamic";

type ScanRow = {
  id: string;
  repo_url: string | null;
  tier: string | null;
  status: string;
  score: number | null;
  duration_ms: number | null;
  created_at: Date | string;
};

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v;
}

export async function GET(req: NextRequest) {
  const refused = requireAdminRoute(req);
  if (refused) return refused;

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    const body = 'event: error\ndata: {"message":"Database not configured"}\n\n';
    return new Response(body, { status: 200, headers: SSE_HEADERS });
  }

  const enc = new TextEncoder();

  const sse = (event: string, data: unknown) =>
    enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let intervalId: ReturnType<typeof setInterval> | undefined;
  let heartbeatId: ReturnType<typeof setInterval> | undefined;
  let closeTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const cleanup = () => {
    clearInterval(intervalId);
    clearInterval(heartbeatId);
    clearTimeout(closeTimeoutId);
  };

  const stream = new ReadableStream({
    async start(ctrl) {
      // 1. Push recent scan history immediately (chronological order)
      let since = new Date();
      try {
        const rows = await sql`
          SELECT id, repo_url, tier, status, score, duration_ms, created_at
          FROM scans
          ORDER BY created_at DESC
          LIMIT 20
        ` as ScanRow[];

        if (rows.length > 0) {
          since = new Date(toIso(rows[0].created_at));
          for (const row of [...rows].reverse()) {
            ctrl.enqueue(sse("scan", { ...row, created_at: toIso(row.created_at) }));
          }
        }
        ctrl.enqueue(enc.encode(`: initial batch (${rows.length})\n\n`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "initial fetch failed";
        if (msg.includes("does not exist") || msg.includes("relation")) {
          ctrl.enqueue(enc.encode(": scans table not initialised yet\n\n"));
        } else {
          ctrl.enqueue(sse("error", { message: msg }));
        }
      }

      // 2. Poll every 3 seconds for new scans
      let lastPollError = "";
      intervalId = setInterval(async () => {
        if (closed) return;
        try {
          const rows = await sql`
            SELECT id, repo_url, tier, status, score, duration_ms, created_at
            FROM scans
            WHERE created_at > ${since.toISOString()}
            ORDER BY created_at ASC
          ` as ScanRow[];

          for (const row of rows) {
            if (closed) break;
            const ts = new Date(toIso(row.created_at));
            if (ts > since) since = ts;
            ctrl.enqueue(sse("scan", { ...row, created_at: ts.toISOString() }));
          }
          lastPollError = "";
        } catch (err) {
          // A failing poll used to be swallowed, so the feed read "live" while
          // nothing could arrive. Tell the client once per distinct message.
          const msg = err instanceof Error ? err.message : "poll failed";
          if (!closed && msg !== lastPollError) {
            lastPollError = msg;
            try { ctrl.enqueue(sse("error", { message: `scan poll failed: ${msg}` })); } catch { /* error-ok — stream already gone */ }
          }
        }
      }, 3_000);

      // 3. Heartbeat every 20 seconds to keep the connection alive through proxies
      heartbeatId = setInterval(() => {
        if (!closed) ctrl.enqueue(enc.encode(": ping\n\n"));
      }, 20_000);

      // 4. Graceful close after 55 seconds. LiveScanFeed handles the `close`
      //    event by reconnecting itself (1s, then backoff on failures) — the
      //    browser's own auto-reconnect is not relied on.
      closeTimeoutId = setTimeout(() => {
        closed = true;
        cleanup();
        try {
          ctrl.enqueue(sse("close", { reason: "timeout" }));
          ctrl.close();
        } catch { /* error-ok — stream may already be gone */ }
      }, 55_000);
    },

    cancel() {
      closed = true;
      cleanup();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
