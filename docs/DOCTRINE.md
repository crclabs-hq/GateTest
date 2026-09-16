# GateTest Engineering Doctrine

> The Bible (`CLAUDE.md`) holds the rules. This file holds the *method* — how a
> professional works on this codebase so the rules are met by construction,
> not by memory. Every principle here was paid for: each one names the defect
> that proved it. Read it before touching the engine; re-read it when a fix
> feels obvious.

Doctrine is short by design. The evidence for each principle is one sentence
and a commit or PR you can open. When a principle stops being true, change it
here and say why — never leave it to drift.

---

## 1. The bug shape that matters most is "reports success while doing nothing"

A scanner that crashes is a bad day. A scanner that says *clean* over code it
never read is a bad quarter, because nobody looks again. The whole 2026-09-04
session was this shape: the customer gate ran `--report-only`, the "known-good
corpus" was two synthetic fixtures, `checkTsSyntax` returned *valid* when the
compiler was missing, the WordPress probes reported *Good* when the site was
unreachable, and `--diff` printed "diff-only (20 files)" over a report of 379.

**Method.** Every time you touch a code path that can return a success value,
ask: *what happens when the input is missing, the tool is absent, the network
is down, or the loop ran zero times?* If the answer is "it says clean", it is a
defect. Prefer three-state answers — checked-and-clean, checked-and-found,
**not checked** — and make the third state visible to the customer (the PR
comment's "Partial scan" / "Not checked" lines, the console's "Deferred" line).

## 2. Precision is measured on code we did not write

Every rule in this engine was tuned against this repository, so this
repository is the one codebase on which its false-positive rate *cannot* be
measured. On 2026-09-04 the self-scan was green while express, flask, fastify,
got, zod and hono were all blocked.

**Method.** `reliability-corpus/real-world.json` pins eleven third-party
repositories at exact commits, each with a blocking ceiling that only ratchets
down, plus OWASP NodeGoat held to a *floor* so precision cannot be bought with
silence. `node scripts/real-world-precision.js` runs them; CI runs it on every
push; `/precision` renders it. **Any change to a rule's recall or scope is
unvalidated until the corpus says otherwise** — a first fix for Ruby backticks
took Rails from 56 to 127 and the corpus was the only thing that noticed.

## 3. No rule ships without a control pair

A test that proves a rule *fires* is half a test. The other half proves it
*stays quiet* on the shape it resembles. Three fixes in one session had a
first cut that the negative control rejected (the label-shape rule that
skipped `secretpass1`; the strict-to-loose regex; the backtick command form).

**Method.** For every rule change: one positive control (the real line from the
repo that exposed the bug, verbatim), one negative control (the legitimate
idiom next to it). When a probe reports *silence* — "this module finds
nothing", "this test never fires" — it needs its **own** positive control
first; three "SILENT" reports in one session were the probe being broken.
Name the file the shape came from in the test's comment.

## 4. One definition, imported — never a private copy

Six modules had their own `TEST_PATH_RE`; 36 had their own directory walk;
five decided "is this a route handler" with a hand-spelled `app.post`; the
domain lived in 55 string literals. Every private copy drifts, and the drift
is always toward the author's own repo.

**Method.** The canonical definitions and where they live:

| Question | One place |
|---|---|
| Which files does a module see? | `BaseModule._collectFiles` (honours `--diff`, the exclude list, `_respectsIncremental`) |
| Which directories does a walk never enter? | `src/core/walk-excludes.js` (`WALK_EXCLUDES`, `WALK_EXCLUDE_SET`, `isExcludedDir`) — every walker imports it, and `tests/walk-excludes.test.js` fails on the *shape* of a private copy (a literal list naming `node_modules` beside `.git`) anywhere under `src/`. 2026-09-05: fifteen such copies were found, each a different subset; the import graph's also skipped every dot-directory, so `.storybook/` and `examples/.experimental/` were invisible to the graph while other modules scanned them |
| Is this a test path? | `src/core/test-paths.js` (`isTestPath`, `TEST_PATH_RE`) — modules reach it as `BaseModule._isTestPath`; core files (dependency reachability, session telemetry) import it directly. `tests/test-path-canonical.test.js` forbids any other declaration in `src/modules` and `src/core` |
| Is this an illustration / harness dir? | `src/core/scan-scope.js` |
| Is this file an HTTP handler? Is session middleware in play? | `src/core/route-grammar.js` |
| What depends on what? | `src/core/import-graph.js` |
| Which packages does this file import? | `src/core/import-graph.js` `externals` — the bare specifiers left over once the graph has resolved everything internal, read from the same statements and the same masked text as the edges, each with its line, how it resolved (`unresolved` / `workspace` / `alias`) and whether every import of it is type-only (`dependencyReachability` counts production imports from it; `aiHallucination` reports the unresolved ones against the nearest manifest, over its own file set, and says which files the graph never read; Vue / Svelte script blocks keep a regex fallback because they are not JavaScript files) |
| What does this specifier resolve to — a tsconfig alias, a workspace package, a `.js` written for a `.ts`? | `src/core/module-resolution.js` (the import graph and the dead-code extractor both resolve through it) |
| Is this file run rather than imported — a package main, a hook, a route file, a tool config, a fixture, a Django `apps.py`? | `src/core/entrypoints.js` |
| What does this Python specifier resolve to — `from ..x import y`, a src-layout package, `'app.module.Class'` in a settings string? | `src/core/python-imports.js` (`deadCode` reads reachability through it; the extractor joins statement continuations with its `logicalLines`) |
| Is this import emitted, and is its binding read while the module graph is still loading — type-only (elided), load-time, or deferred to call time? | `src/core/import-elision.js` (`importCycle` reads the `loadGraph` / `runtimeGraph` views it produces) |
| Where do the strings, comments and regex literals begin and end in this source? | `src/core/source-strip.js` — `stripStringsAndComments` (JS/TS), `stripPythonStringsAndComments`, `stripShellLiterals` (bash grammar, moved out of `bash-safety`), `stripLineLiterals` (the line-level fallback for languages with no parser), and `literalKindAt` (is this column code, string, regex or comment — quote parity on the masked line, looking upward past blank masked lines). `maskSource(text, filePath)` decides which grammar a file gets — Python by extension, shell by extension or shebang, `#`-comment languages line by line, the JavaScript grammar for the C-like rest — and modules reach it as `BaseModule._maskedLines(content, rel)` / `_insideLiteral` / `_matchOnRaw`; the confidence scorer masks through the same call (until 2026-09-05 it ran the JavaScript grammar on `gradlew`, where a `/*)` case pattern opened a phantom comment and a real `eval` scored 0.2); `syntax.js`, the elision tokenizer, the import graph, `confidence.js`, `guarded-catch.js`, `inner-html-safety.js` and `homoglyph` import it directly. The pattern is: match on the masked line, read captured text from the raw line at the same offsets — a rule that must read string content (a route path, a bracket env key, `app.disable('csrf')`) runs on the raw line and requires the match START to be code. 2026-09-05: twenty-two modules and four core files each had a private quote counter (`_isInsideStringLiteral`, `_stripJsStrings`, `isInString`, `maskNonCode`, `_maskedSource`, `_stripStringsKeepTemplateInterp`, …), none of which could see a template literal or a block comment opened on an earlier line; `tests/string-guard-canonical.test.js` now fails on the *shape* of another one (a `quote = ch` walker, an `inSingle = !inSingle` toggle, the dead names) anywhere under `src/` except the home |
| Where do the top-level commas fall in this argument list / type parameter list? | `src/core/source-strip.js` `splitTopLevel(expr, sep, { angle })` — brackets and quotes judged on the masked twin (`undefined-ref`'s declaration reader and `inner-html-safety`'s argument splitter import it) |
| Which packages make up this workspace, which manifest governs a file, what does it declare? | `src/core/workspaces.js` (`listWorkspacePackages`, `nearestWorkspacePackage`, `manifestDeclares`) |
| Where do the migrations live — and is that directory a migration tree or a framework? | `src/core/migration-dirs.js` |
| Is this file a shell script? | `src/core/shell-files.js` (extension or shebang; binaries and prose out) |
| What is this finding's identity? | `src/core/report-provenance.js` `fingerprintFindings` (shared with the determinism gate) |
| What is the repo-relative form of a path — the one a finding id, its `file`, a `.gatetestignore` line and a baseline fingerprint carry? | `src/core/repo-path.js` (`repoRelative(root, abs)`, `toPosix(p)`) — always `/`-joined. `path.relative()` answers with the OS separator, and until 2026-09-13 every module embedded that raw answer, so the same finding was `a11y:html-lang:src\index.html` on a Windows checkout and `src/index.html` on the Linux CI gating the same commit (KI #109: 114 tests red on Windows only, and a `.gatetest/baseline.json` written on one OS silently not matching on the other). 150 call sites in 86 files now go through it; `finding-registry`, `ignore-file` and `baseline` delegate their private normalisers to `toPosix` |
| Which OWASP / SOC 2 / CIS control does a module speak to? | `src/core/compliance-mappings.js` (the website and the SARIF reporter import it) |
| Which `.gatetestignore` line silences it? | `src/core/ignore-file.js` `suggestLine` (verified against the matcher) |
| The public origin | `src/core/site-url.js` / `website/app/lib/site-url.js` |
| The module count, the corpus numbers, page dates | generated: `site-stats.json`, `precision.json`, `build-info.json` |

If you find yourself writing a second answer to one of these questions, stop
and import the first. If the first is wrong, fix it there — every caller gets
the fix.

## 5. Segments, not substrings; tokens, not substrings

`includes('.git')` matches `.github`. `includes('test')` matches
`src/latest/`, `contest/`, `attestation.js`, `inspect.js`. `/==[^=]/` matches
inside `=== 'x'`. `dir.includes('dist')` on an *absolute* path hides an entire
checkout under `/home/ci/build/`. Every one of these was live in this codebase
and every one was a recall hole — a file silently exempted from a check.

**Method.** Path tests anchor on segment boundaries: `/(?:^|\/)tests?(?:\/|$)/`.
Token tests anchor on token boundaries: `(?<![=!])==(?!=)`. Exclude lists
compare *segments*, never `includes`. `tests/test-path-canonical.test.js`
forbids the shape across `src/`, `bin/` and `website/app/lib`; extend its word
list when you find a new one rather than fixing the one instance.

## 6. Say what was not checked

A report that lists findings implies the rest was verified. Deferred modules,
truncated file coverage, an engine fallback, a skipped language, a suppressed
finding — each is a hole in that implication, and each must be printed where
the report is read: the console (`Deferred:`), the PR comment (`Not checked:`,
`Partial scan`), the JSON report (`provenance.modules.{skipped,deferred}`).

**Method.** Any new "skip" path adds its reason to the summary the reporters
consume. A pass that came from a fallback may not wear the green tick.

## 7. Generated over typed

A number typed by hand is a number that will be wrong later: module counts
(`120` survived in 231 places after module 121 shipped), corpus results,
"last updated" dates, permission lists. If a fact can be produced by running
the thing it describes, produce it and import it, and let a test fail when
the import and the copy disagree.

**Method.** `scripts/generate-site-stats.js`, `scripts/real-world-precision.js
--write-json`, `scripts/head-to-head.js`, `scripts/generate-build-info.js` —
extend these rather than adding a literal. `tests/module-count-sync.test.js`,
`tests/precision-page-sync.test.js`, `tests/head-to-head.test.js`,
`tests/comparison-reviewed.test.js` and `tests/site-url.test.js` are the
tripwires. A competitor's number is held to the same rule: the head-to-head
table writes "not measured" and the reason for any tool nobody ran.

## 8. Verify in the environment that decides, after the last edit

Four reporter tests were green locally and red in CI because `src/index.js`
attaches two extra reporters under `GITHUB_ACTIONS=true`. A green self-scan
predated the edit that added an undeclared env var, and CI's self-scan blocked
on it. "It passed for me" is only evidence about the environment it ran in and
the moment it ran.

**Method.** The sweep in the Bible runs the fast suite twice — plain and under
the Actions environment — and runs the quick self-scan **last**. A rule change
also runs the real-world corpus. A module change also runs
`scripts/determinism-check.js`. Reproduce a CI failure locally *first*, then
show the same command passing; one validated push beats three speculative
ones.

**The runner itself is a thing to verify.** For a year the suite ran as
`node --test --test-force-exit …`, adopted because one file left a handle open
and the bare runner hung for hours. Measured on 2026-09-05: that flag exits the
runner as soon as the tests it has *heard of* are done — a child still
streaming its later suites is cut off, its tests are never counted, and the
exit code is 0. The same tree reported 50, 77 and 61 tests on three runs; a
single file alone reported 63, 40, 33, 63 names. Every `# fail 0` produced
that way was evidence about whichever tests finished first (§1's bug, in the
tool that was supposed to catch §1's bug). The suite now runs through
`scripts/run-tests.js`: one plain `node --test` per file, ended only after its
final summary line is read, so a leak is killed on our terms after every
result is in, a file that ends without its summary is a failure, and a file
whose event loop never drains is reported *cancelled* rather than force-exited
in silence — which surfaced two such files on the first run. The check that a
test command counts what it claims to: run it three times on the same tree and
compare the test-name sets, not the pass line.

## 9. Our own scanner reviewing our own PR is the best bug report we get

GitHub Code Scanning runs GateTest on every PR to this repository. On
2026-09-05 five of its findings on one PR were the scanner's, not the code's:
a regex that matched inside `===`, an orphan rule blind to `@/` aliases, a
catch-that-exits counted as a swallow, prose in a docs table read as fake
fixes, a line-ending rewrite read as a 510-line change. Each one was fixed the
same day with a control pair.

**Method.** Treat every bot finding on our own PRs as a bug report with two
possible defendants — the code or the rule — and close it against one of
them. Never `.gatetestignore` a finding on this repository without first
deciding which defendant it was.

## 10. Expect the worst of prior work — and prove it either way

Craig's standing instruction: the earlier sessions were weaker; assume every
claim in the code is untested until you have run it. This is not cynicism, it
is the measurement stance: the eight-language claim had been measured on one
language; the badge `?repo=` parameter was advertised for months and never
read by the handler; the "PR scan drops to 3–10s" comment described a walk
that 22 of 25 modules ignored.

**Method.** When you touch a subsystem, run it end to end once on real input
before trusting its comments. Reconstruct deleted code and diff the outputs
when replacing it (the walk unification proved 36 file sets identical by
reconstruction). Measure before and after; write the numbers in the commit.

## 11. Parallelise mechanical work; verify by reconstruction

Thirty-six file walks, fifty-five domain literals, a 121-module audit — each
was done by background agents with a precise brief, disjoint files, no
commits, and a report table. The brief carried the acceptance test; the
agents carried the diff. What made it safe was that every agent proved
equivalence (old walk vs new, file set vs file set) rather than asserting it.

**Method.** Agents get: the exact files they may touch, the tests they must
run, the control they must show, and "do not commit". The orchestrator runs
the full suite, the self-scan and the corpus once everything lands, and
commits in coherent units. Never let two agents edit the same file.

## 12. Edit files the way their bytes are stored

A Python text-mode read/write turned `docs/ARCHITECTURE.md` (CRLF) into LF —
a 510-line diff for a one-line change, which then lit up five fake-fix
patterns on prose. Scripted edits must preserve line endings, encoding and
BOMs (several website files carry a BOM).

**Method.** Before a scripted edit of a file you did not create, check its
line endings (`grep -c $'\r$'`) and edit in binary mode if they are CRLF.
After any scripted sweep, read `git diff --numstat` and question any file
whose change count is far larger than the edit.

## 13. Commit as coherent units; push and merge without being asked

**The merge is automatic (Craig 2026-09-05: "we need to automatically push
and merge").** A PR is opened, marked ready, and has GitHub auto-merge
enabled (merge method: merge commit) in the same breath; it merges itself the
moment every required check is green. Nobody waits on CI, and a red PR is
still never "waiting on review" — a red check means reproduce, fix, push, and
auto-merge fires on the next green head. The subscription and the check-in
exist to catch the red case and our own scanner's findings, not to press the
button.

Craig's standing instruction: *always push and merge our PRs.* A branch that
sits unmerged is work the customer cannot use and a merge conflict waiting to
happen. The unit of a commit is one cause — one bug, one move — with the
measurement in the message; the PR body is a reviewer's map, not a diary.

**Method.** Per commit: what changed, why (with the line that exposed it), how
it was measured, what was deliberately not done. Per PR: open as draft, CI
green on the current head, merge with a merge commit, unsubscribe, restart
the branch from `main` under the same name. A red PR is never "waiting on
review".

## 14. Speed is a precision feature

A gate that takes ten minutes is a gate teams learn to skip; one that takes
eight seconds on a PR runs on every push. The 17s → 8s diff scan came from
correctness work (the walk unification), not from tuning. The Bible's bars —
quick scan < 15s, full scan < 60s — are precision bars in disguise.

**Method.** Measure wall-clock on the standard commands before and after any
change to the runner, a walker, or a module's file set, and put the numbers
in the commit.

---

## How to use this document

- **Starting a session:** read the Bible, then this file, then `docs/THE-FIFTY.md`
  for the current work queue and `docs/ROADMAP.md` Known Issues.
- **Starting a rule change:** principles 2, 3, 5, 8 — corpus, control pair,
  segments, verify in CI.
- **Starting a refactor:** principles 4, 10, 11, 12 — one definition,
  reconstruct and diff, parallelise safely, preserve bytes.
- **Finishing anything:** principles 6, 7, 13 — say what was not checked,
  generate the facts, ship it.
