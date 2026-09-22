/**
 * Generic web URL scan endpoint.
 *
 * Twin of /api/wp/scan but for any public web URL — not just WordPress.
 * Runs the `web` suite (static probes + runtime browser checks):
 *
 *   - web-headers       CSP, HSTS, XFO, nosniff, Permissions-Policy
 *   - tls-security      HTTPS, cert chain, modern protocol support
 *   - cookie-security   Secure, HttpOnly, SameSite flags
 *   - accessibility     ARIA, alt text, contrast (where probe-able)
 *   - seo               meta, canonical, structured data
 *   - links             broken-link surface check
 *   - performance       basic timing metrics
 *   - runtimeErrors     headless-browser-driven LIVE error capture —
 *                       page errors, console.error spam, CSP violations,
 *                       hydration mismatches, mixed content, network
 *                       failures. The "real conflict" findings that
 *                       static probing can't see.
 *
 * Free preview returns the top 3 highest-signal clusters plus a
 * health-score verdict (0-100). Full report unlocks once payment is
 * captured.
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

const _webScanLimiter = createLimiter(PRESETS.webScan);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

interface WebScanRequest {
  url?: string;
  fullReport?: boolean;
  sessionId?: string;
  /**
   * Optional session auth so the crawl can reach pages behind a login
   * (Craig-authorized 2026-07-25, hosted half of the authed-crawl feature).
   * Engine-side same-origin gating (src/modules/live-crawler-auth.js)
   * guarantees these values are only ever sent to the scan target's origin.
   * Per-request only — never stored, never logged, never echoed back.
   */
  auth?: {
    headers?: Record<string, string>;
    cookie?: string;
  };
}

const AUTH_MAX_HEADERS = 10;
const AUTH_MAX_VALUE_LEN = 4096;
const AUTH_HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Validate + sanitize the optional auth block. Returns null when absent,
 * a sanitized copy when valid, or an { error } when malformed — malformed
 * auth must 400 rather than silently scan unauthenticated (the customer
 * would get a report full of login-redirect noise believing it covered
 * their authed pages).
 */
function sanitizeAuth(auth: WebScanRequest["auth"]): { headers?: Record<string, string>; cookie?: string } | { error: string } | null {
  if (auth === undefined || auth === null) return null;
  if (typeof auth !== "object" || Array.isArray(auth)) return { error: "auth must be an object" };
  const out: { headers?: Record<string, string>; cookie?: string } = {};

  if (auth.headers !== undefined) {
    if (typeof auth.headers !== "object" || auth.headers === null || Array.isArray(auth.headers)) {
      return { error: "auth.headers must be an object of header name → value" };
    }
    const entries = Object.entries(auth.headers);
    if (entries.length > AUTH_MAX_HEADERS) return { error: `auth.headers: at most ${AUTH_MAX_HEADERS} headers` };
    const headers: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (!AUTH_HEADER_NAME_RE.test(name)) return { error: `auth.headers: invalid header name "${name.slice(0, 40)}"` };
      if (typeof value !== "string" || value.length === 0 || value.length > AUTH_MAX_VALUE_LEN || /[\r\n]/.test(value)) {
        return { error: `auth.headers: invalid value for "${name}"` };
      }
      headers[name] = value;
    }
    if (Object.keys(headers).length > 0) out.headers = headers;
  }

  if (auth.cookie !== undefined) {
    if (typeof auth.cookie !== "string" || auth.cookie.length === 0 || auth.cookie.length > AUTH_MAX_VALUE_LEN || /[\r\n]/.test(auth.cookie)) {
      return { error: "auth.cookie must be a non-empty single-line string" };
    }
    out.cookie = auth.cookie;
  }

  return out.headers || out.cookie ? out : null;
}

interface WebFinding {
  severity: "error" | "warning" | "info";
  title: string;
  body: string;
  module: string;
  ruleKey: string;
}

/**
 * Translate a raw check into a customer-facing finding. Reuses the same
 * pattern as /api/wp/scan but with generic web copy — no WordPress-isms.
 */
function translateFinding(check: {
  name: string;
  severity?: string;
  message?: string;
}): WebFinding | null {
  const sev = (check.severity || "info").toLowerCase();
  if (sev !== "error" && sev !== "warning" && sev !== "info") return null;
  if (sev === "info") return null; // summaries / config notes are not customer-facing

  const name = check.name;
  let title = check.message || name;
  let body = check.message || "";
  let module = "general";

  if (name.startsWith("web-headers:")) {
    module = "webHeaders";
    title = "Missing or weak security header";
    body =
      (check.message || "") +
      `\n\nFix: add the header in your reverse proxy (nginx, Caddy, Apache), CDN (Cloudflare, Fastly), or app server (Next.js headers(), Express helmet middleware).`;
  } else if (name.startsWith("tls-")) {
    module = "tlsSecurity";
    title = "HTTPS / TLS issue";
    body = check.message || "";
  } else if (name.startsWith("cookie-")) {
    module = "cookieSecurity";
    title = "Cookie hardening missing";
    body = check.message || "";
  } else if (name.startsWith("runtime-errors:page-error") || name.startsWith("runtime-errors:initial-status")) {
    module = "runtimeErrors";
    title = "JavaScript error on page load";
    body =
      (check.message || "") +
      `\n\nWhy it matters: uncaught JS errors break interactive features (forms, navigation, search). Real visitors see a blank or partially-loaded page.`;
  } else if (name.startsWith("runtime-errors:console-error")) {
    module = "runtimeErrors";
    title = "Console error during load";
    body = check.message || "";
  } else if (name.startsWith("runtime-errors:network")) {
    module = "runtimeErrors";
    title = "Network resource failed to load";
    body =
      (check.message || "") +
      `\n\nFailed assets (scripts, images, fonts) often mean broken features and a degraded experience.`;
  } else if (name.startsWith("runtime-errors:csp-violation")) {
    module = "runtimeErrors";
    title = "Content Security Policy violation";
    body =
      (check.message || "") +
      `\n\nA real browser blocked something the page tried to do. Often this means a third-party script or analytics tag is broken — or your CSP is too strict for your own code.`;
  } else if (name.startsWith("runtime-errors:mixed-content")) {
    module = "runtimeErrors";
    title = "Mixed content blocked";
    body =
      (check.message || "") +
      `\n\nYour HTTPS page tried to load HTTP assets — modern browsers refuse to load them. Convert all asset URLs to https://.`;
  } else if (name.startsWith("runtime-errors:hydration")) {
    module = "runtimeErrors";
    title = "Hydration mismatch (React/Vue/Next.js)";
    body =
      (check.message || "") +
      `\n\nServer-rendered HTML did not match the client React tree on first paint. Users see flicker, blank content, or interactive elements that don't respond until the page re-renders.`;
  } else if (name.startsWith("runtime-errors:navigation")) {
    module = "runtimeErrors";
    title = "Page failed to load in a real browser";
    body =
      (check.message || "") +
      `\n\nA headless Chromium instance could not reach this page. If a scanner can't load it, real visitors will hit the same wall.`;
  } else if (name === "crawl:broken-links" || name === "crawl:broken-images") {
    module = "liveCrawler";
    title = name === "crawl:broken-images" ? "Broken image(s) on your site" : "Broken link(s) on your site";
    body =
      (check.message || "") +
      `\n\nVisitors clicking these get a 404 — bad for conversion and SEO.`;
  } else if (name === "crawl:broken-scripts") {
    module = "liveCrawler";
    title = "Broken JavaScript bundle";
    body =
      (check.message || "") +
      `\n\nWhen a JS file 404s, the features depending on it silently break. Users may not even see an error — they just won't be able to use search, forms, or interactive elements.`;
  } else if (name === "crawl:broken-stylesheets") {
    module = "liveCrawler";
    title = "Broken stylesheet";
    body =
      (check.message || "") +
      `\n\nVisitors see raw HTML with no styling for the few seconds before the page falls back, or permanently if the file never loads.`;
  } else if (name === "crawl:missing-meta-description") {
    module = "liveCrawler";
    title = "Pages missing meta description";
    body =
      (check.message || "") +
      `\n\nGoogle's snippet text uses your meta description. Without one, Google guesses — usually poorly. Click-through rate suffers.`;
  } else if (name === "crawl:missing-canonical") {
    module = "liveCrawler";
    title = "Pages missing canonical link";
    body =
      (check.message || "") +
      `\n\nWithout a canonical, multiple URLs (with/without trailing slash, with/without query strings) can be indexed as separate pages — diluting SEO authority.`;
  } else if (name === "crawl:slow-pages") {
    module = "liveCrawler";
    title = "Slow-loading pages";
    body =
      (check.message || "") +
      `\n\nReal users bounce when TTFB exceeds ~2.5 seconds. Each second past that costs measurable revenue.`;
  } else if (name === "crawl:anchor-missing-target") {
    module = "liveCrawler";
    title = "Anchor links pointing at non-existent targets";
    body =
      (check.message || "") +
      `\n\nA visitor clicks the link and nothing happens. Either remove the anchor or add the id to the target element.`;
  } else if (name === "crawl:duplicate-titles") {
    module = "liveCrawler";
    title = "Duplicate page titles";
    body =
      (check.message || "") +
      `\n\nMultiple pages share a <title>. Browser tabs become indistinguishable and Google de-prioritises duplicated content.`;
  } else if (name === "crawl:sitemap-missing") {
    module = "liveCrawler";
    title = "No sitemap.xml found";
    body = check.message || "";
  } else if (name === "crawl:robots-missing") {
    module = "liveCrawler";
    title = "No robots.txt found";
    body = check.message || "";
  } else if (name === "crawl:favicon-missing") {
    module = "liveCrawler";
    title = "No favicon found";
    body = check.message || "";
  } else if (name.startsWith("crawl:error:")) {
    module = "liveCrawler";
    const errType = name.replace("crawl:error:", "");
    title = `Site issue detected: ${errType.replace(/-/g, " ")}`;
    body = check.message || "";
  } else if (name.startsWith("accessibility:") || name.includes("a11y")) {
    module = "accessibility";
    title = "Accessibility issue";
    body = check.message || "";
  } else if (name.startsWith("seo:")) {
    module = "seo";
    title = "SEO issue";
    body = check.message || "";
  } else if (name.startsWith("links:") || name.startsWith("broken-link")) {
    module = "links";
    title = "Broken link or image";
    body = check.message || "";
  } else if (name.startsWith("performance:")) {
    module = "performance";
    title = "Performance issue";
    body = check.message || "";
  } else {
    title = (check.message || name).split(":").slice(0, 2).join(":");
    body = check.message || `Raw finding: ${name}`;
  }

  return {
    severity: sev as "error" | "warning" | "info",
    title,
    body,
    module,
    ruleKey: name,
  };
}

/**
 * Convert a url-prober finding (live HTTP response analysis) to WebFinding.
 * These are distinct from static-analysis findings: they reflect what the
 * deployed server actually returns, not what config files say it should return.
 */
function translateProbeFinding(pf: {
  module: string;
  severity: string;
  rule: string;
  message: string;
}): WebFinding | null {
  const sev = pf.severity.toLowerCase();
  if (sev !== "error" && sev !== "warning") return null;
  const title = pf.message.split(" — ")[0].split(" (got:")[0];
  return {
    severity: sev as "error" | "warning",
    title,
    body: pf.message + "\n\n*Detected from the live server response — not from static config file analysis.*",
    module: pf.module,
    ruleKey: `live:${pf.rule}`,
  };
}

export async function POST(req: NextRequest) {
  const _rlWebScan = await _webScanLimiter.guard(req);
  if (!_rlWebScan.allowed) {
    return NextResponse.json(_rlWebScan.body, {
      status: _rlWebScan.status ?? 429,
      headers: _rlWebScan.headers as Record<string, string>,
    });
  }

  let url: string | undefined;
  let fullReport = false;
  let body: WebScanRequest = {};

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
  // Grants the unpaywalled report only for (a) an admin request or (b) a
  // Stripe Checkout Session verified server-side as payment_status=paid.
  // See full-report-auth.ts for why this replaced the old
  // `fullReport = Boolean(body.fullReport)` + admin-only-upgrades logic —
  // that let any anonymous caller send {fullReport:true} and get the paid
  // report for free.
  fullReport = await resolveFullReportAccess(req, body);

  const sanitizedAuth = sanitizeAuth(body.auth);
  if (sanitizedAuth && "error" in sanitizedAuth) {
    return NextResponse.json({ error: sanitizedAuth.error }, { status: 400 });
  }

  const validated = await resolveAndValidateUrl(url || "");
  if (!validated.ok) {
    return NextResponse.json(
      {
        error:
          "Please paste a valid public website URL (e.g. https://yoursite.com). " +
          "Localhost and internal addresses are blocked.",
      },
      { status: 400 }
    );
  }
  const parsed = validated.url;

  const targetUrl = `${parsed.protocol}//${parsed.host}`;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require("path") as typeof import("path");

  // turbopackIgnore: the CLI engine eventually loads src/core/registry.js
  // which does dynamic require()s of every module file. Turbopack tries
  // to enumerate all possible targets at build time and crashes.
  //
  // Resolved via engine-entry-resolver.js, NOT a hardcoded relative path —
  // a relative require here resolves against the BUNDLED chunk's location,
  // not this source file's, so a fixed `../../../../../src/index.js`
  // 404s everywhere (confirmed live 2026-07-01: gatetest.ai/api/web/scan
  // 500'd on every request). outputFileTracingIncludes in next.config.ts
  // is what makes src/** actually present in the deployed bundle
  // (turbopackIgnore hides this require from the automatic tracer).
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

  const workspace = fs.mkdtempSync(pathMod.join(os.tmpdir(), "web-scan-"));
  const startTime = Date.now();
  const previousExitCode = process.exitCode;
  // Stable per-scan id used to link the static probe results with the
  // runtime payload that the platform worker (Tallrig) will POST back to us.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cryptoMod = require("crypto") as typeof import("crypto");
  const scanId = `scn_${cryptoMod.randomBytes(9).toString("hex")}`;

  // Start the live HTTP header probe concurrently with the static suite scan.
  // probeUrl() makes a real GET to the target URL and inspects the actual
  // response headers — HSTS, CSP, cookie flags, info-disclosure, CORS misconfig.
  // This catches what static config-file analysis (webHeaders module) cannot:
  // the gap between what the config says and what the server actually returns.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let liveProbePromise: Promise<Array<{ module: string; severity: string; rule: string; message: string }>> = Promise.resolve([]);
  // Whether url-prober actually got a response (regardless of whether it
  // found anything) — url-prober already covers webHeaders/cookieSecurity/
  // tlsSecurity live checks for THIS route (module tags in
  // src/core/reliability/url-prober.js), so those three must not also be
  // reported `notChecked` in the coverage summary below just because zero
  // findings came back from it.
  let liveProbeOk = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const urlProber = require("@/app/lib/reliability/url-prober") as {
      probeUrl: (args: { url: string; timeoutMs?: number; authHeaders?: Record<string, string> }) => Promise<{
        findings: Array<{ module: string; severity: string; rule: string; message: string; file: string }>;
        durationMs: number;
        status: number | null;
        error?: string;
      }>;
    };
    // Authed scans: the probe carries the session too (same-origin only —
    // url-prober drops these headers the moment a redirect leaves the
    // target's origin).
    const probeAuthHeaders = sanitizedAuth
      ? { ...(sanitizedAuth.headers || {}), ...(sanitizedAuth.cookie ? { Cookie: sanitizedAuth.cookie } : {}) }
      : undefined;
    liveProbePromise = urlProber.probeUrl({
      url: targetUrl,
      timeoutMs: 12_000,
      ...(probeAuthHeaders && Object.keys(probeAuthHeaders).length > 0 ? { authHeaders: probeAuthHeaders } : {}),
    })
      .then((r) => {
        liveProbeOk = typeof r.status === "number" && !r.error;
        return r.findings;
      })
      .catch(() => []);
  } catch {
    // error-ok — url-prober unavailable — continue with static-only scan
  }

  let summary: { results?: Array<{ module?: string; name?: string; checks?: Array<{ name: string; severity?: string; passed: boolean; message?: string }>; errors?: number; warnings?: number; info?: number; duration?: number; skipped?: string }>; gateStatus?: string; totalErrors?: number; totalWarnings?: number };

  // ONE shared fetch (issue #643): webHeaders, seo, accessibility and
  // cookieSecurity read this via config.livePage instead of each re-fetching
  // the page, and report themselves not-checked when it's absent rather
  // than fabricating a pass. A failed fetch here is not fatal.
  let livePage: { url: string; status: number; headers: Headers; html: string } | null = null;
  try {
    const pageController = new AbortController();
    const pageTimer = setTimeout(() => pageController.abort(), 15000);
    const pageRes = await fetch(targetUrl, {
      signal: pageController.signal,
      redirect: "follow",
      headers: { "User-Agent": "GateTest/1.0 Web Scanner (gatetest.io)" },
    });
    clearTimeout(pageTimer);
    const html = await pageRes.text().catch(() => "");
    livePage = { url: pageRes.url || targetUrl, status: pageRes.status, headers: pageRes.headers, html };
  } catch { /* error-ok — livePage stays null; affected modules report not-checked with a reason */ }

  try {
    const gt = new GateTest(workspace, { silent: true });
    gt.init();
    // GateTestConfig.set is a real dot-path setter as of 2026-07-25 — before
    // that this whole block silently no-op'd (neither `.set` nor `.data`
    // existed) and the suite ran without a targetUrl. See config.js set().
    if (gt.config && typeof (gt.config as { set?: (k: string, v: unknown) => void }).set === "function") {
      const cfg = gt.config as { set: (k: string, v: unknown) => void };
      cfg.set("targetUrl", targetUrl);
      cfg.set("webUrl", targetUrl);
      if (sanitizedAuth) {
        // Same-origin gating happens engine-side (live-crawler-auth.js):
        // these values only ever reach the scan target's own origin.
        if (sanitizedAuth.headers) cfg.set("modules.liveCrawler.headers", sanitizedAuth.headers);
        if (sanitizedAuth.cookie) cfg.set("modules.liveCrawler.cookie", sanitizedAuth.cookie);
      }
    }
    // Direct property (not `.set()`, which nests under config.config) —
    // every module reads config.livePage directly.
    if (livePage && gt.config) (gt.config as Record<string, unknown>).livePage = livePage;
    summary = (await gt.init().runSuite("web")) as typeof summary;
  } catch (err) {
    process.exitCode = previousExitCode;
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

  // Await the concurrent live probe and fold its findings in with the static ones.
  const liveProbeFindings = await liveProbePromise;
  const allFindings: WebFinding[] = [];
  for (const r of summary.results || []) {
    if (!Array.isArray(r.checks)) continue;
    for (const c of r.checks) {
      if (c.passed === true) continue;
      const translated = translateFinding(c);
      if (translated) allFindings.push(translated);
    }
  }
  for (const pf of liveProbeFindings) {
    const translated = translateProbeFinding(pf);
    if (translated) allFindings.push(translated);
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { clusterAndRankUrlFindings } = require("@/app/lib/url-finding-clusterer") as {
    clusterAndRankUrlFindings: (
      findings: WebFinding[],
      opts?: { includeInfo?: boolean }
    ) => {
      clusters: Array<{ ruleKey: string; severity: 'error' | 'warning' | 'info'; title: string; body: string; module: string; count: number; instances: WebFinding[]; isHighSignal: boolean }>;
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
      score: number;
      grade: 'A' | 'B' | 'C' | 'D' | 'F';
      deductions: Array<unknown>;
      summary: string;
      coverage?: { totalModules: number; checkedModules: number; notCheckedModules: string[] };
    };
    deriveModuleCoverage: (results: typeof summary.results) => { totalModules: number; checkedModules: number; notChecked: Array<{ module: string; reason: string }> };
    deriveFreeCheckNames: (results: typeof summary.results, liveModules?: string[]) => Array<{ module: string; status: 'checked' | 'not-checked'; reason?: string; duration?: number; checks: Array<{ name: string; passed: boolean; severity: string }> }>;
    LIVE_URL_MODULES: string[];
  };

  const clusterResult = clusterAndRankUrlFindings(allFindings);
  // Six of the fourteen `web`-suite modules are file scanners with nothing
  // to read on a URL-only scan (issue #643) — they report `notChecked`
  // instead of a fabricated pass. url-prober (above) already covers
  // webHeaders/cookieSecurity/tlsSecurity live checks for this route
  // independently of those modules, so a module that reports itself
  // not-checked but WAS covered by url-prober must not double-count as
  // uncovered.
  const moduleCoverage = deriveModuleCoverage(summary.results || []);
  if (liveProbeOk) {
    const PROBE_COVERED = new Set(['webHeaders', 'cookieSecurity', 'tlsSecurity']);
    moduleCoverage.notChecked = moduleCoverage.notChecked.filter((n) => !PROBE_COVERED.has(n.module));
    moduleCoverage.checkedModules = Math.max(0, moduleCoverage.totalModules - moduleCoverage.notChecked.length);
  }
  const healthScore = computeHealthScore(clusterResult.clusters, moduleCoverage);
  // Issue #648 item 4: check NAMES for the four live-URL modules are free —
  // only the fix guidance (findings[].body) stays behind the paywall below.
  const moduleChecks = deriveFreeCheckNames(summary.results || [], LIVE_URL_MODULES);

  const PREVIEW_LIMIT = 3;
  const isPreview = !fullReport;
  const visibleClusters = isPreview ? clusterResult.clusters.slice(0, PREVIEW_LIMIT) : clusterResult.clusters;
  const findings = visibleClusters.map((c) => ({
    severity: c.severity,
    title: c.title,
    body: c.body,
    module: c.module,
    ruleKey: c.ruleKey,
    instanceCount: c.count,
    highSignal: c.isHighSignal,
  }));

  // The headless-browser runtime pass (live JS errors, hydration mismatches,
  // CSP violations, network failures) needs a long-running container with
  // Chromium — the platform worker's job. web-runtime-gate.js is the ONE
  // decision (shared with the stream routes): it dispatches only when token +
  // secret + base URL are all present, otherwise it says so with a reason code
  // and nothing leaves the box (KI #111 — fail closed, and say what did not run).
  // Static-probe results ship below either way.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { gateRuntimeScan } = require("@/app/lib/web-runtime-gate") as {
    gateRuntimeScan: (args: {
      scanId: string;
      targetUrl: string;
      suite: "web" | "wp";
      auth?: { headers?: Record<string, string>; cookie?: string };
    }) => Promise<{
      status: "queued" | "unavailable";
      reason: string | null;
      checked: false;
      jobId: string | null;
      pollUrl: string | null;
      timeoutSec?: number;
    }>;
  };
  const runtimeGate = await gateRuntimeScan({
    scanId,
    targetUrl,
    suite: "web",
    // Authed scans: forward the session so the headless-browser worker
    // reaches the same pages the crawl did. The platform scopes it same-origin
    // (its own live-crawler-auth). Rides the HMAC-signed body.
    ...(sanitizedAuth ? { auth: sanitizedAuth } : {}),
  });

  return NextResponse.json({
    scanId,
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
    // Say what was not checked wherever the result is read (Doctrine #6).
    totalModules: moduleCoverage.totalModules,
    checkedModules: moduleCoverage.checkedModules,
    notCheckedModules: moduleCoverage.notChecked.map((n) => n.module),
    // Issue #658 item 1: carry the module's own not-checked reason through
    // the persisted/returned scan record (and, since the share-link is this
    // same JSON re-encoded client-side, through the share payload too) —
    // before this fix only the bare module name survived past this route.
    notCheckedReasons: moduleCoverage.notChecked,
    // Free regardless of `preview` — check NAMES are not the paid part,
    // only the fix guidance in `findings[].body` is (item 4).
    moduleChecks,
    // Honesty flag: true when the caller supplied a session. It is carried
    // by the crawl, the live probe, AND (in the HMAC-signed dispatch body)
    // the runtime browser worker — so authenticated coverage is end-to-end.
    authenticatedScan: Boolean(sanitizedAuth),
    // { status, reason, checked, jobId, pollUrl, timeoutSec } — see web-runtime-gate.js.
    // The session-forwarded note is only true when a job was actually queued.
    runtime: {
      ...runtimeGate,
      note: sanitizedAuth && runtimeGate.status === "queued"
        ? "Your session was forwarded to the runtime browser worker — authenticated coverage applies to the crawl, live probe, and runtime checks."
        : null,
    },
    paywall: isPreview
      ? {
          remainingCount: Math.max(0, clusterResult.clusters.length - findings.length),
          fullReportPriceUsd: 29,
          fullReportCadence: "one-shot",
          ctaUrl: "/checkout?tier=web_scan",
        }
      : null,
  });
}

export async function GET() {
  return NextResponse.json(
    {
      hint: "POST a JSON body { url: 'https://yoursite.com' } or submit the /web landing form.",
    },
    { status: 405 }
  );
}
