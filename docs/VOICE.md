# Voice — how GateTest talks in public

Craig, 2026-09-22: "we need to talk like DevOps operators and full-stack
developers. We can be a marketing machine, but in the correct tone."

The reader is an engineer deciding whether to put a gate in front of their
team's CI. They trust mechanics and numbers with provenance. They uninstall
tools that oversell. Every public string — headline, lede, card, CTA, meta
description, OG image — follows these rules.

1. **Say what the software does, mechanically.** "Fails the job only on
   findings not in the committed baseline" beats "keeps your code honest".
2. **Numbers carry provenance.** "19 pinned third-party repositories,
   measured nightly" — never a bare "real repos". Counts are imported from
   `site-stats.json` / `precision.json`, never typed.
3. **No metaphors, slogans or cute lines.** Banned on sight: cry wolf,
   while you sleep, self-healing, keeps it honest, with receipts, pristine,
   stunning, cinematic, unlock velocity, dominate, kills <tool>.
4. **No unbacked adjectives.** advanced, powerful, seamless, effortless,
   enterprise-grade, AI-native, edge-first, zero-ops, brutally honest,
   instantly. If it is true, show the measurement instead.
5. **Name what the model does, not "AI-powered".** "A model generates a
   patch; the gate re-runs; a regression test is added; a second model
   reviews the diff." Deterministic checks are deterministic — say so.
6. **State limits in the same breath as the claim.** Beta is beta. "Not
   checked" is printed. Mutation and chaos run in the Action, not the
   hosted scan.
7. **Second person, present tense, short sentences.** Imperative for
   instructions. No exclamation marks. No "we're excited".
8. **Sell with specifics.** Pay per run, no seats, exit code 1 on a blocking
   finding, SARIF/JUnit out, baseline file committed to the repo, PR opened
   with a diff and a test. That is the pitch.
9. **Sibling products get the same treatment.** Gluecron and Tallrig are
   described by what they do, not by taglines.
10. **Dated evidence is never rewritten.** Scan records, changelog entries
    and blog posts keep the wording of the day they were written.

Enforced by `tests/public-copy-voice.test.js` (banned-phrase scan over
`website/app/**` excluding `admin/`, `api/`, dated records).
