"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import AuthModal from "./AuthModal";

export const OPEN_AUTH_EVENT = "gatetest:open-auth";

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled]     = useState(false);
  const [authOpen, setAuthOpen]     = useState(false);
  const [authed, setAuthed]         = useState(false);

  // Scroll effect
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Check session state on mount
  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.login) setAuthed(true); })
      .catch(() => {});
  }, []);

  // Listen for cross-component open-auth trigger (e.g. from Hero CTA)
  const openModal = useCallback(() => setAuthOpen(true), []);
  useEffect(() => {
    window.addEventListener(OPEN_AUTH_EVENT, openModal);
    return () => window.removeEventListener(OPEN_AUTH_EVENT, openModal);
  }, [openModal]);

  const linkClass = scrolled
    ? "text-muted hover:text-foreground"
    : "text-white/75 hover:text-white";

  return (
    <>
      <nav
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
          scrolled
            ? "bg-white/92 backdrop-blur-xl border-b border-border shadow-sm"
            : "bg-[#0a0a12]/40 backdrop-blur-md border-b border-white/10"
        }`}
      >
        <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center">
              <span className="text-white font-bold text-sm font-[var(--font-mono)]">G</span>
            </div>
            <span className={`text-xl font-bold tracking-tight ${scrolled ? "text-foreground" : "text-white"}`}>
              Gate<span className="text-teal-400">Test</span>
            </span>
          </Link>

          {/* Desktop nav links */}
          <div className="hidden md:flex items-center gap-8">
            {["Features", "Modules", "Install", "Compare", "Integrations", "Pricing"].map((item) => (
              <a
                key={item}
                href={`#${item.toLowerCase() === "compare" ? "comparison" : item.toLowerCase()}`}
                className={`text-sm transition-colors ${linkClass}`}
              >
                {item}
              </a>
            ))}
          </div>

          {/* Desktop right actions */}
          <div className="hidden md:flex items-center gap-3">
            {authed ? (
              <Link
                href="/dashboard"
                className={`text-sm transition-colors ${linkClass}`}
              >
                Dashboard
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => setAuthOpen(true)}
                className={`text-sm transition-colors ${linkClass}`}
              >
                Sign In
              </button>
            )}
            <a
              href="/github/setup"
              className={`px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${
                scrolled
                  ? "border-border text-foreground hover:border-accent/50"
                  : "border-white/15 text-white/70 hover:text-white hover:border-white/30"
              }`}
            >
              GitHub App
            </a>
            {authed ? (
              <Link
                href="/dashboard"
                className={`px-4 py-2 text-sm font-semibold rounded-lg transition-all ${
                  scrolled ? "btn-cta" : "hero-cta"
                }`}
              >
                My Workspace
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => setAuthOpen(true)}
                className={`px-4 py-2 text-sm font-semibold rounded-lg transition-all ${
                  scrolled ? "btn-cta" : "hero-cta"
                }`}
              >
                Get Automated Fixes
              </button>
            )}
          </div>

          {/* Mobile hamburger */}
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

        {/* Mobile menu */}
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
            {authed ? (
              <Link
                href="/dashboard"
                className={`block text-sm ${scrolled ? "text-muted hover:text-foreground" : "text-white/60 hover:text-white"}`}
                onClick={() => setMobileOpen(false)}
              >
                Dashboard
              </Link>
            ) : (
              <button
                type="button"
                className={`block w-full text-left text-sm ${scrolled ? "text-muted hover:text-foreground" : "text-white/60 hover:text-white"}`}
                onClick={() => { setMobileOpen(false); setAuthOpen(true); }}
              >
                Sign In
              </button>
            )}
            <button
              type="button"
              className={`block w-full px-5 py-2.5 text-sm text-center rounded-lg font-semibold ${scrolled ? "btn-cta" : "hero-cta"}`}
              onClick={() => { setMobileOpen(false); setAuthOpen(true); }}
            >
              Get Automated Fixes
            </button>
          </div>
        )}
      </nav>

      {/* Auth modal — rendered at nav level so it's outside hero/section stacking contexts */}
      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
    </>
  );
}
