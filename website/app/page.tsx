"use client";

/**
 * Homepage — dark, sharp, minimal. Vercel/Linear quality.
 *
 * Design tokens:
 *   bg #000000 · surface #111111 · border #222222
 *   text #FFFFFF · muted #888888 · accent #00E5FF
 *   success #00FF88 · error #FF4444
 *   Font: Inter 700 64px -0.02em hero · 400 16px body
 *
 * Hero only — Navbar + inline hero + Footer.
 * Terminal animates 120-module scan, loops every ~9 s.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";

/* ─── Terminal animation data ──────────────────────────────────────────── */
const LINES: Array<{ delay: number; text: string; color: string }> = [
  { delay: 0,    text: "$ gatetest scan github.com/acme/api",          color: "#888888" },
  { delay: 600,  text: "  scanning 120 modules…",                      color: "#555555" },
  { delay: 1300, text: "  ✓ secrets              0 findings",           color: "#00FF88" },
  { delay: 1900, text: "  ✓ typescript           0 errors",             color: "#00FF88" },
  { delay: 2500, text: "  ✓ dependencies         3 advisories",         color: "#00FF88" },
  { delay: 3100, text: "  ✓ sql-migrations       0 issues",             color: "#00FF88" },
  { delay: 3700, text: "  ✗ auth                 JWT secret hardcoded", color: "#FF4444" },
  { delay: 4300, text: "  ✓ tls-security         patched 2 criticals",  color: "#00FF88" },
  { delay: 5000, text: "  Fix PR → github.com/acme/api/pull/312",       color: "#00E5FF" },
];

/* ─── Terminal component ────────────────────────────────────────────────── */
function Terminal() {
  const [visible, setVisible] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  function schedule() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setVisible(0);

    LINES.forEach((line, i) => {
      const t = setTimeout(() => setVisible(i + 1), line.delay);
      timers.current.push(t);
    });

    const restart = setTimeout(() => schedule(), LINES[LINES.length - 1].delay + 3800);
    timers.current.push(restart);
  }

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setVisible(LINES.length);
      return;
    }
    schedule();
    return () => timers.current.forEach(clearTimeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      role="img"
      aria-label="GateTest scanning a repository, finding an auth issue, and opening a fix PR"
      style={{
        background: "#0a0a0a",
        border: "1px solid #222",
        borderRadius: 8,
        overflow: "hidden",
        textAlign: "left",
        maxWidth: 680,
        margin: "0 auto",
      }}
    >
      {/* Window chrome */}
      <div style={{
        borderBottom: "1px solid #222",
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#FF4444", display: "inline-block" }} aria-hidden="true" />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#333333", display: "inline-block" }} aria-hidden="true" />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#333333", display: "inline-block" }} aria-hidden="true" />
        <span style={{ marginLeft: 8, fontSize: 11, color: "#444", fontFamily: "var(--font-mono, monospace)" }}>
          gatetest — bash
        </span>
      </div>

      {/* Output lines */}
      <div style={{ padding: "16px 20px", minHeight: 220 }}>
        {visible === 0 && (
          <div style={{
            fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
            fontSize: 13,
            lineHeight: "22px",
            color: "#888",
          }}>
            <span
              style={{
                display: "inline-block",
                width: 7,
                height: 13,
                background: "#00E5FF",
                verticalAlign: "middle",
              }}
              aria-hidden="true"
            />
          </div>
        )}
        {LINES.slice(0, visible).map((line, i) => (
          <div
            key={i}
            style={{
              color: line.color,
              fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
              fontSize: 13,
              lineHeight: "22px",
              whiteSpace: "pre",
            }}
          >
            {line.text}
            {i === visible - 1 && visible < LINES.length && (
              <span
                style={{
                  display: "inline-block",
                  width: 7,
                  height: 13,
                  background: "#00E5FF",
                  verticalAlign: "middle",
                  marginLeft: 2,
                }}
                aria-hidden="true"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Page ──────────────────────────────────────────────────────────────── */
export default function Home() {
  return (
    <>
      {/* Load Inter if not already present */}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap"
      />

      <Navbar />

      <main style={{ background: "#000000" }}>
        <section
          aria-label="Hero"
          style={{
            background: "#000000",
            paddingTop: 128,
            paddingBottom: 96,
            paddingLeft: 24,
            paddingRight: 24,
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* Dot-grid backdrop — very low contrast, masked to top ellipse */}
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage:
                "linear-gradient(rgba(0,229,255,0.04) 1px, transparent 1px), " +
                "linear-gradient(90deg, rgba(0,229,255,0.04) 1px, transparent 1px)",
              backgroundSize: "64px 64px",
              WebkitMaskImage:
                "radial-gradient(ellipse 80% 65% at 50% 20%, #000 0%, transparent 100%)",
              maskImage:
                "radial-gradient(ellipse 80% 65% at 50% 20%, #000 0%, transparent 100%)",
              pointerEvents: "none",
            }}
          />

          <div
            style={{
              position: "relative",
              maxWidth: 780,
              margin: "0 auto",
              textAlign: "center",
              fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            }}
          >
            {/* Status badge */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                border: "1px solid #222",
                borderRadius: 999,
                padding: "5px 14px",
                marginBottom: 40,
                fontSize: 12,
                color: "#888888",
                fontWeight: 500,
                letterSpacing: "0.02em",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#00FF88",
                  boxShadow: "0 0 6px #00FF88",
                  display: "inline-block",
                  flexShrink: 0,
                }}
                aria-hidden="true"
              />
              120 modules · v1.50 · self-scan green
            </div>

            {/* Headline — Inter 700 / 64px / -0.02em */}
            <h1
              style={{
                fontSize: "clamp(36px, 5.5vw, 64px)",
                fontWeight: 700,
                letterSpacing: "-0.02em",
                lineHeight: 1.07,
                color: "#ffffff",
                margin: "0 0 20px",
                fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
              }}
            >
              AI writes your code.
              <br />
              GateTest makes sure it{" "}
              <span style={{ color: "#00E5FF" }}>actually works.</span>
            </h1>

            {/* Subline — 16px / #888 */}
            <p
              style={{
                fontSize: "clamp(15px, 2vw, 18px)",
                fontWeight: 400,
                color: "#888888",
                lineHeight: 1.65,
                margin: "0 0 48px",
                maxWidth: 460,
                marginLeft: "auto",
                marginRight: "auto",
              }}
            >
              120 modules. Zero config. Catches what your CI misses.
            </p>

            {/* CTA row */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                marginBottom: 72,
              }}
            >
              {/* Primary CTA — #00E5FF bg / #000 text / 48px / 8px radius */}
              <Link
                href="/github/setup"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#00E5FF",
                  color: "#000000",
                  fontWeight: 700,
                  fontSize: 15,
                  letterSpacing: "-0.01em",
                  height: 48,
                  padding: "0 28px",
                  borderRadius: 8,
                  textDecoration: "none",
                  minWidth: 220,
                  flexShrink: 0,
                  transition: "background 0.15s ease",
                  fontFamily: '"Inter", -apple-system, sans-serif',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#33EEFF"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "#00E5FF"; }}
              >
                Scan your repo free →
              </Link>

              {/* Secondary CTA — ghost */}
              <Link
                href="/preview#playground"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#888888",
                  fontWeight: 500,
                  fontSize: 14,
                  height: 48,
                  padding: "0 20px",
                  borderRadius: 8,
                  border: "1px solid #333",
                  textDecoration: "none",
                  flexShrink: 0,
                  transition: "color 0.15s ease, border-color 0.15s ease",
                  fontFamily: '"Inter", -apple-system, sans-serif',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "#ffffff";
                  e.currentTarget.style.borderColor = "rgba(255,255,255,0.25)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "#888888";
                  e.currentTarget.style.borderColor = "#333";
                }}
              >
                See it live
              </Link>
            </div>

            {/* Terminal animation */}
            <Terminal />

            {/* Trust strip */}
            <div
              style={{
                marginTop: 32,
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "center",
                gap: "6px 20px",
                fontSize: 12,
                color: "#555555",
                fontFamily: '"Inter", -apple-system, sans-serif',
              }}
            >
              <span>No credit card</span>
              <span aria-hidden="true" style={{ color: "#333" }}>·</span>
              <span>Pay per scan</span>
              <span aria-hidden="true" style={{ color: "#333" }}>·</span>
              <span>Built on Claude Sonnet 4.6</span>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
