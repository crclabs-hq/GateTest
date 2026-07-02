"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const navStyle: React.CSSProperties = {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
    height: 60,
    background: scrolled ? "rgba(0,0,0,0.92)" : "rgba(0,0,0,0.70)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    borderBottom: `1px solid ${scrolled ? "#2a2a2a" : "#1a1a1a"}`,
    transition: "background 0.2s ease, border-color 0.2s ease",
  };

  return (
    <nav style={navStyle} aria-label="Main navigation">
      <div
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          padding: "0 24px",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        {/* ── Logo ── */}
        <Link
          href="/"
          aria-label="GateTest home"
          style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, textDecoration: "none" }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 26,
              height: 26,
              background: "#00E5FF",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <span style={{ color: "#000", fontWeight: 800, fontSize: 12, fontFamily: "monospace", lineHeight: 1 }}>G</span>
          </span>
          <span style={{ color: "#ffffff", fontSize: 16, fontWeight: 700, letterSpacing: "-0.015em" }}>
            Gate<span style={{ color: "#00E5FF" }}>Test</span>
          </span>
        </Link>

        {/* ── Center nav links ── */}
        <nav
          aria-label="Site sections"
          style={{ display: "flex", alignItems: "center", gap: 32 }}
          className="hidden md:flex"
        >
          {[
            { label: "Playground", href: "/preview#playground" },
            { label: "Pricing",    href: "#pricing" },
            { label: "Docs",       href: "/docs/api" },
          ].map(({ label, href }) => (
            <Link
              key={label}
              href={href}
              style={{
                color: "#888888",
                fontSize: 14,
                fontWeight: 500,
                textDecoration: "none",
                transition: "color 0.15s ease",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={e => { (e.target as HTMLElement).style.color = "#ffffff"; }}
              onMouseLeave={e => { (e.target as HTMLElement).style.color = "#888888"; }}
            >
              {label}
            </Link>
          ))}
        </nav>

        {/* ── Right: Sign in + Start free ── */}
        <div
          style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}
          className="hidden md:flex"
        >
          <a
            href="/dashboard"
            style={{
              color: "#888888",
              fontSize: 14,
              fontWeight: 500,
              padding: "0 16px",
              height: 36,
              display: "inline-flex",
              alignItems: "center",
              border: "1px solid #333",
              textDecoration: "none",
              whiteSpace: "nowrap",
              minWidth: 44,
              transition: "color 0.15s ease, border-color 0.15s ease",
            }}
            onMouseEnter={e => {
              const el = e.currentTarget;
              el.style.color = "#fff";
              el.style.borderColor = "rgba(255,255,255,0.25)";
            }}
            onMouseLeave={e => {
              const el = e.currentTarget;
              el.style.color = "#888888";
              el.style.borderColor = "#333";
            }}
          >
            Sign in
          </a>
          <Link
            href="/github/setup"
            style={{
              background: "#00E5FF",
              color: "#000000",
              fontSize: 14,
              fontWeight: 700,
              padding: "0 20px",
              height: 36,
              display: "inline-flex",
              alignItems: "center",
              textDecoration: "none",
              whiteSpace: "nowrap",
              letterSpacing: "-0.01em",
              transition: "background 0.15s ease",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "#33EEFF"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "#00E5FF"; }}
          >
            Start free
          </Link>
        </div>

        {/* ── Mobile hamburger ── */}
        <button
          className="md:hidden"
          onClick={() => setMobileOpen(o => !o)}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          style={{
            color: "#888",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 10,
            minWidth: 44,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
            {mobileOpen ? (
              <path d="M18 6L6 18M6 6l12 12" />
            ) : (
              <path d="M3 12h18M3 6h18M3 18h18" />
            )}
          </svg>
        </button>
      </div>

      {/* ── Mobile menu ── */}
      {mobileOpen && (
        <div
          style={{
            background: "#000",
            borderTop: "1px solid #222",
            padding: "20px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          <Link href="/preview#playground" style={{ color: "#888", fontSize: 15, textDecoration: "none" }} onClick={() => setMobileOpen(false)}>Playground</Link>
          <a href="#pricing" style={{ color: "#888", fontSize: 15, textDecoration: "none" }} onClick={() => setMobileOpen(false)}>Pricing</a>
          <Link href="/docs/api" style={{ color: "#888", fontSize: 15, textDecoration: "none" }} onClick={() => setMobileOpen(false)}>Docs</Link>
          <a href="/dashboard" style={{ color: "#888", fontSize: 15, textDecoration: "none" }} onClick={() => setMobileOpen(false)}>Sign in</a>
          <Link
            href="/github/setup"
            style={{
              background: "#00E5FF",
              color: "#000",
              fontWeight: 700,
              fontSize: 15,
              padding: "14px 20px",
              textAlign: "center",
              textDecoration: "none",
              display: "block",
              minHeight: 44,
            }}
            onClick={() => setMobileOpen(false)}
          >
            Start free
          </Link>
        </div>
      )}
    </nav>
  );
}
