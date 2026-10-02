import type { NextConfig } from "next";
import path from "node:path";
import { LEGACY_SITE_HOSTS } from "./app/lib/legacy-site-hosts.js";

// Treat the REPO root (one level above this file) as the build / tracing
// root so `@lib/*` aliases that point at `../lib/*` resolve correctly.
// Vercel does this implicitly via outputFileTracingRoot=/vercel/path0
// but GitHub Actions and local builds need it set explicitly here or
// Turbopack throws "Module not found: Can't resolve '@lib/*'" for every
// API route that uses the shared helpers.
const repoRoot = path.resolve(import.meta.dirname, "..");

// Routes that `require(/* turbopackIgnore: true */ ...)` the CLI engine at
// `../src/index.js` (web/scan, wp/scan, their /stream twins, and
// cli-engine-runner.js used by /api/scan/run). turbopackIgnore tells
// Turbopack to skip STATIC ANALYSIS of that require (needed — the CLI
// engine's registry.js does its own dynamic requires that would otherwise
// crash the build) but that same flag hides the dependency from Next's
// automatic file tracer, so `src/**` never made it into these routes'
// deployed serverless bundles. Confirmed live 2026-07-01: all 4 web/wp
// scan endpoints 500'd in production ("Cannot find module '../src/index.js'")
// and /api/scan/run silently fell back to the lighter runTier path on every
// paid Full/Scan+Fix/Forensic scan. This explicit include is the standard
// Next.js fix for a statically-invisible monorepo require.
const CLI_ENGINE_ROUTES = [
  "/api/web/scan/route",
  "/api/web/scan/stream/route",
  "/api/wp/scan/route",
  "/api/wp/scan/stream/route",
  "/api/scan/run/route",
];

// The one public origin (CLAUDE.md THE DOMAIN: never a domain literal in
// runtime code). `www.` is not a second site: the proxy in front of the box
// forwards both hosts to this process, so the redirect has to live here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DEFAULT_SITE_URL } = require("./app/lib/site-url.js") as { DEFAULT_SITE_URL: string };

const siteOrigin = new URL(process.env.NEXT_PUBLIC_BASE_URL || DEFAULT_SITE_URL);

// URLs people guess that never existed here. Each target was checked live
// (200) on 2026-09-14 before the redirect was written; /support and /contact
// land on the FAQ's "Still have questions? support@…" line because there is
// no dedicated support page — a redirect to a 404 is worse than the 404.
const GUESSED_URLS: Array<{ source: string; destination: string; permanent: boolean }> = [
  { source: "/support", destination: "/#faq", permanent: false },
  { source: "/contact", destination: "/#faq", permanent: false },
  { source: "/terms", destination: "/legal/terms", permanent: true },
  { source: "/privacy", destination: "/legal/privacy", permanent: true },
  // /account never existed; the weekly-digest email's unsubscribe link
  // (website/app/lib/weekly-digest.js) points at /account/notifications and
  // already-sent mails carry it. Subscriptions are managed on /billing.
  { source: "/account", destination: "/dashboard", permanent: false },
  { source: "/account/notifications", destination: "/billing", permanent: false },
];

// Sign-in with GitHub IS sign-up (#810), so the URLs a prospect types to
// register all go to /login. `statusCode: 301`, not `permanent: true`, because
// Next sends `permanent: true` as 308 and the ask was a 301.
const SIGNUP_URLS = ["/register", "/signup", "/sign-up"].map((source) => ({
  source,
  destination: "/login",
  statusCode: 301,
}));

// Redirect-only routes live here, not in a page.tsx that calls redirect().
// A statically prerendered page that redirects is served as its 307 PLUS the
// rendered Next.js error shell (`<html id="__next_error__">`, 16,518 bytes for
// /docs — #812), which crawlers and monitors read as an error page. A config
// redirect is the same 307 with an empty body. Same targets as the pages they
// replaced: /docs has no index of its own (live-site audit 2026-09-10), /scan
// was a primary CTA target with no page, and the Hall of Scans was retired
// 2026-09-10 (current numbers live on /precision).
const REDIRECT_ONLY_ROUTES: Array<{ source: string; destination: string; permanent: boolean }> = [
  { source: "/docs", destination: "/developers", permanent: false },
  { source: "/scan", destination: "/playground", permanent: false },
  { source: "/scans", destination: "/precision", permanent: false },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // `.next/standalone` is what the Dockerfile ships. It is opt-in because
  // `next start` — how the systemd unit on the box runs the site — refuses
  // to serve a standalone build; the Dockerfile sets the flag, the box does
  // not. (Declared in website/.env.example like every other env read.)
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: Object.fromEntries(
    CLI_ENGINE_ROUTES.map((route) => [route, ["../src/**"]])
  ),
  turbopack: {
    root: repoRoot,
  },
  serverExternalPackages: ["ssh2"],
  async redirects() {
    return [
      {
        // www → apex, 301, path and query preserved.
        source: "/:path*",
        has: [{ type: "host", value: `www.${siteOrigin.host}` }],
        destination: `${siteOrigin.origin}/:path*`,
        permanent: true,
      },
      // Former domains (lib/legacy-site-hosts.js), apex and www →
      // the canonical origin, permanent, path and query preserved — the
      // badge URLs in customers' READMEs keep rendering. 308 keeps the
      // method, so an old API client's POST is not turned into a GET.
      ...LEGACY_SITE_HOSTS.flatMap((host) => [host, `www.${host}`]).map((host) => ({
        source: "/:path*",
        has: [{ type: "host" as const, value: host }],
        destination: `${siteOrigin.origin}/:path*`,
        permanent: true,
      })),
      // /preview reviewed the v2 homepage in isolation before launch
      // (issue #636); the owner approved it 2026-09-23 and it is now
      // promoted to / (issue #686 phase 3, website/app/page.tsx). Kept as a
      // permanent redirect rather than deleted outright — the link was
      // shared and bookmarked during the review period.
      { source: "/preview", destination: "/", permanent: true },
      // /regulation/soc2 sold a SOC 2 readiness angle GateTest does not
      // provide: a SOC 2 compliance scan is a separate future product, not
      // built or sold (Craig, 2026-10-01). The page was indexed, so it
      // redirects permanently to the regulation index instead of 404ing.
      { source: "/regulation/soc2", destination: "/regulation", permanent: true },
      ...GUESSED_URLS,
      ...SIGNUP_URLS,
      ...REDIRECT_ONLY_ROUTES,
    ];
  },
  async rewrites() {
    return [
      // /health and /healthz are the orchestrator-convention paths a load
      // balancer or uptime checker tries by default; the real liveness
      // route is /api/health (P2, outside reviewer 2026-09-26 — both 404'd
      // as HTML before this). A rewrite keeps the URL in the address bar
      // (unlike a redirect) and answers with the same JSON `/api/health`
      // already serves, in one request.
      { source: "/health", destination: "/api/health" },
      { source: "/healthz", destination: "/api/health" },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          // Content-Security-Policy is NOT set here (GT-10, outside reviewer
          // 2026-09-26): it needs a fresh nonce every request, which a
          // static `headers()` config can't generate. `website/proxy.ts`
          // sets it per request from the one CSP definition in
          // `app/lib/csp.js`; `tests/website-csp-nonce.test.js` is the
          // control pair proving script-src never regains 'unsafe-eval' /
          // 'unsafe-inline' in production.
          { key: "X-DNS-Prefetch-Control", value: "on" },
        ],
      },
    ];
  },
};

export default nextConfig;
