"use client";

import { useState } from "react";
import { I } from "../_lib/icons";
import { Reveal } from "./Reveal";

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
      "User-controlled URL reaches fetch() with no allowlist — attacker pivots to the cloud metadata endpoint.",
    fix: [
      { n: 1, t: <>{C.kw("const")} url = {C.fn("assertAllowed")}(req.body.url);</> },
      { n: 2, t: <>{C.com("// host checked against ALLOWLIST set")}</> },
      { n: 3, t: <>{C.kw("const")} r = {C.kw("await")} {C.fn("fetch")}(url);</> },
      { n: 4, t: <>res.{C.fn("json")}({C.kw("await")} r.{C.fn("json")}());</> },
    ],
    test: "expect(() => assertAllowed(req.body.url)).toThrow() // metadata IP blocked",
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

export function Playground() {
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
