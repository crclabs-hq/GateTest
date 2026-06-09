import { I } from "../_lib/icons";
import { Reveal } from "./Reveal";

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
      "tsconfig strictness regressions, any-leaks across exported signatures, contract drift, unreasoned ts-ignore directives.",
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

export function Bento() {
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
