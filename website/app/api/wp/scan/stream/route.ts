/**
 * Streaming web URL scan endpoint.
 *
 * Returns Server-Sent Events (text/event-stream) so the customer's UI
 * sees each module tick through in real time — not a fake progress
 * animation. The final `complete` event carries the same payload shape
 * the non-streaming /api/web/scan endpoint returns.
 *
 * Event types:
 *   event: start          { targetUrl, scanId, suite }
 *   event: module:start   { module }
 *   event: module:end     { module, status: "checked", errors, warnings, info, duration }
 *                      or  { module, status: "not-checked", reason, duration }
 *                          `status`/`reason` are issue #648 items 1+2, extended
 *                          to this route by issue #699: a module whose own
 *                          `_notChecked` check fired emits `not-checked` here
 *                          — never a clean tick — via the same
 *                          `buildModuleEndEvent()` helper `/api/web/scan/stream`
 *                          uses (`website/app/lib/scan-stream-events.js`).
 *   event: module:skip    { module, skipped }
 *   event: complete       <full ScanResult JSON>
 *   event: error          { error }
 *
 * The function also emits keep-alive comment lines (`:\n\n`) every ~10s
 * so the connection doesn't idle out on Vercel's serverless runtime
 * before the scan finishes.
 *
 * Client (UrlScanFlow.tsx) consumes via `fetch().body.getReader()` plus
 * a small SSE-line parser. EventSource isn't usable here because it
 * only does GET, and we need POST with a JSON body.
 */

import { NextRequest } from "next/server";
import { resolveFullReportAccess } from "@/app/lib/full-report-auth";
import { gateRuntimeScan } from "@/app/lib/web-runtime-gate";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildModuleEndEvent } = require("@/app/lib/scan-stream-events") as {
  buildModuleEndEvent: (payload: unknown) =>
    | { module: string; status: "checked"; errors?: number; warnings?: number; info?: number; duration?: number }
    | { module: string; status: "not-checked"; reason: string; duration?: number };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveAndValidateUrl } = require("@/app/lib/ssrf-guard") as {
  resolveAndValidateUrl: (input: string) => Promise<{ ok: true; url: URL } | { ok: false; reason: string }>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};

const _wpScanStreamLimiter = createLimiter(PRESETS.webScan);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

interface StreamRequest {
  url?: string;
  fullReport?: boolean;
  sessionId?: string;
}

interface RawCheck { name: string; severity?: string; passed: boolean; message?: string; verdictSource?: string }
interface RawResult { module?: string; name?: string; checks?: RawCheck[]; errors?: number; warnings?: number; info?: number; duration?: number; skipped?: string }
interface RawSummary { results?: RawResult[]; gateStatus?: string; totalErrors?: number; totalWarnings?: number }

interface WebFinding {
  severity: "error" | "warning" | "info";
  title: string;
  body: string;
  module: string;
  ruleKey: string;
  // The Fifty, move 14: 'deterministic' | 'model' | 'mixed' — set once in
  // scan-finding-translate.js from the raw engine check.
  verdictSource: "deterministic" | "model" | "mixed";
}

// Doctrine #4 (one definition, imported) / issue #695: translateFinding
// used to be a per-route copy (missing the WP-specific branches AND the
// #687 cross-browser branch); it now lives in scan-finding-translate.js
// and is imported by all four hosted scan routes (web + wp, JSON + stream).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { translateFinding } = require("@/app/lib/scan-finding-translate") as {
  translateFinding: (check: { name: string; severity?: string; message?: string; verdictSource?: string }) => WebFinding | null;
};

export async function POST(req: NextRequest) {
  const _rlWpScan = await _wpScanStreamLimiter.guard(req);
  if (!_rlWpScan.allowed) {
    return new Response(JSON.stringify(_rlWpScan.body), {
      status: _rlWpScan.status ?? 429,
      headers: { "Content-Type": "application/json", ...(_rlWpScan.headers || {}) },
    });
  }

  let body: StreamRequest;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }
  // Server-side authority on fullReport — NEVER trust body.fullReport.
  // See full-report-auth.ts.
  const fullReport = await resolveFullReportAccess(req, body);
  const validated = await resolveAndValidateUrl(body.url || "");
  if (!validated.ok) {
    return new Response(JSON.stringify({
      error: "Please paste a valid public website URL. Localhost and internal addresses are blocked.",
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const parsed = validated.url;
  const targetUrl = `${parsed.protocol}//${parsed.host}`;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cryptoMod = require("crypto") as typeof import("crypto");
  const scanId = `scn_${cryptoMod.randomBytes(9).toString("hex")}`;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch { /* error-ok — controller closed mid-write */ }
      };
      const keepAliveTimer = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* error-ok — client gone mid-keepalive; the stream is closed in finally */ }
      }, 10000);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("fs") as typeof import("fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = require("os") as typeof import("os");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pathMod = require("path") as typeof import("path");
      const workspace = fs.mkdtempSync(pathMod.join(os.tmpdir(), "wp-scan-"));
      const previousExitCode = process.exitCode;
      const startTime = Date.now();

      send("start", { scanId, targetUrl, suite: "wp" });

      try {
        // Resolved via engine-entry-resolver.js — see web/scan/stream/route.ts
        // for the full explanation. A hardcoded relative path resolves
        // against the bundled chunk's location, not this source file's, so
        // it 404s everywhere (confirmed live 2026-07-01:
        // gatetest.ai/api/wp/scan/stream 500'd on every request).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resolveEngineEntry } = require("@/app/lib/engine-entry-resolver.js") as {
          resolveEngineEntry: () => string;
        };
        const engineEntry = resolveEngineEntry();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { GateTest } = require(/* turbopackIgnore: true */ engineEntry) as {
          GateTest: new (root: string, opts?: Record<string, unknown>) => {
            init: () => { runSuite: (name: string) => Promise<unknown> };
            config: { set?: (key: string, value: unknown) => void; data?: Record<string, unknown> };
          };
        };
        // ONE shared fetch (issue #643) and ONE shared definition (issue
        // #681 item 1 / #695) of how it's wired onto the engine —
        // `website/app/lib/live-scan-config.js` — now used by ALL FOUR
        // hosted scan routes, not just the two web ones. Before this fix
        // this route built its own config wiring by hand and never
        // fetched the page once for webHeaders/seo/accessibility/
        // cookieSecurity to read via `config.livePage`, so those modules
        // reported not-checked here where the equivalent web scan of the
        // same URL had them checked.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { fetchLivePage, applyLiveScanConfig } = require("@/app/lib/live-scan-config") as {
          fetchLivePage: (targetUrl: string, opts?: { timeoutMs?: number }) => Promise<{ url: string; status: number; headers: Headers; html: string } | null>;
          applyLiveScanConfig: (
            gt: { config: ({ set?: (k: string, v: unknown) => void; data?: Record<string, unknown> } & Record<string, unknown>) | undefined | null },
            args: { targetUrl: string; livePage?: { url: string; status: number; headers: Headers; html: string } | null }
          ) => void;
        };
        const livePage = await fetchLivePage(targetUrl);
        // Module-level event forwarding via the new onProgress hook
        const gt = new GateTest(workspace, {
          silent: true,
          onProgress: (event: string, payload: unknown) => {
            // Forward only the lightweight per-module events to the SSE
            // stream. Full suite:end carries the entire summary which we
            // process locally below.
            if (event === "module:start" || event === "module:skip") {
              const p = payload as { module?: string; name?: string; skipped?: string };
              send(event, { module: p.module || p.name || "unknown", skipped: p.skipped });
              return;
            }
            if (event === "module:end") {
              // Issue #648 items 1-2, extended to this route by issue #699:
              // the ONE shared definition (Doctrine #4) both stream routes
              // build this event from — see scan-stream-events.js for why
              // `.toJSON()` and each check's own `notChecked` flag matter.
              send(event, buildModuleEndEvent(payload));
            }
          },
        });
        gt.init();
        applyLiveScanConfig(gt, { targetUrl, livePage });
        // wpUrl is a WP-module-only fallback (src/modules/wp-*.js reads
        // config.targetUrl first, config.wpUrl second) kept for
        // back-compat; applyLiveScanConfig itself only knows about
        // targetUrl/webUrl/livePage.
        if (gt.config && typeof (gt.config as { set?: (k: string, v: unknown) => void }).set === "function") {
          (gt.config as { set: (k: string, v: unknown) => void }).set("wpUrl", targetUrl);
        } else if (gt.config && (gt.config as { data?: Record<string, unknown> }).data) {
          (gt.config as { data: Record<string, unknown> }).data.wpUrl = targetUrl;
        }
        const summary = (await gt.init().runSuite("wp")) as RawSummary;

        const allFindings: WebFinding[] = [];
        for (const r of summary.results || []) {
          if (!Array.isArray(r.checks)) continue;
          for (const c of r.checks) {
            if (c.passed === true) continue;
            const t = translateFinding(c);
            if (t) allFindings.push(t);
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { clusterAndRankUrlFindings } = require("@/app/lib/url-finding-clusterer") as {
          clusterAndRankUrlFindings: (findings: WebFinding[]) => {
            clusters: Array<{ ruleKey: string; severity: 'error' | 'warning' | 'info'; title: string; body: string; module: string; count: number; isHighSignal: boolean; verdictSource: 'deterministic' | 'model' | 'mixed' }>;
            totalIn: number;
            totalInstances: number;
            droppedInfo: number;
          };
        };
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { computeHealthScore } = require("@/app/lib/health-score") as {
          computeHealthScore: (clusters: Array<{ severity: string; isHighSignal: boolean; count: number; ruleKey?: string }>) => {
            score: number; grade: 'A' | 'B' | 'C' | 'D' | 'F'; deductions: Array<unknown>; summary: string;
          };
        };

        const clusterResult = clusterAndRankUrlFindings(allFindings);
        const healthScore = computeHealthScore(clusterResult.clusters);

        const PREVIEW_LIMIT = 3;
        const isPreview = !fullReport;
        const visible = isPreview ? clusterResult.clusters.slice(0, PREVIEW_LIMIT) : clusterResult.clusters;
        const findings = visible.map((c) => ({
          severity: c.severity, title: c.title, body: c.body, module: c.module,
          ruleKey: c.ruleKey, instanceCount: c.count, highSignal: c.isHighSignal,
          verdictSource: c.verdictSource,
        }));

        send("complete", {
          scanId,
          targetUrl,
          scannedAt: new Date().toISOString(),
          duration: Date.now() - startTime,
          healthScore: { score: healthScore.score, grade: healthScore.grade, summary: healthScore.summary },
          totalFindings: allFindings.length,
          totalClusters: clusterResult.clusters.length,
          errorCount: clusterResult.clusters.filter((c) => c.severity === "error").length,
          warningCount: clusterResult.clusters.filter((c) => c.severity === "warning").length,
          infoCount: clusterResult.droppedInfo,
          preview: isPreview,
          findings,
          // ONE decision with /api/web/scan: dispatch only when fully configured,
          // otherwise an explicit reason code — never a silent default (KI #111).
          runtime: await gateRuntimeScan({ scanId, targetUrl, suite: "wp" }),
          paywall: isPreview ? {
            remainingCount: Math.max(0, clusterResult.clusters.length - findings.length),
            fullReportPriceUsd: 19, fullReportCadence: "one-shot",
            ctaUrl: "/checkout?tier=wp_health",
          } : null,
        });
      } catch (err) {
        send("error", { error: err instanceof Error ? err.message : "Unexpected scan failure" });
      } finally {
        process.exitCode = previousExitCode;
        try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* error-ok — temp workspace cleanup; a leftover dir cannot change the scan result */ }
        clearInterval(keepAliveTimer);
        closed = true;
        try { controller.close(); } catch { /* error-ok — already closed */ }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
