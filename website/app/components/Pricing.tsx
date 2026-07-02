"use client";

/**
 * Pricing — dark, sharp, Vercel/Linear quality.
 * Authorised prices (per CLAUDE.md): Quick $29, Full $99, Scan+Fix $199, Forensic $399, Continuous $49/mo
 */

import Link from "next/link";

const TIERS = [
  {
    name: "Quick Scan",
    price: "$29",
    period: "one-time",
    description: "Catch obvious issues fast.",
    features: [
      "4 core modules",
      "Syntax, lint, secrets, code quality",
      "JSON + HTML report",
      "CLI & API access",
    ],
    cta: "Start quick scan",
    href: "/github/setup?tier=quick",
    highlight: false,
  },
  {
    name: "Full Scan",
    price: "$99",
    period: "one-time",
    description: "Every module. Nothing missed.",
    features: [
      "All 120 modules",
      "Security, deps, CI hardening, A11y",
      "AI code review (Claude Sonnet 4.6)",
      "SARIF + JUnit output",
      "Cross-repo prior-art lookup",
    ],
    cta: "Start full scan",
    href: "/github/setup?tier=full",
    highlight: false,
  },
  {
    name: "Scan + Fix",
    price: "$199",
    period: "one-time",
    description: "Get a fix PR, not just a report.",
    features: [
      "Everything in Full Scan",
      "Auto-fix pull request",
      "Regression tests per fix",
      "Pair-review (second AI pass)",
      "Architecture annotations",
    ],
    cta: "Get the fix PR",
    href: "/github/setup?tier=scan_fix",
    highlight: true,
  },
  {
    name: "Forensic",
    price: "$399",
    period: "one-time",
    description: "Board-ready audit with attack-chain correlation.",
    features: [
      "Everything in Scan + Fix",
      "Per-finding Claude diagnosis",
      "Cross-finding attack-chain correlation",
      "Executive summary report",
      "CISO-ready PDF",
    ],
    cta: "Start forensic scan",
    href: "/github/setup?tier=forensic",
    highlight: false,
  },
];

export default function Pricing() {
  return (
    <section
      id="pricing"
      style={{
        background: "#000",
        borderTop: "1px solid #1a1a1a",
        padding: "96px 24px",
      }}
    >
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 56 }}>
          <p style={{ color: "#00E5FF", fontSize: 12, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 16 }}>
            Pricing
          </p>
          <h2
            style={{
              fontSize: "clamp(28px, 4vw, 44px)",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "#fff",
              margin: "0 0 16px",
              lineHeight: 1.1,
            }}
          >
            Pay per scan. No subscription required.
          </h2>
          <p style={{ color: "#888", fontSize: 16, maxWidth: 480, margin: "0 auto" }}>
            One-time payment. If something breaks, we re-run it. No lock-in.
          </p>
        </div>

        {/* Tier grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 1,
            border: "1px solid #222",
            background: "#222",
          }}
        >
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              style={{
                background: tier.highlight ? "#0a0a0a" : "#000",
                padding: "32px 28px",
                display: "flex",
                flexDirection: "column",
                position: "relative",
              }}
            >
              {tier.highlight && (
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 2,
                    background: "#00E5FF",
                  }}
                  aria-hidden="true"
                />
              )}

              <div style={{ marginBottom: 24 }}>
                <p
                  style={{
                    color: tier.highlight ? "#00E5FF" : "#888",
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    marginBottom: 8,
                  }}
                >
                  {tier.name}
                </p>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 8 }}>
                  <span style={{ fontSize: 40, fontWeight: 800, color: "#fff", letterSpacing: "-0.03em", lineHeight: 1 }}>
                    {tier.price}
                  </span>
                  <span style={{ fontSize: 13, color: "#555" }}>{tier.period}</span>
                </div>
                <p style={{ color: "#666", fontSize: 13, lineHeight: 1.5 }}>{tier.description}</p>
              </div>

              <ul style={{ listStyle: "none", padding: 0, margin: "0 0 32px", flex: 1 }}>
                {tier.features.map((f) => (
                  <li
                    key={f}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "6px 0",
                      fontSize: 13,
                      color: "#aaa",
                      borderBottom: "1px solid #111",
                    }}
                  >
                    <span style={{ color: "#00FF88", flexShrink: 0, fontWeight: 700, fontSize: 12 }}>✓</span>
                    {f}
                  </li>
                ))}
              </ul>

              <Link
                href={tier.href}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: 44,
                  background: tier.highlight ? "#00E5FF" : "transparent",
                  color: tier.highlight ? "#000" : "#888",
                  border: tier.highlight ? "none" : "1px solid #333",
                  fontWeight: 700,
                  fontSize: 14,
                  textDecoration: "none",
                  letterSpacing: "-0.01em",
                  transition: "background 0.15s ease, color 0.15s ease",
                }}
                onMouseEnter={e => {
                  if (tier.highlight) {
                    e.currentTarget.style.background = "#33EEFF";
                  } else {
                    e.currentTarget.style.color = "#fff";
                    e.currentTarget.style.borderColor = "rgba(255,255,255,0.25)";
                  }
                }}
                onMouseLeave={e => {
                  if (tier.highlight) {
                    e.currentTarget.style.background = "#00E5FF";
                  } else {
                    e.currentTarget.style.color = "#888";
                    e.currentTarget.style.borderColor = "#333";
                  }
                }}
              >
                {tier.cta}
              </Link>
            </div>
          ))}
        </div>

        {/* Continuous subscription card */}
        <div
          style={{
            marginTop: 1,
            border: "1px solid #222",
            borderTop: "none",
            padding: "28px 32px",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "16px 40px",
            background: "#050505",
          }}
        >
          <div style={{ flex: "1 1 280px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <p style={{ color: "#fff", fontWeight: 700, fontSize: 16 }}>Continuous</p>
              <span
                style={{
                  background: "rgba(0,229,255,0.08)",
                  color: "#00E5FF",
                  border: "1px solid rgba(0,229,255,0.2)",
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 8px",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                subscription
              </span>
            </div>
            <p style={{ color: "#666", fontSize: 13 }}>
              Scan every push. Catch issues before they merge.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ fontSize: 36, fontWeight: 800, color: "#fff", letterSpacing: "-0.03em" }}>$49</span>
            <span style={{ color: "#555", fontSize: 13 }}>/mo · unlimited repos</span>
          </div>
          <Link
            href="/github/setup?tier=continuous"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              height: 44,
              padding: "0 24px",
              background: "transparent",
              color: "#888",
              border: "1px solid #333",
              fontWeight: 600,
              fontSize: 14,
              textDecoration: "none",
              whiteSpace: "nowrap",
              flexShrink: 0,
              transition: "color 0.15s ease, border-color 0.15s ease",
            }}
            onMouseEnter={e => { e.currentTarget.style.color = "#fff"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.25)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "#888"; e.currentTarget.style.borderColor = "#333"; }}
          >
            Start continuous →
          </Link>
        </div>

        {/* Fine print */}
        <p style={{ textAlign: "center", color: "#444", fontSize: 12, marginTop: 24 }}>
          All tiers: no subscription, no minimum, cancel anytime. Pay via Stripe. Re-run guarantee on delivery issues.
        </p>
      </div>
    </section>
  );
}
