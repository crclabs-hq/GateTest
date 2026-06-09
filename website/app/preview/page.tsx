"use client";

/**
 * GateTest.ai — standalone premium homepage (greenfield prototype).
 *
 * Self-contained: every sub-component, all local state, and the motion layer
 * live in this file. No imports from the legacy marketing components, no new
 * dependencies (motion is hand-rolled CSS + IntersectionObserver). Deploys to
 * /preview for review before any live swap.
 *
 * Aesthetic: deep-ink "developer-luxe" — razor-thin borders, glass panels,
 * teal/emerald brand glow, mono code surfaces.
 */

import { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/*  Motion primitives                                                  */
/* ------------------------------------------------------------------ */

/** Reveal-on-scroll wrapper. Pure IntersectionObserver, no library. */
function Reveal({
  children,
  delay = 0,
  className = "",
  as: Tag = "div",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: React.ElementType;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setShown(true);
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={`gt-reveal ${shown ? "gt-in" : ""} ${className}`}
    >
      {children}
    </Tag>
  );
}

/* ------------------------------------------------------------------ */
/*  Iconography (inline, stroke-based, no icon dep)                    */
/* ------------------------------------------------------------------ */

type IconProps = { className?: string };
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const I = {
  shield: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M12 3l7 3v5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  gauge: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M4 18a8 8 0 1116 0" />
      <path d="M12 18l4-5" />
      <circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  branch: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="9" r="2.2" />
      <path d="M6 8.2v7.6M8.2 6h4a3.8 3.8 0 013.8 3" />
    </svg>
  ),
  bug: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <rect x="8" y="8" width="8" height="11" rx="4" />
      <path d="M9 5l1.5 2M15 5l-1.5 2M4 11h4M16 11h4M4 16h4M16 16h4M12 8v11" />
    </svg>
  ),
  type: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M4 7V5h16v2M9 19h6M12 5v14" />
    </svg>
  ),
  cube: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </svg>
  ),
  key: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <circle cx="8" cy="8" r="3.5" />
      <path d="M10.5 10.5L20 20M16 16l2-2M14 14l2-2" />
    </svg>
  ),
  server: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <rect x="4" y="5" width="16" height="6" rx="1.5" />
      <rect x="4" y="13" width="16" height="6" rx="1.5" />
      <path d="M7.5 8h.01M7.5 16h.01" />
    </svg>
  ),
  eye: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  ),
  sparkle: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
    </svg>
  ),
  flask: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M9 3h6M10 3v6l-4.5 8a2 2 0 001.8 3h9.4a2 2 0 001.8-3L14 9V3" />
      <path d="M7.5 15h9" />
    </svg>
  ),
  check: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M5 12l4.5 4.5L19 7" />
    </svg>
  ),
  arrow: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
  chevron: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  github: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} fill="currentColor">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49l-.01-1.7c-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.36 1.12 2.94.86.09-.67.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05a9.34 9.34 0 015 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.79-4.58 5.05.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.02 10.02 0 0022 12.25C22 6.58 17.52 2 12 2z" />
    </svg>
  ),
  lock: (p: IconProps) => (
    <svg viewBox="0 0 24 24" className={p.className} {...stroke}>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 018 0v3" />
    </svg>
  ),
};

/* ------------------------------------------------------------------ */
/*  Navigation                                                         */
/* ------------------------------------------------------------------ */

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

function NavBar() {
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
                110 Checks Architecture
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
                    <span>See the full 110-module matrix</span>
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
                110 Checks Architecture
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

/* ------------------------------------------------------------------ */
/*  Hero — live mock code review                                       */
/* ------------------------------------------------------------------ */

const REVIEW_COMMENTS = [
  {
    sev: "critical",
    line: "L42",
    rule: "moneyFloat",
    text: "parseFloat() on a currency value — IEEE-754 drift. Use Decimal.",
  },
  {
    sev: "high",
    line: "L57",
    rule: "ssrf",
    text: "req.body.url reaches fetch() with no allowlist. SSRF vector.",
  },
  {
    sev: "medium",
    line: "L88",
    rule: "raceCondition",
    text: "findUnique → create with no transaction. Lost-update risk.",
  },
];

const sevColor: Record<string, string> = {
  critical: "text-rose-400 bg-rose-500/10 border-rose-500/20",
  high: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  medium: "text-sky-400 bg-sky-500/10 border-sky-500/20",
};

function HeroMock() {
  const [visible, setVisible] = useState(0);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      const raf = requestAnimationFrame(() =>
        setVisible(REVIEW_COMMENTS.length),
      );
      return () => cancelAnimationFrame(raf);
    }
    const id = setInterval(() => {
      setVisible((v) => {
        if (v >= REVIEW_COMMENTS.length) {
          clearInterval(id);
          return v;
        }
        return v + 1;
      });
    }, 900);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="gt-tilt relative rounded-2xl border border-white/10 bg-[#0a0c12]/70 shadow-[0_40px_120px_-40px_rgba(13,148,136,0.45)] backdrop-blur-xl">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
        <span className="ml-2 font-mono text-[11px] text-zinc-500">
          checkout/route.ts · GateTest review
        </span>
        <span className="ml-auto flex items-center gap-1.5 rounded-full border border-teal-300/20 bg-teal-400/10 px-2 py-0.5 text-[10px] font-medium text-teal-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-300" />
          scanning
        </span>
      </div>

      {/* code body */}
      <div className="grid gap-px bg-white/[0.04] sm:grid-cols-[1fr]">
        <pre className="overflow-hidden bg-[#070910] p-4 font-mono text-[12.5px] leading-relaxed text-zinc-300">
          <code>
            <span className="text-zinc-600">42 </span>
            <span className="text-sky-300">const</span> total ={" "}
            <span className="text-amber-300">parseFloat</span>
            (req.body.amount);{"\n"}
            <span className="text-zinc-600">57 </span>
            <span className="text-sky-300">const</span> res ={" "}
            <span className="text-sky-300">await</span>{" "}
            <span className="text-amber-300">fetch</span>(req.body.url);{"\n"}
            <span className="text-zinc-600">88 </span>
            <span className="text-sky-300">await</span> db.user.
            <span className="text-amber-300">create</span>({"{ "}data {"}"});
          </code>
        </pre>
      </div>

      {/* review thread */}
      <div className="space-y-2 p-4">
        {REVIEW_COMMENTS.map((c, i) => (
          <div
            key={c.rule}
            className={`flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 transition-all duration-500 ${
              i < visible
                ? "translate-y-0 opacity-100"
                : "pointer-events-none translate-y-2 opacity-0"
            }`}
          >
            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border border-teal-300/20 bg-teal-400/10">
              <I.shield className="h-3.5 w-3.5 text-teal-300" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sevColor[c.sev]}`}
                >
                  {c.sev}
                </span>
                <span className="font-mono text-[11px] text-zinc-500">
                  {c.line}
                </span>
                <span className="font-mono text-[11px] text-teal-300/80">
                  {c.rule}
                </span>
              </div>
              <p className="mt-1 text-[13px] leading-snug text-zinc-300">
                {c.text}
              </p>
            </div>
          </div>
        ))}

        {/* PR result */}
        <div
          className={`flex items-center gap-3 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.07] p-3 transition-all duration-500 ${
            visible >= REVIEW_COMMENTS.length
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-2 opacity-0"
          }`}
        >
          <span className="grid h-6 w-6 place-items-center rounded-md bg-emerald-400/15 text-emerald-300">
            <I.branch className="h-3.5 w-3.5" />
          </span>
          <p className="text-[13px] font-medium text-emerald-200">
            Auto-fix PR #1284 opened — 3 issues resolved, 2 regression tests
            added.
          </p>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section id="top" className="relative overflow-hidden px-4 pb-24 pt-36 sm:pt-40">
      {/* ambient glows */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(60% 50% at 50% -8%, rgba(13,148,136,0.20), transparent 60%), radial-gradient(40% 40% at 85% 20%, rgba(56,189,248,0.10), transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.18]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage:
            "radial-gradient(70% 55% at 50% 0%, #000 30%, transparent 75%)",
          WebkitMaskImage:
            "radial-gradient(70% 55% at 50% 0%, #000 30%, transparent 75%)",
        }}
      />

      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
        {/* Left column */}
        <div>
          <Reveal>
            <a
              href="#bento"
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-teal-300/30 hover:text-white"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-teal-300" />
              110+ unified checks · auto-fix pull requests
              <I.arrow className="h-3.5 w-3.5 text-teal-300" />
            </a>
          </Reveal>

          <Reveal delay={60}>
            <h1 className="mt-6 font-display text-[clamp(2.6rem,6vw,4.4rem)] font-bold leading-[1.02] tracking-tight text-white">
              AI writes fast.
              <br />
              <span className="bg-gradient-to-r from-teal-200 via-teal-300 to-emerald-300 bg-clip-text text-transparent">
                GateTest keeps it honest.
              </span>
            </h1>
          </Reveal>

          <Reveal delay={120}>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-zinc-400">
              The enterprise QA guardrail for the AI-assisted era. Hook GateTest
              into your repo and ship every commit through{" "}
              <span className="text-zinc-200">110+ deep checks</span> — security,
              memory leaks, type safety, edge cases, architecture — in one
              unified scan. Every issue comes back as an{" "}
              <span className="text-zinc-200">auto-fix pull request</span>, not
              just another alert.
            </p>
          </Reveal>

          <Reveal delay={180}>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href="#cta"
                className="group flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-zinc-900 shadow-[0_8px_30px_-8px_rgba(255,255,255,0.4)] transition-transform hover:scale-[1.02]"
              >
                <I.github className="h-4.5 w-4.5" />
                Connect Repository
                <I.arrow className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </a>
              <a
                href="#pipeline"
                className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-5 py-3 text-sm font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.05]"
              >
                <I.eye className="h-4.5 w-4.5 text-teal-300" />
                Watch a live scan
              </a>
            </div>
          </Reveal>

          <Reveal delay={240}>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-zinc-500">
              <span className="flex items-center gap-1.5">
                <I.check className="h-4 w-4 text-teal-300" />
                No subscription — pay per scan
              </span>
              <span className="flex items-center gap-1.5">
                <I.check className="h-4 w-4 text-teal-300" />
                Quick scan under 15s
              </span>
              <span className="flex items-center gap-1.5">
                <I.check className="h-4 w-4 text-teal-300" />
                SOC 2–aligned controls
              </span>
            </div>
          </Reveal>
        </div>

        {/* Right column — mock */}
        <Reveal delay={160} className="lg:pl-4">
          <HeroMock />
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Trust strip                                                        */
/* ------------------------------------------------------------------ */

const REPLACES = [
  "SonarQube",
  "Snyk",
  "ESLint",
  "Dependabot",
  "tfsec",
  "Checkov",
  "gitleaks",
  "CodeQL",
];

function TrustStrip() {
  return (
    <section className="border-y border-white/[0.06] px-4 py-8">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <p className="text-center text-xs uppercase tracking-[0.2em] text-zinc-500">
            One scan replaces the whole fragmented stack
          </p>
        </Reveal>
        <Reveal delay={80}>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {REPLACES.map((name) => (
              <span
                key={name}
                className="text-base font-medium text-zinc-500 line-through decoration-rose-400/40 decoration-2"
              >
                {name}
              </span>
            ))}
            <span className="flex items-center gap-2 rounded-full border border-teal-300/20 bg-teal-400/10 px-3 py-1 text-sm font-semibold text-teal-200">
              <I.shield className="h-4 w-4" />
              GateTest
            </span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Scan-to-PR pipeline                                                */
/* ------------------------------------------------------------------ */

const STAGES = [
  {
    key: "scan",
    icon: I.eye,
    label: "Scan initiated",
    sub: "Repo hooked. 110 modules fan out across every file in parallel.",
    metric: "12,480 files",
    metricLabel: "indexed",
  },
  {
    key: "detect",
    icon: I.bug,
    label: "Issues detected",
    sub: "Findings clustered to root causes, ranked by blast radius.",
    metric: "37 root causes",
    metricLabel: "from 912 findings",
  },
  {
    key: "fix",
    icon: I.branch,
    label: "Auto-fix PR generated",
    sub: "Validated fixes + regression tests, opened straight to your branch.",
    metric: "PR #1284",
    metricLabel: "ready to merge",
  },
];

function Pipeline() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      const raf = requestAnimationFrame(() => setActive(STAGES.length - 1));
      return () => cancelAnimationFrame(raf);
    }
    const id = setInterval(
      () => setActive((a) => (a + 1) % STAGES.length),
      2200,
    );
    return () => clearInterval(id);
  }, [paused]);

  return (
    <section id="pipeline" className="px-4 py-24">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-300">
              The Scan-to-PR engine
            </p>
            <h2 className="mt-3 font-display text-[clamp(2rem,4vw,3rem)] font-bold tracking-tight text-white">
              From red flag to merged fix — without leaving the PR
            </h2>
            <p className="mt-4 text-lg text-zinc-400">
              Most tools stop at the alert. GateTest closes the loop: detect,
              diagnose, fix, and prove the fix with a generated test.
            </p>
          </div>
        </Reveal>

        <Reveal delay={100}>
          <div
            className="mt-14"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
          >
            <div className="grid gap-4 md:grid-cols-3 md:gap-0">
              {STAGES.map((s, i) => {
                const on = i <= active;
                const current = i === active;
                return (
                  <div key={s.key} className="relative flex flex-col">
                    {/* connector */}
                    {i < STAGES.length - 1 && (
                      <div className="absolute left-1/2 top-7 hidden h-px w-full md:block">
                        <div className="h-px w-full bg-white/10" />
                        <div
                          className="absolute inset-0 h-px bg-gradient-to-r from-teal-300 to-emerald-300 transition-all duration-700"
                          style={{ width: i < active ? "100%" : "0%" }}
                        />
                        {i < active && (
                          <span className="absolute right-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-emerald-300 shadow-[0_0_10px_2px_rgba(110,231,183,0.7)]" />
                        )}
                      </div>
                    )}

                    {/* node */}
                    <button
                      onClick={() => setActive(i)}
                      className="relative z-10 mx-auto grid h-14 w-14 place-items-center rounded-2xl border transition-all duration-500"
                      style={{
                        borderColor: on
                          ? "rgba(45,212,191,0.4)"
                          : "rgba(255,255,255,0.1)",
                        background: on
                          ? "linear-gradient(135deg, rgba(45,212,191,0.18), rgba(16,185,129,0.06))"
                          : "rgba(255,255,255,0.02)",
                        boxShadow: current
                          ? "0 0 0 6px rgba(45,212,191,0.10), 0 0 40px -6px rgba(45,212,191,0.6)"
                          : "none",
                      }}
                      aria-label={s.label}
                    >
                      <s.icon
                        className={`h-6 w-6 transition-colors ${
                          on ? "text-teal-200" : "text-zinc-500"
                        }`}
                      />
                      {current && (
                        <span className="absolute inset-0 rounded-2xl border border-teal-300/40 gt-ping" />
                      )}
                    </button>

                    {/* card */}
                    <div
                      className={`mx-2 mt-5 rounded-2xl border p-5 text-center transition-all duration-500 md:mx-3 ${
                        current
                          ? "border-teal-300/25 bg-white/[0.04]"
                          : "border-white/[0.06] bg-white/[0.015]"
                      }`}
                    >
                      <h3 className="text-base font-semibold text-white">
                        {s.label}
                      </h3>
                      <p className="mt-2 text-sm leading-snug text-zinc-400">
                        {s.sub}
                      </p>
                      <div className="mt-4 rounded-lg border border-white/[0.06] bg-[#070910] px-3 py-2">
                        <div className="font-mono text-sm font-semibold text-teal-200">
                          {s.metric}
                        </div>
                        <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                          {s.metricLabel}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  110-check bento matrix                                             */
/* ------------------------------------------------------------------ */

const BENTO = [
  {
    icon: I.shield,
    title: "Security Auditing",
    count: 22,
    span: "lg:col-span-2 lg:row-span-2",
    feature: true,
    blurb:
      "SSRF taint-tracking, injection, hardcoded secrets, TLS-bypass, cookie hardening, supply-chain pinning, and full auth-flow analysis.",
    chips: ["SSRF", "Injection", "Secrets", "Supply chain", "TLS", "Auth"],
  },
  {
    icon: I.type,
    title: "Type Verification",
    count: 14,
    blurb:
      "tsconfig strictness regressions, any-leaks across exported signatures, contract drift, @ts-ignore abuse.",
    chips: ["strict", "no-any", "contracts"],
  },
  {
    icon: I.gauge,
    title: "Performance Bottlenecks",
    count: 12,
    blurb:
      "N+1 queries inside loops, unclosed streams & handles, unbounded retry storms, catastrophic regex.",
    chips: ["N+1", "Leaks", "ReDoS"],
  },
  {
    icon: I.bug,
    title: "Deep Edge Cases",
    count: 11,
    blurb:
      "Race conditions, check-then-act TOCTOU, async-iteration footguns, timezone & 0-indexed-month traps.",
    chips: ["TOCTOU", "async", "datetime"],
  },
  {
    icon: I.server,
    title: "Infra & CI Hardening",
    count: 12,
    blurb:
      "Dockerfile, Terraform/IaC, Kubernetes manifests, GitHub Actions SHA-pinning & pwn-request defense.",
    chips: ["Docker", "Terraform", "K8s", "Actions"],
  },
  {
    icon: I.key,
    title: "Secrets & Credentials",
    count: 9,
    blurb:
      "Git-aware rotation windows, .env ↔ .env.example drift, placeholder-shaped-like-real detection.",
    chips: ["Rotation", "Env drift"],
  },
  {
    icon: I.cube,
    title: "Architecture & Dead Code",
    count: 10,
    blurb:
      "Import cycles via Tarjan SCC, unused exports, orphaned files, OpenAPI ↔ route drift.",
    chips: ["Cycles", "Dead code", "Drift"],
  },
  {
    icon: I.eye,
    title: "Accessibility & Web Standards",
    count: 8,
    blurb:
      "WCAG contrast & ARIA, security headers, CSP unsafe-eval, CORS misconfig, mixed-content.",
    chips: ["WCAG", "CSP", "CORS"],
  },
  {
    icon: I.sparkle,
    title: "AI-Output Integrity",
    count: 7,
    blurb:
      "Hallucinated packages & methods, fake-fix symptom patches, mock-data leaking into production.",
    chips: ["Hallucination", "Fake-fix"],
  },
  {
    icon: I.flask,
    title: "Test Quality & Mutation",
    count: 5,
    blurb:
      "Mutation testing proves your tests catch bugs, flaky-test detection, focused/skipped test guards.",
    chips: ["Mutation", "Flaky"],
  },
];

function Bento() {
  const total = BENTO.reduce((s, b) => s + b.count, 0);
  return (
    <section id="bento" className="px-4 py-24">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <div className="flex flex-col items-center gap-4 text-center md:flex-row md:items-end md:justify-between md:text-left">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-300">
                The 110-check architecture
              </p>
              <h2 className="mt-3 font-display text-[clamp(2rem,4vw,3rem)] font-bold tracking-tight text-white">
                Ten domains. One unified gate.
              </h2>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-3 text-center">
              <div className="font-display text-4xl font-bold text-teal-200">
                {total}
              </div>
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                checks per scan
              </div>
            </div>
          </div>
        </Reveal>

        <div className="mt-12 grid auto-rows-[1fr] gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {BENTO.map((b, i) => (
            <Reveal
              key={b.title}
              delay={(i % 4) * 60}
              className={b.span ?? ""}
            >
              <div
                className={`group relative h-full overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 transition-all duration-300 hover:border-teal-300/25 hover:bg-white/[0.04] ${
                  b.feature ? "lg:p-7" : ""
                }`}
              >
                {/* hover glow */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-100"
                  style={{ background: "rgba(45,212,191,0.18)" }}
                />
                <div className="relative flex items-center justify-between">
                  <span className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-white/[0.03] text-teal-300">
                    <b.icon className="h-5.5 w-5.5" />
                  </span>
                  <span className="font-mono text-sm font-semibold text-zinc-500">
                    {String(b.count).padStart(2, "0")}
                  </span>
                </div>
                <h3
                  className={`relative mt-4 font-semibold text-white ${
                    b.feature ? "text-xl" : "text-base"
                  }`}
                >
                  {b.title}
                </h3>
                <p
                  className={`relative mt-2 leading-snug text-zinc-400 ${
                    b.feature ? "text-base" : "text-sm"
                  }`}
                >
                  {b.blurb}
                </p>
                {b.chips && (
                  <div className="relative mt-4 flex flex-wrap gap-1.5">
                    {b.chips.map((c) => (
                      <span
                        key={c}
                        className="rounded-md border border-white/10 bg-white/[0.02] px-2 py-0.5 font-mono text-[10.5px] text-zinc-400"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Interactive code playground                                        */
/* ------------------------------------------------------------------ */

type Scenario = {
  id: string;
  label: string;
  rule: string;
  sev: string;
  before: { n: number; t: React.ReactNode }[];
  finding: string;
  fix: { n: number; t: React.ReactNode }[];
  test: string;
};

const C = {
  kw: (s: string) => <span className="text-sky-300">{s}</span>,
  fn: (s: string) => <span className="text-amber-300">{s}</span>,
  str: (s: string) => <span className="text-emerald-300">{s}</span>,
  com: (s: string) => <span className="text-zinc-600">{s}</span>,
  ok: (s: string) => <span className="text-teal-200">{s}</span>,
};

const SCENARIOS: Scenario[] = [
  {
    id: "money",
    label: "Currency drift",
    rule: "moneyFloat",
    sev: "critical",
    before: [
      { n: 1, t: <>{C.kw("const")} total = {C.fn("parseFloat")}(amount);</> },
      { n: 2, t: <>{C.kw("const")} tax = total * {C.str("0.0825")};</> },
      { n: 3, t: <>charge(total + tax); {C.com("// off by cents")}</> },
    ],
    finding:
      "parseFloat() stores money in IEEE-754 float — $0.01 × 1M drifts. Regulators call this fraud.",
    fix: [
      { n: 1, t: <>{C.kw("import")} {`{ Decimal }`} {C.kw("from")} {C.str("\"decimal.js\"")};</> },
      { n: 2, t: <>{C.kw("const")} total = {C.ok("new Decimal")}(amount);</> },
      { n: 3, t: <>{C.kw("const")} tax = total.{C.fn("times")}({C.str("0.0825")});</> },
      { n: 4, t: <>charge(total.{C.fn("plus")}(tax).{C.fn("toFixed")}({C.str("2")}));</> },
    ],
    test: "expect(charge(0.1, 0.2)).toBe('0.30') // not 0.30000000004",
  },
  {
    id: "ssrf",
    label: "SSRF",
    rule: "ssrf",
    sev: "high",
    before: [
      { n: 1, t: <>{C.kw("const")} url = req.body.url;</> },
      { n: 2, t: <>{C.kw("const")} r = {C.kw("await")} {C.fn("fetch")}(url);</> },
      { n: 3, t: <>res.{C.fn("json")}({C.kw("await")} r.{C.fn("json")}());</> },
    ],
    finding:
      "User-controlled URL reaches fetch() with no allowlist — attacker pivots to 169.254.169.254 metadata.",
    fix: [
      { n: 1, t: <>{C.kw("const")} url = {C.fn("assertAllowed")}(req.body.url);</> },
      { n: 2, t: <>{C.com("// host checked against ALLOWLIST set")}</> },
      { n: 3, t: <>{C.kw("const")} r = {C.kw("await")} {C.fn("fetch")}(url);</> },
      { n: 4, t: <>res.{C.fn("json")}({C.kw("await")} r.{C.fn("json")}());</> },
    ],
    test: "expect(() => assertAllowed('http://169.254.169.254')).toThrow()",
  },
  {
    id: "race",
    label: "Race condition",
    rule: "raceCondition",
    sev: "medium",
    before: [
      { n: 1, t: <>{C.kw("let")} u = {C.kw("await")} db.{C.fn("findUnique")}({`{ email }`});</> },
      { n: 2, t: <>{C.kw("if")} (!u)</> },
      { n: 3, t: <>{"  "}u = {C.kw("await")} db.{C.fn("create")}({`{ email }`});</> },
    ],
    finding:
      "Check-then-act with no transaction. Two concurrent signups → duplicate users, lost update.",
    fix: [
      { n: 1, t: <>{C.kw("const")} u = {C.kw("await")} db.{C.fn("upsert")}({`{`}</> },
      { n: 2, t: <>{"  "}where: {`{ email }`}, {C.fn("create")}: {`{ email }`},</> },
      { n: 3, t: <>{"  "}update: {`{}`}, {C.com("// atomic ON CONFLICT")}</> },
      { n: 4, t: <>{`}`});</> },
    ],
    test: "await Promise.all([signup(e), signup(e)]); expect(count(e)).toBe(1)",
  },
];

const sevPill: Record<string, string> = {
  critical: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  high: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  medium: "border-sky-500/30 bg-sky-500/10 text-sky-300",
};

function Playground() {
  const [active, setActive] = useState(0);
  const s = SCENARIOS[active];

  return (
    <section id="playground" className="px-4 py-24">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-300">
              See it on real code
            </p>
            <h2 className="mt-3 font-display text-[clamp(2rem,4vw,3rem)] font-bold tracking-tight text-white">
              The bug, the diagnosis, the merged fix
            </h2>
            <p className="mt-4 text-lg text-zinc-400">
              Pick a finding. GateTest doesn&apos;t just flag it — it rewrites the
              code and writes the test that proves the bug is dead.
            </p>
          </div>
        </Reveal>

        {/* tabs */}
        <Reveal delay={80}>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-2">
            {SCENARIOS.map((sc, i) => (
              <button
                key={sc.id}
                onClick={() => setActive(i)}
                className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-all ${
                  i === active
                    ? "border-teal-300/30 bg-teal-400/10 text-teal-200"
                    : "border-white/10 bg-white/[0.02] text-zinc-400 hover:text-white"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    i === active ? "bg-teal-300" : "bg-zinc-600"
                  }`}
                />
                {sc.label}
              </button>
            ))}
          </div>
        </Reveal>

        <Reveal delay={120}>
          <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/[0.06] lg:grid-cols-2">
            {/* BEFORE */}
            <div className="bg-[#070910]">
              <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
                <span className="font-mono text-[11px] text-zinc-500">
                  your-code.ts
                </span>
                <span
                  className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sevPill[s.sev]}`}
                >
                  {s.sev} · {s.rule}
                </span>
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-7">
                <code>
                  {s.before.map((l) => (
                    <div key={l.n} className="flex">
                      <span className="mr-4 select-none text-zinc-700">
                        {String(l.n).padStart(2, "0")}
                      </span>
                      <span className="text-zinc-300">{l.t}</span>
                    </div>
                  ))}
                </code>
              </pre>
              <div className="mx-5 mb-5 flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                <I.bug className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                <p className="text-[12.5px] leading-snug text-zinc-400">
                  {s.finding}
                </p>
              </div>
            </div>

            {/* AFTER */}
            <div className="relative bg-[#06100d]">
              <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
                <span className="flex items-center gap-2 font-mono text-[11px] text-emerald-300/80">
                  <I.branch className="h-3.5 w-3.5" />
                  gatetest-autofix.ts
                </span>
                <span className="rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                  resolved
                </span>
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-7">
                <code>
                  {s.fix.map((l) => (
                    <div key={l.n} className="flex">
                      <span className="mr-4 select-none text-emerald-900">
                        {String(l.n).padStart(2, "0")}
                      </span>
                      <span className="text-zinc-200">{l.t}</span>
                    </div>
                  ))}
                </code>
              </pre>
              <div className="mx-5 mb-5 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.06] p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-300">
                  <I.flask className="h-3.5 w-3.5" />
                  regression test added
                </div>
                <code className="block font-mono text-[12px] leading-snug text-emerald-200/90">
                  {s.test}
                </code>
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal delay={160}>
          <p className="mt-5 text-center font-mono text-xs text-zinc-500">
            $ gatetest scan --fix --tier full{"   "}
            <span className="text-teal-300">
              → 1 PR opened, {SCENARIOS.length} checks shown of 110
            </span>
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Enterprise trust                                                   */
/* ------------------------------------------------------------------ */

const STATS = [
  { v: "110+", l: "checks per unified scan" },
  { v: "<15s", l: "quick-scan wall time" },
  { v: "10+", l: "fragmented tools replaced" },
  { v: "100×", l: "margin vs. manual review" },
];

const POSTURE = [
  {
    icon: I.lock,
    t: "Least-privilege by design",
    d: "Read scoped access, ephemeral runners, no long-lived credentials stored.",
  },
  {
    icon: I.shield,
    t: "Fail-closed webhooks",
    d: "Every event is HMAC-verified. Missing secret rejects — never fails open.",
  },
  {
    icon: I.eye,
    t: "Evidence on every gate",
    d: "Each pass produces a timestamped report. Audit-ready by construction.",
  },
];

function Enterprise() {
  return (
    <section id="enterprise" className="px-4 py-24">
      <div className="mx-auto max-w-6xl">
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_1fr]">
          <Reveal>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-300">
                Built for engineering leadership
              </p>
              <h2 className="mt-3 font-display text-[clamp(2rem,4vw,3rem)] font-bold tracking-tight text-white">
                Unlock AI velocity without surrendering control
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-zinc-400">
                Your team is shipping AI-generated code at record speed. GateTest
                is the gate that keeps that speed honest — a single,
                policy-driven checkpoint your CTO can stand behind in front of
                the board.
              </p>

              <div className="mt-8 space-y-3">
                {POSTURE.map((p) => (
                  <div
                    key={p.t}
                    className="flex items-start gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4"
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-teal-300">
                      <p.icon className="h-4.5 w-4.5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-white">
                        {p.t}
                      </h3>
                      <p className="mt-0.5 text-sm text-zinc-400">{p.d}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>

          <Reveal delay={100}>
            <div>
              <div className="grid grid-cols-2 gap-4">
                {STATS.map((s) => (
                  <div
                    key={s.l}
                    className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6"
                  >
                    <div className="font-display text-4xl font-bold text-teal-200">
                      {s.v}
                    </div>
                    <div className="mt-1 text-sm text-zinc-400">{s.l}</div>
                  </div>
                ))}
              </div>

              <figure className="mt-4 rounded-2xl border border-white/[0.07] bg-gradient-to-br from-teal-500/[0.07] to-transparent p-6">
                <blockquote className="text-[17px] leading-relaxed text-zinc-200">
                  &ldquo;We let the AI write at full throttle. GateTest is the
                  reason we can sleep at night — every PR is gated, fixed, and
                  proven before a human ever looks at it.&rdquo;
                </blockquote>
                <figcaption className="mt-4 flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-teal-400/15 font-semibold text-teal-200">
                    VP
                  </span>
                  <span className="text-sm">
                    <span className="block font-medium text-white">
                      VP of Engineering
                    </span>
                    <span className="block text-zinc-500">
                      Series-B fintech platform
                    </span>
                  </span>
                </figcaption>
              </figure>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Final CTA + footer                                                 */
/* ------------------------------------------------------------------ */

function FinalCTA() {
  return (
    <section id="cta" className="px-4 py-24">
      <div className="mx-auto max-w-5xl">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#0a0c12] p-10 text-center sm:p-16">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(60% 80% at 50% 0%, rgba(13,148,136,0.25), transparent 60%)",
              }}
            />
            <div className="relative">
              <h2 className="mx-auto max-w-2xl font-display text-[clamp(2rem,5vw,3.4rem)] font-bold leading-[1.05] tracking-tight text-white">
                Connect your repo. Get a fixed PR back.
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-lg text-zinc-400">
                One scan. 110+ checks. Real fixes with tests. Pay per scan — no
                subscription, no seat licenses, no risk.
              </p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <a
                  href="/scan/status"
                  className="group flex items-center gap-2 rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-zinc-900 shadow-[0_8px_30px_-6px_rgba(255,255,255,0.45)] transition-transform hover:scale-[1.02]"
                >
                  <I.github className="h-5 w-5" />
                  Connect Repository
                  <I.arrow className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </a>
                <a
                  href="#pricing"
                  className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-6 py-3.5 text-sm font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.05]"
                >
                  View pricing
                </a>
              </div>
              <p
                id="pricing"
                className="mt-8 font-mono text-xs text-zinc-500"
              >
                Quick $29 · Full $99 · Scan + Fix $199 · Forensic $399
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/[0.06] px-4 py-12">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 sm:flex-row">
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-lg border border-teal-300/20 bg-teal-400/10">
            <I.shield className="h-4 w-4 text-teal-300" />
          </span>
          <span className="text-sm font-semibold text-white">
            Gate<span className="text-teal-300">Test</span>
          </span>
          <span className="ml-2 text-xs text-zinc-600">
            AI writes fast. GateTest keeps it honest.
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-zinc-400">
          <a href="#bento" className="hover:text-white">
            Architecture
          </a>
          <a href="#playground" className="hover:text-white">
            Docs
          </a>
          <a href="#pricing" className="hover:text-white">
            Pricing
          </a>
          <a href="/legal/terms" className="hover:text-white">
            Terms
          </a>
          <a href="/legal/privacy" className="hover:text-white">
            Privacy
          </a>
        </div>
      </div>
      <p className="mx-auto mt-8 max-w-6xl text-center text-xs text-zinc-600">
        © {new Date().getFullYear()} GateTest · Preview build — not the live
        homepage.
      </p>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function PreviewHomepage() {
  return (
    <main className="relative min-h-screen overflow-x-hidden bg-[#06070b] text-zinc-200 antialiased selection:bg-teal-400/20 selection:text-white">
      {/* scoped styles: keyframes + reveal + scroll behaviour */}
      <style>{`
        html { scroll-behavior: smooth; }
        .gt-preview-root { background: #06070b; }
        .gt-reveal {
          opacity: 0;
          transform: translateY(16px);
          transition: opacity 0.6s cubic-bezier(0.16,1,0.3,1),
                      transform 0.6s cubic-bezier(0.16,1,0.3,1);
          will-change: opacity, transform;
        }
        .gt-reveal.gt-in { opacity: 1; transform: translateY(0); }
        @keyframes gtPing {
          0% { transform: scale(1); opacity: 0.7; }
          80%,100% { transform: scale(1.5); opacity: 0; }
        }
        .gt-ping { animation: gtPing 1.8s cubic-bezier(0,0,0.2,1) infinite; }
        @keyframes gtFloat {
          0%,100% { transform: translateY(0) rotateX(0) rotateY(0); }
          50% { transform: translateY(-6px); }
        }
        .gt-tilt { animation: gtFloat 7s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          html { scroll-behavior: auto; }
          .gt-reveal { opacity: 1; transform: none; transition: none; }
          .gt-ping, .gt-tilt { animation: none; }
        }
      `}</style>

      <NavBar />
      <Hero />
      <TrustStrip />
      <Pipeline />
      <Bento />
      <Playground />
      <Enterprise />
      <FinalCTA />
      <Footer />
    </main>
  );
}
