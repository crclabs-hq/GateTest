import { I } from "../_lib/icons";
import { Reveal } from "./Reveal";

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

export function TrustStrip() {
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
