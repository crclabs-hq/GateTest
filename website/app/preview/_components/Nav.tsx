"use client";

import { useEffect, useRef, useState } from "react";
import { I } from "../_lib/icons";

const ARCHITECTURE_MENU = [
  {
    icon: I.shield,
    title: "Security Auditing",
    count: 22,
    blurb: "SSRF, injection, secrets, supply chain, TLS, auth flaws.",
  },
  {
    icon: I.type,
    title: "Type Verification",
    count: 14,
    blurb: "Strictness regressions, any-leaks, contract drift.",
  },
  {
    icon: I.gauge,
    title: "Performance Bottlenecks",
    count: 12,
    blurb: "N+1 queries, resource leaks, unbounded retries.",
  },
  {
    icon: I.bug,
    title: "Deep Edge Cases",
    count: 11,
    blurb: "Race conditions, async iteration, datetime traps.",
  },
  {
    icon: I.server,
    title: "Infra & CI Hardening",
    count: 12,
    blurb: "Dockerfile, Terraform, K8s, GitHub Actions pinning.",
  },
  {
    icon: I.sparkle,
    title: "AI-Output Integrity",
    count: 7,
    blurb: "Hallucinated APIs, fake-fix patches, mock-data leaks.",
  },
];

export function NavBar() {
  const [open, setOpen] = useState(false); // mega dropdown
  const [scrolled, setScrolled] = useState(false);
  const [mobile, setMobile] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const hoverOpen = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hoverClose = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  return (
    <header className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
      <nav
        className={`w-full max-w-6xl rounded-2xl border transition-all duration-300 ${
          scrolled
            ? "border-white/10 bg-[#0a0c12]/80 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl"
            : "border-white/[0.06] bg-white/[0.02] backdrop-blur-md"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-2.5 sm:px-5">
          {/* Brand */}
          <a href="#top" className="flex items-center gap-2.5">
            <span className="relative grid h-8 w-8 place-items-center rounded-lg border border-teal-300/20 bg-gradient-to-br from-teal-400/20 to-emerald-500/5">
              <I.shield className="h-4 w-4 text-teal-300" />
              <span className="absolute inset-0 rounded-lg shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-white">
              Gate<span className="text-teal-300">Test</span>
            </span>
          </a>

          {/* Center links */}
          <div className="hidden items-center gap-1 md:flex">
            <div
              className="relative"
              onMouseEnter={hoverOpen}
              onMouseLeave={hoverClose}
            >
              <button
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-zinc-300 transition-colors hover:text-white"
                aria-expanded={open}
              >
                120 Checks Architecture
                <I.chevron
                  className={`h-3.5 w-3.5 transition-transform duration-200 ${
                    open ? "rotate-180" : ""
                  }`}
                />
              </button>

              {/* Mega dropdown */}
              <div
                className={`absolute left-1/2 top-full w-[600px] -translate-x-1/2 pt-3 transition-all duration-200 ${
                  open
                    ? "pointer-events-auto translate-y-0 opacity-100"
                    : "pointer-events-none translate-y-1 opacity-0"
                }`}
              >
                <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0a0c12]/95 p-2 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.85)] backdrop-blur-2xl">
                  <div className="grid grid-cols-2 gap-1">
                    {ARCHITECTURE_MENU.map((m) => (
                      <a
                        key={m.title}
                        href="#bento"
                        className="group flex gap-3 rounded-xl p-3 transition-colors hover:bg-white/[0.04]"
                      >
                        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-teal-300">
                          <m.icon className="h-4.5 w-4.5" />
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 text-sm font-medium text-white">
                            {m.title}
                            <span className="rounded-full border border-teal-300/20 bg-teal-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-teal-300">
                              {m.count}
                            </span>
                          </span>
                          <span className="mt-0.5 block text-xs leading-snug text-zinc-400">
                            {m.blurb}
                          </span>
                        </span>
                      </a>
                    ))}
                  </div>
                  <a
                    href="#bento"
                    className="mt-1 flex items-center justify-between rounded-xl border-t border-white/10 px-3 pb-1 pt-3 text-sm text-zinc-300 transition-colors hover:text-white"
                  >
                    <span>See the full 120-module matrix</span>
                    <I.arrow className="h-4 w-4" />
                  </a>
                </div>
              </div>
            </div>

            <a
              href="#playground"
              className="rounded-lg px-3 py-2 text-sm text-zinc-300 transition-colors hover:text-white"
            >
              Docs
            </a>
            <a
              href="#pricing"
              className="rounded-lg px-3 py-2 text-sm text-zinc-300 transition-colors hover:text-white"
            >
              Pricing
            </a>
          </div>

          {/* Right CTAs */}
          <div className="hidden items-center gap-2 md:flex">
            <a
              href="/scan/status"
              className="rounded-lg px-3 py-2 text-sm text-zinc-300 transition-colors hover:text-white"
            >
              Sign in
            </a>
            <a
              href="#cta"
              className="group relative flex items-center gap-2 overflow-hidden rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-zinc-900 transition-transform hover:scale-[1.02]"
            >
              <I.github className="h-4 w-4" />
              Connect Repository
            </a>
          </div>

          {/* Mobile toggle */}
          <button
            onClick={() => setMobile((v) => !v)}
            className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 text-zinc-300 md:hidden"
            aria-label="Menu"
          >
            <div className="space-y-1.5">
              <span
                className={`block h-px w-5 bg-current transition-transform ${
                  mobile ? "translate-y-[6px] rotate-45" : ""
                }`}
              />
              <span
                className={`block h-px w-5 bg-current transition-opacity ${
                  mobile ? "opacity-0" : ""
                }`}
              />
              <span
                className={`block h-px w-5 bg-current transition-transform ${
                  mobile ? "-translate-y-[6px] -rotate-45" : ""
                }`}
              />
            </div>
          </button>
        </div>

        {/* Mobile sheet */}
        {mobile && (
          <div className="border-t border-white/10 px-4 py-3 md:hidden">
            <div className="flex flex-col gap-1">
              <a href="#bento" className="rounded-lg px-3 py-2.5 text-sm text-zinc-300">
                120 Checks Architecture
              </a>
              <a href="#playground" className="rounded-lg px-3 py-2.5 text-sm text-zinc-300">
                Docs
              </a>
              <a href="#pricing" className="rounded-lg px-3 py-2.5 text-sm text-zinc-300">
                Pricing
              </a>
              <a
                href="#cta"
                className="mt-1 flex items-center justify-center gap-2 rounded-lg bg-white px-3.5 py-2.5 text-sm font-semibold text-zinc-900"
              >
                <I.github className="h-4 w-4" />
                Connect Repository
              </a>
            </div>
          </div>
        )}
      </nav>
    </header>
  );
}
