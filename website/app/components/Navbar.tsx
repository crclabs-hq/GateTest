"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
      scrolled
        ? "bg-white/90 backdrop-blur-2xl border-b border-border/60 shadow-[0_1px_0_0_rgba(0,0,0,0.06),inset_0_1px_0_0_rgba(255,255,255,0.6)]"
        : "bg-[#14141d]/80 backdrop-blur-md border-b border-white/8"
    }`}>
      <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center">
            <span className="text-white font-bold text-sm font-[var(--font-mono)]">G</span>
          </div>
          <span className={`text-xl font-bold tracking-tight ${scrolled ? "text-foreground" : "text-white"}`}>
            Gate<span className="text-teal-400">Test</span>
          </span>
          {/* BETA badge — sets the right expectation site-wide. Pre-launch
              polish + product fit are still in flight. Remove this once
              we hit GA. */}
          <span
            className={`hidden sm:inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
              scrolled
                ? "bg-amber-100 border-amber-300 text-amber-700"
                : "bg-amber-400/15 border-amber-400/40 text-amber-300"
            }`}
            aria-label="Beta — the product is rough and getting polished daily"
          >
            Beta
          </span>
        </Link>

        <div className="hidden md:flex items-center gap-8">
          {["Features", "Modules", "Install", "Compare", "Integrations", "Pricing"].map((item) => (
            <a
              key={item}
              href={`#${item.toLowerCase() === "compare" ? "comparison" : item.toLowerCase()}`}
              className={`text-sm transition-colors ${
                scrolled
                  ? "text-muted hover:text-foreground"
                  : "text-white/75 hover:text-white"
              }`}
            >
              {item}
            </a>
          ))}
          <Link
            href="/developers"
            className={`text-sm transition-colors ${
              scrolled ? "text-muted hover:text-foreground" : "text-white/75 hover:text-white"
            }`}
          >
            Developers
          </Link>
        </div>

        <div className="hidden md:flex items-center gap-4">
          <Link
            href="/scans"
            className={`text-sm transition-colors ${
              scrolled ? "text-muted hover:text-foreground" : "text-white/75 hover:text-white"
            }`}
          >
            Hall of Scans
          </Link>
          <a
            href="/dashboard"
            className={`text-sm transition-colors ${
              scrolled ? "text-muted hover:text-foreground" : "text-white/75 hover:text-white"
            }`}
          >
            My Scans
          </a>
          <a
            href="/github/setup"
            className={`px-5 py-2.5 text-sm font-medium rounded-lg border transition-colors ${
              scrolled
                ? "border-border text-foreground hover:border-accent/50"
                : "border-white/15 text-white/70 hover:text-white hover:border-white/30"
            }`}
          >
            Install GitHub App
          </a>
          <Link
            href="/scan/preview"
            className={`px-5 py-2.5 text-sm font-semibold rounded-lg transition-all ${
              scrolled
                ? "btn-cta"
                : "hero-cta"
            }`}
          >
            Free Preview Scan
          </Link>
        </div>

        <button
          className={`md:hidden ${scrolled ? "text-muted" : "text-white/60"} hover:text-white`}
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {mobileOpen ? (
              <path d="M18 6L6 18M6 6l12 12" />
            ) : (
              <path d="M3 12h18M3 6h18M3 18h18" />
            )}
          </svg>
        </button>
      </div>

      {mobileOpen && (
        <div className={`md:hidden border-t px-6 py-4 space-y-4 ${
          scrolled
            ? "border-border bg-white/95 backdrop-blur-xl"
            : "border-white/10 bg-[#0a0a12]/95 backdrop-blur-xl"
        }`}>
          {["Features", "Modules", "Install", "Compare", "Integrations", "Pricing"].map((item) => (
            <a
              key={item}
              href={`#${item.toLowerCase() === "compare" ? "comparison" : item.toLowerCase()}`}
              className={`block text-sm ${scrolled ? "text-muted hover:text-foreground" : "text-white/60 hover:text-white"}`}
              onClick={() => setMobileOpen(false)}
            >
              {item}
            </a>
          ))}
          <Link
            href="/scans"
            className={`block text-sm ${scrolled ? "text-muted hover:text-foreground" : "text-white/60 hover:text-white"}`}
            onClick={() => setMobileOpen(false)}
          >
            Hall of Scans
          </Link>
          <a
            href="/dashboard"
            className={`block text-sm ${scrolled ? "text-muted hover:text-foreground" : "text-white/60 hover:text-white"}`}
            onClick={() => setMobileOpen(false)}
          >
            My Scans
          </a>
          <Link
            href="/scan/preview"
            className={`block px-5 py-2.5 text-sm text-center rounded-lg font-semibold ${scrolled ? "btn-cta" : "hero-cta"}`}
            onClick={() => setMobileOpen(false)}
          >
            Free Preview Scan
          </Link>
        </div>
      )}
    </nav>
  );
}
