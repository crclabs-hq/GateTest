import { I } from "../_lib/icons";
import { Reveal } from "./Reveal";

export function FinalCTA() {
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

export function Footer() {
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
