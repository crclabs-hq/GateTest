import { ImageResponse } from "next/og";
import { TOTAL_MODULES } from "@/app/lib/module-count";

// Rendered on the Node runtime: production is a Node server (the box), where
// `runtime = "edge"` made this route 502 and every social share lost its image.
export const alt = "GateTest — AI-powered QA platform";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#ffffff",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          padding: "60px 80px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* Top accent bar */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 6,
            background: "#0f766e",
          }}
        />

        {/* Logo */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 40,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 12,
              background: "#0f766e",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              fontSize: 28,
              fontWeight: 700,
            }}
          >
            G
          </div>
          <span style={{ fontSize: 42, fontWeight: 700, color: "#111827" }}>
            GateTest
          </span>
        </div>

        {/* Headline — satori (next/og) requires an explicit display on any
            element with more than one child; text + <br/> + <span> was not
            valid and made the route 502 / the build fail. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            fontSize: 52,
            fontWeight: 700,
            color: "#111827",
            textAlign: "center",
            lineHeight: 1.15,
            marginBottom: 24,
          }}
        >
          <div style={{ display: "flex" }}>AI writes fast.</div>
          <div style={{ display: "flex", color: "#0f766e" }}>CI quality gate for AI-written code.</div>
        </div>

        {/* Subtext */}
        <div
          style={{
            fontSize: 24,
            color: "#6b7280",
            textAlign: "center",
            maxWidth: 700,
            lineHeight: 1.5,
          }}
        >
          {`${TOTAL_MODULES} modules scan your entire codebase. Security, supply chain, auth flaws, CI hardening, and AI code review. Pay per scan via Stripe.`}
        </div>

        {/* Bottom bar */}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            display: "flex",
            gap: 32,
            color: "#6b7280",
            fontSize: 18,
          }}
        >
          <span>gatetest.io</span>
          <span>From $29/scan</span>
          <span>One-time per scan</span>
        </div>
      </div>
    ),
    { ...size }
  );
}
