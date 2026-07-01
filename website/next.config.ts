import type { NextConfig } from "next";
import path from "node:path";

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

const nextConfig: NextConfig = {
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: Object.fromEntries(
    CLI_ENGINE_ROUTES.map((route) => [route, ["../src/**"]])
  ),
  turbopack: {
    root: repoRoot,
  },
  serverExternalPackages: ["ssh2"],
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
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com", // web-headers-ok — unsafe-eval required by Stripe.js (https://stripe.com/docs/security/guide#content-security-policy)
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https: blob:",
              "font-src 'self' data:",
              "connect-src 'self' https://api.stripe.com https://api.anthropic.com https://api.github.com https://github.com",
              "frame-src https://js.stripe.com https://hooks.stripe.com",
              "frame-ancestors 'self'",
              "form-action 'self' https://checkout.stripe.com",
              "base-uri 'self'",
              "object-src 'none'",
              "upgrade-insecure-requests",
            ].join("; "),
          },
          { key: "X-DNS-Prefetch-Control", value: "on" },
        ],
      },
    ];
  },
};

export default nextConfig;
