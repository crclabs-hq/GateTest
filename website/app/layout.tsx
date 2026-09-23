import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque } from "next/font/google";
import "./globals.css";
import { ChatWidget } from "./components/ChatWidget";
import { SiteHeader, SiteFooter } from "./components/SiteChrome";
import { organizationSchema, webSiteSchema, jsonLd } from "./lib/seo/schema";
import { SITE_URL } from "./lib/site-url";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import { THEME_INIT_SCRIPT } from "./components/ThemeToggle";

// Editorial display face for headlines — gives the marketing surfaces a
// distinctive, premium voice without restyling body copy. Exposed as a CSS
// variable so only elements that opt in (.font-display) use it.
const displayFont = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0f766e",
};

export const metadata: Metadata = {
  // Every relative `canonical` and `openGraph.url` in the app resolves
  // against this. Page-level metadata must use relative paths ("/compare/snyk")
  // so a domain move stays a one-variable change.
  metadataBase: new URL(SITE_URL),
  title: "GateTest — CI quality gate for AI-written code",
  description:
    `${TOTAL_MODULES} deterministic checks in one CI gate. Fails on the diff, not the backlog. Precision published on pinned third-party repos. Optional fix PR with a regression test. Pay per run.`,
  keywords: [
    "QA",
    "testing",
    "quality assurance",
    "AI testing",
    "security scanning",
    "accessibility",
    "performance",
    "visual regression",
    "CI/CD",
    "code quality",
    "mutation testing",
    "auto-fix",
    "code review",
    "SonarQube alternative",
    "Snyk alternative",
    "GitHub code scanning",
    "static analysis",
    "OWASP",
    "WCAG",
    "SEO audit",
  ],
  openGraph: {
    title: "GateTest — CI quality gate for AI-written code",
    description:
      `${TOTAL_MODULES} modules scan your entire codebase. We find the bugs AND fix them. Pay per scan — subscriptions optional.`,
    url: "/",
    siteName: "GateTest",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "GateTest — CI quality gate for AI-written code",
    description:
      `${TOTAL_MODULES} modules scan your entire codebase. We find the bugs AND fix them. Pay per scan — subscriptions optional.`,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/icon-180.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full antialiased ${displayFont.variable}`}>
      <head>
        {/* Theme system (issue #690): read the stored light/dark choice and
            stamp data-theme on <html> before first paint. Must be the first
            thing in <head> and a plain synchronous script (not next/script,
            which defers) — otherwise a stored explicit theme flashes the
            other one for a frame. "system" needs no JS: globals.css's
            prefers-color-scheme media query handles it on its own. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <link rel="manifest" href="/manifest.json" />
      </head>
      <body className="min-h-full flex flex-col">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              name: "GateTest",
              applicationCategory: "DeveloperApplication",
              operatingSystem: "Any",
              url: SITE_URL,
              description:
                `AI-powered QA platform that scans your entire codebase with ${TOTAL_MODULES} modules — security, supply chain, auth flaws, CI hardening, and more. Pay per scan via Stripe — one-time scan tiers, with optional Continuous and hosted MCP subscriptions.`,
              offers: [
                {
                  "@type": "Offer",
                  name: "Quick Scan",
                  price: "29.00",
                  priceCurrency: "USD",
                  description: "4 modules: syntax, lint, secrets, code quality",
                },
                {
                  "@type": "Offer",
                  name: "Full Scan",
                  price: "99.00",
                  priceCurrency: "USD",
                  description:
                    `Every applicable module of the ${TOTAL_MODULES}-module engine, including AI code review, security, supply chain, auth flaws, and more`,
                },
                {
                  "@type": "Offer",
                  name: "Scan + Fix",
                  price: "199.00",
                  priceCurrency: "USD",
                  description:
                    `Every applicable module of the ${TOTAL_MODULES}-module engine plus an AI auto-fix pull request with regression tests, pair-review, and architecture annotations`,
                },
                {
                  "@type": "Offer",
                  name: "Forensic Scan",
                  price: "399.00",
                  priceCurrency: "USD",
                  description:
                    "Deep scan with per-finding AI diagnosis, cross-finding attack-chain correlation, auto-fix PR, pair-review, and an executive summary report",
                },
              ],
            }),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLd(organizationSchema()) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLd(webSiteSchema()) }}
        />
        {/* One header and one footer for the whole site — pages never render
            their own (tests/site-shell.test.js). */}
        <SiteHeader />
        {/* min-w-0 matters here: this div is a flex item of an implicit
            column flex context, and a flex item's default min-width is
            "auto" — its content's min-content size — not 0. A page with any
            wide-but-unbreakable content deep inside (a 4-column table, a
            long unbroken token) can silently force this whole column wider
            than the viewport at 375px even though the page's own overflow-x
            guards are correct, because those guards only stop this element
            from growing past ITS OWN min-content, not past the viewport.
            min-w-0 makes it respect the actual available width instead. */}
        <div className="flex-1 flex flex-col min-w-0">{children}</div>
        <SiteFooter />
        <ChatWidget />
      </body>
    </html>
  );
}
