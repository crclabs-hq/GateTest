/**
 * POST /api/admin/triage
 *
 * Orchestrator endpoint for the source / server / browser triage flow.
 *
 * Given a repo URL and a live website URL, fires the three independent
 * scans IN PARALLEL (repo source scan, live server scan, browser scan),
 * normalises each into a ScanLayer, hands them to the pure correlator,
 * and returns the localised verdict + a renderable markdown block.
 *
 * Auth: gatetest_admin cookie — same two-method check as every other
 * /api/admin/* route. Returns 401 if not authenticated.
 *
 * Tolerant of per-scan failure: a failed downstream scan is captured
 * as { ok: false, error } in its ScanLayer and passed to the correlator
 * — the correlator is built to reason about partial signals (Rule 1
 * covers all-three-failed). We never bail the whole triage because one
 * scan returned 5xx or threw.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import {
  getAdminConfig,
  getAdminUser,
  SESSION_COOKIE_NAME,
} from "@/app/lib/admin-session";
import { ADMIN_COOKIE_NAME, deriveAdminToken } from "@/app/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// ----------------------------------------------------------------------------
// Types — mirror the correlator's public surface. Replicated here as TS
// interfaces because the correlator ships as a .js module; keeping them
// local avoids a typedef-chasing dependency at build time.
// ----------------------------------------------------------------------------

type LayerSource = "source" | "server" | "browser";

interface ScanLayer {
  source: LayerSource;
  ok: boolean;
  error?: string;
  totalIssues?: number;
  status?: string;
  modules?: Array<{ name: string; status: string; details?: string[] }>;
  raw?: unknown;
}

interface Verdict {
  layer: LayerSource | "unknown" | "multiple";
  confidence: "low" | "medium" | "high";
  summary: string;
  reasons: string[];
}

interface TriageInput {
  source: ScanLayer;
  server: ScanLayer;
  browser: ScanLayer;
}

// ----------------------------------------------------------------------------
// Correlator import — .js module loaded via require for parity with how
// drafter.js and watcher.js are loaded by /api/admin/hn-launch/draft.
// eslint config already exempts api/**/route.ts from no-require-imports,
// so no inline disable directives are needed.
// ----------------------------------------------------------------------------

const {
  correlate,
  summariseLayer,
  renderVerdictMarkdown,
} = require("@/app/lib/triage/correlator.js") as {
  correlate: (input: TriageInput) => Verdict;
  summariseLayer: (raw: unknown, opts: { source: LayerSource }) => ScanLayer;
  renderVerdictMarkdown: (
    verdict: Verdict,
    layers: { source: ScanLayer; server: ScanLayer; browser: ScanLayer }
  ) => string;
};

// ----------------------------------------------------------------------------
// Auth — copied verbatim from /api/admin/repos/route.ts so every admin
// surface uses the same canonical check.
// ----------------------------------------------------------------------------

async function isAuthenticatedAdmin(): Promise<boolean> {
  const store = await cookies();
  const adminStatus = getAdminConfig();
  if (adminStatus.ok && adminStatus.config) {
    const sessionCookie = store.get(SESSION_COOKIE_NAME)?.value;
    if (getAdminUser(sessionCookie, adminStatus.config)) return true;
  }
  const adminPassword = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (adminPassword) {
    const passwordCookie = store.get(ADMIN_COOKIE_NAME)?.value || "";
    const expected = crypto
      .createHmac("sha256", adminPassword)
      .update("gatetest-admin-v1")
      .digest("hex");
    if (
      passwordCookie &&
      passwordCookie.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(passwordCookie), Buffer.from(expected))
    )
      return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// Input validation + normalisation
// ----------------------------------------------------------------------------

function normaliseRepoUrl(input: string): string | null {
  const v = (input || "").trim();
  if (!v) return null;
  // owner/repo shorthand → full GitHub URL
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(v)) {
    return `https://github.com/${v}`;
  }
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function isValidLiveUrl(input: string): boolean {
  const v = (input || "").trim();
  if (!v) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Downstream scan helpers — each returns the parsed response body OR
// throws. The orchestrator wraps everything in Promise.allSettled and
// converts failures to { ok: false, error } via summariseLayer.
// ----------------------------------------------------------------------------

interface FetchOk {
  ok: true;
  data: unknown;
}
interface FetchErr {
  ok: false;
  error: string;
}
type FetchOutcome = FetchOk | FetchErr;

async function callScan(
  url: string,
  body: Record<string, unknown>
): Promise<FetchOutcome> {
  const adminToken = deriveAdminToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (adminToken) headers["x-admin-token"] = adminToken;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return { ok: false, error: `response parse: ${msg}` };
    }
    return { ok: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

function outcomeToLayer(outcome: FetchOutcome, source: LayerSource): ScanLayer {
  if (!outcome.ok) {
    // Defensive: hand the failure straight through. The correlator's
    // summariseLayer also tolerates this shape, but we don't even need to
    // call it for a known-failed outcome — we know the layer already.
    return summariseLayer({ ok: false, error: outcome.error }, { source });
  }
  return summariseLayer(outcome.data, { source });
}

// ----------------------------------------------------------------------------
// Route handler
// ----------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  let body: { repoUrl?: string; liveUrl?: string; serverUrl?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "invalid-json", message: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const repoUrl = normaliseRepoUrl(String(body?.repoUrl || ""));
  if (!repoUrl) {
    return NextResponse.json(
      {
        error: "invalid-repoUrl",
        message:
          "repoUrl is required — pass either 'owner/repo' or a full https://github.com/... URL.",
      },
      { status: 400 }
    );
  }

  const liveUrlRaw = String(body?.liveUrl || "").trim();
  if (!isValidLiveUrl(liveUrlRaw)) {
    return NextResponse.json(
      {
        error: "invalid-liveUrl",
        message: "liveUrl is required and must be an http(s) URL.",
      },
      { status: 400 }
    );
  }

  const serverUrlRaw = String(body?.serverUrl || "").trim();
  const serverUrl =
    serverUrlRaw && isValidLiveUrl(serverUrlRaw) ? serverUrlRaw : liveUrlRaw;

  // Resolve base URL the same way /api/watches/tick does, with a fallback
  // to the incoming request's host header for local dev / preview.
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    `http://${req.headers.get("host") || "localhost:3000"}`;

  try {
    // Fan out the three scans in parallel. allSettled means a thrown
    // promise from one scan can't take the others down.
    const [sourceOutcome, serverOutcome, browserOutcome] =
      await Promise.allSettled([
        callScan(`${baseUrl}/api/scan/run`, { repoUrl, tier: "quick" }),
        callScan(`${baseUrl}/api/scan/server`, { url: serverUrl }),
        callScan(`${baseUrl}/api/web/scan`, { url: liveUrlRaw }),
      ]);

    const unwrap = (
      settled: PromiseSettledResult<FetchOutcome>
    ): FetchOutcome => {
      if (settled.status === "fulfilled") return settled.value;
      const msg =
        settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason);
      return { ok: false, error: msg };
    };

    const layers = {
      source: outcomeToLayer(unwrap(sourceOutcome), "source"),
      server: outcomeToLayer(unwrap(serverOutcome), "server"),
      browser: outcomeToLayer(unwrap(browserOutcome), "browser"),
    };

    const verdict = correlate(layers);
    const markdown = renderVerdictMarkdown(verdict, layers);

    return NextResponse.json({
      ok: true,
      triagedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      inputs: { repoUrl, liveUrl: liveUrlRaw, serverUrl },
      verdict,
      layers,
      markdown,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[GateTest] triage POST crashed:", message);
    return NextResponse.json(
      { error: "triage-failed", message },
      { status: 500 }
    );
  }
}
