/**
 * IndexNow key verification endpoint.
 *
 * Serves the IndexNow ownership-proof file at /<key>.txt where the
 * response body is the key itself. The key matches our environment
 * variable INDEXNOW_KEY so search engines can verify we own this
 * origin before honouring submissions.
 *
 * Without this endpoint IndexNow will reject every submission with
 * "key not found at keyLocation".
 *
 * Boss-Rule respect: this is a static-shape route. The KEY value is
 * an env var so rotating it doesn't require a code change. Only ONE
 * key is honoured at a time — any other /<x>.txt request returns 404.
 */

import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  // The route param is the filename (without .txt).
  // Next.js dynamic-segment routes drop the literal "[key].txt" → pathname is /<actualKey>.txt
  const match = url.pathname.match(/\/([a-zA-Z0-9-]{8,128})\.txt$/);
  if (!match) {
    return new Response("Not Found", { status: 404 });
  }
  const requested = match[1];

  const configured = process.env.INDEXNOW_KEY;
  if (!configured) {
    // Without a configured key, the IndexNow surface is dormant — we
    // refuse to claim a key we haven't been asked to honour.
    return new Response("Not Found", { status: 404 });
  }
  if (requested !== configured) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(configured, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
