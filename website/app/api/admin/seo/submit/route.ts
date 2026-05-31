/**
 * Admin SEO submission endpoint.
 *
 * POST /api/admin/seo/submit
 *
 * Reads the canonical URL list (sitemap source-of-truth) and submits
 * to IndexNow (Bing / Yandex / Seznam / Naver in one call) + pings
 * Bing and Yandex sitemap endpoints in parallel.
 *
 * Auth: admin only. Reuses the existing admin auth pattern.
 *
 * Boss-Rule respect: this is admin-only; the public never triggers a
 * submission. The IndexNow key comes from env var (no secret in code).
 * Submissions only push URLs we own (origin-validated by indexnow.js).
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { submitUrls, isValidKey } = require("@/app/lib/seo/indexnow.js") as {
  submitUrls: (args: { urls: string[]; key: string; host?: string; _fetch?: typeof fetch }) => Promise<{
    submitted: number;
    rejected: Array<{ url: string; reason: string }>;
    batches: Array<{ count: number; status: number | null; ok: boolean; error?: string }>;
  }>;
  isValidKey: (key: string) => boolean;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pingAllEngines } = require("@/app/lib/seo/sitemap-ping.js") as {
  pingAllEngines: (args?: { sitemapUrl?: string; _fetch?: typeof fetch }) => Promise<
    Array<{ engine: string; ok: boolean; status: number | null; error?: string }>
  >;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildAllUrls } = require("@/app/lib/seo/all-urls.js") as {
  buildAllUrls: (args?: { modulesDataPath?: string }) => string[];
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const cookie = req.cookies.get("gatetest_admin")?.value;
  return Boolean(cookie);
}

export async function POST(req: NextRequest) {
  try {
    if (!(await isAdminRequest(req))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const key = process.env.INDEXNOW_KEY;
    if (!key || !isValidKey(key)) {
      return NextResponse.json({
        error: "INDEXNOW_KEY env var not configured (must be 8-128 chars alphanumeric/hyphen)",
      }, { status: 400 });
    }

    const modulesDataPath = path.resolve(
      process.cwd(),
      "website/app/components/howitworks/modules-data.ts"
    );
    const urls = buildAllUrls({ modulesDataPath });

    const [indexNowResult, pingResults] = await Promise.all([
      submitUrls({ urls, key }),
      pingAllEngines(),
    ]);

    return NextResponse.json({
      ok: true,
      urlCount: urls.length,
      indexNow: indexNowResult,
      sitemapPings: pingResults,
    });
  } catch (err) {
    console.error("[seo/submit] failed:", err);
    return NextResponse.json(
      { error: "Submission failed", message: (err as Error).message },
      { status: 500 }
    );
  }
}
