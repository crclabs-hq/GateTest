import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ChatWidget } from "./components/ChatWidget";
import { organizationSchema, webSiteSchema, jsonLd } from "./lib/seo/schema";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0f766e",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://gatetest.ai"),
  title: "GateTest — AI writes fast. GateTest keeps it honest.",
  description:
    "110 modules scan your entire codebase. Security, accessibility, performance, and more. We find the bugs AND fix them. Pay per scan, no subscription.",
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
  alternates: {
    canonical: "https://gatetest.ai",
  },
  openGraph: {
    title: "GateTest — AI writes fast. GateTest keeps it honest.",
    description:
      "110 modules scan your entire codebase. We find the bugs AND fix them. Pay per scan, no subscription.",
    url: "https://gatetest.ai",
    siteName: "GateTest",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "GateTest — AI writes fast. GateTest keeps it honest.",
    description:
      "110 modules scan your entire codebase. We find the bugs AND fix them. Pay per scan, no subscription.",
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
    <html lang="en" className="h-full antialiased">
      <head>
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
              url: "https://gatetest.ai",
              description:
                "AI-powered QA platform that scans your entire codebase with 110 modules — security, supply chain, auth flaws, CI hardening, and more. Pay per scan via Stripe. One-time payment, no subscription.",
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
                    "All 110 modules including AI code review, security, supply chain, auth flaws, and more",
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
        {/* Sitewide beta banner — sits ABOVE the navbar so it's the first
            thing any visitor sees. Sets the expectation explicitly: this
            is pre-launch, rough edges are real, your bug reports help us.
            Removed at GA. */}
        <div
          role="status"
          className="bg-amber-500/95 text-black text-center text-xs sm:text-sm font-medium px-4 py-2 border-b border-amber-600"
        >
          <strong>BETA</strong> · GateTest is in active polish ahead of public
          launch. Some flows are rough. Found a bug?{" "}
          <a
            href="mailto:hello@gatetest.ai"
            className="underline-offset-2 underline hover:no-underline"
          >
            hello@gatetest.ai
          </a>
          {" "}— we&apos;re reading every message.
        </div>
        {children}
        <ChatWidget />
      </body>
    </html>
  );
}
