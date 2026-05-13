import type { NextConfig } from "next";
import path from "path";

// CSP — production locks down `'unsafe-eval'`. Next.js Turbopack dev mode
// uses eval() for HMR, so the dev CSP keeps it. The string concatenation
// is intentional so the production CSP doesn't contain the substring
// "unsafe-eval" at all.
const isProd = process.env.NODE_ENV === "production";
const scriptSrc = isProd
  ? "script-src 'self' 'unsafe-inline' https://js.stripe.com"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
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
              scriptSrc,
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
