import { I } from "../_lib/icons";
import { Reveal } from "./Reveal";

const STATS = [
  { v: "120+", l: "checks per unified scan" },
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

export function Enterprise() {
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

            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
