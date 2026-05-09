/**
 * /api/scan/fix/stream — backwards-compatible alias for /api/scan/fix?stream=1.
 *
 * The original implementation here was a heartbeat-only proxy that
 * fetched /api/scan/fix internally and sprinkled elapsed-time pings
 * over the wire. That proxy is gone — /api/scan/fix now natively
 * streams SSE events when called with `?stream=1` (or with an
 * `Accept: text/event-stream` header), so this route is a thin
 * forward kept for any existing caller still pointing at the old
 * URL.
 */

import { NextRequest } from "next/server";
import { POST as fixPost } from "../route";

// Match the inner endpoint's max duration.
export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  // Build a new URL with stream=1 forced so the main POST takes
  // the streaming branch even if the caller didn't add the param.
  const forwardedUrl = new URL(req.url);
  forwardedUrl.searchParams.set("stream", "1");
  // NextRequest is constructed from the original (preserves body,
  // headers, method) but with the rewritten URL.
  const forwarded = new NextRequest(forwardedUrl, req);
  return fixPost(forwarded);
}
