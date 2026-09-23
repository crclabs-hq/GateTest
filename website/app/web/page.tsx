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
import { Hero, Section, Card } from "../components/v2";

export const metadata = {
  title: "GateTest — Live Website Health Check, Security + Runtime Audit",
  description:
    "Paste any URL. We run live HTTPS, security-header, TLS, cookie, accessibility, SEO, broken-link and page-weight probes against your site. Plain-English report with a 0-100 health score. The real-browser runtime pass (JavaScript errors, hydration mismatches, CSP violations) is rolling out and is reported separately when it runs.",
};

export default function WebLanding() {
  return (
    <main>
      <Section wrap={false}>
        <div className="v2-wrap">
          <Hero
            align="center"
            kicker="For any website"
            title={<>What&apos;s actually wrong with your website?</>}
            lede={<>
              Most scanners only check what your server <em>says</em> it does.
              We probe your live site — security headers, TLS, cookies,
              accessibility, SEO, broken links, page weight — and tell you what
              is actually wrong. One 0-100 score. Plain-English fixes. The
              real-browser pass (JavaScript errors, broken hydration, CSP
              violations) is rolling out: when it can&apos;t run, the report says
              so instead of pretending.
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
        </div>
      </Section>

      <Section>
        <div className="v2-kicker mb-3">what we look for</div>
        <h2 className="v2-h2 max-w-2xl mb-10">
          We don&apos;t just check what your server <em>claims</em>. Live probes run against your site on every scan; the real-Chromium checks below are marked while that pass is still rolling out.
        </h2>
        <div className="grid sm:grid-cols-2 gap-6">
          {PAINKILLERS.map(({ title, pain, what, browserPass }) => (
            <Card key={title}>
              <h3 className="font-semibold text-lg mb-2 text-[var(--v2-fg)]">
                {title}
                {browserPass && (
                  <span className="ml-2 align-middle inline-block v2-kicker rounded-full border border-[var(--v2-warn)]/40 px-2 py-0.5 !text-[11px] font-semibold text-[var(--v2-warn)]">
                    browser pass · rolling out
                  </span>
                )}
              </h3>
              <p className="text-sm text-[var(--v2-bad)] mb-3">
                <span className="font-semibold">Why it matters: </span>
                {pain}
              </p>
              <p className="text-sm text-[var(--v2-muted)]">
                <span className="font-semibold text-[var(--v2-fg)]">What we check: </span>
                {what}
              </p>
            </Card>
          ))}
        </div>
      </Section>

      <Section tight>
        <h2 className="v2-h2 mb-6">Cluster-first, noise-last</h2>
        <p className="text-base sm:text-lg text-[var(--v2-muted)] leading-relaxed max-w-3xl">
          A typical site scan returns 800-1000 raw findings — mostly the
          same root cause repeated across pages. We collapse them into
          ~20 root-cause clusters ranked highest-signal first, score the
          site 0-100, and tell you the three things that move the needle
          most. The other 977 findings are the same fix repeated — you
          shouldn&apos;t pay (in attention or money) for noise.
        </p>
      </Section>

      <Section>
        <div className="v2-kicker mb-3">pay per scan. no subscription required for the one-shot</div>
        <h2 className="v2-h2 mb-10">Honest pricing</h2>
        <div className="grid sm:grid-cols-2 gap-6 max-w-3xl">
          {TIERS.map((tier) => (
            <Card key={tier.name} className={tier.highlighted ? "!border-[var(--v2-accent)]" : ""}>
              <h3 className="font-semibold text-xl mb-1 text-[var(--v2-fg)]">{tier.name}</h3>
              <div className="flex items-baseline gap-1 mb-1">
                <span className="v2-mono text-3xl font-medium text-[var(--v2-fg)]">{tier.price}</span>
                <span className="text-sm text-[var(--v2-muted)]">/ {tier.cadence}</span>
              </div>
              <ul className="space-y-2 text-sm mt-4 text-[var(--v2-muted)]">
                {tier.includes.map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <span className="text-[var(--v2-accent)]" aria-hidden>✓</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </Section>

      <Section tight>
        <div className="text-center">
          <h2 className="v2-h2 mb-6">Ready when you are.</h2>
          <Link href="#top" className="v2-btn v2-btn-primary">Scan my site</Link>
          <p className="text-xs text-[var(--v2-muted)] mt-6">
            Same engine as the developer <Link href="/" className="text-[var(--v2-accent)] hover:underline">GateTest</Link> CLI —
            this scan runs its {siteStats.suites.web}-module live-site suite (header, TLS, cookie, accessibility,
            SEO and link probes; the headless-browser runtime pass is rolling out) out of the {TOTAL_MODULES}-module engine. WordPress
            owner? <Link href="/wp" className="text-[var(--v2-accent)] hover:underline">WordPress-specific scan here</Link>.
          </p>
        </div>
      </Section>
    </main>
  );
}

const PAINKILLERS: { title: string; pain: string; what: string; browserPass?: boolean }[] = [
  {
    title: "Live JavaScript errors",
    pain: "Your visitors see a half-loaded page. Search and forms silently break. Static probes can't see this — only a real browser can.",
    what: "Uncaught page errors, unhandled promise rejections, console.error spam during initial load.",
    browserPass: true,
  },
  {
    title: "Hydration mismatches",
    pain: "React/Next.js/Vue/Nuxt sites can render server HTML that doesn't match the client tree. Users see flicker or a blank UI for seconds before interactivity arrives.",
    what: "Console output captured by a real Chromium for hydration / SSR-mismatch / minified React error markers.",
    browserPass: true,
  },
  {
    title: "Broken or blocked network resources",
    pain: "A 404 on a critical script kills features silently. A blocked CDN call breaks search or checkout. Real users feel it; uptime monitors don't.",
    what: "Every script, image, font, stylesheet, and fetch() call that fires during page load — fail status or DNS / refused / timeout reasons.",
    browserPass: true,
  },
  {
    title: "Content Security Policy violations",
    pain: "A live browser blocked your own scripts or third-party assets. Either your CSP is too strict for your own code, or an analytics provider is breaking.",
    what: "Every CSP report-uri-style violation reported during the page session.",
    browserPass: true,
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
      "Browser runtime capture when the browser pass runs — the report tells you if it didn't",
      "Health Score + per-rule deductions",
      "Best for: post-deploy, post-redesign, quarterly audits",
    ],
  },
];
