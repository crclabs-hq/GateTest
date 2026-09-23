/**
 * WordPress site scan endpoint.
 *
 * Customer pastes a URL on /wp; this endpoint runs the WP-flavoured
 * module suite against that URL (HTTP probes, no auth required) and
 * returns a plain-language report.
 *
 * Flow:
 *   1. Validate the URL (must be http/https, reachable, looks like a website)
 *   2. Build a "wp-scan" tier context — sets targetUrl in the config so the
 *      WP-specific modules know what to probe
 *   3. Run the suite via the CLI engine runner (closes the 91-vs-22 gap)
 *   4. Translate findings into plain-language WP-owner copy
 *   5. Return JSON suitable for the /wp landing page to render
 *
 * Free preview behaviour: by default returns only the top 3 highest-severity
 * findings, plus a `paywall: { remainingCount }` field. The full report
 * lands once payment is captured (Stripe wire-up follows).
 *
 * No authentication. No git access. Just a URL → report.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveFullReportAccess } from "@/app/lib/full-report-auth";
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

const _wpScanLimiter = createLimiter(PRESETS.webScan);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60; // WP scans are HTTP-probe-bound; 60s is plenty

interface WpScanRequest {
  url?: string;
  fullReport?: boolean; // true once payment captured; defaults to preview
  sessionId?: string;
}

interface WpFinding {
  severity: "error" | "warning" | "info";
  title: string;
  body: string;
  module: string;
  ruleKey: string;
}

// Doctrine #4 (one definition, imported) / issue #695: translateFinding
// used to be a per-route copy (with its own WordPress-specific branches
// and missing the #687 cross-browser branch); it now lives in
// scan-finding-translate.js and is imported by all four hosted scan
// routes (web + wp, JSON + stream), WP branches included.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { translateFinding } = require("@/app/lib/scan-finding-translate") as {
  translateFinding: (check: { name: string; severity?: string; message?: string }) => WpFinding | null;
};

export async function POST(req: NextRequest) {
  const _rlWpScan = await _wpScanLimiter.guard(req);
  if (!_rlWpScan.allowed) {
    return NextResponse.json(_rlWpScan.body, {
      status: _rlWpScan.status ?? 429,
      headers: _rlWpScan.headers as Record<string, string>,
    });
  }

  // Support both JSON body (XHR from React) and form submission (the
  // landing page's <form action="/api/wp/scan" method="POST">).
  let url: string | undefined;
  let fullReport = false;
  let body: WpScanRequest = {};

  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    url = body.url;
  } else {
    const form = await req.formData();
    url = String(form.get("url") || "");
  }

  // Server-side authority on fullReport — NEVER trust body.fullReport.
  // See full-report-auth.ts.
  fullReport = await resolveFullReportAccess(req, body);

  const validated = await resolveAndValidateUrl(url || "");
  if (!validated.ok) {
    return NextResponse.json(
      {
        error:
          "Please paste a valid public WordPress site URL (e.g. https://yoursite.com). " +
          "Localhost and internal addresses are blocked.",
      },
      { status: 400 }
    );
  }
  const parsed = validated.url;

  const targetUrl = `${parsed.protocol}//${parsed.host}`;

  // WP scans probe a live URL — no fileContents needed. We invoke the
  // CLI engine directly here (rather than going through cli-engine-runner)
  // so we can inject targetUrl into the runtime config that the WP
  // modules read. cli-engine-runner doesn't yet support a config-override
  // shape; can be unified once we have a clear pattern across both flows.
  //
  // turbopackIgnore: the CLI engine eventually loads src/core/registry.js
  // which does dynamic require()s of every module file. Turbopack tries
  // to enumerate all possible targets at build time and crashes. The
  // comment tells Turbopack to skip tracing through this boundary;
  // Node-at-runtime resolves normally.
  //
  // Resolved via engine-entry-resolver.js, NOT a hardcoded relative path —
  // a relative require here resolves against the BUNDLED chunk's location,
  // not this source file's, so a fixed `../../../../../src/index.js`
  // 404s everywhere (confirmed live 2026-07-01: gatetest.ai/api/wp/scan
  // 500'd on every request). outputFileTracingIncludes in next.config.ts
  // is what makes src/** actually present in the deployed bundle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require("path") as typeof import("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolveEngineEntry } = require("@/app/lib/engine-entry-resolver.js") as {
    resolveEngineEntry: () => string;
  };
  const engineEntry = resolveEngineEntry();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GateTest } = require(/* turbopackIgnore: true */ engineEntry) as {
    GateTest: new (root: string, opts?: Record<string, unknown>) => {
      init: () => { runSuite: (name: string) => Promise<unknown> };
      registry: { list: () => string[] };
      config: { set?: (key: string, value: unknown) => void; data?: Record<string, unknown> };
    };
  };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os") as typeof import("os");

  const workspace = fs.mkdtempSync(pathMod.join(os.tmpdir(), "wp-scan-"));
  const startTime = Date.now();

  // Pre-empt the engine setting process.exitCode = 1 if any module fails.
  const previousExitCode = process.exitCode;

  let summary: { results?: Array<{ module?: string; name?: string; checks?: Array<{ name: string; severity?: string; passed: boolean; message?: string }>; errors?: number; warnings?: number; info?: number; duration?: number; skipped?: string }>; gateStatus?: string; totalErrors?: number; totalWarnings?: number };

  // ONE shared fetch (issue #643) and ONE shared definition (issue #681
  // item 1 / #695) of how it's wired onto the engine —
  // `website/app/lib/live-scan-config.js` — now used by ALL FOUR hosted
  // scan routes, not just the two web ones. Before this fix this route
  // built its own config wiring by hand and never fetched the page once
  // for webHeaders/seo/accessibility/cookieSecurity to read via
  // `config.livePage`, so those modules reported not-checked on a wp scan
  // where the equivalent web scan of the same URL had them checked.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { fetchLivePage, applyLiveScanConfig } = require("@/app/lib/live-scan-config") as {
    fetchLivePage: (targetUrl: string, opts?: { timeoutMs?: number }) => Promise<{ url: string; status: number; headers: Headers; html: string } | null>;
    applyLiveScanConfig: (
      gt: { config: ({ set?: (k: string, v: unknown) => void; data?: Record<string, unknown> } & Record<string, unknown>) | undefined | null },
      args: { targetUrl: string; livePage?: { url: string; status: number; headers: Headers; html: string } | null }
    ) => void;
  };
  const livePage = await fetchLivePage(targetUrl);

  try {
    const gt = new GateTest(workspace, { silent: true });
    gt.init();
    applyLiveScanConfig(gt, { targetUrl, livePage });
    // wpUrl is a WP-module-only fallback (src/modules/wp-*.js reads
    // config.targetUrl first, config.wpUrl second) kept for back-compat;
    // applyLiveScanConfig itself only knows about targetUrl/webUrl/livePage.
    if (gt.config && typeof (gt.config as { set?: (k: string, v: unknown) => void }).set === "function") {
      (gt.config as { set: (k: string, v: unknown) => void }).set("wpUrl", targetUrl);
    } else if (gt.config && (gt.config as { data?: Record<string, unknown> }).data) {
      (gt.config as { data: Record<string, unknown> }).data.wpUrl = targetUrl;
    }
    summary = (await gt.init().runSuite("wp")) as typeof summary;
  } catch (err) {
    process.exitCode = previousExitCode;
    // Best-effort cleanup
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* error-ok — temp workspace cleanup; a leftover dir cannot change the scan result */ }
    const msg = err instanceof Error ? err.message : "Unexpected scan failure";
    return NextResponse.json(
      { error: `Scan failed: ${msg}. Please try again or contact support.` },
      { status: 500 }
    );
  } finally {
    process.exitCode = previousExitCode;
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* error-ok — temp workspace cleanup; a leftover dir cannot change the scan result */ }
  }

  // Flatten findings, translate to plain-language
  const allFindings: WpFinding[] = [];
  for (const r of summary.results || []) {
    if (!Array.isArray(r.checks)) continue;
    for (const c of r.checks) {
      if (c.passed === true) continue; // skip passing checks
      const translated = translateFinding(c);
      if (translated) allFindings.push(translated);
    }
  }

  // Cluster by rule + rank by signal/severity/count, drop info chatter.
  // One finding per cluster gets surfaced (with its instance count),
  // so the customer sees "1 missing CSP header (affects all pages)"
  // not 47 copies of the same finding.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { clusterAndRankUrlFindings } = require("@/app/lib/url-finding-clusterer") as {
    clusterAndRankUrlFindings: (
      findings: WpFinding[],
      opts?: { includeInfo?: boolean }
    ) => {
      clusters: Array<{ ruleKey: string; severity: 'error' | 'warning' | 'info'; title: string; body: string; module: string; count: number; instances: WpFinding[]; isHighSignal: boolean }>;
      totalIn: number;
      totalInstances: number;
      droppedInfo: number;
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { computeHealthScore } = require("@/app/lib/health-score") as {
    computeHealthScore: (clusters: Array<{ severity: string; isHighSignal: boolean; count: number; ruleKey?: string }>) => {
      score: number;
      grade: 'A' | 'B' | 'C' | 'D' | 'F';
      deductions: Array<unknown>;
      summary: string;
    };
  };

  const clusterResult = clusterAndRankUrlFindings(allFindings);
  const healthScore = computeHealthScore(clusterResult.clusters);

  const PREVIEW_LIMIT = 3;
  const isPreview = !fullReport;
  const visibleClusters = isPreview ? clusterResult.clusters.slice(0, PREVIEW_LIMIT) : clusterResult.clusters;
  // Surface each cluster as ONE finding with a count. Keeps the
  // customer-facing list tidy: 3 clusters not 47 noise rows.
  const findings = visibleClusters.map((c) => ({
    severity: c.severity,
    title: c.title,
    body: c.body,
    module: c.module,
    ruleKey: c.ruleKey,
    instanceCount: c.count,
    highSignal: c.isHighSignal,
  }));

  return NextResponse.json({
    targetUrl,
    scannedAt: new Date().toISOString(),
    duration: Date.now() - startTime,
    healthScore: {
      score: healthScore.score,
      grade: healthScore.grade,
      summary: healthScore.summary,
    },
    totalFindings: allFindings.length,
    totalClusters: clusterResult.clusters.length,
    errorCount: clusterResult.clusters.filter((c) => c.severity === "error").length,
    warningCount: clusterResult.clusters.filter((c) => c.severity === "warning").length,
    infoCount: clusterResult.droppedInfo,
    preview: isPreview,
    findings,
    paywall: isPreview
      ? {
          remainingCount: Math.max(0, clusterResult.clusters.length - findings.length),
          fullReportPriceUsd: 19,
          fullReportCadence: "one-shot",
          ctaUrl: "/checkout?tier=wp_health",
        }
      : null,
  });
}

export async function GET() {
  return NextResponse.json(
    {
      hint: "POST a JSON body { url: 'https://yoursite.com' } or submit the /wp landing form.",
    },
    { status: 405 }
  );
}
