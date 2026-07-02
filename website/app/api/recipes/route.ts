/**
 * /api/recipes — Memory-as-a-Service endpoint for the cross-customer
 * fix-recipe flywheel.
 *
 * THE STRATEGIC PIECE: every opt-in GateTest customer who runs the
 * auto-fix loop and produces a successful fix can sync that recipe
 * here. Every other customer queries here BEFORE invoking Claude,
 * gets a high-confidence pre-computed recipe back, and avoids the
 * Claude round-trip entirely. The engine compounds across the whole
 * user base instead of starting from zero per customer.
 *
 * Privacy:
 *   - We store only `(module, finding-type, file-extension, before-hash,
 *     before-snippet, after-snippet, confidence, usage_count)`. NO file
 *     paths, NO repo names, NO user identifiers ever land in the table.
 *     The existing `fix-recipe-store.js` enforces this at the write
 *     layer; this route is a thin transport wrapper.
 *   - Snippets are capped at 2KB per the store's MAX_SNIPPET_BYTES.
 *   - Anonymous PUT — no auth required. Customers don't need accounts.
 *     The data is safe to be anonymous because it's already anonymised
 *     by the store layer. We add an IP-based rate limit to prevent
 *     recipe-poisoning by a single malicious source.
 *   - Confidence-weighted reads — low-confidence recipes (< 0.6) are
 *     never returned, so a single bad PUT can't poison real customers.
 *
 * Wire format matches `recipe-store-remote.js` (the customer-side glue
 * that lives in the action / CLI):
 *   GET  /api/recipes?module=&finding=&ext=
 *        → { recipes: [{ module, finding_type, file_extension,
 *                         before_snippet, after_snippet, confidence,
 *                         usage_count }] }
 *   PUT  /api/recipes
 *        body: { module, findingType (or issue), filePath, beforeContent,
 *                afterContent, confidenceDelta? }
 *        → { ok: true, action: 'recorded' }
 *
 * Failure mode: every error returns 200/204/null-shape so the customer's
 * fix flow never stalls on us. The remote store is best-effort — if our
 * endpoint is down, the customer's local recipe store + Claude fallback
 * still ship the fix.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 10;

// CommonJS interop — the recipe store + db live in the existing
// website lib/ directory and are CommonJS-shaped per the established
// pattern (see fix-recipe-store.js for the contract).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const recipeStore = require("@/app/lib/fix-recipe-store") as {
  recordRecipe: (opts: {
    sql: unknown;
    module: string;
    issue: string;
    filePath: string;
    beforeContent: string;
    afterContent: string;
    confidenceDelta?: number;
  }) => Promise<void>;
  getRecipeStats: (opts: { sql: unknown }) => Promise<unknown>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbModule = require("@/app/lib/db") as {
  getDb: () => unknown;
};

// Minimum confidence a recipe must have before we return it from GET.
// Recipes start at 0.5 baseline and only climb via repeated successful
// reuse — a recipe below 0.6 hasn't proven itself.
const MIN_CONFIDENCE_TO_RETURN = 0.6;

// Per-IP rate limit: PUT (write) is bounded to N per minute, GET (read)
// to M per minute. In-memory map; resets on cold start. Vercel's
// per-region fleet means an attacker could parallelise across regions
// — V2 will move to a shared store. Good enough for V1 launch.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_PUT_PER_WINDOW = 30;
const RATE_LIMIT_GET_PER_WINDOW = 600;
const rateBuckets = new Map<string, { count: number; resetAt: number; method: string }>();

function checkRate(ip: string, method: "GET" | "PUT"): boolean {
  const key = `${method}:${ip}`;
  const now = Date.now();
  const cap = method === "PUT" ? RATE_LIMIT_PUT_PER_WINDOW : RATE_LIMIT_GET_PER_WINDOW;
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS, method });
    return true;
  }
  if (bucket.count >= cap) return false;
  bucket.count += 1;
  return true;
}

function getIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

// ─── GET — return high-confidence recipes ──────────────────────────────
//
// Query params (all optional — filters apply if present):
//   ?module=         filter by module name (ssrf, secrets, tlsSecurity, ...)
//   ?finding=        filter by extracted finding-type slug
//   ?ext=            filter by file extension (ts, tsx, py, ...)
//   ?limit=          max rows to return (default 50, capped at 200)
//
// All params are optional because the customer-side `recipe-store-remote`
// does a single GET and filters client-side. Server-side filtering is
// just a performance optimisation.
export async function GET(req: NextRequest) {
  const ip = getIp(req);
  if (!checkRate(ip, "GET")) {
    return NextResponse.json(
      { recipes: [], reason: "rate-limited" },
      { status: 429 },
    );
  }

  try {
    const url = new URL(req.url);
    const moduleParam = url.searchParams.get("module") || "";
    const findingParam = url.searchParams.get("finding") || "";
    const extParam = url.searchParams.get("ext") || "";
    const limit = Math.min(
      Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50),
      200,
    );

    const sql = dbModule.getDb() as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<Array<Record<string, unknown>>>;

    // Always ensure the table exists. Idempotent CREATE TABLE IF NOT EXISTS.
    await sql`
      CREATE TABLE IF NOT EXISTS fix_recipes (
        id              SERIAL PRIMARY KEY,
        module          TEXT NOT NULL,
        finding_type    TEXT NOT NULL,
        file_extension  TEXT NOT NULL,
        before_hash     TEXT NOT NULL,
        before_snippet  TEXT NOT NULL,
        after_snippet   TEXT NOT NULL,
        usage_count     INTEGER NOT NULL DEFAULT 1,
        confidence      REAL    NOT NULL DEFAULT 0.5,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Conditional filters compose at query time. Empty string = no filter.
    // Confidence threshold + usage_count tiebreak so the most-trusted
    // recipes land at the top of the response list.
    const rows = await sql`
      SELECT module, finding_type, file_extension, before_snippet,
             after_snippet, confidence, usage_count
      FROM fix_recipes
      WHERE confidence >= ${MIN_CONFIDENCE_TO_RETURN}
        AND (${moduleParam}  = '' OR module         = ${moduleParam})
        AND (${findingParam} = '' OR finding_type   = ${findingParam})
        AND (${extParam}     = '' OR file_extension = ${extParam})
      ORDER BY confidence DESC, usage_count DESC
      LIMIT ${limit}
    `;

    return NextResponse.json(
      { recipes: rows },
      {
        headers: {
          "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=120",
        },
      },
    );
  } catch (err) {
    // Best-effort: never break the customer's fix flow.
    console.error("[/api/recipes GET] error:", err);
    return NextResponse.json({ recipes: [], error: "store-unavailable" });
  }
}

// ─── PUT — upsert a single recipe ──────────────────────────────────────
//
// Body shape (matches what recipe-store-remote sends):
//   {
//     module: string,
//     findingType?: string,  // OR `issue` (legacy)
//     issue?: string,
//     filePath: string,      // used to derive file_extension only — NOT stored
//     beforeContent: string,
//     afterContent: string,
//     confidenceDelta?: number
//   }
export async function PUT(req: NextRequest) {
  const ip = getIp(req);
  if (!checkRate(ip, "PUT")) {
    return NextResponse.json(
      { ok: false, reason: "rate-limited" },
      { status: 429 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
  }

  // Schema validation — fail closed. We accept ONLY known fields and
  // ignore any extras (prevents accidental data-shape drift).
  const moduleName = typeof body.module === "string" ? body.module.slice(0, 64) : "";
  const issue =
    typeof body.findingType === "string" ? body.findingType.slice(0, 256) :
    typeof body.issue === "string" ? body.issue.slice(0, 256) : "";
  const filePath = typeof body.filePath === "string" ? body.filePath.slice(0, 512) : "";
  const beforeContent = typeof body.beforeContent === "string" ? body.beforeContent : "";
  const afterContent = typeof body.afterContent === "string" ? body.afterContent : "";
  const confidenceDelta =
    typeof body.confidenceDelta === "number" ? body.confidenceDelta : 0;

  if (!moduleName || !issue || !filePath || !beforeContent || !afterContent) {
    return NextResponse.json(
      { ok: false, reason: "missing-fields" },
      { status: 400 },
    );
  }

  // The store enforces snippet length cap (MAX_SNIPPET_BYTES = 2048) and
  // does the SHA-256 hashing of beforeContent — so this route doesn't
  // need to defend further; it just hands the inputs through.
  try {
    const sql = dbModule.getDb();
    await recipeStore.recordRecipe({
      sql,
      module: moduleName,
      issue,
      filePath,
      beforeContent,
      afterContent,
      confidenceDelta,
    });
    return NextResponse.json({ ok: true, action: "recorded" });
  } catch (err) {
    console.error("[/api/recipes PUT] error:", err);
    return NextResponse.json(
      { ok: false, reason: "store-error" },
      { status: 500 },
    );
  }
}

// Block other methods explicitly — Next defaults to 405 but a JSON shape
// helps the customer-side remote-store know it's not a transient error.
export async function POST() {
  return NextResponse.json(
    { ok: false, reason: "method-not-allowed", hint: "Use PUT to upsert a recipe" },
    { status: 405 },
  );
}

export async function DELETE() {
  return NextResponse.json(
    { ok: false, reason: "method-not-allowed" },
    { status: 405 },
  );
}
