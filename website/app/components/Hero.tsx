"use client";

/**
 * Hero — dark, Vercel/Linear quality.
 *
 * Design tokens (Craig spec):
 *   bg #000000 · surface #111111 · border #222222
 *   text #fff · secondary #888 · accent #00E5FF
 *   success #00FF88 · error #FF4444
 *   headline 64px / -0.02em / 700 · Inter
 *
 * Layout: centered headline → subline → CTA row → terminal animation
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

const LINES: Array<{ delay: number; text: string; color: string }> = [
  { delay: 0,    text: "$ gatetest scan --repo github.com/acme/backend", color: "#888888" },
  { delay: 700,  text: "  Scanning 120 modules...",                      color: "#555555" },
  { delay: 1500, text: "  ✓  secrets            0 findings",             color: "#00FF88" },
  { delay: 2100, text: "  ✓  dependencies       3 advisories",           color: "#00FF88" },
  { delay: 2700, text: "  ✓  typescript         0 errors",               color: "#00FF88" },
  { delay: 3300, text: "  ✗  auth               JWT secret hardcoded",   color: "#FF4444" },
  { delay: 3900, text: "  ✓  security           patched 2 criticals",    color: "#00FF88" },
  { delay: 4700, text: "  Fix PR opened → github.com/acme/backend/pull/248", color: "#00E5FF" },
];

function TerminalLine({
  text,
  color,
  cursor,
}: {
  text: string;
  color: string;
  cursor: boolean;
}) {
  return (
    <div
      style={{
        color,
        fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
        fontSize: 13,
        lineHeight: "22px",
        whiteSpace: "pre",
      }}
    >
      {text}
      {cursor && (
        <span
          style={{ display: "inline-block", width: 7, height: 13, background: "#00E5FF", verticalAlign: "middle", marginLeft: 2 }}
          className="cursor-blink"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export default function Hero() {
  const [visible, setVisible] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setVisible(LINES.length);
      return;
    }

    timers.current.forEach(clearTimeout);
    timers.current = [];
    setVisible(0);

    LINES.forEach((line, i) => {
      const t = setTimeout(() => setVisible(i + 1), line.delay);
      timers.current.push(t);
    });

    const loop = setTimeout(() => {
      setVisible(0);
      timers.current.forEach(clearTimeout);
      timers.current = [];
      LINES.forEach((line, i) => {
        const t = setTimeout(() => setVisible(i + 1), line.delay);
        timers.current.push(t);
      });
    }, LINES[LINES.length - 1].delay + 4000);
    timers.current.push(loop);

    return () => timers.current.forEach(clearTimeout);
  }, []);

  return (
    <section
      aria-label="Hero"
      style={{
        background: "#000000",
        paddingTop: 100,
        paddingBottom: 80,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Subtle dot-grid background — low-contrast, not decorative */}
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
            "radial-gradient(ellipse 75% 65% at 50% 25%, #000 0%, transparent 100%)",
          maskImage:
            "radial-gradient(ellipse 75% 65% at 50% 25%, #000 0%, transparent 100%)",
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          position: "relative",
          maxWidth: 760,
          margin: "0 auto",
          padding: "0 24px",
          textAlign: "center",
        }}
      >
        {/* Live badge */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            border: "1px solid #222",
            padding: "6px 14px",
            marginBottom: 36,
            fontSize: 12,
            color: "#888",
            letterSpacing: "0.02em",
            fontWeight: 500,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "#00FF88",
              display: "inline-block",
              flexShrink: 0,
              boxShadow: "0 0 6px #00FF88",
            }}
            aria-hidden="true"
          />
          120 modules · v1.50 · Now in beta
        </div>

        {/* Headline — 64px / -0.02em / 700 */}
        <h1
          style={{
            fontSize: "clamp(36px, 6vw, 64px)",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            lineHeight: 1.07,
            color: "#ffffff",
            margin: "0 0 20px",
          }}
        >
          AI writes your code.{" "}
          <br />
          GateTest makes sure it{" "}
          <span style={{ color: "#00E5FF" }}>actually works.</span>
        </h1>

        {/* Subline */}
        <p
          style={{
            fontSize: "clamp(15px, 2.2vw, 20px)",
            color: "#888888",
            lineHeight: 1.65,
            margin: "0 0 44px",
            maxWidth: 480,
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
            marginBottom: 64,
          }}
        >
          <Link
            href="/github/setup"
            style={{
              background: "#00E5FF",
              color: "#000000",
              fontWeight: 700,
              fontSize: 15,
              letterSpacing: "-0.01em",
              padding: "0 28px",
              height: 48,
              minWidth: 220,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              textDecoration: "none",
              flexShrink: 0,
              transition: "background 0.15s ease",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "#33EEFF"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "#00E5FF"; }}
          >
            Scan your repo free →
          </Link>
          <Link
            href="/preview#playground"
            style={{
              color: "#888888",
              fontWeight: 500,
              fontSize: 14,
              padding: "0 20px",
              height: 48,
              minWidth: 120,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              textDecoration: "none",
              border: "1px solid #333",
              flexShrink: 0,
              transition: "color 0.15s ease, border-color 0.15s ease",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.color = "#fff";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.25)";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = "#888888";
              e.currentTarget.style.borderColor = "#333";
            }}
          >
            See it live
          </Link>
        </div>

        {/* Terminal animation */}
        <div
          role="img"
          aria-label="GateTest scanning a repository, finding an auth issue and opening a fix PR"
          style={{
            background: "#0a0a0a",
            border: "1px solid #222",
            overflow: "hidden",
            textAlign: "left",
          }}
        >
          {/* Chrome row */}
          <div
            style={{
              borderBottom: "1px solid #222",
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#FF4444", display: "inline-block" }} aria-hidden="true" />
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#333", display: "inline-block" }} aria-hidden="true" />
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#333", display: "inline-block" }} aria-hidden="true" />
            <span style={{ marginLeft: 8, fontSize: 11, color: "#444", fontFamily: "monospace" }}>gatetest — bash</span>
          </div>

          {/* Body */}
          <div style={{ padding: "16px 20px", minHeight: 200 }}>
            {LINES.slice(0, visible).map((line, i) => (
              <TerminalLine
                key={i}
                text={line.text}
                color={line.color}
                cursor={i === visible - 1 && visible < LINES.length}
              />
            ))}
            {visible === 0 && (
              <TerminalLine text="" color="#888" cursor={true} />
            )}
          </div>
        </div>

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
            color: "#555",
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
  );
}
