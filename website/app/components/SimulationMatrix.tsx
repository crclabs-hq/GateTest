"use client";

/**
 * SimulationMatrix — animated 3-panel demonstration of the fix pipeline.
 *
 * Left:   Bug intercept — a real finding with an amber fault line.
 * Centre: Three parallel hypothesis sandboxes (Alpha / Beta / Gamma).
 * Right:  Bidirectional gate output — Negative control FAIL, Positive PASS,
 *         CERTIFIED flash.
 *
 * Pure CSS + light React state — no third-party animation libraries.
 * Loops continuously so visitors who scroll in mid-cycle still see it.
 */

import { useEffect, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase = "idle" | "intercept" | "hypotheses" | "gate" | "certified";

const PHASE_MS: Record<Phase, number> = {
  idle:        800,
  intercept:   1600,
  hypotheses:  2800,
  gate:        2000,
  certified:   1800,
};

const PHASES: Phase[] = ["idle", "intercept", "hypotheses", "gate", "certified"];

// ── Sub-components ────────────────────────────────────────────────────────────

function Panel({ title, children, className = "" }: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden ${className}`}>
      <div className="px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/60 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-zinc-600" />
        <span className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest">{title}</span>
      </div>
      <div className="p-4 flex-1">{children}</div>
    </div>
  );
}

function CodeLine({ text, highlighted, delay = 0 }: {
  text: string;
  highlighted?: boolean;
  delay?: number;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  return (
    <div
      className={`font-mono text-[11px] leading-5 transition-opacity duration-300 ${visible ? "opacity-100" : "opacity-0"} ${
        highlighted
          ? "relative pl-3 text-amber-300"
          : "text-zinc-400 pl-3"
      }`}
    >
      {highlighted && (
        <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-amber-400 rounded" />
      )}
      {text}
    </div>
  );
}

function HypothesisBar({ label, name, progress, status, delay = 0 }: {
  label: string;
  name: string;
  progress: number; // 0-100
  status: "running" | "passed" | "pending";
  delay?: number;
}) {
  const [animProgress, setAnimProgress] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      setAnimProgress(progress);
    }, delay + 200);
    return () => clearTimeout(t);
  }, [progress, delay]);

  const barColor =
    status === "passed"  ? "bg-emerald-500" :
    status === "running" ? "bg-teal-400"    : "bg-zinc-700";
  const labelColor =
    status === "passed"  ? "text-emerald-400" :
    status === "running" ? "text-teal-300"    : "text-zinc-600";

  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest w-4">{label}</span>
          <span className="font-mono text-[11px] text-zinc-400">{name}</span>
        </div>
        <span className={`font-mono text-[10px] font-semibold ${labelColor}`}>
          {status === "passed" ? "RANK 1" : status === "running" ? "..." : "QUEUE"}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${barColor}`}
          style={{ width: `${animProgress}%` }}
        />
      </div>
    </div>
  );
}

function GateLine({ text, type, visible }: {
  text: string;
  type: "neutral" | "fail" | "pass" | "certified";
  visible: boolean;
}) {
  const color =
    type === "fail"      ? "text-amber-400"  :
    type === "pass"      ? "text-emerald-400" :
    type === "certified" ? "text-emerald-300 font-bold" :
                           "text-zinc-500";
  const prefix =
    type === "fail"      ? "✗ " :
    type === "pass"      ? "✓ " :
    type === "certified" ? "◆ " : "  ";

  return (
    <div className={`font-mono text-[11px] leading-6 transition-all duration-500 ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"} ${color}`}>
      {prefix}{text}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function SimulationMatrix() {
  const [phase, setPhase] = useState<Phase>("idle");

  // Cycle through phases in a loop
  useEffect(() => {
    let idx = 0;
    function tick() {
      idx = (idx + 1) % PHASES.length;
      const next = PHASES[idx];
      setPhase(next);
      return PHASE_MS[next];
    }
    let timeout: ReturnType<typeof setTimeout>;
    function schedule(delay: number) {
      timeout = setTimeout(() => schedule(tick()), delay);
    }
    schedule(PHASE_MS["idle"]);
    return () => clearTimeout(timeout);
  }, []);

  const showCode       = phase !== "idle";
  const showHypotheses = phase === "hypotheses" || phase === "gate" || phase === "certified";
  const showGate       = phase === "gate" || phase === "certified";
  const showCertified  = phase === "certified";

  return (
    <section className="py-24 px-6 bg-zinc-950 border-t border-zinc-900">
      <div className="mx-auto max-w-6xl">

        {/* Header */}
        <div className="text-center mb-12">
          <span className="inline-block text-[11px] font-mono uppercase tracking-[0.2em] text-teal-500 mb-4">
            Repair Pipeline
          </span>
          <h2 className="text-2xl sm:text-3xl font-bold text-zinc-100 mb-3">
            Finding → Sandboxes → Certified PR
          </h2>
          <p className="text-zinc-400 max-w-lg mx-auto text-sm leading-relaxed">
            Three independent repair hypotheses execute in parallel. The
            bidirectional gate certifies the winner before the PR opens.
          </p>
        </div>

        {/* Three-panel grid */}
        <div className="grid lg:grid-cols-3 gap-4 items-stretch">

          {/* Panel 1 — Interception */}
          <Panel title="Intercept · /api/auth.js">
            <div className={`space-y-0.5 transition-opacity duration-500 ${showCode ? "opacity-100" : "opacity-30"}`}>
              <CodeLine text="async function authenticate(req) {" delay={0} />
              <CodeLine text="  const token = req.headers.auth;" delay={80} />
              <CodeLine text="  const user = db.findUser(token);" highlighted delay={160} />
              <CodeLine text="  // ↑ missing await — race condition" highlighted delay={240} />
              <CodeLine text="  if (!user) return res.status(401);" delay={320} />
              <CodeLine text="  return user;" delay={400} />
              <CodeLine text="}" delay={480} />
            </div>

            {showCode && (
              <div className="mt-4 pt-3 border-t border-zinc-800">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  <span className="text-[10px] font-mono text-amber-400 uppercase tracking-widest">
                    asyncIteration · line 3
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 mt-1 font-mono">
                  await omitted — Promise coerced to truthy
                </p>
              </div>
            )}
          </Panel>

          {/* Panel 2 — Hypothesis Matrix */}
          <Panel title="Hypothesis Matrix · gt-hyp-*">
            <div className="space-y-0">
              <HypothesisBar
                label="α"
                name="gt-hyp-alpha"
                progress={showHypotheses ? 100 : 0}
                status={showHypotheses ? "passed" : "pending"}
                delay={0}
              />
              <HypothesisBar
                label="β"
                name="gt-hyp-beta"
                progress={showHypotheses ? 88 : 0}
                status={showHypotheses ? "passed" : "pending"}
                delay={300}
              />
              <HypothesisBar
                label="γ"
                name="gt-hyp-gamma"
                progress={showHypotheses ? 62 : 0}
                status={showHypotheses ? "running" : "pending"}
                delay={600}
              />
            </div>

            {showHypotheses && (
              <div className="mt-4 pt-3 border-t border-zinc-800 space-y-1.5">
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-zinc-500">Syntax gate</span>
                  <span className="text-emerald-400">3 / 3 PASS</span>
                </div>
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-zinc-500">Test gate</span>
                  <span className="text-emerald-400">2 / 3 PASS</span>
                </div>
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-zinc-500">Winner</span>
                  <span className="text-teal-300">α — lineDelta 2</span>
                </div>
              </div>
            )}
          </Panel>

          {/* Panel 3 — Gate Certification */}
          <Panel title="Bidirectional Gate">
            <div className="space-y-0.5 min-h-[140px]">
              <GateLine
                text="Running negative control…"
                type="neutral"
                visible={showGate}
              />
              <GateLine
                text="Test vs. buggy source"
                type="neutral"
                visible={showGate}
              />
              <GateLine
                text="Negative: FAILED (fault verified)"
                type="fail"
                visible={showGate}
              />
              <GateLine
                text="Running positive control…"
                type="neutral"
                visible={showGate}
              />
              <GateLine
                text="Test vs. fixed source"
                type="neutral"
                visible={showGate}
              />
              <GateLine
                text="Positive: PASSED (fix confirmed)"
                type="pass"
                visible={showGate}
              />
              <GateLine
                text=""
                type="neutral"
                visible={false}
              />
              <GateLine
                text="GATE: CERTIFIED — opening PR"
                type="certified"
                visible={showCertified}
              />
            </div>

            {showCertified && (
              <div className="mt-4 pt-3 border-t border-zinc-800">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                  </span>
                  <span className="text-[10px] font-mono text-emerald-400 uppercase tracking-widest">
                    PR · regression test included
                  </span>
                </div>
              </div>
            )}
          </Panel>
        </div>

        {/* Connecting arrow labels — visible on lg only */}
        <div className="hidden lg:flex items-center justify-center gap-0 mt-4 text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
          <span className="flex-1 text-right">Fault interception</span>
          <span className="px-6 text-zinc-700">──────▶──────</span>
          <span className="flex-1 text-center">Parallel evaluation</span>
          <span className="px-6 text-zinc-700">──────▶──────</span>
          <span className="flex-1 text-left">Certified output</span>
        </div>
      </div>
    </section>
  );
}
