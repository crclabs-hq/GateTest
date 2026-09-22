export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  title: string;
  body: string;
  module: string;
  ruleKey: string;
  instanceCount?: number;
  highSignal?: boolean;
}

export interface HealthScore {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  summary: string;
}

export interface RuntimeBlock {
  status: "queued" | "completed" | "failed" | "unavailable";
  jobId?: string | null;
  /**
   * Reason code from web-runtime-gate.js when status is "unavailable":
   * "not-configured" | "dispatch-failed:<http status|network|timeout>" |
   * "callback-timeout". Mapped to plain English in RuntimeUnavailable.
   */
  reason?: string | null;
  /** True only once a signed runtime callback has landed. Queued is a promise, not a result. */
  checked?: boolean;
  pollUrl?: string | null;
  /** Seconds after which a queued job with no callback is reported as callback-timeout. */
  timeoutSec?: number;
  payload?: {
    status?: string;
    durationMs?: number;
    findings?: Array<{ name: string; severity: Severity; passed: boolean; message: string }>;
    error?: string;
  };
}

/**
 * Issue #648 item 4 — free-safe per-module check breakdown for the four
 * live-URL modules (webHeaders/seo/accessibility/cookieSecurity). Check
 * NAMES and pass/fail state are free; fix guidance (`Finding.body`) stays
 * behind the existing paywall boundary on `ScanResult.findings`. Built by
 * `deriveFreeCheckNames()` in website/app/lib/health-score.js — the one
 * definition both /api/web/scan and /api/web/scan/stream import.
 */
export interface ModuleCheckSummary {
  module: string;
  status: "checked" | "not-checked";
  /** Only present when status is "not-checked" — the module's own
   *  `_notChecked()` message, never web-runtime-gate.js's reason text. */
  reason?: string;
  duration?: number;
  checks: Array<{ name: string; passed: boolean; severity: Severity }>;
}

export interface ScanResult {
  scanId?: string;
  targetUrl: string;
  scannedAt: string;
  duration: number;
  healthScore: HealthScore;
  totalFindings: number;
  totalClusters: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  preview: boolean;
  findings: Finding[];
  runtime?: RuntimeBlock | null;
  /** Modules the suite defines for this scan (issue #643 — six of the web
   *  suite's modules are file scanners with nothing to read on a URL-only
   *  scan; they report themselves not-checked rather than a fabricated
   *  pass). Optional so an older cached/shared result still renders. */
  totalModules?: number;
  /** `totalModules` minus `notCheckedModules.length` — what the Health
   *  Score above was actually computed over. */
  checkedModules?: number;
  /** Module names that reported themselves not-checked on this scan. */
  notCheckedModules?: string[];
  /** Issue #658 item 1 — the module's own not-checked reason (the exact
   *  text the live stream showed via `ModuleProgress.reason`), carried
   *  through the completed report and the share-link payload. Optional so
   *  an older cached/shared result (pre-fix) still renders — falls back to
   *  the bare names in `notCheckedModules` above. */
  notCheckedReasons?: Array<{ module: string; reason: string }>;
  /** Free check-name breakdown for the four live-URL modules (item 4).
   *  Optional so an older cached/shared result still renders. */
  moduleChecks?: ModuleCheckSummary[];
  /** Present only on a result restored from a `?s=` permalink (item 3) —
   *  the client-side share encoding's own embedded timestamp, read by
   *  `decodeShareData()` to expire a link after 48h. Never sent by the
   *  server. */
  sharedAt?: number;
  paywall: {
    remainingCount: number;
    fullReportPriceUsd: number;
    fullReportCadence: string;
    ctaUrl: string;
  } | null;
}

export interface UrlScanFlowProps {
  suite: "web" | "wp";
  endpoint: string;
  streamEndpoint?: string;
  recommendEndpoint?: string;
  placeholderUrl?: string;
  brandLabel?: string;
  /** Pre-populates the input. Use with a changing `key` prop to remount
   *  on sample-URL clicks so React re-syncs the controlled value. */
  initialUrl?: string;
}

export interface Recommendation {
  detected: {
    cms?: string | null;
    framework?: string | null;
    cdn?: string | null;
    server?: string | null;
    language?: string | null;
    hints?: string[];
  } | null;
  recommendation: {
    suite: "web" | "wp";
    tier: "quick" | "full" | "scan_fix" | "nuclear";
    emphasis: string[];
    reasoning: string[];
    ctaUrl: string;
    suiteDescription: string;
    tierDescription: string;
    priceUsd: number;
  };
}

export interface ModuleProgress {
  name: string;
  /** "not-checked" — issue #648 item 1: a module whose own `_notChecked`
   *  check fired must render distinctly from "done" (clean/found), never
   *  as a clean tick. */
  state: "queued" | "running" | "done" | "skipped" | "not-checked";
  errors?: number;
  warnings?: number;
  duration?: number;
  /** Only present when state is "not-checked" — the module's own reason,
   *  never web-runtime-gate.js's runtime-dispatch reason (item 2). */
  reason?: string;
}

export const MODULE_TICKER: Record<"web" | "wp", string[]> = {
  web: [
    "Checking HTTPS / TLS certificate",
    "Reading security headers (CSP, HSTS, X-Frame-Options)",
    "Inspecting cookies for Secure / HttpOnly flags",
    "Crawling links for broken pages",
    "Measuring page performance",
    "Auditing accessibility",
    "Sweeping for SEO issues",
    "Queueing live-browser runtime check",
  ],
  wp: [
    "Probing for exposed sensitive files",
    "Looking up WordPress version disclosure",
    "Testing XML-RPC endpoint",
    "Checking plugin CVE database",
    "Scanning for malware patterns",
    "Testing user enumeration",
    "Auditing admin endpoint protection",
    "Checking PHP version end-of-life",
    "Reading security headers (CSP, HSTS, X-Frame-Options)",
    "Inspecting cookies for Secure / HttpOnly flags",
    "Auditing accessibility",
    "Sweeping for SEO issues",
    "Queueing live-browser runtime check",
  ],
};

export const GRADE_COLORS: Record<"A" | "B" | "C" | "D" | "F", { bar: string; text: string; bg: string; ring: string }> = {
  A: { bar: "bg-emerald-500", text: "text-emerald-600", bg: "bg-emerald-50", ring: "ring-emerald-300" },
  B: { bar: "bg-lime-500", text: "text-lime-700", bg: "bg-lime-50", ring: "ring-lime-300" },
  C: { bar: "bg-amber-500", text: "text-amber-700", bg: "bg-amber-50", ring: "ring-amber-300" },
  D: { bar: "bg-orange-500", text: "text-orange-700", bg: "bg-orange-50", ring: "ring-orange-300" },
  F: { bar: "bg-rose-500", text: "text-rose-700", bg: "bg-rose-50", ring: "ring-rose-300" },
};

export const SEVERITY_STYLES: Record<Severity, { badge: string; text: string; dot: string; label: string }> = {
  error: {
    badge: "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200",
    text: "text-rose-700",
    dot: "bg-rose-500",
    label: "Error",
  },
  warning: {
    badge: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200",
    text: "text-amber-700",
    dot: "bg-amber-500",
    label: "Warning",
  },
  info: {
    badge: "bg-slate-50 text-slate-600 ring-1 ring-inset ring-slate-200",
    text: "text-slate-600",
    dot: "bg-slate-400",
    label: "Info",
  },
};
