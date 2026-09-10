# GateTest

### One gate. 121 modules. Self-healing CI.

**AI-powered code quality. Pay per scan via Stripe.**

<!-- Our own live GateTest grade — the flagship example of the embeddable
     badge at /badge/:owner/:repo (dynamic SVG, cached 5 min, "not scanned"
     fallback when no scan is on record yet — see website/app/badge). -->
[![GateTest](https://gatetest.io/badge/crclabs-hq/GateTest)](https://gatetest.io)
[![npm](https://img.shields.io/npm/v/@gatetest/cli.svg)](https://www.npmjs.com/package/@gatetest/cli)
[![CI](https://github.com/crclabs-hq/GateTest/actions/workflows/ci.yml/badge.svg)](https://github.com/crclabs-hq/GateTest/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Modules](https://img.shields.io/badge/modules-121-purple.svg)](#what-it-replaces)
[![Tests](https://img.shields.io/badge/tests-6000%2B-brightgreen.svg)](#real-repo-proofs)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](https://nodejs.org/)
[![GitHub Marketplace](https://img.shields.io/badge/marketplace-GateTest%20Quality%20Gate-2ea44f.svg)](https://github.com/marketplace/actions/gatetest-quality-gate)

---

## The 30-second pitch

**GateTest is a single CLI plus a composite GitHub Action that runs 121 static-analysis modules against any codebase, then uses Claude to repair the findings it can.** It replaces SonarQube, Snyk, ESLint, Cypress, Lighthouse, axe, pa11y, and twenty-plus other tools with one config, one gate decision, and one report.

**It is different because the cost trends to zero.** Deterministic AST and rule-based layers run first — these are free and ship the fix in milliseconds. Claude only runs on patterns nothing else has seen. Every Claude win is distilled into a reusable recipe, so the next time the same pattern appears anywhere in the network it is handled for free. The longer you run GateTest, the less of it is paid work.

**What you get depends on the tier.** A pull request with the fixes, regression tests pinned to each fix, an architecture-shape critique, a cross-finding attack-chain analysis, and a CTO-readable executive summary — in whichever combination the tier you bought includes. One-time payment per scan via Stripe at checkout. No subscription, no auto-renew.

---

## Install &amp; Usage — 30 seconds

### GitHub Action — recommended for most users

Drop this in `.github/workflows/gatetest.yml`:

```yaml
name: GateTest Quality Gate
on: [push, pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: crclabs-hq/GateTest@v1
        with:
          suite: full
          auto-fix: ${{ github.event_name == 'pull_request' }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action is a composite — no Docker pull, no container build. It installs GateTest, runs the gate, and if `auto-fix: true` and `ANTHROPIC_API_KEY` is set, runs the AI repair loop on a blocking gate. See [`action.yml`](action.yml) for every input.

**Your first full run passes.** Turning a gate on against an existing codebase would otherwise fail on years of backlog nobody wrote this week, so a full-repo run that finds no `.gatetest/baseline.json` snapshots what is already there and exits green. Commit that file and every run after it fails on **new** findings only — pull requests are judged on the files they change from the very first run. Details under [baseline mode](#onboarding-a-mature-repo--baseline-mode).

### CLI — local development

```bash
# Install from npm:
npm install -g @gatetest/cli
gatetest --suite quick

# Or run against the current directory with no install:
npx github:crclabs-hq/GateTest --suite quick

# Or clone and run from source:
git clone https://github.com/crclabs-hq/GateTest
cd gatetest && npm install
node bin/gatetest.js --suite quick
```

### Pre-push sweep

Run the full pre-merge sweep locally in one command:

```bash
npm run sweep          # ~30-60s — tests + build + gate + secrets + self-scan
```

This runs the same seven checks that block a merge in CI. Verdict is green or red. Exit code is 0 or 1, matching CI exactly.

Fast path during iteration:

```bash
npm run sweep -- --fast    # skip tests + build, gate-only, ~3-5s
```

See `gatetest sweep --help` for every flag.

### Silencing a false positive — 10 seconds

Every scanner gets it wrong sometimes. When GateTest flags something you've judged safe, add one line to a `.gatetestignore` file at your repo root:

```gitignore
# Silence one rule from one module:
secrets:generic-api-key

# Silence a whole module:
deadCode

# Silence a rule everywhere it fires:
*:trailing-whitespace

# Scope a suppression to a path:
secrets:generic-api-key@tests/fixtures/**

# Skip a path entirely:
vendor/**
```

Suppressed findings are excluded from the gate decision and every failure count, but stay visible in a `suppressedChecks` list — nothing is silently hidden. Two more controls:

- `gatetest --noise` — ranks your noisiest modules and prints the exact ignore line to copy. The same signal, aggregated across every opted-in scan, is published rule by rule at [gatetest.io/noise](https://gatetest.io/noise).
- **Auto-softening** — a module you chronically dismiss stops blocking the gate on its own (never on thin evidence: it takes repeated dismissals at a high fire-rate).

**The policy is reviewed as policy.** `.gatetest.json` and `.gatetestignore` are what
every later PR is judged by, so a PR that changes them says so: a suppression added
to `.gatetestignore`, a module disabled, the gate set to report-only or the block
threshold raised in `.gatetest.json` each produce a `Gate policy changed` warning on
that PR — reported, never blocking, quiet on comments and on tightening. Every
signed report records the SHA-256 of both files (`gatetest verify-report` prints
them), so two reports that disagree can be told apart by policy, not only by
engine.

Project-wide options live in `.gatetest.json` (suites, per-module config, severity overrides) — run `gatetest --init` to scaffold one.

### Onboarding a mature repo — baseline mode

Turning a scanner on against a large existing codebase usually means drowning in a backlog you didn't write. GateTest's baseline mode grandfathers everything that exists today so the gate only ever fails on **new** findings — "clean as you code."

```bash
# Snapshot every current finding into .gatetest/baseline.json — commit it:
gatetest --baseline

# From now on, normal runs pass on the pre-existing findings and only
# block on NEW ones. Baselined findings stay visible, never hidden.
gatetest --suite full
```

Fix a baselined finding and it's gone for good; the count is tracked per file, so adding a *second* secret to a file that already had one baselined re-blocks the gate (you can't sneak a new problem in behind an old one). Refresh the snapshot after paying down debt with `gatetest --baseline`; delete `.gatetest/baseline.json` to see everything again.

### Testing pages behind a login — authenticated crawl

The live crawler can carry a session so it reaches authed areas (`/dashboard/*`, account pages) instead of bouncing off the login redirect:

```bash
# A header (repeatable), a cookie, or an exported browser session —
# values support ${ENV_VAR} so secrets stay out of committed config:
gatetest --crawl https://app.example.com --crawl-header "Authorization: Bearer ${TOKEN}"
gatetest --crawl https://app.example.com --crawl-cookie "session=${SESSION}"
gatetest --crawl https://app.example.com --crawl-storage-state state.json
```

Session material is only ever sent to the target's own origin — never to third-party links, assets, or cross-origin redirects. Without a session, a crawl that hits a login wall tells you exactly which flag to add rather than silently skipping the protected pages. The hosted scanner at [gatetest.io](https://gatetest.io) accepts the same session auth.

### Claude Code / MCP — give Claude eyes, ears & hands

Connect GateTest directly to Claude Code (or any MCP-compatible AI) in one command:

```bash
claude mcp add gatetest -- npx -y @gatetest/mcp-server
```

24 tools across five families:

| Family | Tools | What it gives Claude |
|--------|-------|----------------------|
| **Engine** | `scan_local`, `run_module`, `fix_issue`, `verify_fix`, … | Scan + fix local code |
| **👁 Eyes** | `capture_screenshot`, `get_visual_diff` | See the rendered page as a real image |
| **👂 Ears** | `get_production_errors`, `run_live_checks` | Hear Sentry/Datadog/Rollbar errors + localhost runtime failures |
| **🤝 Hands** | `verify_fix` | Hard ✅/❌ — prove the fix actually worked |
| **🔬 Root Cause** | `resolve_stack_trace`, `blame_regression` | Resolve a minified stack trace to original file:line via source maps; find the git commit that introduced a specific line. Same engines are also CLI subcommands (`gatetest trace`, `gatetest blame`) — one implementation, both entry points |

Works with Claude Code, Cursor, Windsurf, Continue, and Cline. See [`packages/mcp-server/`](packages/mcp-server/) for the full tool reference and example prompts.

### Website — no install at all

Visit [gatetest.io/web](https://gatetest.io/web) and paste any URL. You get a free preview and a paid full report. For WordPress sites use [gatetest.io/wp](https://gatetest.io/wp).

### Wire it into CI — GitHub, GitLab, or CircleCI

Don't hand-write the pipeline. One command scaffolds a complete, conventional config:

```bash
gatetest --ci-init github     # .github/workflows/gatetest.yml
gatetest --ci-init gitlab     # .gitlab-ci.yml
gatetest --ci-init circleci   # .circleci/config.yml
```

Each generated config gates the right thing at the right time rather than running
everything everywhere: a **quick, diff-scoped** scan on merge requests and pull
requests, a **full** scan on the main branch, and a separate security stage. JUnit
and SARIF are emitted to `.gatetest/reports/` and wired into the platform's native
test-reporting and artifact storage, so failures show up in the UI instead of only
in the log.

On any other CI — Jenkins, Buildkite, Bitbucket, Drone — the CLI is the whole
integration:

```bash
npx @gatetest/cli --suite full --junit --sarif
```

Onboarding an existing codebase? Pair this with **baseline mode** above so the gate
only fails on new findings.

### Merge queues and monorepos

**Merge queues.** The GitHub Action and the drop-in workflow handle the `merge_group`
event: each group is scanned diff-scoped against the *queue's* base (the event
payload's `base_sha`, which the engine resolves through one shared base resolver —
the same one `--pr`, prSize and the fake-fix detector use, so no module measures a
different diff from another). Add `merge_group:` under `on:` in your workflow and
nothing else changes.

**Path filters.** In a monorepo, scope the gate to the packages it owns in
`.gatetest.json`:

```json
{ "paths": { "include": ["packages/api", "packages/shared/**"], "exclude": ["**/fixtures/**"] } }
```

A bare directory means everything under it; `*` is one segment, `**` any depth;
exclude wins. The filter applies at the one file walk every module shares, findings
from modules with their own lookups are dropped at the runner, and every report says
so — `Scope: .gatetest.json paths — include packages/api (3 finding(s) outside it
not shown)` — and carries it in the signed provenance. No `paths` key, no filter.

### Replay a failing CI run locally

Reproduce any failing GitHub Actions run on your laptop in seconds:

```bash
gatetest replay https://github.com/owner/repo/actions/runs/12345
```

This fetches the run, identifies which steps failed, and runs them locally
against your current working tree. Output tells you whether the failure
reproduces, doesn't reproduce (flaky CI), or hits a different error.

Authentication is optional — if you have a `GITHUB_TOKEN` set or `gh` CLI
installed, replay can read private repo runs. Otherwise it uses the
unauthenticated rate limit (60 req/hour, fine for a few replays).

When a gate is blocked inside GitHub Actions, the log and the checks tab
already carry this command with the run's URL filled in.

### Self-hosted and air-gapped

The engine is an npm package with four runtime dependencies that reads your tree and
writes to `.gatetest/`. By default the only thing that leaves the machine is the
anonymized telemetry flush (module and rule ids with integer counts; opt out with
`GATETEST_NO_TELEMETRY=1`); the AI-backed fix paths are opt-in and need
`ANTHROPIC_API_KEY`. For an air-gapped runner, make that a stated promise:

```bash
gatetest --suite full --offline        # or GATETEST_OFFLINE=1
```

Under `--offline` nothing leaves the machine: no telemetry upload, no AI calls
(`--fix` / `--auto-pr` are refused with a message, `gatetest fix` exits 2), no live
API ping from `--doctor`. The console prints the mode, the summary carries
`offline: true`, and the signed provenance records it — so a report produced inside
the perimeter can be verified outside it with `gatetest verify-report` and the key.
There is no licence server and no account; nothing expires.

### Verify a scan report

Every JSON report (`.gatetest/reports/gatetest-report-latest.json`) carries a
`provenance` block — engine version, runtime, which modules ran, which were
skipped or deferred, the suppression state, and a SHA-256 digest of the
findings — and, when `GATETEST_REPORT_SIGNING_KEY` is set where the scan runs,
an HMAC-SHA256 signature over it.

```bash
gatetest verify-report .gatetest/reports/gatetest-report-latest.json --key "$GATETEST_REPORT_SIGNING_KEY"
```

`VERIFIED` means the signature matches the provenance and the findings still
match the digest — neither block can be edited without the other noticing.
Without a key the report says `signature.unsigned` explicitly rather than
carrying a decorative field.

### Compliance evidence pack

```bash
gatetest --suite full --compliance
```

Writes `.gatetest/reports/gatetest-compliance-<timestamp>.json` and `.md`: every
finding filed under **OWASP Top 10 2021**, **SOC 2 Trust Services Criteria** and
**CIS Controls v8**, control by control, with the raw results behind the tables
and the same provenance + signature as the JSON report, so `gatetest verify-report`
proves the pack was not edited after the scan. Three states, never two: a control is
**PASS** only when a module mapped to it ran and found nothing; **NOT CHECKED**
when no mapped module ran in that suite (and the report names which, and why);
**NO MODULE** when nothing in the engine maps to it. Modules without a framework
mapping are listed as unattributed rather than filed under a catch-all.

### Root-cause a bug from the CLI

```bash
# Resolve a minified stack trace back to original file:line:column
cat error.log | gatetest trace -

# Find which commit introduced a specific line (read-only — never
# checks out or mutates the working tree)
gatetest blame src/app.js --line 42
```

Both subcommands share the exact same engine as the MCP `resolve_stack_trace`
and `blame_regression` tools — run them by hand or let Claude call them
mid-fix-loop; the answer is identical either way. Run `gatetest trace --help`
or `gatetest blame --help` for the full option list.

---

## The flywheel — why GateTest gets cheaper over time

```
                ┌──────────────────────────┐
   CI BREAKS    │  Failed workflow run     │
       ──>      └────────────┬─────────────┘
                             │
                ┌────────────▼─────────────┐
                │  AI CI-fixer reads logs  │
                │  + failing files         │
                └────────────┬─────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
         ┌────────┐    ┌────────┐    ┌────────┐
         │  AST   │ →  │  Rule  │ →  │ Recipe │   ─── ALL FREE ───
         └────┬───┘    └────┬───┘    └────┬───┘
              │             │             │   (none matched?)
              └─────────────┴─────────────┘
                             │
                             ▼
                ┌──────────────────────────┐
                │ Claude — paid, one shot  │
                │ Result distilled into a  │
                │ recipe for next time     │
                └────────────┬─────────────┘
                             │
                             ▼
                ┌──────────────────────────┐
                │  PR opens with the fix   │
                │  + regression test       │
                └──────────────────────────┘
```

**First time we see a pattern: Claude. Every time after: free.** The longer you run GateTest, the cheaper it gets.

---

## What it replaces

One config, one bill, one gate decision. Twelve-plus tools dissolve into single CLI flags.

| Their tool                                 | GateTest module                                    |
| ------------------------------------------ | -------------------------------------------------- |
| Snyk Code, Dependabot, npm audit           | `security`, `dependencies`                         |
| SonarQube                                  | `codeQuality` + every other module                 |
| ESLint, Stylelint                          | `lint`                                             |
| Cypress, BrowserStack, Sauce Labs          | `e2e`                                              |
| Lighthouse                                 | `performance`                                      |
| axe, pa11y                                 | `accessibility`                                    |
| Percy, Chromatic                           | `visual`                                           |
| git-secrets, TruffleHog                    | `secrets`, `secretRotation`                        |
| hadolint, dockle                           | `dockerfile`                                       |
| actionlint, zizmor, StepSecurity           | `ciSecurity`                                       |
| tfsec, Checkov, Terrascan                  | `terraform`                                        |
| kube-score, kubeaudit, Polaris             | `kubernetes`                                       |
| Stryker, Pitest                            | `mutation`                                         |
| broken-link-checker                        | `links`                                            |
| _(none — fragmented across ESLint rules)_  | `errorSwallow`, `nPlusOne`, `flakyTests`           |
| _(none — no static tool exists)_           | `redos`, `moneyFloat`, `logPii`, `tlsSecurity`     |
| _(none — runtime profilers only)_          | `resourceLeak`, `raceCondition`, `retryHygiene`    |

**Twelve-plus tools. One config. One bill.** Full module catalogue: run `node bin/gatetest.js --list` or read it on [gatetest.io](https://gatetest.io).

---

## Tiers and pricing

Scan tiers are one-time payments via Stripe at checkout — no auto-renew. Continuous and MCP are monthly subscriptions; manage or cancel them yourself at [gatetest.io/billing](https://gatetest.io/billing) (enter your checkout email, get a secure Stripe portal link by email — update your card, view invoices, change plan, or cancel). Refunds only at our discretion for scans that failed to start or crashed mid-way without producing a report (contact `hello@gatetest.ai`).

| Tier              | Price   | What you get                                                                                                                                       |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Quick Scan**    | $29     | 4 modules — syntax, linting, secrets, code quality. Fastest path to a first signal. Scan-only — no auto-fix.                                       |
| **Full Scan**     | $99     | The full engine suite (88 modules; mutation + chaos run via the GitHub Action or a nightly instead — they need a CI runner to execute your test suite, and mutation re-runs it once per mutant). Every scan prints what it deferred and where that work runs. SARIF + JUnit reports via the CLI / GitHub Action. Scan-only — auto-fix ships at the Scan + Fix tier. |
| **Scan + Fix**    | $199    | Everything in Full, plus a second-Claude pair-review critique on every fix and an architecture-shape design-observations report.                   |
| **Forensic Scan** | $399    | Everything in Scan + Fix, plus real Claude diagnosis on every finding, cross-finding attack-chain correlation, board-ready CISO report (OWASP / SOC2 / CIS v8 / 30-60-90), and a CTO-readable executive summary. Mutation testing and chaos / fuzz pass are also available via the GitHub Action (`mutation: true` / `chaos: true`) — they need a CI runner to execute your test suite and a headless browser, so they ship with the Action rather than the website-only scan. |
| **Continuous**    | $49/mo  | Scan every push via the GitHub App. Unlimited deterministic push scans plus a monthly Claude AI-review allowance. Fix PRs are a per-scan upsell.    |
| **MCP**           | $29/mo  | The **hosted** remote MCP endpoint — use GateTest from claude.ai web/mobile or locked-down machines, plus hosted scan history (`gtmcp_` key delivered by email after checkout). The **local** MCP server (`npx @gatetest/mcp-server`) is 100% free — every tool runs on your machine with your keys. |

Live prices and Stripe checkout at [gatetest.io](https://gatetest.io).

---

## Honest limits

GateTest is not magic. The things it does not yet do, said out loud:

- **Headless-browser modules (`liveCrawler`, `runtimeErrors`, `explorer`, `chaos`) degrade gracefully on Vercel serverless.** Chromium cannot launch inside the function. The modules emit an info-level skip and the rest of the scan continues — full power requires the CLI, a worker, or local dev.
- **Hosted website scans read up to 50 source files per scan** (prioritised by relevance). Most small-to-mid repos fit; a large monorepo gets a representative slice. The CLI and GitHub Action scan everything with no cap.

The full Known Issues table (with severity and status) lives in [CLAUDE.md](CLAUDE.md) — that file is the project's source of truth.

---

## Architecture

**Static engine.** 121 modules, every one extending `BaseModule`. Each module is a self-contained scanner that emits checks at three severity levels (error blocks the gate, warning reports, info is informational). The runner is `EventEmitter`-based, supports parallel execution, diff-mode (`--diff` scans only git-changed files), watch mode, and five output formats (Console, JSON, HTML, SARIF for the GitHub Security tab, JUnit XML for any CI). The gate has four small runtime dependencies (`acorn`, `pngjs`, `pixelmatch`, and the MCP SDK) — `node bin/gatetest.js --list` runs anywhere Node 20+ runs.

**Website and payments.** [gatetest.io](https://gatetest.io) is Next.js 16 with the App Router, Tailwind 4, and Stripe in per-scan upfront-charge mode. One-time payment per scan at checkout — no subscription, no auto-renew, no hold-then-capture flow. All scan state is persisted in Stripe metadata so the serverless functions stay stateless across requests — there is no shared in-memory state and no webhook is required for the critical user flow. The scan executes inside the function response and reports back directly.

**AI layer.** Claude (Anthropic). On the GitHub Action the customer brings their own `ANTHROPIC_API_KEY` and pays Anthropic directly. On the website the key is managed and the cost is folded into the tier price. Every Claude success is distilled into a recipe by the flywheel orchestrator (see [`lib/`](lib/) and the AI CI-fixer at [`scripts/ai-ci-fixer.js`](scripts/ai-ci-fixer.js)) so subsequent runs on the same pattern are deterministic and free.

The codebase ships under MIT, the gate runs locally with no external calls, and every architectural decision is documented inline in [CLAUDE.md](CLAUDE.md).

---

## Real-repo proofs

GateTest is dogfooded against itself on every push, and the team runs the full Forensic pipeline against external production codebases before shipping changes that touch the deeper tiers. The reports below are reproducible artifacts in this repo:

- **AI CI-fixer end-to-end run** — full orchestrator path exercised (log → parse → Claude → patch → gate → commit → push → PR): [docs/proofs/ai-ci-fixer-real-run.md](docs/proofs/ai-ci-fixer-real-run.md)
- **GateTest scanning itself** — quick-suite self-scan, 30 of 39 modules pass, 37 errors found and triaged: [docs/proofs/phase-1-self-scan.md](docs/proofs/phase-1-self-scan.md)
- **Iterative fix loop on the live repo** — one-attempt fix on `src/runtime/alerts.js`, 8.5 seconds wall time, syntax gate green: [docs/proofs/phase-1-self-fix-real.md](docs/proofs/phase-1-self-fix-real.md)
- **Forensic scan of Crontech.ai** — Bun + Turbo TypeScript monorepo, 754 errors found, 23 of 39 modules pass, two critical attack chains including a supply-chain CI takeover: [docs/proofs/phase-2-3-crontech-real-customer-grade.md](docs/proofs/phase-2-3-crontech-real-customer-grade.md)
- **Forensic scan of Gluecron.com** — 649 errors and three chains (incl. an "operational lock-in" chain neither finding describes alone): [docs/proofs/phase-2-3-gluecron.md](docs/proofs/phase-2-3-gluecron.md)
- **Pair-review and architecture annotator on the self-scan** — Phase 2 deliverables exercised end-to-end: [docs/proofs/phase-2-self-pair-review-and-architecture.md](docs/proofs/phase-2-self-pair-review-and-architecture.md)
- **Full Forensic pipeline on the self-scan** — 12 of 12 findings diagnosed, four chains including a session-forgery vector: [docs/proofs/phase-3-self-nuclear.md](docs/proofs/phase-3-self-nuclear.md)

---

## Develop and contribute

```bash
git clone https://github.com/crclabs-hq/GateTest
cd gatetest
npm install
(cd website && npm install)
node --test tests/*.test.js
node bin/gatetest.js --list
```

The Bible — [CLAUDE.md](CLAUDE.md) — is required reading for contributors. It defines the architecture, the quality bar, the forbidden list, the protected platforms, and the authorization rules that apply to anything touching money, user data, or public-facing communication.

Bug reports and feature requests are welcome via [GitHub Issues](https://github.com/crclabs-hq/GateTest/issues). Small PRs that fix one thing and add a test are merged fastest. The pre-commit and pre-push hooks under [`src/hooks/`](src/hooks/) run the gate locally — running them before pushing keeps CI green.

---

## License

MIT — see [LICENSE](LICENSE).

---

<sub>
GateTest is built and maintained at <a href="https://gatetest.io">gatetest.io</a>.
Talk to the team via the chat on the site. File bugs at <a href="https://github.com/crclabs-hq/GateTest/issues">GitHub Issues</a>.
</sub>
