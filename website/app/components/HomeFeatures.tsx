/**
 * HomeFeatures — three-column feature grid.
 * Dark, sharp, no illustrations, no gradients.
 */

const FEATURES = [
  {
    icon: "⬡",
    title: "120 modules in one gate",
    body: "Security, deps, CI hardening, accessibility, TypeScript strictness, N+1 queries, regex DoS, money floats, and 110 more. Replace SonarQube, Snyk, ESLint, and 7 others.",
  },
  {
    icon: "⚡",
    title: "Zero config. Works on any repo.",
    body: "Point GateTest at a GitHub URL. No YAML, no plugin list, no .gatetest.json required. Auto-detects stack, language, and framework from your code.",
  },
  {
    icon: "→",
    title: "Finds the bug. Ships the fix.",
    body: "The Scan + Fix tier opens a PR with the patch already written, a regression test covering it, and a second AI that reviewed the diff before it was opened.",
  },
  {
    icon: "◉",
    title: "AI-native diagnosis, not templates",
    body: "Forensic tier sends every finding to Claude Sonnet 4.6 for root-cause analysis, then correlates findings into attack chains your team actually acts on.",
  },
  {
    icon: "◈",
    title: "Catches what your CI misses",
    body: "Your CI runs lint. GateTest runs 120 modules including secret rotation age, TLS bypass patterns, feature-flag rot, import cycles, and async-iteration footguns.",
  },
  {
    icon: "⊞",
    title: "Pay per scan. No subscription.",
    body: "Each scan is a one-time Stripe payment. No seats, no tiers-by-team-size, no annual commit. Scan a repo once or scan every PR — you control the spend.",
  },
];

export default function HomeFeatures() {
  return (
    <section
      id="features"
      style={{
        background: "#000",
        borderTop: "1px solid #1a1a1a",
        padding: "96px 24px",
      }}
    >
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ maxWidth: 560, marginBottom: 64 }}>
          <p
            style={{
              color: "#00E5FF",
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 16,
            }}
          >
            Why GateTest
          </p>
          <h2
            style={{
              fontSize: "clamp(26px, 3.5vw, 40px)",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "#fff",
              margin: "0 0 16px",
              lineHeight: 1.15,
            }}
          >
            The QA layer that ships with your AI-written code
          </h2>
          <p style={{ color: "#666", fontSize: 16, lineHeight: 1.65 }}>
            AI generates code faster than humans review it. GateTest is the verification layer that makes AI-generated code production-safe.
          </p>
        </div>

        {/* Feature grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 1,
            border: "1px solid #1a1a1a",
            background: "#1a1a1a",
          }}
        >
          {FEATURES.map((f) => (
            <div
              key={f.title}
              style={{
                background: "#000",
                padding: "32px 28px",
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  fontSize: 18,
                  color: "#333",
                  marginBottom: 16,
                  fontFamily: "monospace",
                  lineHeight: 1,
                }}
              >
                {f.icon}
              </div>
              <h3
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: "#fff",
                  margin: "0 0 10px",
                  letterSpacing: "-0.01em",
                }}
              >
                {f.title}
              </h3>
              <p style={{ fontSize: 13, color: "#666", lineHeight: 1.65, margin: 0 }}>
                {f.body}
              </p>
            </div>
          ))}
        </div>

        {/* Module count strip */}
        <div
          style={{
            marginTop: 1,
            border: "1px solid #1a1a1a",
            borderTop: "none",
            background: "#050505",
            padding: "20px 28px",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px 40px",
          }}
        >
          {[
            ["120", "total modules"],
            ["5,700+", "tests passing"],
            ["$0.02", "avg cost per scan"],
            ["38s", "avg time to fix PR"],
          ].map(([num, label]) => (
            <div key={label} style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 20, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
                {num}
              </span>
              <span style={{ fontSize: 12, color: "#555" }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
