import Link from "next/link";

/**
 * <HomeHonest> — the six things that make a gate one developers can trust,
 * each named by the artefact that proves it exists. Capability copy, not
 * positioning: every line maps to a shipped feature and the file or command
 * that carries it (Sync Rule — capability lists are facts).
 */

const ITEMS: { title: string; body: string; proof: string; href?: string }[] = [
  {
    title: "It blocks on your new code, not your backlog",
    body: "The first run on a mature repo records what is already there and passes. Every run after fails only on findings that are new. Adoptable on day one, still able to say no.",
    proof: ".gatetest/baseline.json · --diff on pull requests",
    href: "/quickstart",
  },
  {
    title: "The PR comment shows only what the PR introduced",
    body: "Findings are attributed by changed line, not by file. A pre-existing warning three functions down does not become your problem because you touched the file.",
    proof: "inDiff / inChangedFile on every finding",
    href: "/github/setup",
  },
  {
    title: "It says what it did not check",
    body: "A deferred module, a missing toolchain, a scan that timed out — printed in the console, the PR comment and the JSON report. A pass from a fallback never wears the green tick.",
    proof: "Not checked: · Partial scan · provenance.modules.skipped",
  },
  {
    title: "Every false positive has a one-line answer",
    body: "Each finding carries the exact ignore line that silences it and nothing else. In a PR, reply with the command and it is done.",
    proof: ".gatetestignore · @gatetest ignore <module:rule>",
  },
  {
    title: "Reports are signed and reproducible",
    body: "Every JSON report carries provenance and an HMAC signature. A CI job asserts the same tree gives the same findings, run after run.",
    proof: "gatetest verify-report <file> · determinism gate",
    href: "/trust",
  },
  {
    title: "A red CI reproduces locally in one command",
    body: "The blocked gate leads with the replay command for that run, so the fix starts on your machine, not in a log viewer.",
    proof: "gatetest replay <run-url>",
  },
];

export default function HomeHonest() {
  return (
    <section id="honest" className="max-w-6xl mx-auto my-20 px-4">
      <div className="text-center mb-12">
        <p className="text-xs uppercase tracking-widest text-[var(--accent)] font-semibold mb-3">
          Built to be trusted, not tolerated
        </p>
        <h2 className="text-3xl md:text-4xl font-semibold text-[var(--foreground)] tracking-tight max-w-3xl mx-auto" style={{ textWrap: "balance" }}>
          The six habits that separate a gate from a linter with better marketing
        </h2>
      </div>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
        {ITEMS.map((it) => (
          <div key={it.title} className="rounded-2xl border border-[var(--border)] bg-[var(--surface-solid)] p-6 flex flex-col">
            <h3 className="font-bold text-[var(--foreground)] mb-2">{it.title}</h3>
            <p className="text-sm text-[var(--foreground-secondary)] leading-relaxed flex-1">{it.body}</p>
            <p className="mt-4 text-xs font-mono text-[var(--muted)] break-words">{it.proof}</p>
            {it.href ? (
              <Link href={it.href} className="mt-2 text-xs font-semibold text-[var(--accent)] hover:underline">
                How it works →
              </Link>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
