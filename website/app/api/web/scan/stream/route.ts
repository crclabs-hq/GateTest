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
 *                          `status`/`reason` are issue #648 items 1+2: a
 *                          module whose own `_notChecked` check fired emits
 *                          `not-checked` here — never a clean tick — and
 *                          `reason` is that check's own message, never
 *                          web-runtime-gate.js's runtime-dispatch reason.
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
const { engineBuild } = require("@/app/lib/engine-build") as { engineBuild: () => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};

const _webScanStreamLimiter = createLimiter(PRESETS.webScan);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

interface StreamRequest {
  url?: string;
  fullReport?: boolean;
  sessionId?: string;
}

interface RawCheck { name: string; severity?: string; passed: boolean; message?: string; notChecked?: boolean; verdictSource?: string }
interface RawResult { module?: string; name?: string; checks?: RawCheck[]; errors?: number; warnings?: number; infoFindings?: number; info?: number; duration?: number; skipped?: string; toJSON?: () => RawResult }
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
// used to be a per-route copy; it now lives in scan-finding-translate.js
// and is imported by all four hosted scan routes (web + wp, JSON + stream).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { translateFinding } = require("@/app/lib/scan-finding-translate") as {
  translateFinding: (check: { name: string; severity?: string; message?: string; verdictSource?: string }) => WebFinding | null;
};

export async function POST(req: NextRequest) {
  const _rlWebScan = await _webScanStreamLimiter.guard(req);
  if (!_rlWebScan.allowed) {
    return new Response(JSON.stringify(_rlWebScan.body), {
      status: _rlWebScan.status ?? 429,
      headers: { "Content-Type": "application/json", ...(_rlWebScan.headers || {}) },
    });
  }

  let body: StreamRequest;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }
  // Server-side authority on fullReport — NEVER trust body.fullReport.
  // This streaming route previously didn't check admin status OR payment
  // at all: `const fullReport = Boolean(body.fullReport)` let any caller
  // unlock the paid report for free. See full-report-auth.ts.
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
      const workspace = fs.mkdtempSync(pathMod.join(os.tmpdir(), "web-scan-"));
      const previousExitCode = process.exitCode;
      const startTime = Date.now();

      send("start", { scanId, targetUrl, suite: "web" });

      try {
        // Resolved via engine-entry-resolver.js, NOT a hardcoded relative
        // path — a relative require here resolves against the BUNDLED
        // chunk's location (deep inside .next/server/chunks/), not this
        // source file's location, so a fixed
        // `../../../../../../src/index.js` 404s in both `next start` and
        // on Vercel (confirmed live 2026-07-01: gatetest.ai/api/web/scan/stream
        // 500'd on every request). outputFileTracingIncludes in
        // next.config.ts is what makes src/** actually present in the
        // deployed bundle (turbopackIgnore hides this require from the
        // automatic tracer).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resolveEngineEntry } = require("@/app/lib/engine-entry-resolver.js") as {
          resolveEngineEntry: () => string;
        };
        const engineEntry = resolveEngineEntry();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { GateTest } = require(/* turbopackIgnore: true */ engineEntry) as {
          GateTest: new (root: string, opts?: Record<string, unknown>) => {
            init: () => { runSuite: (name: string) => Promise<unknown> };
            config: { set?: (key: string, value: unknown) => void; data?: Record<string, unknown> } & Record<string, unknown>;
          };
        };

        // ONE shared fetch for the whole suite (issue #643), and ONE shared
        // definition (issue #681 item 1) of how it's wired onto the engine —
        // `website/app/lib/live-scan-config.js`, used by both this route and
        // the non-streaming `/api/web/scan` so the two routes cannot
        // silently disagree about which modules a given URL scan checks.
        // webHeaders, seo, accessibility and cookieSecurity all read the
        // fetch result via `config.livePage` instead of each re-fetching the
        // page. A failed fetch here is not fatal — the runner still
        // executes; the modules that need `config.livePage` report
        // themselves `notChecked` when it's absent rather than fabricating
        // a pass.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { fetchLivePage, applyLiveScanConfig } = require("@/app/lib/live-scan-config") as {
          fetchLivePage: (targetUrl: string, opts?: { timeoutMs?: number }) => Promise<{ url: string; status: number; headers: Headers; html: string } | null>;
          applyLiveScanConfig: (
            gt: { config: ({ set?: (k: string, v: unknown) => void; data?: Record<string, unknown> } & Record<string, unknown>) | undefined | null },
            args: { targetUrl: string; livePage?: { url: string; status: number; headers: Headers; html: string } | null; sanitizedAuth?: { headers?: Record<string, string>; cookie?: string } | null }
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
              // Issue #648 items 1-2, extracted for issue #699 into the ONE
              // shared definition (Doctrine #4) both stream routes build
              // this event from — see scan-stream-events.js for the full
              // explanation of why `.toJSON()` and each check's own
              // `notChecked` flag matter here.
              send(event, buildModuleEndEvent(payload));
            }
          },
        });
        gt.init();
        applyLiveScanConfig(gt, { targetUrl, livePage });
        const summary = (await gt.init().runSuite("web")) as RawSummary;

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
        const { computeHealthScore, deriveModuleCoverage, deriveFreeCheckNames, LIVE_URL_MODULES } = require("@/app/lib/health-score") as {
          computeHealthScore: (
            clusters: Array<{ severity: string; isHighSignal: boolean; count: number; ruleKey?: string }>,
            moduleCoverage?: { totalModules: number; checkedModules: number; notChecked: Array<{ module: string; reason: string }> },
          ) => {
            score: number; grade: 'A' | 'B' | 'C' | 'D' | 'F'; deductions: Array<unknown>; summary: string;
            coverage?: { totalModules: number; checkedModules: number; notCheckedModules: string[] };
          };
          deriveModuleCoverage: (results: RawResult[]) => { totalModules: number; checkedModules: number; notChecked: Array<{ module: string; reason: string }> };
          deriveFreeCheckNames: (results: RawResult[], liveModules?: string[]) => Array<{ module: string; status: 'checked' | 'not-checked'; reason?: string; duration?: number; checks: Array<{ name: string; passed: boolean; severity: string }> }>;
          LIVE_URL_MODULES: string[];
        };

        const clusterResult = clusterAndRankUrlFindings(allFindings);
        // Six of the fourteen `web`-suite modules are file scanners that
        // have nothing to read on a URL-only scan (issue #643) — they
        // report themselves `notChecked` rather than a fabricated pass.
        // Pull that out of the summary BEFORE scoring so the Health Score
        // says, in the same sentence, what it did and did not measure.
        const moduleCoverage = deriveModuleCoverage(summary.results || []);
        const healthScore = computeHealthScore(clusterResult.clusters, moduleCoverage);
        // Issue #648 item 4: check NAMES for the four live-URL modules are
        // free — only the fix guidance (findings[].body) stays paywalled.
        const moduleChecks = deriveFreeCheckNames(summary.results || [], LIVE_URL_MODULES);

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
          // Say what was not checked wherever the result is read (Doctrine
          // #6) — the card, the JSON, and the markdown export all read this
          // same field rather than re-deriving it.
          totalModules: moduleCoverage.totalModules,
          checkedModules: moduleCoverage.checkedModules,
          notCheckedModules: moduleCoverage.notChecked.map((n) => n.module),
          // Issue #658 item 1: the module's own reason (shown live via
          // module:end above) must survive into the completed report and
          // the share-link payload, which is this same `complete` event's
          // JSON re-encoded — before this fix only the bare name did.
          notCheckedReasons: moduleCoverage.notChecked,
          // Free regardless of `preview` — check NAMES are not the paid
          // part, only the fix guidance in `findings[].body` is (item 4).
          moduleChecks,
          // Issue #661 — the engine build stamp, the SAME value
          // `/api/platform-status` reports as `commit`. Carried so a
          // customer's client-side per-URL snapshot (UrlScanFlow.tsx) can
          // tell "the engine changed between your two scans" apart from
          // "your site changed".
          build: engineBuild(),
          // ONE decision with /api/web/scan: dispatch only when fully configured,
          // otherwise an explicit reason code — never a silent default (KI #111).
          runtime: await gateRuntimeScan({ scanId, targetUrl, suite: "web" }),
          paywall: isPreview ? {
            remainingCount: Math.max(0, clusterResult.clusters.length - findings.length),
            fullReportPriceUsd: 29, fullReportCadence: "one-shot",
            ctaUrl: "/checkout?tier=web_scan",
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
