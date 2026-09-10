// Generic web URL scan landing — lives at /web. Twin of /wp but
// for any public site (not just WordPress).
//
// Voice: plain English for non-technical site owners + technical voice
// where it differentiates (live browser checks, hydration mismatch
// detection, real CSP violation capture).

import Link from "next/link";
import { UrlScanFlow } from "@/app/components/UrlScanFlow";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import siteStats from "../data/site-stats.json";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";

export const metadata = {
  title: "GateTest — Live Website Health Check, Security + Runtime Audit",
  description:
    "Paste any URL. We run live HTTPS + header + cookie probes AND open the site in a real headless browser to catch JavaScript errors, broken assets, CSP violations and hydration mismatches in the actual page load. Plain-English report with a 0-100 health score.",
};

export default function WebLanding() {
  return (
    <main>
      <PageHero
        align="center"
        eyebrow="For any website"
        title={<>What&apos;s actually wrong<br /><span className="text-accent">with your website?</span></>}
        lede={<>
          Most scanners only check what your server <em>says</em> it does.
          We open your site in a real browser and watch what actually
          happens. JavaScript errors. Broken hydration. CSP violations.
          Mixed-content. Network failures. Plus all the usual hardening
          checks. One 0-100 score. Plain-English fixes.
        </>}
        actions={
          <UrlScanFlow
            suite="web"
            endpoint="/api/web/scan"
            streamEndpoint="/api/web/scan/stream"
            recommendEndpoint="/api/scan/recommend"
          />
        }
      />

      <Section
        title="What we look for"
        lede={<>We don&apos;t just check what your server <em>claims</em>. We open your site in a real Chromium and watch what actually breaks.</>}
      >
        <div className="grid sm:grid-cols-2 gap-6">
          {PAINKILLERS.map(({ title, pain, what }) => (
            <div key={title} className="card p-6">
              <h3 className="font-display font-bold text-lg mb-2 text-foreground">{title}</h3>
              <p className="text-sm text-danger mb-3">
                <span className="font-semibold">Why it matters: </span>
                {pain}
              </p>
              <p className="text-sm text-muted">
                <span className="font-semibold text-foreground">What we check: </span>
                {what}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <Section alt narrow title="Cluster-first, noise-last">
        <p className="text-base sm:text-lg text-foreground-secondary leading-relaxed">
          A typical site scan returns 800-1000 raw findings — mostly the
          same root cause repeated across pages. We collapse them into
          ~20 root-cause clusters ranked highest-signal first, score the
          site 0-100, and tell you the three things that move the needle
          most. The other 977 findings are the same fix repeated — you
          shouldn&apos;t pay (in attention or money) for noise.
        </p>
      </Section>

      <Section title="Honest pricing" lede="Pay per scan. No subscription required for the one-shot.">
        <div className="grid sm:grid-cols-2 gap-6 max-w-3xl">
          {TIERS.map((tier) => (
            <div key={tier.name} className={`p-6 ${tier.highlighted ? "card-highlight" : "card"}`}>
              <h3 className="font-display font-bold text-xl mb-1 text-foreground">{tier.name}</h3>
              <div className="flex items-baseline gap-1 mb-1">
                <span className="font-display text-3xl font-bold text-foreground">{tier.price}</span>
                <span className="text-sm text-muted">/ {tier.cadence}</span>
              </div>
              <ul className="space-y-2 text-sm mt-4 text-foreground-secondary">
                {tier.includes.map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <span className="text-accent" aria-hidden>✓</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section alt narrow>
        <div className="text-center">
          <h2 className="font-display text-3xl font-bold text-foreground mb-6">Ready when you are.</h2>
          <Link href="#top" className="btn-cta inline-block px-8 py-4 text-lg font-semibold rounded-xl">
            Scan my site
          </Link>
          <p className="text-xs text-muted mt-6">
            Same engine as the developer <Link href="/" className="text-accent hover:underline">GateTest</Link> CLI —
            this scan runs its {siteStats.suites.web}-module live-site suite (header, TLS and cookie probes plus
            headless-browser runtime capture) out of the {TOTAL_MODULES}-module engine. WordPress
            owner? <Link href="/wp" className="text-accent hover:underline">WordPress-specific scan here</Link>.
          </p>
        </div>
      </Section>
    </main>
  );
}

const PAINKILLERS = [
  {
    title: "Live JavaScript errors",
    pain: "Your visitors see a half-loaded page. Search and forms silently break. Static probes can't see this — only a real browser can.",
    what: "Uncaught page errors, unhandled promise rejections, console.error spam during initial load.",
  },
  {
    title: "Hydration mismatches",
    pain: "React/Next.js/Vue/Nuxt sites can render server HTML that doesn't match the client tree. Users see flicker or a blank UI for seconds before interactivity arrives.",
    what: "Console output captured by a real Chromium for hydration / SSR-mismatch / minified React error markers.",
  },
  {
    title: "Broken or blocked network resources",
    pain: "A 404 on a critical script kills features silently. A blocked CDN call breaks search or checkout. Real users feel it; uptime monitors don't.",
    what: "Every script, image, font, stylesheet, and fetch() call that fires during page load — fail status or DNS / refused / timeout reasons.",
  },
  {
    title: "Content Security Policy violations",
    pain: "A live browser blocked your own scripts or third-party assets. Either your CSP is too strict for your own code, or an analytics provider is breaking.",
    what: "Every CSP report-uri-style violation reported during the page session.",
  },
  {
    title: "Mixed content (HTTPS+HTTP)",
    pain: "Modern browsers refuse to load HTTP assets from an HTTPS page. Images vanish, scripts fail, the lock icon disappears.",
    what: "Every HTTP asset URL embedded in your HTTPS page.",
  },
  {
    title: "Security headers missing",
    pain: "Modern browsers stop XSS, clickjacking, and cookie theft — but only if your site asks them to. Most don't.",
    what: "CSP, X-Frame-Options, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy.",
  },
  {
    title: "HTTPS / TLS misconfiguration",
    pain: "Wrong cert, expired cert, weak protocol — browsers show a warning page and visitors bounce immediately.",
    what: "Cert chain validity, modern TLS support, mixed-content surface, HSTS preload eligibility.",
  },
  {
    title: "Cookie hardening missing",
    pain: "Session cookies without Secure / HttpOnly / SameSite are a session-takeover vector for any XSS or CSRF that lands.",
    what: "Every Set-Cookie header captured during the scan — flagged for missing protections.",
  },
];

const TIERS = [
  {
    name: "Free Preview",
    price: "$0",
    cadence: "no signup",
    includes: [
      "Top 3 highest-signal issues",
      "Health Score (0-100) + letter grade",
      "Plain-English summary",
      "Best for: deciding whether to dig deeper",
    ],
  },
  {
    name: "Full Report",
    price: "$29",
    cadence: "one-shot",
    highlighted: true,
    includes: [
      "Every clustered issue on your site",
      "Per-cluster fix instructions",
      "Live browser runtime capture",
      "Health Score + per-rule deductions",
      "Best for: post-deploy, post-redesign, quarterly audits",
    ],
  },
];
