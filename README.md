# GateTest

### One gate. 120 modules. Self-healing CI.

**AI-powered code quality. Pay per scan via Stripe.**

<!-- Our own live GateTest grade — the flagship example of the embeddable
     badge at /badge/:owner/:repo (dynamic SVG, cached 5 min, "not scanned"
     fallback when no scan is on record yet — see website/app/badge). -->
[![GateTest](https://gatetest.ai/badge/crclabs-hq/GateTest)](https://gatetest.ai)
[![npm](https://img.shields.io/npm/v/@gatetest/cli.svg)](https://www.npmjs.com/package/@gatetest/cli)
[![CI](https://github.com/crclabs-hq/GateTest/actions/workflows/ci.yml/badge.svg)](https://github.com/crclabs-hq/GateTest/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Modules](https://img.shields.io/badge/modules-120-purple.svg)](#what-it-replaces)
[![Tests](https://img.shields.io/badge/tests-6000%2B-brightgreen.svg)](#real-repo-proofs)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](https://nodejs.org/)
<!-- Marketplace listing — re-enable when the GitHub Marketplace approval lands:
[![GitHub Marketplace](https://img.shields.io/badge/marketplace-GateTest-2ea44f.svg)](https://github.com/marketplace/gatetest)
-->

---

## The 30-second pitch

**GateTest is a single CLI plus a composite GitHub Action that runs 120 static-analysis modules against any codebase, then uses Claude to repair the findings it can.** It replaces SonarQube, Snyk, ESLint, Cypress, Lighthouse, axe, pa11y, and twenty-plus other tools with one config, one gate decision, and one report.

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
      - uses: crclabs-hq/GateTest@v1.1.1
        with:
          suite: full
          auto-fix: ${{ github.event_name == 'pull_request' }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action is a composite — no Docker pull, no container build. It installs GateTest, runs the gate, and if `auto-fix: true` and `ANTHROPIC_API_KEY` is set, runs the AI repair loop on a blocking gate. See [`action.yml`](action.yml) for every input.

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

- `gatetest --noise` — ranks your noisiest modules and prints the exact ignore line to copy.
- **Auto-softening** — a module you chronically dismiss stops blocking the gate on its own (never on thin evidence: it takes repeated dismissals at a high fire-rate).

Project-wide options live in `.gatetest.json` (suites, per-module config, severity overrides) — run `gatetest --init` to scaffold one.

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

Visit [gatetest.ai/web](https://gatetest.ai/web) and paste any URL. You get a free preview and a paid full report. For WordPress sites use [gatetest.ai/wp](https://gatetest.ai/wp).

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

**Twelve-plus tools. One config. One bill.** Full module catalogue: run `node bin/gatetest.js --list` or read it on [gatetest.ai](https://gatetest.ai).

---

## Tiers and pricing

Scan tiers are one-time payments via Stripe at checkout — no auto-renew. Continuous and MCP are monthly subscriptions (cancel anytime). Refunds only at our discretion for scans that failed to start or crashed mid-way without producing a report (contact `hello@gatetest.ai`).

| Tier              | Price   | What you get                                                                                                                                       |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Quick Scan**    | $29     | 4 modules — syntax, linting, secrets, code quality. Fastest path to a first signal. Scan-only — no auto-fix.                                       |
| **Full Scan**     | $99     | The full engine suite (88 modules; mutation + chaos run via the GitHub Action instead — they need a CI runner). SARIF + JUnit reports via the CLI / GitHub Action. Scan-only — auto-fix ships at the Scan + Fix tier. |
| **Scan + Fix**    | $199    | Everything in Full, plus a second-Claude pair-review critique on every fix and an architecture-shape design-observations report.                   |
| **Forensic Scan** | $399    | Everything in Scan + Fix, plus real Claude diagnosis on every finding, cross-finding attack-chain correlation, board-ready CISO report (OWASP / SOC2 / CIS v8 / 30-60-90), and a CTO-readable executive summary. Mutation testing and chaos / fuzz pass are also available via the GitHub Action (`mutation: true` / `chaos: true`) — they need a CI runner to execute your test suite and a headless browser, so they ship with the Action rather than the website-only scan. |
| **Continuous**    | $49/mo  | Scan every push via the GitHub App. Unlimited deterministic push scans plus a monthly Claude AI-review allowance. Fix PRs are a per-scan upsell.    |
| **MCP**           | $29/mo  | The **hosted** remote MCP endpoint — use GateTest from claude.ai web/mobile or locked-down machines, plus hosted scan history (`gtmcp_` key delivered by email after checkout). The **local** MCP server (`npx @gatetest/mcp-server`) is 100% free — every tool runs on your machine with your keys. |

Live prices and Stripe checkout at [gatetest.ai](https://gatetest.ai).

---

## Honest limits

GateTest is not magic. The things it does not yet do, said out loud:

- **Headless-browser modules (`liveCrawler`, `runtimeErrors`, `explorer`, `chaos`) degrade gracefully on Vercel serverless.** Chromium cannot launch inside the function. The modules emit an info-level skip and the rest of the scan continues — full power requires the CLI, a worker, or local dev.
- **Hosted website scans read up to 50 source files per scan** (prioritised by relevance). Most small-to-mid repos fit; a large monorepo gets a representative slice. The CLI and GitHub Action scan everything with no cap.

The full Known Issues table (with severity and status) lives in [CLAUDE.md](CLAUDE.md) — that file is the project's source of truth.

---

## Architecture

**Static engine.** 120 modules, every one extending `BaseModule`. Each module is a self-contained scanner that emits checks at three severity levels (error blocks the gate, warning reports, info is informational). The runner is `EventEmitter`-based, supports parallel execution, diff-mode (`--diff` scans only git-changed files), watch mode, and five output formats (Console, JSON, HTML, SARIF for the GitHub Security tab, JUnit XML for any CI). The gate has four small runtime dependencies (`acorn`, `pngjs`, `pixelmatch`, and the MCP SDK) — `node bin/gatetest.js --list` runs anywhere Node 20+ runs.

**Website and payments.** [gatetest.ai](https://gatetest.ai) is Next.js 16 with the App Router, Tailwind 4, and Stripe in per-scan upfront-charge mode. One-time payment per scan at checkout — no subscription, no auto-renew, no hold-then-capture flow. All scan state is persisted in Stripe metadata so the serverless functions stay stateless across requests — there is no shared in-memory state and no webhook is required for the critical user flow. The scan executes inside the function response and reports back directly.

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
GateTest is built and maintained at <a href="https://gatetest.ai">gatetest.ai</a>.
Talk to the team via the chat on the site. File bugs at <a href="https://github.com/crclabs-hq/GateTest/issues">GitHub Issues</a>.
</sub>
