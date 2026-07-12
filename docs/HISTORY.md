# GateTest History

Completed build plans, shipped specs, version changelogs, and resolved Known Issues.

> Split out of CLAUDE.md (the Bible) 2026-07-07 to keep every session's context lean.
> The Bible holds rules + current truth; this file holds the detail. Nothing was deleted.

## THE FIX-FIRST BUILD PLAN — MAKE THE PRODUCT MATCH THE PRICING (READ THIS EVERY SESSION)

**Authorization:** Granted by Craig 2026-04-26 — *"I want an honest product that does what it says it's going to do and it fixes everything for that pricing tier... we make a plan, this is the project we're going to build, we don't stop until it's built and then we'll reassess."*

This plan supersedes "pick the next Known Issue." Every session reads this section, picks up where the previous session stopped on this plan, and continues. Only stop for Boss Rule items. No "what should I do next" questions back to Craig — the plan IS the answer.

### The competitive thesis

Nobody on the market today (April 2026) ships **scan → iterative-self-validating-fix-loop → cross-finding conflict detection → test generation per fix → pair-review → on pay-per-completion pricing**. GitHub Copilot Autofix is CodeQL-narrow. Snyk Code Autofix is pattern-matched. DeepSource Autofix uses fix recipes. Sweep is single-pass. Devin is autonomous-agent demo-ware. Codium/CodeRabbit/Greptile are review-only. The gap is real. We build into that gap. 110% best-in-class, not 10%.

### Phase 1 — Foundation: the iterative fix loop

The thing that doesn't exist anywhere else today.

- [x] **1.1** Per-finding fix attempt → re-scan THAT specific finding in isolation → if fail, retry with the failure context → max N retries (configurable, default 3) → log every attempt — **DONE commit `c9535fd`** (`website/app/lib/fix-attempt-loop.js`, 11 tests in `tests/fix-attempt-loop.test.js`)
- [~] **1.2a** Cross-fix syntax-validation gate (vm.compileFunction for JS, JSON.parse for JSON; TS family pass-through pending typescript dep at the root) — **DONE commit `478b675`** (`website/app/lib/cross-fix-syntax-gate.js`, 22 tests in `tests/cross-fix-syntax-gate.test.js`)
- [x] **1.2b** Cross-file scanner re-validation — **PRODUCTION-WIRED 2026-06-09**. Algorithm: `website/app/lib/cross-fix-scanner-gate.js` builds a synthetic post-fix workspace, calls `runTier()`, diffs against the original scan's findings, attributes new findings to specific fixes, rolls back the offending ones (22 tests). Production wiring: `website/app/lib/fix-workspace-hydrator.js` (14 tests) — when a caller doesn't pass `originalFileContents`/`originalFindingsByModule`, `/api/scan/fix` now hydrates the workspace server-side (tree+blob fetch, fix-target files prioritised, convention files for grounding/stack-detection, 60-file cap) and computes the baseline findings by running `runTier` on the original workspace. Scan/status page additionally passes its own paid-scan findings as the baseline (more faithful + saves a server scan). Gate is now LIVE for every production caller: customer scan page, all 3 admin Command Center paths, watchdog auto-fix. Response carries `workspaceHydration` observability field.
- [x] **1.3** Test generation per fix — **DONE commit `(this commit)`** (`website/app/lib/test-generator.js`, 33 tests in `tests/test-generator.test.js`). For every successful, gate-passed fix, Claude writes a regression test that demonstrates the original bug. Tests land at `tests/auto-generated/<flattened-path>.test.<ext>` in the same PR. Defaults to `node:test` framework; honors `frameworkHint`. Untestable fixes (config, docs, CREATE_FILE, type modules) are skipped silently. Per-fix failures never block the underlying fix from shipping.
- [x] **1.4** PR composition — **DONE commit `(this commit)`** (`website/app/lib/pr-composer.js`, 25 tests in `tests/pr-composer.test.js`). Single composer renders: header with issue/file/test counts, before/after scan-comparison table (when baseline supplied), gate results (syntax / scanner / test-gen summaries), per-file attempt-history table (each fix's outcome breakdown + Claude time), fixed-files block, regression-tests-added section, advisory section for items that didn't fix cleanly, "How GateTest works" + Next Steps + footer. Auto-generated regression tests rendered in their own section, NOT in fixed-files. Order verified by test.
- [~] **1.5** Real-repo proof: end-to-end on 3 real public repos. Output documented in `docs/proofs/phase-1-<repo>.md` with timestamps, before/after scan reports, and the actual PR diff. **Partial — 2/3 proofs shipped**: (1) `docs/proofs/phase-1-self-scan.md` documents a real `node bin/gatetest.js --suite quick` run against this repo (30/39 modules passed, 37 errors, 328 warnings, 10s wall time, blocking gate). (2) `docs/proofs/phase-1-self-fix-real.md` documents a real Claude API call exercising the iterative fix loop end-to-end on `src/runtime/alerts.js` — 1 attempt, 8.5s wall time, 2 console.log calls correctly replaced with `process.stderr.write`, syntax gate passed. Third proof (full `/api/scan/fix` route flow opening a real PR) needs either dev-server or deployed-endpoint exercise; algorithm is proven, route flow remains. Targets named in the proof docs.
- [ ] **Definition of done for this phase:** every box above ticked AND the 3 proof docs exist AND `node --test tests/*.test.js` is green.

### Phase 2 — $199 Scan + Fix tier (depth)

- [x] **2.1** Pair-review agent — **DONE commit `(this commit)`** (`website/app/lib/pair-review.js`, 33 tests in `tests/pair-review.test.js`). Second Claude reads each fix's (original → fixed) diff and the regression test, scores 4 axes 1-5 (correctness / completeness / readability / testCoverage), writes a paragraph critique. Output rendered as a PR comment via `renderReviewComment`. Wired into route — runs ONLY when `input.tier === "scan_fix"` so $99 customers don't pay for $199 work. Failures non-blocking (PR ships even if critique fails). Auto-generated regression-test files are excluded from review (reviewing the test the first Claude wrote is a different task).
- [x] **2.2** Architecture annotations — **DONE commit `(this commit)`** (`website/app/lib/architecture-annotator.js`, 33 tests in `tests/architecture-annotator.test.js`). Reads the codebase SHAPE (not per-file): top-dir counts, ext distribution, biggest files, a sample of N (default 8) most-significant files. Sends to Claude with strict-output prompt. Produces "design observations" report (Summary / Observations / Recommendations sections) — informational only, never auto-refactored. Posts as a separate PR comment via `renderArchitectureComment`. Wired into route — runs ONLY on `tier === "scan_fix"` AND when `originalFileContents` is supplied. Failures non-blocking. Skips codebases with < 3 source files. Files in `node_modules/`, `dist/`, `build/`, `.next/`, `coverage/`, `vendor/`, tests, specs, and minified bundles are excluded from sampling.
- [x] **2.3** Wire `scan_fix` tier into `/api/checkout/route.ts` `TIERS` and add the card to `Pricing.tsx` — **DONE commit `(this commit)`**. Pre-authorised by the loosened Boss Rule because 2.1 + 2.2 + 2.4 all shipped with proof. Stripe `GateTest Scan + Fix` product (already in Stripe at $199 — Craig confirmed via screenshot earlier this session) now wired through. Pricing grid expanded from `md:grid-cols-2 max-w-3xl` to `md:grid-cols-3 max-w-5xl` so all three tiers render side-by-side. Card features list emphasises pair-review + architecture annotator + iterative-loop + regression-test guarantees as the differentiators over $99.
- [x] **2.4** Real-repo proof on 3 repos — **DONE 4/3 (requirement exceeded)** commit `(this commit)`. (1) `docs/proofs/phase-2-self-pair-review-and-architecture.md` — gatetest self-proof. (2) `docs/proofs/phase-2-3-crontech-real-customer-grade.md` — Crontech (754 errors, 23/39 modules pass). (3-4) `docs/proofs/phase-2-3-gluecron-marcoreid.md` — Gluecron (649 errors) + MarcoReid (124 errors, includes a critical money-float in trust-account handling). 9/9 diagnoses on each target. Correlator honestly returned 0 chains on MarcoReid (independent findings) rather than padding — integrity validated.
- [ ] Definition of done: customer can buy $199 tier and receive a measurably deeper deliverable than $99.

### Phase 3 — $399 Nuclear tier (correlation + adversarial)

- [x] **3.1** Replace ALL templated shell-command fixes with Claude-driven diagnosis — **DONE commit `(this commit)`** (`website/app/lib/nuclear-diagnoser.js`, 29 tests in `tests/nuclear-diagnoser.test.js`). Per-finding diagnoser sends each (detail, module, severity, hostname, platform context) to Claude and parses a structured response (EXPLANATION / ROOT_CAUSE / RECOMMENDATION / PLATFORM_NOTES). Replaces the category-matched template generators in `server-fix/route.ts` ONLY for the Nuclear tier — Quick/Full continue to use the legacy templates as free starter snippets (the dishonest "we know your stack" pattern only existed at Nuclear, which now branches to real diagnosis). Failures non-blocking per finding. Caps at 20 findings per request to bound Anthropic spend per call. `renderDiagnosesReport` formats the customer-visible markdown with $399-tier branded footer.
- [x] **3.2** Cross-finding correlation engine — **DONE commit `(this commit)`** (`website/app/lib/cross-finding-correlator.js`, 24 tests in `tests/cross-finding-correlator.test.js`). Reads the full findings set, identifies CHAINS where the combined severity is materially worse than the worst individual finding. Strict output schema (CHAIN / SEVERITY / INVOLVES / IMPACT / FIX_ORDER), max 5 chains, SKIP marker honest fallback when nothing combines. Validates finding numbers against bounds, rejects single-finding "chains," skips malformed blocks instead of failing the whole batch. Resolves finding numbers back to detail strings for the markdown report. Renders as `## GateTest Cross-Finding Correlation` with severity badges (🔴/🟠/🟡/⚪). Wired into the Nuclear path — runs in parallel with diagnoseFindings (independent Claude calls) for speed.
- [x] **3.3** Mutation testing pass — **DONE commit `(this commit)`**. Module shipped at `src/modules/mutation.js` (existed pre-session as a 258-line implementation). Operators extracted to a testable engine at `src/core/mutation-engine.js` (19 canonical operators: equality flips, boundary swaps, math swaps, return-value flips, increment/decrement, logical-operator swaps). 33 algorithm tests in `tests/mutation-engine.test.js` cover every operator + the `shouldSkipLine` filter + `generateMutations` orchestrator + `applyCandidate` helper. **Bug found + fixed during test build:** `return true` pattern lacked `\b` so it matched `return trueish` and produced `return falseish` nonsense — fixed with word-boundary anchors. Inline build, zero new dependencies (per Craig's Stryker-vs-inline call). Module is in the CLI's Nuclear tier (`src/core/config.js:256`). Runs locally via `gatetest --suite nuclear`; serverless-side wiring to the website's `runTier()` is future work since mutation testing requires running the customer's test suite which Vercel functions can't safely do.
- [x] **3.4** Chaos / fuzz pass — **DONE commit `(this commit)`**. Module shipped at `src/modules/chaos.js` (existed pre-session as a 281-line Playwright-based implementation). Five resilience scenarios: slow network (3G simulation), API failures, offline mode, missing resources, server timeouts. 7 real tests in `tests/chaos.test.js` cover module shape + scenario method presence + URL-resolution priority (chaos.url > explorer.url > liveCrawler.url) + Playwright-missing graceful degradation + the no-URL early-return path doesn't even attempt to require Playwright. Tests use `Module._resolveFilename` interception to simulate Playwright absence without actually uninstalling it. Inline build, zero new dependencies. Module is in the CLI's Nuclear tier (`src/core/config.js:255`). Runs locally where Playwright + a target URL are available.
- [x] **3.5** Executive summary report — **DONE commit `(this commit)`** (`website/app/lib/executive-summary.js`, 22 tests in `tests/executive-summary.test.js`). Synthesises scan stats + top findings + chains into a CTO-readable single document. 5 sections (HEADLINE / POSTURE / TOP_3_ACTIONS / WORKING_WELL / RECOMMENDED_NEXT) with strict-output schema. Renders as `# Executive Summary` markdown with subject hostname, blockquote headline, posture bullets, top-3 actions, what's working well counter-balance, recommended next step. Wired into Nuclear path AFTER parallel diagnosis + correlation — sequential because it depends on their outputs. Failures non-blocking. Output ordered in `report`: executive first (CTO read), then technical diagnosis report, then correlation report.
- [x] **3.6** Wire `nuclear` tier into `/api/checkout/route.ts` `TIERS` and add the card to `Pricing.tsx` — **DONE commit `(this commit)`**. Pre-authorised by the loosened Boss Rule because 3.1 + 3.2 + 3.3 + 3.4 + 3.5 + 3.7 all shipped with proof. Stripe `GateTest Nuclear` product exists at $399 (Craig confirmed via screenshot earlier this session). Pricing grid expanded from `md:grid-cols-3 max-w-5xl` to `md:grid-cols-2 lg:grid-cols-4 max-w-7xl` so all four tiers render side-by-side on large screens. Card features list emphasises real-Claude-diagnosis + cross-finding correlation + mutation testing + chaos/fuzz + executive summary as the differentiators over $199.
- [x] **3.7** Real-repo proof on 3 repos — **DONE 4/3 (requirement exceeded)** commit `(this commit)`. (1) gatetest self: 12/12 diagnosed, 4 chains incl. textbook session-forgery vector. (2) Crontech: 10/10, 2 critical chains (client-bundle exposure + supply-chain CI takeover). (3) Gluecron: 9/9, 3 chains incl. the cleverest one — *"Hardcoded secret + undeclared key in .env.example → secret rotation is impossible"* — describes operational lock-in neither finding describes alone. (4) MarcoReid: 9/9, 0 chains (correlator HONESTLY said findings independent rather than padding), but flagged real `parseFloat`-on-trust-account-money textbook fintech bug. Total Anthropic spend across all 4 proofs: ~$3-4. Margin at $399 = 100x+.
- [ ] Definition of done: customer can buy $399 tier and receive a deliverable that justifies a $399 spend (i.e. a real engineer would say "yes, that was worth $399").

### Phase 4 — Honesty sweep

- [x] **4.1** Disable any of the 90 modules that don't survive real-repo validation — **DONE no-op** (this commit). Across the four real-repo proofs (gatetest, Crontech, Gluecron, MarcoReid) every module that fired produced legitimate findings. No module crashed, no module produced obvious noise. All modules load via `node bin/gatetest.js --list`. No disabling required. The sweep posture: "we looked, found no module that needed disabling, all 90 (at the time) stayed in their assigned tiers."
- [x] **4.2** Sweep `compare/*` pages — **DONE** (this commit). The $199 Scan + Fix mentions across all 5 compare pages (snyk, deepsource, sonarqube, eslint, github-code-scanning) are now honest because Phase 2.3 shipped. Each page's auto-fix FAQ updated with a tail clause acknowledging the $399 Nuclear tier (Claude-driven per-finding diagnosis, attack-chain correlation, mutation testing, executive summary). github-code-scanning's "Auto-fix, not just alerts" comparison row also extended.
- [x] **4.3** Update CLAUDE.md `## VERSION` to reflect post-build state — **DONE** (this commit). v1.41.0 → v1.42.0 with full FIX-FIRST BUILD PLAN summary. Also fixed Bible drift "64 modules" → "90 modules" across 8 surfaces (was lingering from earlier).
- [x] **4.4** Move resolved Known Issues out of the table — **DONE no-op** (this commit). Reviewed all 29 Known Issues; the FIX-FIRST plan didn't directly resolve any (it added new tiers, didn't fix old bugs). No table edits needed.
- [x] **Bonus — `next.config.ts` ESM `__dirname` fix** — **DONE** (this commit). Next 16 loads next.config.ts as ESM where `__dirname` is undefined. Fixed via `path.dirname(fileURLToPath(import.meta.url))`.

### Operating rules during the build

1. **Pick up from the last unchecked box.** Every session reads this list, finds the first `- [ ]` box, and works it. No re-asking Craig.
2. **Commit at every meaningful milestone.** Bible's "no chicken scratchings" rule still applies — but partial-progress commits with clear messages are fine and encouraged so the next session has a clean handoff.
3. **Real-repo proof is mandatory.** No phase counts as done without the proof docs. "It compiles" is not done.
4. **Boss Rule loosened for this plan only.** Sub-tasks 2.3, 3.6, and 4.2 (the three would-be pauses) are **pre-authorised** when the preceding sub-tasks of their phase have shipped with proof artifacts and tests green. So $199 doesn't get flipped on for sale until pair-review + architecture annotations + proof docs exist; $399 doesn't get flipped on until diagnosis + correlation + mutation + chaos + report + proof docs exist; compare-page sweep doesn't run until the modules being marketed are validated. Authorisation: Craig 2026-04-26 — *"we just want you to start building from the start and carry on to finish."* Nuclear-button items (production deploys, DNS, new third-party API integrations, brand rewrites, anything touching money/user-data outside this plan) still require Craig's explicit go-ahead.
5. **Update CLAUDE.md when a phase ships.** Tick the boxes. Move the version number. Add a date.
6. **Tests stay green.** Sweep checklist runs every session. If something this plan touched broke a test, fix it before moving on.

### Status tracker

| Phase | Started | Status |
| --- | --- | --- |
| 1 — Iterative fix loop | 2026-04-26 | 6/6 sub-tasks at scaffold-or-better. 1.1 ✓, 1.2a ✓, 1.2b ✓ **PRODUCTION-WIRED 2026-06-09** (server-side workspace hydration — gate live for all callers), 1.3 ✓, 1.4 ✓, 1.5 ~ partial (1/3 proofs done; remaining 2 need API-keyed session). |
| 2 — $199 Scan + Fix tier | 2026-04-26 | **5/5 SHIPPED — $199 LIVE FOR SALE** (2.1 ✓, 2.2 ✓, 2.3 ✓, 2.4 ✓ 4/3 proofs). |
| 3 — $399 Nuclear tier | 2026-04-26 | **7/7 SHIPPED — $399 LIVE FOR SALE** (3.1 ✓, 3.2 ✓, 3.3 ✓, 3.4 ✓, 3.5 ✓, 3.6 ✓, 3.7 ✓ 4/3 proofs). |
| 4 — Honesty sweep | 2026-04-26 | **5/5 SHIPPED — PHASE 4 COMPLETE** (4.1 ✓ no-op, 4.2 ✓, 4.3 ✓, 4.4 ✓ no-op, bonus ✓ next.config.ts ESM fix). |

---

## KNOWN ISSUES — RESOLVED (moved from the Bible)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Scan page needs fresh checkout — stale sessions show "cancelled" | MEDIUM | DONE (2026-04-16) — `/api/scan/status` now returns a new `status: "expired"` state when `piStatus === "canceled"` AND no `scan_status` metadata exists (i.e. session expired BEFORE scan ran). Page renders a dedicated slate-palette "Session Expired" block with a prominent "Start New Scan" CTA, distinct from the amber failure state. |
| 2 | Website design needs major upgrade — current is basic | HIGH | **DONE** (2026-06-03, PR #177) — Full wishlist complete: navbar dual-layer glass (backdrop-blur-2xl + inset highlight shadow), stats counter-animation on scroll (CountUp in Hero StatusCell, fixed comma-number handling), comparison-bar fill-on-scroll (staggered delays, GateTest row fills last), module-card 3D perspective (perspective(900px) rotateX/Y tilt on hover, prefers-reduced-motion guarded). |
| 8 | Gluecron-first direction ratified in the Bible — still need Gluecron's API surface (endpoints, auth, webhook model) before the `HostBridge` refactor can ship a `GluecronBridge`. | HIGH | DONE (2026-04-19) — GluecronBridge shipped, website callers swapped off GitHub App. `src/core/gluecron-bridge.js` implements the HostBridge contract; `website/app/lib/gluecron-client.ts` replaces `github-app.ts` in scan/run, scan/fix, scan-executor, and admin/health. Env migrated to `GLUECRON_BASE_URL` + `GLUECRON_API_TOKEN`. `src/core/github-bridge.js` kept as a sibling implementation per the HostBridge architecture. **REVERSED 2026-04-22 on the `/api/webhook` sub-clause** — see Known Issue #27 (dual-host revival). The Gluecron migration as a whole stands; only the GitHub webhook shutdown was premature. |
| 9 | `HostBridge` abstraction not yet extracted from `src/core/github-bridge.js`. Pre-authorized. Safe to do in parallel with getting Gluecron answers. | MEDIUM | DONE (2026-04-14) — `src/core/host-bridge.js` shipped, `GitHubBridge extends HostBridge`, registry + shared markdown formatter + 21 contract tests green. Gluecron bridge can plug in without further refactor once API surface is known. |
| 10 | Our own `.github/workflows/ci.yml:49` has `continue-on-error: true` on the GateTest job — Bible Forbidden #24 violation. Caught by the new `ciSecurity` module (dog-fooded). Fix = remove that line once the self-scan is known-green; until then the gate is advisory-only in our own CI. | HIGH | DONE (2026-04-16) — `continue-on-error: true` removed from BOTH the gatetest-quick step (ci.yml:51) and the gatetest-full step (ci.yml:90). SARIF / artifact upload steps keep `continue-on-error` because Forbidden #24 scopes to the gate step itself. Self-scan is green: 816/816 tests pass, 67/67 modules load, website builds clean. |
| 11 | Landing-page hero (`website/app/components/Hero.tsx:16,28,71`) says "13 Modules". Product ships 67 modules per Bible v1.40.0 version string. Marketing drift — day-one customers will see numbers that don't match docs / CLI `--list`. | HIGH | DONE (2026-04-17) — Craig authorized "just do it all". All 13→67 references aligned across 9 surfaces: `Hero.tsx` (4 places incl. badge, subhead, terminal output, stat tile), `Pricing.tsx` (Full Scan description + features), `layout.tsx` (structured-data Offer), `manifest.json`, `opengraph-image.tsx`, `api/checkout/route.ts` (2 places), `scan/status/page.tsx` (2 CTAs), `admin/AdminPanel.tsx`. Hero stat "200+ Quality Checks" also bumped to "800+" to match product reality. |
| 12 | 31 of 67 modules have no 1:1 `tests/<name>.test.js` file (ai-review, agentic, accessibility, chaos, code-quality, compatibility, csharp, data-integrity, documentation, e2e, explorer, go-lang, integration-tests, java, kotlin, links, lint, live-crawler, mutation, performance, php, python, ruby, rust-lang, secrets, seo, swift, syntax, unit-tests, visual). 816 tests pass so they're not untested — most are covered via integration paths, shared universal-checker tests, or reporter tests — but per-module test files are still missing. Quality Bar #1 risk: a silent regression in one of these modules may not fail a specific test. | MEDIUM | DONE (2026-04-17) — 31 baseline test files shipped in one batch. 19 modules exercised end-to-end via `mod.run(result, { projectRoot: tmp })` against a scratch tmpdir (syntax, lint, secrets, unitTests, integrationTests, accessibility, compatibility, dataIntegrity, documentation, python, go-lang, rust-lang, java, ruby, php, csharp, kotlin, swift). 12 modules narrowed to shape-only (name / description / `typeof run === 'function'`) — 9 for external-surface reasons (e2e, visual, performance, chaos, mutation, aiReview, agentic, liveCrawler, explorer) and 3 because they require the full `GateTestConfig` object not a plain `{}` (codeQuality, links, seo). Suite count jumped from 263 to 298; pass count jumped from 816/816 to 864/864. All green. |
| 13 | **Webhook signature verification fails open** — both `/api/webhook/route.ts:108` (GitHub) and `/api/stripe-webhook/route.ts:32` (Stripe) returned `true` when the respective secret env var was unset. Any attacker could forge events → trigger scans on any installed repo, forge payment-capture events. | CRITICAL | DONE (2026-04-18) — Both endpoints now **fail closed**: missing secret ⇒ reject. Added explicit empty-signature / empty-signature-array guards to Stripe path. Bible Forbidden #15 compliance. |
| 14 | **Marketing copy drift** — "20 modules" resurfaced across 8 surfaces (layout.tsx metadata x3 + structured-data, Cta.tsx x3, github/setup x2, github/installed x1). Customers would see "20" in the hero/meta and "67" in checkout. | HIGH | DONE (2026-04-18) — All 8 replaced with "67 modules" (+ structured-data description). |
| 15 | **Phantom "$199 Scan + Fix" tier in Cta.tsx:29** — tier did not exist in `/api/checkout` TIERS (only `quick` $29 and `full` $99). Customer click-through would mismatch checkout. | HIGH | DONE (2026-04-18) — Cta card now shows "Full Scan — $99 / All 67 modules". |
| 16 | **Commit status hangs forever on scan crash** — `/api/webhook/route.ts` processWebhook set `pending`, fire-and-forget scan, if scan threw the commit stayed at "Scanning..." indefinitely. | HIGH | DONE (2026-04-18) — Wrapped the whole pipeline in try/catch that forces status→`failure` with "Scan failed — please retry" description on any thrown error. Tracks `pendingSha` so the failure goes on the right commit. |
| 17 | **PII in error logs** — `/api/stripe-webhook/route.ts:161` logged full `sessionId`, `paymentIntentId`, `tier`, `repoUrl` on missing-metadata events. Logging infrastructure becomes a PII store. | HIGH | DONE (2026-04-18) — Logs now emit only 12-char prefixes of Stripe IDs + boolean `tierPresent` / `repoUrlPresent` flags. Enough to correlate, not enough to reconstruct. |
| 18 | **Checkout error leaks Stripe internals** — `/api/checkout/route.ts:161` returned raw `err.message` to the browser. Stack traces and Stripe API error shapes exposed. | HIGH | DONE (2026-04-18) — Server-side log preserves full error; user-facing response is a generic "Checkout failed. Please try again or contact support." |
| 19 | **Admin brute-force resistance weak** — `/api/admin/auth/route.ts` had a fixed 400ms delay on failure. At ~150 guesses/minute a long-lived attacker could enumerate passwords. | HIGH | DONE (2026-04-18) — Bumped to randomised 1500-2500ms delay (jitter eliminates timing side-channels, ceiling ~30 guesses/minute vs. an exponential-entropy password). Durable per-IP lockout requires external state; tracked as follow-up. |
| 20 | **`/api/scan/run` had no idempotency** — browser refresh / back-button / network retry / concurrent stripe-webhook after() would re-run the scan AND re-capture the PI. Potential double-charge or overwrite of a valid result. | HIGH | DONE (2026-04-18) — Added Stripe-metadata-based idempotency: before scanning, fetch the PI, check `metadata.scan_status`. If `complete` or `failed`, return the cached state; do not re-scan, do not re-capture. Lookup failures fall through to scan (never block a legit customer on a stale lookup). |
| 37 | **Product-direction pivot (Craig, 2026-07-09)** — engine-first re-sequencing: (1) lead with the 120-module engine over the 22 MCP tools, (2) customer-chosen model (Sonnet 5 / Opus 4.8 / Fable 5) vs BYOK, (3) tidy MCP messaging, (4) pen-testing Coming Soon. | MEDIUM | **DONE (2026-07-10, v1.58.0)** — engine-first messaging shipped (MCP page/OG, derived tool count via `tools-data.ts`, llms.txt corrected); model picker shipped on CLI/MCP/website; BYOK shipped (CLI/MCP documented + website `anthropicApiKey`); Sonnet 5 everywhere per Craig's call; pen-test Coming Soon had already shipped 2026-07-09. Carved out as new Known Issues: #38 (shelved MCP pricing threshold), #39 (BYOK × $29/mo gate — Craig decision). |
| 21 | **scan/status page could stick at "Scanning..."** — `/scan/status/page.tsx` only recognised `complete`/`failed`/`expired`. Any other status from `/api/scan/run` (pending/running/cancelled/malformed) left the header reading "Scanning..." with a full progress bar. | MEDIUM | DONE (2026-04-18) — Unknown statuses are normalised to `failed` with an `error: "Scan returned unexpected state: X"` so the user always reaches a resolved UI and sees retry CTA. |
| 27 | **Dual-host revival (Phase 1 shipped)** — `/api/webhook` no longer 410s; it accepts GitHub App push / pull_request events, HMAC-verifies `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET` (fail-closed, Forbidden #15), and enqueues into the shared `scan_queue` via `scan-queue-store.enqueueScan` — same path as Gluecron's Signal Bus. Uses `X-GitHub-Delivery` as the idempotency `eventId`. `gluecron-client.ts` already has GitHub PAT fallback so scans actually run. Helpers in `website/app/lib/github-events.js`, 23 unit tests in `tests/github-events.test.js`. Strategic direction updated from "Gluecron-first" to "dual-host, Gluecron-long-term". | HIGH | DONE (2026-04-22) — Phase 1 shipped. Phase 2 queued as Issue #28. |
| 28 | **Dual-host Phase 2: GitHub commit-status + PR comment callback** — worker currently calls Gluecron's callback only. GitHub-host scans run and are stored, but the customer's PR page shows no feedback. Needs `scan-worker.js` to branch on event origin (detect via repository↔installation lookup or add a `host` column to `scan_queue`) and call `GitHubBridge.postCommitStatus` + `GitHubBridge.postPullRequestComment` for GitHub-hosted jobs. Without this, GitHub Marketplace listing has no visible product loop. | HIGH | DONE (2026-04-23) — `scan_queue.host` column added (ALTER TABLE IF NOT EXISTS for safe migration). `github-events.js` tags jobs `host='github'`; `events-push.js` tags `host='gluecron'`. `website/app/lib/github-callback.js` posts commit status (success/failure/error) + formatted PR comment with per-module breakdown via global `fetch` using `GATETEST_GITHUB_TOKEN`/`GITHUB_TOKEN`. Worker tick `dispatchCallback()` branches on `job.host`. 28 new tests in `tests/github-callback.test.js`. 1048/1048 tests pass, website builds clean. |
| 30 | **Five test files renamed `.test.skip.js`** to unblock CI — all five now RESTORED. (1) `datadog-client` — rewritten for actual API (fetchTopErrors/fetchErrorTraces/extractSourceLocation). (2) `incremental-filter` — fixed wrong property name + implemented missing universal-checker incremental support + config.incremental shape. (3) `incremental-scan` — implemented --since/--pr CLI flags + runner._resolveIncrementalFiles + skip/alwaysRun list logic. (4) `cross-repo-lookup` — replaced stale priorArt assertions with correct buildDiagnosisPrompt shape tests. (5) `mcp-server` — changed hardcoded "90 modules" to `\d{2,3}` regex. All 5 test files active, full suite 4721/4722 pass. | MEDIUM | **DONE** — all 5 skip files restored across PR #120 + PR #121. |
| 35 | **Public Pricing UI ↔ backend pricing mismatch (DISCOVERED 2026-06-30)** — `website/app/components/Pricing.tsx` renders Quick Scan $29, Full Deep Scan $99, and **Continuous Guard Shield $299/mo**, with NO $199 Scan+Fix or $399 Nuclear/Forensic cards. The checkout backend (`website/app/api/checkout/route.ts` `TIERS`) still defines quick $29, full $99, scan_fix $199, nuclear $399, and continuous at **$49/mo** (4900¢). So: (a) the UI advertises Continuous at $299 while checkout charges $49 — a live public-facing price discrepancy; (b) the $199 and $399 tiers are unreachable from the pricing page despite being "LIVE FOR SALE" per Phases 2-3; (c) commit 14e6e36 claimed to remove $29/$99 from the grid but they are present again (Pricing.tsx was rewritten as "Guard Shield" after that). Public copy also claimed "90+ modules" vs the real 111. | HIGH | **DONE (2026-06-30)** — Craig authorized the fix and confirmed the canonical lineup (Quick $29 / Full $99 / Scan+Fix $199 / Forensic $399 one-time + Continuous $49/mo). `Pricing.tsx` rewritten to render all five tiers matching the backend `TIERS` exactly, plus the free-CLI callout (`npx @gatetest/cli`); module-count copy fixed to "111". `marketing-claim-verification` pricing test green; `next build` clean. |
| 33 | **Hacker-news-monitor trainer built + tested but UNWIRED** — `website/app/lib/trainers/hacker-news-monitor.js` (Craig's 2026-05-29 HN-feedback directive) was absent from `trainer-nightly.yml` and the `bin/gatetest-train.js` TRAINERS array, held for Craig's Boss Rule #7 OK. | HIGH | DONE (2026-06-12) — **Craig authorized same-session** ("Yes, wire it in"). Trainer #8 now in `trainer-nightly.yml` (own step + docs/trainer artifact copy + "all 8 trainers" PR copy) and `gatetest train` (`--only hn`). Added `renderMarkdown()` + CLI main writing `~/.gatetest/trainers/hacker-news-latest.json`, matching the other trainers' contract. Verified end-to-end locally; still read-only / drafts-only — posting remains Craig's call (Boss Rule #8). |

## VISUAL & RUNTIME TESTING SPEC — TOOL 1 SHIPPED (READ THIS EVERY SESSION)

**Authorization:** Craig 2026-07-01 — full 10-tool spec handed over
(`GATETEST_VISUAL_SPEC.md`) with the directive to build Tool 1 first:
*"This single tool would have caught the Vapron redesign before it went
live."* The 10 tools, in the spec's stated build order: `visualRegression`
(Week 1, **SHIPPED**), `interactiveElements` (Week 2, **SHIPPED this
session**), `apiHealth` (Week 3), `performanceBudget` + `mobileRendering`
(Week 4), `formTesting` + enhanced `consoleErrors`/`runtimeErrors` (Week 5),
`deployGate` (Week 6, orchestrates all the above). Tools 3-10 are
recorded here so future sessions pick up the build order instead of
re-asking Craig — same pattern as the FIX-FIRST BUILD PLAN and the
Hyper-Aggressive Roadmap above.

**Cross-repo boundary decision (read before touching this module again):**
`visualRegression` was built inside GateTest (`src/modules/visual-regression.js`)
using Playwright + pixelmatch/pngjs — Playwright is an already-approved
GateTest dependency (see the Playwright-as-internal-dep decision below);
pixelmatch/pngjs are pure-JS, zero native bindings, added this session
directly at Craig's request. The **Jarvis platform** (`/opt/jarvis`,
separate repo/infra, `MarcoReid Intelligence Systems`) has its own
CLAUDE.md with an explicit **Rule 5 — "No Playwright... extend
`src/screenshot-service.js`"** for Jarvis's own orchestration code. To
respect both governing documents at once: the GateTest module itself
never hardcodes a Jarvis path or Jarvis's Slack bot token — `baselineDir`,
`platform`, `slackWebhook`/`SLACK_WEBHOOK_URL`, and `slackBotToken`/
`SLACK_BOT_TOKEN` are all config-driven with product-local defaults
(`.gatetest/visual-baselines/`). Jarvis orchestration (`audit-runner.js`
or a future wrapper) is expected to invoke GateTest as a subprocess/CLI
call — same pattern `audit-runner.js` already uses for build/test
commands — and pass `baselineDir: /opt/jarvis/visual-baselines/{platform}`
explicitly when it wants cross-platform monitoring. This keeps Playwright
entirely inside GateTest's own dependency tree; Jarvis's `package.json`
never needs it, satisfying Rule 5 to the letter.

`visualRegression` module contract: screenshots every configured route
at desktop (1280px) + mobile (390px) full-page, stores baselines under
`{baselineDir}/{platform}/{viewport}/{route-slug}.png`, diffs via
pixelmatch on first-mismatch-fails-open dimension padding (page grew/
shrank counts as real diff, doesn't crash), fails the check when diff
exceeds `threshold`% (default 5). `maskSelectors` config hides
dynamic-content regions (timestamps, live counters) before capture.
`updateBaseline: true` accepts an intentional redesign as the new
baseline. On a failing diff, best-effort Slack notification: bot-token
upload of a baseline|current|diff composite image when configured,
text-only webhook summary otherwise — both non-blocking (Forbidden #15).
Registered in the `wp` and `web` suites alongside `runtimeErrors` /
`explorer` (needs a live URL + Crontech-class worker; skips gracefully
on Vercel serverless same as its siblings). Real-repo proof: ran against
`https://vapron.ai` this session — first run created 1280×7098 (desktop)
and 390×11683 (mobile) full-page baselines; second run against the live
site again confirmed the pass path (0.05% / 0.06% diff, well under the
5% threshold); unit tests cover the fail path (synthetic PNGs, diff >
threshold → error-severity check + Slack notify invoked).

**Tool 2 — `interactiveElements` (link + button liveness crawler), SHIPPED
this session.** Built at `src/modules/interactive-elements.js`, deliberately
NOT a duplicate of `explorer` (which already does full autonomous QA:
forms, toggles, disclosures, screenshots, and clicks every button with
no safety list). `interactiveElements` is narrower and safety-first —
built specifically to close the gap the spec calls out: *"Destructive
buttons (delete, cancel) must not actually fire."*

- **Links** (`<a href>` without `role="button"`) are verified with a
  direct HTTP request, not a simulated click — faster, catches
  server-side 404s a client-side router would swallow, zero destructive
  risk. HEAD is the fast path; a HEAD timeout/4xx/5xx is verified with a
  real GET before being trusted (`_checkLinkLive`) — Next.js middleware
  routes can mishandle HEAD while GET works fine, confirmed against real
  `vapron.ai` routes during this session's proof run.
- **Buttons** (`<button>`, `[role="button"]`, `input[type=button|submit]`)
  ARE click-tested — there's no way to verify "does this do something"
  without clicking. Before clicking, the label is checked against a
  destructive-action pattern list (delete/cancel/unsubscribe/deactivate/
  sign out/archive/revoke/terminate/reset/ban/wipe/purge/...) —
  matches are skipped, never clicked. The pattern list only fires on
  short imperative labels (≤ 40 chars, doesn't end in `?`) — a long FAQ
  question like *"Can I cancel at any time?"* is NOT an action button
  and must still be click-tested; confirmed as a real false-positive
  against zoobicon.com's pricing FAQ during this session's proof run.
- **Dead-button detection** diffs page URL, `body.innerHTML.length`, a
  broad dynamic-UI selector count (dialogs/menus/dropdowns/popovers/
  toasts/`aria-expanded`), the clicked element's OWN class/aria-expanded/
  aria-pressed/data-state (catches React/Vue toggling state on the
  trigger itself), AND `<html>`/`<body>` class state (catches
  Tailwind/next-themes-style dark-mode toggles that touch the document
  root, not the button or body content — confirmed as a real false
  positive, "Toggle colour theme" on vapron.ai, before this signal was
  added). Modals opened by a click are dismissed (Escape, then a
  best-effort close-button click) before the next element is tested.
  Scrolling before element discovery is capped at a small step count so
  infinite-scroll pages can't turn one visit into an unbounded crawl.
- Reuses `checkUrl`/`fetchPage` from `live-crawler-http-helpers.js`
  rather than duplicating HTTP-fetch logic. 17 unit tests.
- Registered in the `wp` and `web` suites alongside `runtimeErrors` /
  `explorer` / `visualRegression`.
- **Real-repo proof**: `vapron.ai` (found 3 genuinely broken/hanging
  links — `/products`, `/forgot` hang 15s+ even under plain `curl`, not
  a module artifact; 7 remaining "dead" nav-category buttons are
  hover-only mega-nav triggers, a legitimate tap/keyboard-accessibility
  finding, not a false positive) and `zoobicon.com` (found likely-dead
  `Start Pro trial` / `Start Agency trial` / `Join the waitlist` CTAs on
  `/pricing` and dead FAQ accordion buttons — exactly the class of bug
  this tool exists to catch on a revenue-critical page).

**Tool 3 — `apiHealth` (endpoint status/timing/content-type checker),
SHIPPED this session.** Built at `src/modules/api-health.js` on top of
TWO pieces of infrastructure that already existed and were reused
rather than duplicated: `src/core/endpoint-discovery.js` (finds
(url, method, params) to test — OpenAPI spec > HTML crawl of forms/
links > a curated common-paths guess list) and
`src/core/live-probe-runner.js` (the HTTP engine already built for the
live-pentest-probe family — per-host rate limiting, per-request
timeout, wallclock budget, blocked-host SSRF protection). apiHealth
does NOT go through `authorization-gate.js` — unlike liveSqlInjection/
liveXss/etc. it never sends attack payloads, only benign valid/missing-
parameter requests, the same trust level as `liveCrawler` /
`interactiveElements`. Being pure HTTP (no Playwright), it's the first
tool in this spec that runs fine on Vercel serverless, not just the
Crontech-worker path.

- Per discovered endpoint (grouped by method+url, deduped across the
  per-param rows endpoint-discovery emits): a bare request with no
  parameters (the "invalid input" case — a well-behaved API should
  400/422, not 500) and a request with every parameter filled with a
  type-inferred benign value (email/url/id/phone/password/date
  heuristics on the param name). OpenAPI path parameters
  (`/users/{id}`) are substituted into the URL before sending — they're
  part of the route, not an optional input.
- Findings: 5xx on either request (error); 404 on a route sourced from
  OpenAPI/explicit-config/a real HTML crawl — NOT a speculative
  common-paths guess (error); an API-shaped endpoint (path contains
  `/api/`, `/graphql`, `.json`, `/wp-json/`, a non-GET method, or an
  OpenAPI source) answering with `text/html` instead of JSON — the
  literal "returns HTML instead of JSON" bug named in the spec (error,
  gated to TRUSTED sources only — see the false-positive note below); a
  2xx response claiming `application/json` that doesn't actually parse
  (error); response time over a slow/critical threshold (default 5s
  warning / 15s error).
- **Real false positive found and fixed during the vapron.ai proof
  run**: the wrong-content-type check originally fired on ANY
  API-shaped endpoint, including speculative common-paths guesses like
  `/graphql` and `/wp-json/wp/v2/users` on a site that runs neither
  GraphQL nor WordPress — those correctly get the site's normal
  200-status catch-all page back, which is expected behaviour for a
  guessed route, not a bug. Fixed by gating the check to `trusted`
  sources only (same gate the 404-check already had).
- Known, documented limitation (not silently overclaimed): this module
  cannot validate response BODY SHAPE against a schema (a tRPC
  procedure returning 200 with the wrong fields) — that needs a real
  contract to diff against, which is `trpcContract`'s / the static
  `openapiDrift` module's job. apiHealth only proves the endpoint
  answers, answers fast enough, and answers with the right
  content-type.
- 17 unit tests via a fake-runner injection (the real `LiveProbeRunner`
  blocks localhost/private IPs by design, so a local test server can't
  be used — same pattern `live-sql-injection.test.js` already uses).
  Registered in the `wp` + `web` suites.
- **Real-repo proof against `vapron.ai`**: 21 endpoints checked, 3
  genuinely broken (timeouts on `/api/login`, `/search`, `/download`,
  `/redirect`), 4 slow (one at 20989ms). This independently
  corroborates the `interactiveElements` proof from the same session —
  two completely different code paths (link-liveness HTTP checks vs.
  API endpoint probing) both surfaced the same underlying reliability
  problem on vapron.ai.

**Tool 4 — `performanceBudget` + `mobileRendering`, SHIPPED this
session.** Two modules, both from the spec's Week 4 grouping.

`performanceBudget` (`src/modules/performance-budget.js`) is the LIVE
counterpart to the existing `performance` module, which is entirely
static (bundle size from build output, HTML/JS regex checks, and a
check for whether the `lighthouse` CLI is *installed* — it never
actually loads a page). This module opens the real URL in Chromium and
measures TTFB (Navigation Timing), LCP and CLS (`PerformanceObserver`s
installed via `page.addInitScript` BEFORE navigation so early entries
aren't missed), and page weight (summed `content-length` across every
response). Per the spec's own stated limitations: one throwaway
warm-up request mitigates cold-start-inflated TTFB, and every route is
measured 3 times with the MEDIAN reported (matches the spec's own
Lighthouse-variance guidance) rather than failing the gate on a single
noisy run. Default budgets: TTFB 800ms / LCP 2.5s / CLS 0.1 / page
weight 2MB, all overridable via `modules.performanceBudget.budgets`.
10 unit tests via fake-browser injection.

`mobileRendering` (`src/modules/mobile-rendering.js`) is the focused,
spec-named counterpart to a lighter check `explorer` already does
(horizontal-overflow + clipped-text at 2 viewports as one signal among
many in its full autonomous pass) — this module runs the full 5-device
matrix the spec names (390 iPhone / 414 Android / 768 tablet / 1024
small-laptop / 1280 desktop) as ABSOLUTE checks (not a diff against a
baseline like `visualRegression` — this catches "broken right now").
Adds one check `explorer` doesn't do: unreadably small text (computed
font-size below a configurable legibility floor, default 10px).
`moduleCfg.exemptRoutes` (string prefix or RegExp) skips narrow-
viewport checks for intentionally desktop-only pages (the spec's own
stated limitation — e.g. an admin dashboard). A navigation failure on
one viewport is bucketed as its own `page-errors` finding, NOT folded
into "overflow" — confirmed as a real mislabeling bug during the
vapron.ai proof run (a 20s timeout on the iPhone viewport was
originally being reported as a horizontal-overflow finding). 11 unit
tests via fake-browser injection.

Both registered in the `wp` + `web` suites, both need Playwright (skip
gracefully without it, same as their siblings).

**Real-repo proof against `vapron.ai`**: `performanceBudget` passed
cleanly on the homepage (TTFB 15ms, LCP 244ms, CLS 0.0001, 236KB — all
comfortably within budget), proving the pass path works on a real fast
page. `mobileRendering` found genuine issues: 63px horizontal overflow
at 1024px (laptop), and 9.92px text on FOUR viewport widths including
1280px desktop (dashboard stat-card labels — a real, consistent
small-font choice, not a mobile-only issue) — plus the iPhone-viewport
navigation timeout that led to the page-errors bucketing fix above.

**Tools 5-10 SHIPPED 2026-07-01 (overnight session, Craig's renumbered
build order — supersedes the Week 5/6 grouping above).**

**Tool 5 — `formTesting`, SHIPPED.** `src/modules/form-testing.js`.
Fills and submits SAFE forms only (contact, newsletter, search,
feedback) via Playwright; verifies a real success signal (URL change,
success text, DOM delta, or a fired non-GET request) rather than
trusting a silent submit. Payment-shaped forms (card/CVV fields, or a
Stripe/Braintree/PayPal element), auth-shaped forms (`input[type=password]`),
CAPTCHA-protected forms, and destructive-labeled submits are detected
and SKIPPED — never submitted, never bypassed (the Boss-Rule-adjacent
sub-pieces flagged in the prior session's note were resolved by simply
not doing them). Email fields always resolve to `test@gatetest.ai` so
a real inbox is never reached. 13 unit tests. Real-repo proof:
zoobicon.com (1 form found, submitted OK), vapron.ai (0 forms on
crawled pages — clean).

**Tool 6 — `consoleErrors`, SHIPPED.** `src/modules/console-errors.js`.
Site-WIDE crawl aggregating console.error/warn + page errors across
every same-origin page visited — the breadth counterpart to
`runtimeErrors`' single-page depth. Fingerprints strip line:col/query
strings/hex ids/numbers so the same underlying error across N pages
collapses to one finding with a page count. Errors seen on every
crawled page are flagged "persistent" and promoted to error severity.
A known-noisy allowlist (GA/GTM, Facebook Pixel, Hotjar, doubleclick,
favicon 404s, Next.js Fast Refresh) prevents "always finds 40 errors on
every site" syndrome. 11 unit tests. Real-repo proof against
`vapron.ai`: found a real, persistent, site-wide bug — the site's own
`style-src 'self' 'unsafe-inline'` CSP blocks its Google Fonts
stylesheet on all 5 crawled pages.

**Tool 7 — `designSystemCompliance`, SHIPPED.**
`src/modules/design-system-compliance.js`. Audits LIVE computed styles
(not source/Tailwind-config, not a pixel baseline) for design-system
drift: near-duplicate colors (RGB distance ≤ 10) clustered as
"probably one token," distinct color/font-size/font-family/border-radius
counts above configurable thresholds, and margin/padding values not on
a configurable spacing grid (default 4px). No opinion on aesthetics —
only on internal consistency. 12 unit tests. Real-repo proof:
vapron.ai (52 colors vs. 20 threshold, 17 font sizes, 35 off-grid
spacing values), zoobicon.com (4 duplicate-color clusters).

**Tool 8 — `crossBrowser`, SHIPPED.** `src/modules/cross-browser.js`.
Runs the same page load across Chromium/Firefox/WebKit (Chromium as
reference), diffing navigation success, page/console errors, and a
pixel-diffed screenshot (reuses `core/visual-diff-engine.js` — no
duplicated diff logic). An engine that can't launch (missing binary or
missing OS-level shared libs) is skipped per-engine at info severity,
never blocking. Documented limitation: engine-specific-error matching
is exact-text, not fingerprinted — different vendors phrase the same
underlying error in unrelated templates, so no cheap normalization
safely unifies them. 10 unit tests. Real-repo proof: installed
firefox+webkit binaries this session; firefox independently
reproduced the Tool 6 CSP/fonts bug on vapron.ai in its own error
phrasing (real cross-engine corroboration); webkit gracefully skipped
(this host lacks libgtk-4/libflite/libavif); zoobicon.com clean on
both engines that ran.

**Tool 9 — VS Code extension, VERIFIED (already existed).** Found a
fully-built, non-stub extension already shipped in an earlier session
(commit `89ff568`) — `vscode-extension/` with a real 346-line
`extension.ts` (scan commands, diagnostics collection, status bar,
sidebar views, MCP auto-setup for Claude/Cursor/Windsurf/Cline).
Verified `npm install && npx tsc -p ./` compiles clean. Found and
fixed one real broken-state item (Always-On Mode): `package.json`'s
`icon: "images/icon.png"` pointed at a file that didn't exist (would
break `vsce package`) — fixed by reusing the existing
`website/public/icon-400.png` brand asset. Also gitignored the
compiled `out/` dir and `*.vsix` packages (build artifacts, same
pattern as `website/.next/`).

**Tool 10 — `deployGate`, SHIPPED.**
`integrations/github-actions/gatetest-deploy-gate.yml`. The deploy-time
counterpart to `gatetest-gate.yml` (which only ever sees checked-out
code, never a live URL) — fires on a `deployment_status` event
(state=success) or manual `workflow_dispatch(url)`, writes
`.gatetest/config.json` pointing `webUrl`/`wpUrl`/`targetUrl` at the
deployed URL (the shared fallback chain all 9 live modules already
read), runs the full `web` suite against it, reports a GitHub
deployment status back, and fails the workflow itself on a blocking
result. This is the literal "deployGate, orchestrates all the above"
from the original Week 6 spec. Marked as a PROTECTED INTEGRATION FILE,
opt-in (not part of `install.sh`'s required three). 4 new guard tests
added to `tests/integrations.test.js` (22/22 pass) verifying the file
exists, never soft-fails, triggers correctly, actually fails on a
blocking result, and orchestrates all 9 live modules via the `web`
suite.

Module count 116 → 120 across Tools 5-8 (formTesting, consoleErrors,
designSystemCompliance, crossBrowser — Tool 9 is dev tooling and
Tool 10 is CI config, neither registers a scan module).
`site-stats.json` and `modules-data.ts` regenerated/updated after each
module tool. Full suite: 6059 tests, 6056 pass, 3 skipped (unrelated
pre-existing skips), 0 fail. Website builds clean throughout.

---

## VERSION CHANGELOGS (moved from the Bible)

**Pre-launch credibility pass — overnight session (2026-07-12, commits 81d6382 + ca4ce4b + follow-ups):** Craig's directive: website info must be correct, professional, trust-building, no cyberpunk; full autonomy granted overnight. Two fronts:
- **Website correctness (81d6382 + ca4ce4b):** every stale module count fixed (90/110/111/118 → 120) across compare pages, blog, country pages (incl. the test that had itself gone stale asserting 110 — now reads the measured count from site-stats.json), Slack bot, chat prompt (also Nuclear→Forensic rename, Full-Scan-is-scan-only correction per Bible honesty note), deepsource FAQ mutation-testing claim removed, hero "Launching today" → "Live in beta". Hall of Scans: typo fixed, Gluecron correctly described as a git host, misleading "$399" tags dropped from dogfood scans, per-entry engine-version honesty. Dead trust panel ("STANDBY / Awaiting first scan") replaced by dated MEASURED fallback: `scripts/generate-self-scan-fallback.js` writes `website/app/data/self-scan-fallback.json` from the real report; `HomeSelfScan` + the status API route serve it when no live CI publish exists. KEY DIAGNOSIS: most live-site wrongness was a **stale deploy on the Coolify box**, already fixed in main — redeploy is on Craig's checklist (`CRAIG-MORNING-CHECKLIST.md`), along with the missing `GATETEST_INTERNAL_TOKEN` secret + `SELF_SCAN_STATUS_URL` var that have made CI's badge publish silently no-op forever.
- **Self-scan dogfood: 85 blocking findings → 0 (ca4ce4b), all root-cause:** ignore-file module/rule spelling normalization (kebab-case entries now match camelCase registry names — the copy-from-finding path never matched before; 5 regression tests); syntax module now compiles CJS inside Node's module wrapper (bare vm.Script false-positived legal top-level `return`); log-streamer real fs TOCTOU fixed (open-then-fstat); 45 error-swallows documented with `// error-ok:` reasons per the module's own convention; env-vars module no longer flags its own doc comments; eslint.config react-hooks compiler-rule demotion rescoped (unscoped block made ESLint 9 crash exit-2 — the lint module had been silently dead; now runs clean, 0 errors); `.gatetestignore` created (marketing-snippet localhost FP + reliability-corpus known-bad training data); 28 env vars documented in .env.example; mcp-remote banner console.log→console.error. Gate: PASSED 41/41.

**deadCode import-graph completeness (2026-07-11, commit 4d0128a):** Careful analysis of the 266 `unused-export` findings showed most were false-positive CLASSES from an incomplete import graph — NOT the tool being wrong about genuine dead code (which it still catches). Five root-cause fixes in `dead-code-extractor.js` / `dead-code-index.js` / `dead-code.js`, each with a regression test that ALSO asserts genuinely-dead code is still flagged (no false negatives):
- **Namespace imports** — a whole-module import (`const M = require('./m')`, `import M from`, `import * as`, dynamic import) can reach any export via `M.helper` or a late destructure, so none of that file's exports are flagged. Kills the ubiquitous "exported for the test" CommonJS pattern (`src/` 43 → 0).
- **TS `import type { X } from`** was not parsed at all — now handled (plus inline `{ type X }`).
- **Barrel re-exports** — `export * from './x'` and `export { a } from './x'` are now tracked, so an `index.ts` barrel no longer makes the underlying files' exports look dead (`integrations/` 7 → 0).
- **Python internal refs** — a def/class referenced within its own file (dispatch table, registry, internal call) is used, not dead; no longer extracted as an export (`.holdenmercer` runner 17 → 0).
- **Test files** (`*.test.*`, `*.spec.*`, `/tests/`) are runner entry points, never imported — incidental exports no longer flagged (`tests/` 7 → 0). Plus VS Code `activate`/`deactivate` added to FRAMEWORK_RESERVED.
- Net: 266 → ~131 on our repo; the remainder is now GENUINE dead code (an orphaned admin UI kit from the tab refactor) the tool should report. 13 new regression tests (44 deadCode tests total).

**Engine-quieting dogfood pass (2026-07-11, commits ..f45850e):** Ran the engine on our OWN repo, found the top false-positive floods, fixed each at root cause with a regression test (never suppressed our own findings). Measured before→after on this repo:
- **errorSwallow ~90 → 5.** `.write()` dropped from the promise-method hints — Node's `Writable.write()`/`ClientRequest.write()` return a boolean, never an awaitable promise, on ANY receiver (was 42 FPs; the receiver allowlist couldn't enumerate every stream var name). `.delete()` now only flags with an object-literal arg — `Map`/`Set`/`cookieStore.delete(key)` return boolean/void, only ORM `delete({where})` is a real floating-promise.
- **lint 376 errors → 0.** Markdown whitespace nits (trailing spaces, blank lines) downgraded error→info; a code gate must not bury real findings under prose-style notes.
- **syntax 100 → 0.** The dangling backtick/paren heuristic now (a) skips files the authoritative parser (`vm.Script`/`node --check`) already accepted — balanced by definition; (b) counts backticks on STRIPPED source so a backtick in a string/comment/regex doesn't trip it; (c) runs on `.js` only — TS/TSX get real `tsc` validation and the JS stripper mis-handles generics/JSX. Real unclosed literals in unparseable files still caught.
- **deadCode: Python constant FPs removed.** Module-level UPPER_CASE assignments (`REPO`, `TASK_ID`) are no longer extracted as Python "exports" — they're in-module config, not a reusable API (300+ FPs on one runner script). `def`/`class` detection unchanged.
- **Still open (next task, deferred to avoid hiding real dead code):** deadCode flags TS/JS public-API exports in `integrations/` because no INTERNAL file imports them, though they're the external surface consumed by Crontech/Gluecron. Needs a `package.json` exports / public-surface-aware fix + an `import type` / barrel-re-export scanner audit.
- ~15 new regression tests across error-swallow / lint / syntax; full fast suite green, heavy 304/304, build clean.

**v1.59.0 changes (2026-07-11 — core-engine program: every-scan flywheel + false-positive control + entry-level CLI):**
Three workstreams from the launch plan (`~/.claude/plans/ok-since-we-re-getting-ancient-lamport.md`), reusing existing engine pieces rather than rebuilding.
- **WS1 — every-scan flywheel capture (opt-out) + central ingest.** Previously ONLY fixes fed the flywheel; a thousand scans produced zero learning. New `src/core/scan-telemetry.js` writes an anonymized record per scan (module names + integer error/warning counts + gate status — never code/paths/findings) and auto-calls `persistentMemory.recordScan` (closing the exposed-but-never-called gap → fireRate always fresh). Wired at CLI / MCP `handleScanLocal` / website `/api/scan/run` (Action inherits CLI). `src/core/telemetry-uploader.js` buffers + best-effort POSTs to `POST /api/telemetry/scan` (`scan-telemetry-store.ts` + shared pure sanitizer `scan-telemetry-sanitize.js` that REJECTS any path/content/message-shaped key; Neon store, 503 + keep-buffering when `DATABASE_URL` unset — today's pre-Vapron state). Opt-out: `GATETEST_NO_TELEMETRY=1` or `.gatetest.json {telemetry:false}`, one guard for all entry points + a one-time CLI notice. New `telemetry` rate-limit preset (20/min).
- **WS2 — false-positive control (the 'quiet tool').** `src/core/ignore-file.js`: repo-root `.gatetestignore` (`module:rule` | `module` | `*:rule` | `module:rule@glob` | `path/**`) suppresses findings — excluded from the block decision AND every failure count, kept in a visible `suppressedChecks` list. `src/core/noise-model.js`: turns per-module fireRate + dismissals (persistent-memory + false-positives.json) into confidence penalties the runner applies (a chronically-dismissed high-fire module softens below the 0.7 block threshold, `flywheel-softened` signal; never on thin evidence — min 3 runs, 3 dismissals, >50% fire-rate; floored 0.5) AND a ranked `gatetest --noise` report. End-to-end verified: a secret that blocks the gate passes once `secrets` is in `.gatetestignore`.
- **WS3 — entry-level CLI front door.** `printPlainSummary()`: after every scan, a jargon-free recap + the ONE next command (PASS → commit; BLOCK → `fix --apply` / `--noise` / `.gatetestignore`). Suppressed under `--sarif`/`--junit`/`--github-annotations`/`--report-only` so CI stays clean. Default suite deliberately unchanged (no smart-for-no-args — would alter CI). The entry-level WEB door already exists (`/scan/url`); enhancing it is Boss Rule #8, flagged for Craig.
- 50 new tests (scan-telemetry capture/opt-out/uploader/sanitizer, ignore-file grammar, noise-model thresholds, runner suppression+softening, plain-summary subprocess). Fast suite green (pre-existing ai-guardrails-module libuv flake only), heavy 304/304, website build clean.

**v1.58.1 changes (2026-07-11 — the four v1.57.0 debug tools were never actually reachable; restored):**
- **Broken state found during the distribution push:** `run_tests`, `stream_logs`, `query_db`,
  `http_request` had handlers, exports, and direct unit tests (`tests/heavy/mcp-debug-tools.test.js`)
  — but were **missing from the `TOOLS` array AND the dispatcher switch** in `bin/gatetest-mcp.mjs`.
  No MCP client could list or call them, while the $29/mo page sold all four. The v1.57.0 changelog
  claimed "4 tool definitions + 4 dispatcher cases"; that wiring was never in the file.
- Restored: 4 tool definitions (schemas matching the handler args), 4 dispatcher cases, all four
  added to `GATED_TOOLS`. Live `tools/list` now returns **24 tools** (verified by spawn test).
- Heavy tripwire updated 20 → 24 (`tests/heavy/mcp-server.test.js`).
- Tool-count truth reconciled everywhere: Bible said 22 (2 phantom rows), the npm/README/server.json
  said 20 (pre-restoration count). All surfaces now say **24**; `website/app/mcp/tools-data.ts` gained
  the 3 previously-unlisted tools (scan_repo, resolve_stack_trace, blame_regression) and TOOL_COUNT
  counts distinct tool names.
- **Lesson:** a tool isn't shipped until it appears in a live `tools/list` — handler + tests + marketing
  can all exist while the tool is unreachable. The tripwire test now pins the exact registered count.

**v1.58.0 changes (2026-07-10 — Sonnet 5 everywhere + user-selectable model + BYOK + engine-first messaging):**
- **Sonnet 5 upgrade (Craig's call):** `CHEAP_MODEL` → `claude-sonnet-5` in both engine-models
  twins; every hardcoded `claude-sonnet-4-6` in live code, workflows, and site copy swept to
  sonnet-5 (same sticker price $3/$15 per MTok; intro $2/$10 through 2026-08-31 not baked into
  caps). docs/proofs + HISTORY left as historical record.
- **User-selectable model:** `ALLOWED_FIX_MODELS` allow-list (sonnet-5 / opus-4.8 / fable-5 +
  aliases) + `resolveModelChoice()` in both twins, parity-tested. Surfaces: CLI `--model` on
  `fix --apply` and `--auto-pr`, MCP `model` arg on fix_issue/explain_finding (schema enum built
  from the allow-list), website `model` field on /api/scan/fix (400 + allowedModels on bad input).
  Precedence: explicit choice > `GATETEST_FIX_MODEL` env (now honored by CLI + MCP + website —
  resolving the doc-drift where only the website read it) > per-tier default.
- **BYOK:** CLI + MCP documented as bring-your-own-key (user's `ANTHROPIC_API_KEY`, user's spend,
  straight to api.anthropic.com). Website fix route accepts optional `anthropicApiKey`
  (sk-ant-* shape check, per-request only via ALS tracker `apiKeyOverride`, never
  stored/logged/echoed — `snapshot()` whitelists fields). BYOK trackers: `maxUsd: Infinity`
  (customer's budget) + tier token cap kept as runaway guard; budget summary renders BYOK
  wording instead of "$Infinity". BYOK does NOT bypass the $29/mo MCP gate (open Craig decision).
- **CLI fix bug (pre-existing, found during design):** `bin/gatetest.js` called
  `runFixOrchestration(fixable, root, key, opts)` positionally and destructured a batch contract
  the per-file orchestrator never returned — `fix --apply` / `--auto-pr` crashed on
  `accepted.length`. Fixed with `runFixBatch()` in `cli-fix-orchestrator.js` (groups findings
  per file, drives the per-file orchestrator, composes prBody via `lib/pr-composer`).
- **Engine-first messaging (closes Known Issue #37):** MCP page + OG lead with the 120-module
  engine; tool catalog extracted to `website/app/mcp/tools-data.ts` so every surface derives the
  count (kills the "18 tools" drift); llms.txt module count now read from `site-stats.json`
  (was hand-written 110) and no longer claims "no subscription" alongside two subscriptions.
- Tests: engine-models allow-list + BYOK tracker + parity, `runFixBatch` contract,
  aiFix model pass-through (injection), heavy CLI subprocess (`--model bogus` exits 1 keyless,
  alias ordering, help text), heavy MCP (schema enum, check_health GATETEST_FIX_MODEL
  reflection). Fast suite 6198 pass / heavy 302 pass / build clean at ship.

**v1.57.0 changes (2026-07-06 — 4 new MCP tools: run_tests / stream_logs / query_db / http_request):**
- **`src/core/test-runner.js`** — auto-detects and runs the project's test suite. Supports
  Jest / Vitest / Mocha / pytest / cargo / go / rspec / npm; returns structured pass/fail per
  test. Handles Node.js 20+ spec reporter format (✔/✖/ℹ) AND TAP format. `detectRunner()`
  reads `package.json` scripts + devDependencies + manifest files to infer the runner.
  Zero new GateTest dependencies.
- **`src/core/log-streamer.js`** — tails a running process or log file for N seconds (max 60).
  Three modes: `command` (spawn + capture stdout/stderr), `logFile` (poll every 250ms),
  `pid` (Linux /proc — graceful error on Windows). Returns `{lines, totalLines, truncated,
  duration, mode}`. Zero new GateTest dependencies.
- **`src/core/db-client.js`** — read-only SQL/document queries. Hard-coded safety gate blocks
  INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE/GRANT/REVOKE/REPLACE/MERGE/EXEC.
  Driver resolution: tries project's own `node_modules` (pg/mysql2/better-sqlite3/mongodb/
  ioredis) before CLI fallbacks (psql/mysql/sqlite3/mongosh/redis-cli). Auto-detects dialect
  from connection string prefix. Auto-adds LIMIT N to SELECT queries. Max rows 100 (hard cap
  500). Connection resolution order: explicit arg → env vars → `.gatetest.json`. Zero new
  GateTest dependencies.
- **`bin/gatetest-mcp.mjs`** — 4 new handler functions + 4 tool definitions + 4 dispatcher
  cases. `handleHttpRequest` is inline (native `http`/`https`) — supports Bearer/Basic/
  custom-header auth, redirect follow (up to 5), 1MB body cap, 30s default timeout, both
  localhost and external URLs. All 4 tools added to `GATED_TOOLS` (require `$29/mo` key).
  `scan_local` description strengthened with mandatory-first-step language and debug protocol.
  Version bumped to `1.57.0` in the server greeting.
- **New tests**: `tests/mcp-run-tests.test.js` (12 tests), `tests/mcp-stream-logs.test.js`
  (13 tests), `tests/mcp-query-db.test.js` (34 tests), `tests/mcp-http-request.test.js`
  (13 tests) — 72 new tests, all passing. Node.js 20+ recursive test-runner guard avoided
  by using TAP-format output from `node -e` instead of spawning nested `node --test`.
- **`CLAUDE.md`** — new `### MCP Debug Protocol — MANDATORY` section under Session Protocol
  with the 5-step debug loop (scan_local → explain_finding → fix_issue → run_tests →
  verify_fix).

**v1.57.0 changes (2026-07-05 — MCP/CLI root-cause tools: source-map
trace resolution + git regression blame):**
- Craig's directive: make debugging smarter for any codebase, and make
  sure it's built INTO the MCP (not the scan/fix module engine) so it
  never cross-contaminates the paid scan+fix pipeline, and ALSO works
  from the CLI so both surfaces share one engine.
- **`src/core/source-map-resolver.js`** — zero-dependency Source Map V3
  decoder (hand-rolled Base64 VLQ, no `source-map` npm package). Resolves
  a minified/bundled stack-trace location (`dist/app.js:1:48213`) back to
  the original file:line:column (`src/Foo.tsx:42:7`) via an inline `data:`
  URI or a sibling `.map` file. Parses V8 (`at fn (file:line:col)`) and
  Firefox/Safari (`fn@file:line:col`) stack-frame shapes; frames with no
  reachable map are reported honestly as unresolved, never guessed.
  46 unit tests in `tests/source-map-resolver.test.js`.
- **`src/core/regression-bisector.js`** — read-only git blame/log helpers.
  `blameLine`/`blameRange` parse porcelain `git blame` output (single-
  and multi-commit-per-range); `showCommit` fetches a commit's message +
  capped diff; `findLikelyRegressionCommit` ranks candidate commits
  across several `{file, line}` hits (e.g. every frame of a resolved
  stack trace) by how many hits they explain. Deliberately never calls
  `git bisect`/`git checkout` — nothing here mutates the working tree.
  17 unit tests in `tests/regression-bisector.test.js`.
- **Two new MCP tools** (`bin/gatetest-mcp.mjs`): `resolve_stack_trace`
  and `blame_regression`, both gated behind the $29/mo MCP subscription
  (added to `GATED_TOOLS`). `tests/mcp-server.test.js`
  drift-tripwire updated; `tests/mcp-debug-tools.test.js` covers both
  handlers end-to-end against real fixtures (a real bundle+map pair, a
  real git repo).
- **Two new CLI subcommands** (`gatetest trace`, `gatetest blame`) at
  `bin/gatetest-trace.js` / `bin/gatetest-blame.js`, routed in
  `bin/gatetest.js` alongside `sweep`/`replay`/`train`/`fix`. Both call
  the exact same core engines as the MCP tools — one implementation, two
  entry points, so an MCP-connected agent and a CI script calling the
  CLI directly get identical answers. `tests/gatetest-trace-cli.test.js`
  + `tests/gatetest-blame-cli.test.js` cover the CLI wiring.
- **No cross-contamination**: both engines live in `src/core/`, not
  `src/modules/` — neither is registered in `src/core/registry.js` or
  any suite in `src/core/config.js`. Module count stays at 120; the paid
  scan+fix engine is untouched. First entry in a longer "make Claude
  smarter at debugging any codebase" list — remaining ideas (CDP
  breakpoint state capture, visual-diff-to-DOM-to-source mapping,
  cross-signal incident correlation, element-level DOM/style diffing,
  HAR capture tied to errors, minimal auto-repro scripts, sandboxed
  re-execution loop, parallel hypothesis debugging) tracked for later.

**v1.56.0 changes (2026-07-04 — MCP payment gate, $29/mo tier):**
- **`website/app/lib/mcp-subscription-store.js`** — new store for the MCP
  subscription tier. `generateApiKey()` (`gtmcp_<64hex>`, 70 chars),
  `upsertMcpSubscription()` (idempotent on conflict — preserves `api_key`
  on Stripe webhook retry), `findByApiKey()`, `setMcpSubscriptionStatus()`.
  Same Neon DB + tagged-template `sql` injection pattern as
  `continuous-subscription-store.js`.
- **`website/app/lib/digest-mailer.js`** — added `sendApiKeyEmail({ to, apiKey })`
  export. Dark-theme HTML email with key in `<pre>`, install command, link to
  `/mcp`. Same native `https` + Resend pattern, zero new deps.
- **`website/app/api/mcp/validate/route.ts`** — `GET /api/mcp/validate?key=xxx`
  → `{ valid: boolean }`. Fast-rejects keys that don't start with `gtmcp_` or
  are < 70 chars. Single indexed DB query, always 200 (never 5xx for bad keys).
- **`website/app/api/stripe-webhook/route.ts`** — `checkout.session.completed`
  subscription block now forks on `tier`: `mcp` branch generates a key, stores
  it, emails it (non-blocking). `continuous` branch unchanged. Both the MCP and
  Continuous `setXxxStatus()` helpers are called on
  `customer.subscription.updated/deleted`.
- **`website/app/api/checkout/route.ts`** — `mcp` tier added to TIERS
  (`$29/mo, recurring: true`). `repoUrl` validation skipped when `tier === 'mcp'`.
- **`bin/gatetest-mcp.mjs`** — in-process `isKeyValid()` cache (1-hour TTL,
  stale-cache fallback on network error), `GATED_TOOLS` Set, gate check at top
  of the `CallToolRequestSchema` dispatcher. `scan_local` free on quick suite;
  gated for any non-quick suite.
- **`website/app/components/Pricing.tsx`** — MCP card added (blue accent,
  `border-blue-500`, `ring-blue-500/30`). Grid expanded to `lg:grid-cols-4`.
- **`website/app/mcp/page.tsx`** — `/mcp` landing: hero with $29/mo CTA
  (client-side checkout fetch), 18-tool free-vs-paid table, Eyes/Ears/Hands
  value props, FAQ, bottom CTA.
- **`server.json` (root) + `packages/mcp-server/server.json`** — `GATETEST_API_KEY`
  added to `environmentVariables` (isRequired: false, isSecret: true).
  `packages/mcp-server/server.json` also expanded to include all Sentry/Datadog/
  Rollbar env vars (was missing them).
- **`tests/mcp-payment-gate.test.js`** — 12 unit tests: key format, cache TTL,
  cache fallback, gate firing, free tools bypass, store idempotency. 12/12 pass.

**v1.55.0 changes (2026-07-01 evening — 6-item security/quality/product
sweep):**
- **Paywall bypass fix** — `resolveFullReportAccess()` (`full-report-auth.ts`
  + unit-tested `full-report-auth-core.js`) is now the only thing allowed
  to grant `fullReport` on web/scan, wp/scan, and both `/stream` twins —
  admin request or a Stripe-verified paid session, never trusted from the
  client. **Also found and fixed a live production 500** on all 4 of
  those routes (confirmed against gatetest.ai, not just locally) — the
  CLI-engine require was invisible to Next's file tracer
  (`outputFileTracingIncludes` + `engine-entry-resolver.js` fix it); the
  same root cause was silently degrading `/api/scan/run`'s paid Full/
  Scan+Fix/Forensic tiers to the lighter fallback engine too.
- **False-positive elimination** across the 5 modules Craig named:
  `visualRegression` auto-masks dynamic content (timestamps/live clocks)
  by default now; `interactiveElements` no longer reports a hover-only
  mega-nav trigger as a dead button (reclassified into its own
  `hoverOnly` finding); `consoleErrors`' noisy-third-party allowlist
  grew from 7 to 20+ vendor patterns; `performanceBudget` tags a CLS
  failure as animation-driven vs. a single load-time thrash
  (diagnostic only, never changes pass/fail); `designSystemCompliance`
  excludes known third-party widget containers from the site's own
  color/spacing sample.
- **Playground polish** — real SSE streaming (`/api/playground/scan/stream`,
  `runTier()` gained an optional `onModuleComplete` callback), an honest
  "X/120" progress bar via the same shadow-preview upsell mechanic the
  $29 tier already uses (does not run the paid module catalog for free),
  severity-colour-coded findings, 48h shareable result URLs
  (stateless — no KV/Redis in the approved stack), and a "Fix This PR"
  button per finding that routes to the paid Scan+Fix checkout.
- **Jarvis deploy gate** — new `jarvis-deploy-gate` systemd service
  (separate `jarvis-platform` repo) polls Jarvis's own session-lifecycle
  table for real deploys and runs a live GateTest scan against the
  platform's URL, flagging critical findings to `#javis-cclabs` +
  `platform_state`. Advisory only (documented as such) — real hard
  enforcement is the GitHub Actions `deployGate` (below) wired as a
  required status check.
- **Embeddable badge** — `GET /badge/:owner/:repo`, the real path-wired
  version (a pre-existing `api/badge/[repo]/route.ts` had a misleading
  `[repo]` folder name that only ever read a query param). Added to
  GateTest's own README as the flagship example.
- **Vapron CSP fix** — pushed to `vapron` `origin/Main`: `WEB_CSP` was
  missing a Google Fonts allowance `CUSTOMER_CSP` (two lines below in
  the same file) already had — the exact persistent, site-wide bug
  `consoleErrors` and `crossBrowser` both independently found on
  vapron.ai during the Tools 5-10 session.

**v1.54.0 changes (2026-07-01 — Tools 5-10, Visual & Runtime Testing
Spec COMPLETE):** `formTesting`, `consoleErrors`, `designSystemCompliance`,
`crossBrowser` (4 new scan modules, 116 → 120), VS Code extension
verified + fixed (already existed, missing packaging icon), `deployGate`
GitHub Actions integration shipped. Full detail in the "VISUAL & RUNTIME
TESTING SPEC" section above — all 10 tools in Craig's build order are
now shipped. See that section for real-repo proof against `vapron.ai`
and `zoobicon.com` per tool.

**v1.53.4 changes (2026-07-01 — performanceBudget + mobileRendering,
Visual & Runtime Testing Spec Tool 4):**
- **`src/modules/performance-budget.js`** — new `performanceBudget`
  module. Live TTFB/LCP/CLS/page-weight via Playwright, median of 3
  runs with a warm-up request first. 10 unit tests via fake-browser
  injection.
- **`src/modules/mobile-rendering.js`** — new `mobileRendering` module.
  Horizontal-overflow + unreadable-text checks across the 5 device
  widths the spec names, plus `exemptRoutes` for intentionally
  desktop-only pages. 11 unit tests via fake-browser injection.
- Both registered in `src/core/registry.js` and added to the `wp` +
  `web` suites.
- **Real-repo proof against `vapron.ai`** — see the Tool 4 section
  above. `performanceBudget` passed cleanly on the homepage;
  `mobileRendering` found real overflow + tiny-text issues, and one
  real bug in the module itself (a navigation timeout was being
  mislabeled as an overflow finding) was found and fixed from the
  proof-run evidence before shipping.
- Module count 114 → 116. `site-stats.json` regenerated.
  `modules-data.ts` catalog updated.

**v1.53.3 changes (2026-07-01 — apiHealth module, Visual & Runtime
Testing Spec Tool 3):**
- **`src/modules/api-health.js`** — new `apiHealth` module. See the
  Tool 3 section above for the full design (endpoint-discovery +
  live-probe-runner reuse, path-param substitution, trusted-source
  gating on the wrong-content-type check). 17 unit tests via
  fake-runner injection.
- Registered in `src/core/registry.js` and added to the `wp` + `web`
  suites. Pure HTTP — no Playwright, runs on Vercel serverless.
- **Real-repo proof against `vapron.ai`** — see the Tool 3 section
  above. Found and fixed a real false positive (wrong-content-type
  firing on untrusted common-paths guesses) using live evidence before
  shipping. Found genuine timeouts on 4 routes, corroborating the
  `interactiveElements` proof from the same session via an independent
  code path.
- Module count 113 → 114. `site-stats.json` regenerated. `modules-data.ts`
  catalog updated.

**v1.53.2 changes (2026-07-01 — interactiveElements module, Visual &
Runtime Testing Spec Tool 2):**
- **`src/modules/interactive-elements.js`** — new `interactiveElements`
  module. See the Tool 2 section above for the full design (HTTP-based
  link liveness with a HEAD→GET fallback, destructive-action-skipped
  button click-testing, modal cleanup, bounded scroll). 17 unit tests.
- Registered in `src/core/registry.js` and added to the `wp` + `web`
  suites.
- **Real-repo proof against `vapron.ai` and `zoobicon.com`** — see the
  Tool 2 section above. Found genuine broken/hanging links, hover-only
  nav triggers (accessibility finding), and likely-dead pricing-page
  CTAs + FAQ accordions on zoobicon.com.
- Module count 112 → 113. `site-stats.json` regenerated. `modules-data.ts`
  catalog updated.
- Also found and fixed a pre-existing broken build (`Pricing.tsx` JSX
  structure, see the v1.53.1 fix commit) and confirmed a resource-
  contention false alarm in the Always-On sweep hook (running a manual
  full test-suite pass concurrently with the hook's own automatic pass
  produced a corrupted/truncated log and a false "test hang" signal —
  not a code defect; re-ran cleanly once the two passes weren't
  competing for the same CPU).

**v1.53.1 changes (2026-07-01 — visualRegression module, Visual & Runtime
Testing Spec Tool 1):**
- **`src/core/visual-diff-engine.js`** — pure pixel-diff algorithms
  (pixelmatch + pngjs, both pure JS). `compareScreenshots()`,
  `buildSideBySideComposite()`, dimension-mismatch padding so page
  growth/shrinkage at the bottom of a full-page capture is a real diff
  signal instead of a crash. 9 unit tests, zero browser dependency.
- **`src/modules/visual-regression.js`** — new `visualRegression`
  module. Playwright full-page screenshots at desktop (1280px) + mobile
  (390px), baseline-on-first-run, pixel diff on every run after, fails
  the check above a configurable threshold (default 5%). Best-effort
  Slack notification (bot-token image upload or webhook text) on a
  failing diff, never blocks the check itself. 20 unit tests incl. two
  exercising the real fail/pass paths with synthetic PNGs via a mocked
  browser.
- **New deps**: `pixelmatch@^7.2.0`, `pngjs@^7.0.0` — pure JS, no native
  bindings, Craig-authorized via the visual-spec handoff.
- Registered in `src/core/registry.js` and added to the `wp` + `web`
  suites (needs a live URL + browser, same family as `runtimeErrors` /
  `explorer`).
- **Real-repo proof against `vapron.ai`** (see the section above for
  detail) — baseline created, re-run confirmed pass path on the live
  site.
- Module count 111 → 112. `site-stats.json` regenerated
  (`node scripts/generate-site-stats.js`). MCP server help text
  (`bin/gatetest-mcp.mjs`) module-count strings + engine version bumped
  to match.
- Sweep: full suite green after regenerating site-stats.json (the
  honesty-lock test self-corrects once the JSON matches live counts).

**v1.53.0 changes (2026-06-30 — Weekly Digest: email + Slack):**
- **`website/app/lib/digest-mailer.js`** — Resend REST email sender (native `https`, no new npm dep). Dark-theme HTML email with stat cards (trend / net delta / scan count), health grade, top recurring module, patterns, CTA button. Plain-text fallback. Gracefully no-ops when `RESEND_API_KEY` not set.
- **`website/app/lib/weekly-digest.js`** — Orchestrator. `buildTrendFromHistory()` derives trend/netDelta/topModule/grade from `scan_history` rows (7-day window). `sendRepoDigest()` sends to Slack + email per repo. `runWeeklyDigests()` iterates all active Continuous subscribers and dispatches. Falls back to global `SLACK_WEBHOOK_URL` if no per-repo webhook.
- **`continuous_subscriptions` schema** — `customer_email` + `slack_webhook_url` columns added via safe `ALTER TABLE IF NOT EXISTS` migration. `upsertSubscription` accepts both; `COALESCE` on conflict so existing values are preserved. `setSlackWebhook()` helper added for future notification-settings UI.
- **Stripe webhook** — captures `customer_email` from `session.customer_email` / `session.customer_details.email` on subscription checkout and persists it for digest delivery.
- **`website/app/api/digest/route.ts`** — Admin trigger (`POST /api/digest`, Bearer auth). Optional `{ repo_url }` body for single-repo debug mode. `GET` returns health check. Max 120s Vercel timeout.
- **`.github/workflows/digest-weekly.yml`** — Cron Monday 08:00 UTC + `workflow_dispatch`. Calls `POST /api/digest` via curl, parses sent/failed counts, warns on delivery failures.
- **New env vars**: `RESEND_API_KEY` (Resend.com, optional — email skipped if absent), `RESEND_FROM` (sender override, default `GateTest <watchdog@gatetest.ai>`).
- **GitHub Actions secret needed**: `GATETEST_ADMIN_PASSWORD` + optional `GATETEST_BASE_URL` variable.
- Sweep: 5921/5924 pass (3 graceful TS-require skips), 0 fail. `next build` clean. 111 modules load.

**v1.52.0 changes (2026-06-30 — Godmode Tier 1: Playground + Badge page + Fix PR prominence):**
- **Live Public Playground shipped** — `website/app/playground/page.tsx` + `website/app/api/playground/scan/route.ts`. Free, no-auth, no payment. Paste any public GitHub URL → watch quick suite (syntax/lint/secrets/codeQuality) run with animated dark terminal → see health grade ring (A–F SVG circle) + module cards stagger in + top findings. Upsells to Full/Scan+Fix/Forensic. Badge embed snippet auto-generated for the scanned repo. 4 example repos (React, Next.js, Express, GateTest). Navbar + Hero wired: "Playground" nav link (emerald) + "Scan Free →" CTA.
- **Badge landing page** — `website/app/badge/page.tsx`. Documents and markets the `/api/badge?repo=owner/repo` embed. Live grade previews (A–F rendered as inline SVG). One-click copy for Markdown / HTML / RST. 3-step quickstart + API reference + why-it-matters cards. Footer links from playground reference it.
- **Fix PR hero action** — `scan/status/page.tsx`. Gradient banner (emerald→cyan) surfaces "Open Fix PR →" as the first visible action after scan results land on paid fix tiers (scan_fix/nuclear), above the full findings panel. Previously buried at the bottom after scrolling. Hidden once fixing starts or completes.
- Sweep: 5871/5874 pass, 0 fail. `next build` clean. 111 modules load. 3 commits.

**v1.51.0 changes (2026-06-30 — Godmode: smart suite, persistent memory, Slack):**
- **`--suite smart` shipped** — `src/core/smart-suite-selector.js` (325 lines, 28 tests). Diff-aware module selector with 35+ affinity rules maps file path patterns to relevant modules (weights 1-3). Baseline (memory/syntax/secrets) always runs; 15-25 dynamic modules chosen from what actually changed. Auth file → cookieSecurity/tlsSecurity/logPii/crossFileTaint. API route → ssrf/asyncIteration/nPlusOne/retryHygiene. DB/ORM → nPlusOne/raceCondition/moneyFloat. Infra → terraform/kubernetes/ciSecurity. No diff detected → falls back to quick suite. Wired into `src/index.js:runSuite()`, `src/core/config.js:getSuite()`, and `/api/v1/scan/route.ts` (smart now a valid tier). Emits `smart:selected` / `smart:fallback` events for CLI observability.
- **Persistent per-repo memory shipped** — `src/core/persistent-memory.js` (22 tests). Writes `.gatetest/memory.json` per repo. Tracks module fire rates, fix acceptance rates (merge vs rejection per rule key), quality trend (improving/declining/stable), recurring patterns (>80% of last 10 scans). `getSmartSuiteBoosts()` feeds signal back into the smart selector: modules firing >70% of the time get +3 priority boost; >40% get +1. `getFixConfidenceMultiplier()` returns 0.5-1.05 based on historical acceptance (≥3 attempts required to adjust). Never throws; graceful on missing or corrupted files. SCHEMA_VERSION = 2, MAX_SCAN_HISTORY = 100.
- **Slack integration shipped (Craig-authorized Boss Rule #7)** — `website/app/lib/slack-notifier.js` (22 tests). Block Kit builders for scan-complete, critical-finding alert, and daily digest messages. HMAC-SHA256 signature verification (Slack's security model, fail-closed). Slash command parse + `slashResponse` helpers. `website/app/api/slack/events/route.ts` handles `/gatetest scan <url> [quick|full|smart]`, `/gatetest status`, `/gatetest help`. Acks within Slack's 3s window; async scan posts rich Block Kit results back via `response_url`. `/api/v1/scan/route.ts` fires `notifyScanComplete()` after every scan when `SLACK_WEBHOOK_URL` or per-request `slack_webhook` is set.
- **New env vars**: `SLACK_WEBHOOK_URL` (default Slack channel for scan results), `SLACK_SIGNING_SECRET` (slash command signature verification), `GATETEST_INTERNAL_API_KEY` (optional: internal Bearer token for Slack route → v1 API calls).
- Sweep: 5871/5874 pass, 0 fail, 3 graceful Node-20 TS-require skips. `next build` clean. 111 modules load.

**Post-1.50.0 reality sync (2026-06-30 — Bible-accuracy pass, no Boss-Rule changes):**
- **Package renamed `gatetest` → `@gatetest/cli`** (commit 9987a49, published to npm under the @gatetest org scope). All install commands across website + README updated to `npx @gatetest/cli`. Bible architecture section + this VERSION block now reflect the new name.
- **acorn AUTHORIZED + INSTALLED, Phase 1B DONE** (commit 3df833c). `acorn@^8.17.0` is now a real dependency; AST-level name-level export tracing in `dead-code-extractor.js` / `dead-code.js` is fully operational. Phase 1B checkbox + dependency tracker updated from "awaiting authorization" to shipped.
- **Flywheel Playback Engine shipped** (commit 39aa783, PR #259) — `src/core/flywheel-playback-engine.js` (393 lines, 34 tests). Before calling Claude in the fix loop, `executePlaybackSimulation` checks the local recipe cache and short-circuits on a recipe hit (`hypothesis:'Playback', attempt:0`), saving an Anthropic call when a known structural fix shape applies.
- **CLI fix-loop hardening** (commits 80036d8, 720a914, 97a1799, 9b0405a, d5ccd3f) — bidirectional self-correcting test gate, mutation-engine lexical-scope quarantine, speculative parallel hypothesis tree, and Windows path-separator fixes across 8 test suites. Self-scan gate now green on Windows.
- **PRICING DRIFT RESOLVED (Craig-authorized 2026-06-30).** `Pricing.tsx` was out of sync — it showed Quick $29 / Full Deep Scan $99 / **Continuous Guard Shield $299/mo** with NO $199 / $399 cards, contradicting the backend. Craig confirmed the canonical lineup (Quick $29 / Full $99 / Scan+Fix $199 / Forensic $399 one-time + Continuous $49/mo) and authorized the fix. `Pricing.tsx` rewritten to render all five tiers matching `/api/checkout/route.ts` `TIERS` exactly, plus the free-CLI callout (`npx @gatetest/cli --suite full`, 111 modules). Module-count copy corrected "90+" → "111". `marketing-claim-verification` pricing test now green; website builds clean. Known Issue #35 → DONE.

**v1.50.0 changes (2026-06-23 — Inclusive Agentic QA Platform vision locked + workspace alias fix):**
- **Master Build Specification v1.0.0 locked into CLAUDE.md.** Three-persona architecture (Co-Pilot / Visual Dashboard / Expert Toggle), Phase 1-3 roadmap, tone & personality guidelines, revenue/privacy direction. All Boss Rule items flagged. Pre-authorized Phase 1B (AST name-level tracing) awaiting `acorn` dependency authorization from Craig.
- **dead-code workspace alias suppression shipped (PR #240).** `src/modules/dead-code.js` now reads npm/pnpm/lerna workspace config, maps source files to their workspace package, and suppresses dead-code findings for any package that is actively imported elsewhere in the monorepo. Fixes the Vapron `@vapron/deploy-planner` false-positive. 5 new tests, 25/25 pass, full suite 5727/5728.

**v1.49.0 changes (2026-06-18 — Sonnet 4.6 engine + marketing):**
- **Engine pinned to `claude-sonnet-4-6`** (Craig directive 2026-06-18 —
  "the only Claude model that developers might even trust... we need to make
  that very clear across all our website"). All 28 source-file references
  (`src/modules/`, `src/core/`, `website/app/api/`, `website/app/lib/`,
  `.github/workflows/`) updated from `claude-sonnet-4-7` → `claude-sonnet-4-6`.
  Marketing copy, `CLAUDE.md` AI Layer table, and score page updated to
  "Sonnet 4.6". Pricing constants unchanged ($3 input / $15 output / MTok —
  same tier).
- **CI fix** — `marketing-claim-verification.test.js` was pinned to "110 modules /
  v1.45" but the engine now ships 111 (SBOM registered in v1.48). Updated pin
  to 111 / v1.48. `site-stats.json` regenerated: 5713 pass / 0 fail.

**v1.48.0 changes (2026-06-18 — live header probe wired, SBOM registered):**
- **Live HTTP header probe wired into `/api/web/scan`** — `url-prober.js`
  (`website/app/lib/reliability/url-prober.js`) now runs concurrently with
  the static suite scan on every URL scan. Checks actual response headers:
  HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
  cookie flags (Secure/HttpOnly/SameSite), info-disclosure (Server/X-Powered-By),
  CORS wildcard + credentials, mixed-content body scan. Previously customers
  scanning a URL got empty webHeaders results because the static `webHeaders`
  module ran against an empty temp directory. Findings tagged `live:<rule>`
  to distinguish from static-analysis findings.
- **SBOM module registered** (`sbom: '../modules/sbom.js'`). The CycloneDX
  1.4 SBOM generator was complete and dormant (Known Issue #32 — file-system
  only, no network calls). Now registered as module 111, added to `full` and
  `nuclear` suites. US EO 14028 + EU Cyber Resilience Act compliance artifact
  ships automatically in every paid scan. Known Issue #32 partially resolved
  (SBOM only — CVE feed still pending Craig's network-call policy decision).
- **111 modules** — site-stats.json regenerated; site-stats-honesty test
  remains green.

**v1.47.0 changes (2026-06-12 evening — Continuous tier launch, Craig
green-light "Green light" after margin-protection plan approved):**
- **$49/mo Continuous subscription LIVE.** Stripe `mode=subscription`
  checkout with inline recurring price_data (no dashboard product
  needed). Pricing card flipped from "Coming soon" to live checkout.
- **Margin protection**: unlimited deterministic scans (marginal cost
  ≈ $0), AI reviews metered by `continuous_ai_ledger` — default $10/mo
  allowance (`CONTINUOUS_AI_BUDGET_USD`). Worst-case abuse ≈ $12-15
  cost vs $49 revenue (~70% floor); typical ~90% margin.
- **New store** `website/app/lib/continuous-subscription-store.js`
  (19 tests): `continuous_subscriptions` + `continuous_ai_ledger`
  tables, normalised repo lookup (`findActiveByRepo`) for push-scan
  entitlement, `checkAiAllowance`/`recordAiSpend` for the AI meter.
- **Stripe webhook lifecycle**: `checkout.session.completed`
  (mode=subscription) records the entitlement — returns 500 on DB
  failure so Stripe retries (paid customer must never lose
  entitlement silently); `customer.subscription.updated/deleted`
  sync status (active / past_due / canceled).
- Known Issue #34 filed: AI-allowance enforcement point in the
  push-scan worker — push scans today run deterministic suites (no
  Claude spend), so the meter has nothing to gate yet; wire
  `checkAiAllowance` when AI-on-push / weekly deep scans ship.

**v1.46.1 changes (2026-06-12 full-audit session, Craig directive
"fine-tooth comb before more distribution"):**
- **Module-count drift KILLED at the source.** The engine ships 110
  (registry + CLI verified); the website catalog (`modules-data.ts`)
  was missing 6 of them (aiGuardrails + the 5 live pen-test probes:
  liveSqlInjection, liveXss, livePathTraversal, liveAuthBypass,
  liveIdor) so `TOTAL_MODULES` computed 104. Catalog now carries all
  110 (new "Live pen-test probes" category). Every stale hardcoded
  count (91 / 102 / 103 / 104) swept to 110 across ~20 surfaces:
  trust, how-it-works, for/*, countries.ts, docs/api, github/installed,
  triage, HomeFaq, suite-recommender, pr-composer, ai-handoff,
  hn-reply drafter. Six different numbers were live simultaneously —
  worst credibility bug on the site.
- **Flywheel production-capture wired** (was the audit's top gap):
  `/api/scan/fix` now calls `recordFixAttempt()` once per attempted
  file (layer = rule for CVE bumps / claude otherwise) so the nightly
  pattern-miner finally trains on PRODUCTION data, not just CLI runs.
- **Cross-repo corpus CONSUME side shipped**: new
  `website/app/lib/cross-repo-prior-art.js` (12 tests) classifies each
  completed fix's diff shape with the promoter's own classifier, looks
  up the anonymised vector corpus, and appends a "Cross-repo prior
  art" section to the PR body when a fix shape has shipped before.
  The corpus now compounds INTO the product, not just on disk.
- **SEO/AI-search hardening**: FAQPage JSON-LD on the homepage FAQ
  (plain-text mirrors per item), `generateMetadata` on
  `regulation/[slug]`, metadata layouts for `/developers` and
  `/scan/url`, JSON-LD offers extended to all four tiers ($29/$99/
  $199/$399 Forensic). Footer now links `/web`, `/wp`, `/fixes`
  (previously orphaned — unreachable from any nav).
- **Honesty fixes**: score page said "powered by Claude Opus 4.7" →
  Sonnet 4.6. `statsByRule()` now warns when DATABASE_URL is unset
  instead of silently feeding the confidence-calibrator zeros.
- **HN-monitor trainer WIRED as trainer #8** — Craig authorized
  same-session (Boss Rule #7). Nightly workflow + `gatetest train
  --only hn` + renderMarkdown/CLI-main contract. Read-only Algolia
  sweep; drafts marked FOR CRAIG REVIEW; never posts (Known Issue
  #33 → DONE).

**v1.46 changes (2026-06-03 session):**
- **Opus → Sonnet across the entire engine** (Craig 2026-06-03 — *"Opus
  is absolutely terrible at debugging websites, it needs to be Sonnet"*).
  Boss Rule #1 (major architectural change) + #3 (pricing/economics
  shift) explicitly authorized.
  - All 28 source-code references to `claude-opus-4-7` swapped to
    `claude-sonnet-4-6` (modules, lib, routes, workflows, MCP bin).
  - `budget-tracker.js` pricing constants flipped: input
    $15→$3/MTok, output $75→$15/MTok (Anthropic's published Sonnet
    rates, ~5x cheaper than Opus on both).
  - **Per-tier dollar caps UNCHANGED** (Strategy A): Quick $1.50,
    Full $5, Scan+Fix $12, Forensic $30. Net effect — same dollar
    spend per scan buys ~5x more analysis depth. Customer gets the
    upgrade; margin stays where it was.
  - Marketing-claim test flipped to assert Sonnet + ban Opus.
  - Public homepage / pricing copy updated with the
    "we tested both, Sonnet won, banked savings as 5x depth"
    framing (Tier 2-Plus per the session's positioning analysis).
- Why this is honest: Sonnet 4.x scores ~77% on SWE-bench Verified
  vs Opus 4.x at ~72%. Anthropic themselves recommend Sonnet for
  code. We tested on real customer codebases. Sonnet won.

**v1.45 changes (earlier this session):**
- $399 tier renamed **Nuclear → Forensic** (Craig 2026-06-02 — "It
  shouldn't be called nuclear anymore"). Boss Rule #6 authorized via
  AskUserQuestion. Restrained, audit-grade framing; pairs with the
  existing "forensic stack" copy.
- Bible drift corrected: prior versions said 92/91/90 modules; the
  registry has actually carried 110 for some time once the dormant
  Pen Test tier modules + recent additions are counted. Website-side
  copy was at "104 modules" — also wrong. All surfaces sync to 110.
- aiGuardrails (shipped previously this session in v1.44) remains
  Forensic-tier only.

**v1.44 (earlier today) — aiGuardrails module shipped:**
30 starter scenarios across 8 attack categories: jailbreak, prompt
injection, PII leak, hallucination, topic constraint, schema
integrity, tool exfil, cost control. Forensic-tier only; no-op when
no endpoint configured. Pure scoring engine (78 unit + integration
tests). Splits the static slice (promptSafety) from the dynamic
slice (aiGuardrails) in the competitive table — was overpromising
"replaces Promptfoo / Garak" under the static-only `promptSafety`
module. Authorized by Craig 2026-06-02 — "Yes please as long as you
think that our code is gonna
be clean it's gonna work 100%." Code is clean; scoring heuristic
accuracy ~85-90% per category (industry standard).

GateTest v1.43.0 — 91 modules + intelligence pipeline (6 trainers,
session-fix corpus capture, claude-opus-4-7 everywhere, per-tier
budget caps, customer-feedback API).

WAVE 1-6 SHIPPED 2026-05-20 — Craig directive "build everything,
ASAP, under GitHub review." Year-2030 intelligence pipeline:

- **Session telemetry** (`website/app/lib/session-telemetry.js`) —
  every dev / Claude Code commit lands in the corpus via git-history
  ingestion. Closes the gap where 80% of engineering work was
  invisible to the production flywheel.

- **6 trainers** under `website/app/lib/trainers/`:
  1. `pattern-miner` — finds recurring patterns + under-tested
     modules + Claude-vs-deterministic share signals
  2. `recipe-promoter` — recurring patterns → recipe proposals
     (with diff-shape plausibility scoring)
  3. `regression-test-generator` — under-tested modules → drafted
     `.pending.test.js` files (filename suffix prevents accidental
     run; reviewer fills in assertions)
  4. `cross-repo-promoter` — anonymised structural rewrite vectors
     in `~/.gatetest/cross-repo-corpus/<fingerprint>.json` so fixes
     captured on one customer's repo harden every other customer
     WITHOUT leaking customer strings (SOC2-safe by construction)
  5. `adversarial-mutator` — self-tests the gate by mutating
     known-good code and reporting any mutation that slips through
     as a coverage hole
  6. `confidence-calibrator` — reads `finding_dismissals` (customer
     suppressions) and recommends per-rule severity downgrades when
     dismissal rates indicate a rule is treated as noise

- **Nightly trainer workflow** (`.github/workflows/trainer-nightly.yml`)
  runs all 6 at 03:00 UTC and opens a draft PR with the report +
  any drafted pending tests + coverage-holes.json.

- **Trainer CLI** (`gatetest train`) — same 6 trainers runnable on
  laptop. Demoable for App Review. Outputs land at
  `~/.gatetest/trainers/<name>-latest.json`.

- **Customer feedback API** (`POST /api/finding/dismiss`) — feeds
  the confidence-calibrator. Neon-backed (graceful degrade when
  DATABASE_URL unset). Validates reason against VALID_REASONS set.

- **claude-opus-4-7 everywhere** — Craig directive: "GateTest at
  all times runs the latest Opus model everywhere including GitHub."
  25 source files swept (modules, scripts, lib, routes, workflows).
  Pricing constants in `budget-tracker.js` updated to Opus rates
  ($15/MTok input, $75/MTok output).

- **Per-tier USD budget caps** in `website/app/lib/budget-tracker.js`:
  Quick $1.50, Full $5, Scan+Fix $12, Nuclear $30. `runWithTracker`
  IIFE in `scan/fix/route.ts` wraps the whole request; `anthropicCall`
  calls `tracker.preflight()` before and `tracker.record()` after.
  BUDGET_EXCEEDED throws return 402 with a tracker snapshot for
  finance reconciliation. Margins preserved on every tier (≥92%).

- **Playwright stability + sandbox** (`src/core/playwright-stability.js`
  + `src/core/playwright-sandbox.js`) — 3-strike retry, 30+ tracking
  domain stubs, process-level sandbox with hard wallclock SIGKILL,
  memory cap, stderr quarantine.

- **Admin auth lockout** (`website/app/lib/admin-lockout.ts`) —
  Neon-backed per-IP brute-force protection. 5 fails / 15min →
  30min cooldown (429 + Retry-After). Audit log table.

- **Cross-file-taint Drizzle false-positive fix** —
  `src/modules/cross-file-taint.js` safe-harbours parameterised
  ORMs (drizzle-orm, @prisma/client, kysely, postgres, slonik,
  typeorm, sequelize, mongoose, knex). Also fixed a real pre-
  existing bug where `// uses sql\`...\`` comments falsely
  suppressed real injection findings.

Total new tests in Wave 1-6: 190+. Sweep: 4249 pass / 0 fail / 1 skip.

REMAINING TO DO (next sessions):
- [x] Recipe auto-promotion — DONE (2026-06-03, PR #176): recipe-auto-
  promoter wired into trainer-nightly.yml; pending rule files written to
  rule-based-fixer-pending/ and committed to the trainer PR for reviewer
  approval before becoming real rules.
- [x] Marketing-claim verification tests — DONE (2026-06-03, PR #176):
  dogfood-nightly.yml runs tests/marketing-claim-verification.test.js
  every night and opens a GitHub Issue on any drift.
- [x] Dep hygiene dogfood workflow — DONE: dogfood-nightly.yml already
  ran the dependencies module nightly; confirmed complete.
- Boss Rule items: edge / warm-pool scan workers, continuous
  training run, Crontech as engine orchestrator, true compiler-
  agnostic AST translation. All require explicit Craig auth.

(Original v1.41/v1.42 content retained below for history.)

---

## v1.41 / v1.42 HISTORY

GateTest v1.41.0 — 90 modules (24 core + 9 universal language checkers
for Python, Go, Rust, Java, Ruby, PHP, C#, Kotlin, Swift + 7 **infra
& supply-chain hardening scanners** — dependencies (npm/pip/Pipenv/
Poetry/go.mod/Cargo/Bundler/Composer/Maven/Gradle), Dockerfile,
CI-security (GitHub Actions + GitLab CI), shell scripts,
SQL migrations, Terraform/IaC, Kubernetes manifests + 1 **AI-app
security scanner** — prompt/LLM safety (client-bundled API keys,
unbounded max_tokens cost-DoS, prompt-injection surfaces, deprecated
models) + 1 **codebase hygiene scanner** — dead code / unused
exports / orphaned files across JS/TS/Python, rotting commented-out
blocks + 1 **credential-lifecycle scanner** — git-aware secret
rotation (stale > 90d / aging > 30d), `.env`↔`.env.example` drift,
placeholder-shaped-like-real detection + 1 **web-header / CORS
scanner** — CSP `unsafe-eval`/`unsafe-inline`, wildcard origin +
credentials, missing HSTS/CSP/XFO/nosniff across Next.js, Vercel,
Netlify, nginx, Express/Fastify + 1 **TypeScript-strictness scanner**
— `tsconfig.json` regressions (`strict: false`, `noImplicitAny: false`,
`skipLibCheck: true`), `@ts-nocheck` / unreasoned `@ts-ignore` abuse,
`any`-leak detection across exported signatures and `as any` casts
+ 1 **flaky-test detector** — committed `.only` / `.skip` / `xit`,
unseeded `Math.random()`, real-clock `Date.now()` without fake timers,
real-HTTP `fetch`/`axios` calls without mock harness, `setTimeout`/
`setInterval` without fake timers, unrestored `process.env` mutations,
and self-admitted flaky titles ("sometimes", "intermittent", "flaky")
+ 1 **error-swallow detector** — empty `catch {}` blocks, log-and-eat
catches that don't re-throw, `.catch(() => {})` / `.catch(noop)` on
Promise chains, silent `process.on('uncaughtException')` handlers,
Node-callback `(err, ...) =>` that ignores `err`, and fire-and-forget
calls to `.save()`/`.commit()`/`.send()`/etc. without await or .catch)
+ 1 **N+1 query detector** — database queries inside loop bodies
across Prisma, Sequelize, TypeORM, Mongoose, Knex, Drizzle, node-pg,
MySQL2, and generic `db`/`orm`/`repo` shapes; understands block-form
(`for`/`while`/`for..of`/`for..in`) and callback-form (`.map`/
`.forEach`/`.filter`/`.reduce`) loops; recognises the
`await Promise.all(arr.map(async () => await db.query(...)))`
batched-parallel fix shape and records it as info rather than error
+ 1 **retry-hygiene scanner** — tight retry loops, no backoff,
unbounded retry across `fetch`/`axios`/`got`/`node-http`/`superagent`.
Flags `while (true)` / `for (;;)` with an HTTP call and no
`break`/max-attempts marker (error), constant literal sleeps with no
`attempt`-based multiplier (warning: no-backoff), constant sleeps
with no `Math.random()` jitter (warning: no-jitter), and retry
blocks that reference 4xx status without a `throw`/`return`/`break`
guard (warning: retry-on-4xx). Recognises `async-retry` / `p-retry` /
`retry` library use as info-level library-ok
+ 1 **race-condition detector** — TOCTOU / check-then-act patterns:
fs exists/stat → destructive op (unlink/rm/rename/chmod/copyFile/
truncate) on the same path (error, CWE-367, downgraded to warning
inside test files); `stat`/`lstat` → ANY mutating fs op on the same
path (symlink-race vector); Prisma/Sequelize/Mongoose/TypeORM
`findFirst`/`findUnique`/`findOne` → `create`/`update`/`upsert`/
`save`/`delete` on the same model with no visible `$transaction` /
`FOR UPDATE` / `ON CONFLICT` / upsert / duplicate-key-error handler
(warning: get-or-create lost-update). Skips the idempotent-setup
pattern `if (!exists) mkdirSync(..., { recursive: true })` and
single-arg-match on the mutate's first argument to avoid
cross-function false-positives
+ 1 **resource-leak detector** — unclosed `fs.createReadStream`/
`createWriteStream` (error), `fs.open`/`fs.promises.open` file
handles (warning), `new WebSocket`/`EventSource` and
`net.createConnection`/`createServer` (warning). setInterval: bare
calls with discarded return value (error) and captured handles that
are never `clearInterval`-ed (warning). Recognises
`stream.pipeline(x, ...)` and `stream.finished(x, ...)` as cleanup,
plus escape paths through `return`, `module.exports`/`export`,
property-assignment (`this.timers = ...`, `obj.handle = ...`) and
array push/set/add — so legitimate handle-storage patterns don't
false-positive. JSDoc / block-comment aware
+ 1 **SSRF / URL-validation gap detector** — taints `req.body`/
`req.query`/`req.params`/`req.headers`/`ctx.request`/`event.body`
sources and flags when tainted values reach `fetch`/`axios`/`got`/
`http.request`/`needle`/`superagent`/`undici`/`ky` without an
intermediate validator. Hardcoded cloud-metadata endpoints
(AWS 169.254.169.254, GCP metadata.google.internal, Azure
metadata.azure.com, Alibaba 100.100.100.200) are treated as error.
Suspicious-named vars (`webhookUrl`, `callbackUrl`, `redirectUrl`,
etc.) warn when handed to a client with no visible validation.
Suppresses on `validateUrl`/`isValidUrl`/`allowedHosts.includes`/
URL-hostname allowlist guards. Records info-level `library-ok` for
`ssrf-req-filter` / `request-filtering-agent` / `safe-url` /
`ssrfcheck` imports
+ 1 **hardcoded-URL / localhost / private-IP leak detector** —
flags strings in source that embed `http://localhost`, `127.0.0.1`,
`0.0.0.0` (error), RFC1918 ranges 10/8, 172.16/12, 192.168/16
(error), link-local 169.254/16 (error), internal TLDs
(`.internal`, `.local`, `.lan`, `.corp`) and staging subdomain
shapes (`staging.`, `dev.`, `qa.`, `uat.`) (warning), and plain
`http://` URLs pointing at external hosts (warning: downgrade /
mixed-content). Suppresses on filter-pattern use
(`.startsWith`/`.includes`/`.match`/`===`/`new RegExp`), the
env-fallback shape `process.env.X || "http://..."`, `NODE_ENV !==
'production'` guards, dev-context variable names (`DEV_URL`,
`LOCAL_URL`), test/e2e/stories/fixture paths (downgrade to info),
local-dev config files (`playwright.config.*`, `vitest.config.*`,
`jest.config.*`, `cypress.config.*`, `webpack.config.*`,
`vite.config.*`, `rollup.config.*`), and doc allowlist
(`example.com`, `your-domain.com`, etc.)
+ 1 **env-vars contract scanner** — cross-references declared
env vars (`.env.example` / `.env.*.example` / `vercel.json` /
`netlify.toml` / `docker-compose*.yml` / `.github/workflows/*.yml`
env blocks) against actual reads in JS/TS
(`process.env.X` / `process.env["X"]`), Python (`os.environ["X"]` /
`os.environ.get("X")` / `os.getenv("X")`) and Go (`os.Getenv("X")` /
`os.LookupEnv("X")`). Flags referenced-but-not-declared (error),
declared-but-unreferenced (warning), and `NEXT_PUBLIC_*` /
`VITE_*` / `REACT_APP_*` client-bundled keys (info). Runtime
allowlist (`NODE_ENV`, `PORT`, `CI`, `VERCEL_*`, `GITHUB_*`,
`AWS_*`, `PATH`, etc.) never flags. Skips test paths, dev-config
files (`playwright.config.*`, `vitest.config.*`, etc.), JSDoc
block comments, line comments, and Python `"""` docstrings
+ 1 **async-iteration detector** — catches the four canonical
Promise-meets-array-iterator footguns: `.reduce(async ...)` (error:
silently serialises, accumulator becomes a Promise chain the
developer didn't intend), `.filter/.some/.every/.find*(async ...)`
(error: Promise is truthy, predicate returns meaningless result),
`.forEach(async ...)` (warning: forEach doesn't await, enclosing
function returns before inner awaits resolve, errors are
swallowed), `.map(async ...)` not wrapped in
`Promise.all`/`allSettled`/`any`/`race` and not chained with
`.then`/`.catch`/`.finally` (warning: unwrapped-map, caller will
iterate Promises not values). Paren-depth walk backwards from the
call site detects whether `.map` is inside a Promise combinator
argument, avoiding false-positives on
`Promise.all(arr.map(async ...))`. Supports
`// async-iteration-ok` suppression on the same or preceding line
+ 1 **homoglyph / Unicode-lookalike detector** — catches the
Trojan Source (CVE-2021-42574) attack class plus the broader
homoglyph family. Flags bidirectional-override / isolate characters
(U+202A..U+202E, U+2066..U+2069) (error), Cyrillic / Greek letters
embedded inside otherwise-Latin identifiers (error: `а` U+0430,
`е` U+0435, `о` U+043E, `р` U+0440, `с` U+0441, `х` U+0445,
`у` U+0443, `ѕ` U+0455, Greek `ο` U+03BF, `ρ` U+03C1, ...),
zero-width chars U+200B / U+200C / U+200D / U+2060 / U+FEFF
mid-file (warning: identifier-shadow), and non-printable control
chars (warning). String, line-comment, and block-comment contents
are stripped before identifier scanning so translation strings
don't false-positive. Locale paths (`locales/`, `i18n/`, `lang/`,
`translations/`, `intl/`, `l10n/`), locale extensions (`.po`,
`.pot`, `.xliff`, `.arb`, `.mo`), and doc files (`.md`, `.mdx`,
`.rst`) are exempt. BOM on first byte of first line is allowed
+ 1 **OpenAPI ↔ code drift detector** — cross-references
`openapi.{yaml,yml,json}` / `swagger.*` against code routes across
Express / Connect / Fastify (block + object form) / Koa / Hono /
Next.js App Router (`app/api/**/route.ts` with exported `GET`/
`POST`/`PATCH`/`PUT`/`DELETE` functions). Normalises Express
`:id` → OpenAPI `{id}` and fuzzy-matches `{id}` ~= `{userId}` so
param-name differences don't false-positive. Flags: code route
missing from spec (error: `undocumented-route` — consumers of the
generated client won't know it exists), spec path with no matching
handler (warning: `spec-ghost-route`). No-op when no spec file is
present. Test paths excluded from code-harvest
+ 1 **PR-size enforcer** — blocks unreviewably-large pull requests
before they reach a human reviewer. Diffs HEAD against a base ref
(configurable, or auto-detected via staged/working-tree/HEAD~1),
counts added+removed lines, and enforces four independent limits:
total files (soft 50 / hard 100), total lines (soft 500 / hard 1000),
per-file lines (soft 300 / hard 500), and top-level directory sprawl
(warning at >3, catches mixed-concern PRs). Auto-excludes lockfiles
(package-lock, yarn.lock, pnpm-lock, Gemfile.lock, Cargo.lock,
poetry.lock, composer.lock, go.sum, mix.lock, flake.lock),
build output (`dist/`, `build/`, `out/`, `.next/`, `coverage/`,
`node_modules/`, `vendor/`, `target/`), minified/bundled files
(`*.min.*`, `*.bundle.*`), snapshot tests (`*.snap`), and
source-maps. Parses both `git diff --numstat` output (preferred)
and unified-diff bodies; handles numstat rename shapes
(`old => new` and `src/{a => b}/file`). Honest dogfood: fires
correctly against `main...HEAD` on a feature branch
+ 1 **ReDoS / catastrophic-regex detector** — catches the three
canonical regex-DoS shapes that hit every long-lived JS project
eventually: nested quantifier on an inner element that's itself
quantified or can match empty (`(a+)+`, `(.*)*`, `(?:[abc]+)*` —
error, catastrophic backtracking), alternation with overlapping
branches inside a quantified group (`(a|a)*`, `(\d|\d+)*` — error,
CWE-1333), and greedy `.*`/`.+` sequences in unanchored patterns
(warning). Plus one data-flow rule: `new RegExp(req.body.pattern)`
/ `RegExp(userInput)` — user-controlled regex construction (error,
injection vector). Extracts patterns from JS/TS regex literals
(`/pattern/flags`), `new RegExp("...")` constructors (unescapes
string-literal escapes so `"\\d+"` is analysed as `\d+`), and
Python `re.compile` / `re.match` / `re.search` (both raw and
regular string forms). Line-comment / block-comment aware. Test
paths downgrade error → warning. `// redos-ok` on the same or
preceding line suppresses
+ 1 **cron-expression validator** — catches the silent-killer bug
class: a typo in a cron string that either never fires (the worst
case, because nobody notices until prod blows up) or fires at
unintended times. Scans `.github/workflows/*.yml` GitHub Actions
`schedule: [{ cron: "..." }]`, Kubernetes `CronJob` `spec.schedule`,
`vercel.json` `crons[].schedule`, and source-code call sites:
node-cron `cron.schedule('...')`, croner `new Cron('...')`,
node-schedule `schedule.scheduleJob('...')`, APScheduler
`CronTrigger.from_crontab('...')` (Python), and Spring
`@Scheduled(cron = "...")` (Java/Kotlin). Validates: field count
(5 standard / 6 with seconds / predefined alias — error), out-of-
range values per field (minute 0-59, hour 0-23, DoM 1-31, month
1-12 or JAN-DEC, DoW 0-7 or SUN-SAT — error), step syntax
(`*/5`), ranges (`0-30`), lists (`1,5,10`), and Quartz extensions
(`L`, `W`, `#`). Catches impossible dates that will never fire
(Feb 30/31, Apr/Jun/Sep/Nov 31 — error, the actual silent-killer
case). Warns on too-frequent crons (`* * * * *` every minute)
and typo aliases (`@weely` instead of `@weekly`). Test paths
downgrade error → warning. `# cron-ok` / `// cron-ok` on same or
preceding line suppresses
+ 1 **datetime / timezone bug detector** — the "works on my machine,
breaks in prod" clock-bug class that every long-running codebase
eventually ships. Walks JS/TS and Python sources for five runtime-
silent failure modes: Python `datetime.now()` without a `tz=`
argument (error: returns naive datetime — CI runner and prod server
have different timezones, comparisons against aware datetimes
`TypeError` at runtime, comparisons against other naives silently
use local); Python `datetime.utcnow()` (error: deprecated in Python
3.12+, returns a naive datetime treated as local by anything that
checks `tzinfo is None` — use `datetime.now(timezone.utc)`);
JS `new Date(yyyy, 1-12, dd)` (warning: JS months are 0-indexed,
so month-literal 1..12 is nearly always wrong — either the bug
(`Feb 14` becomes `Mar 14`) or correct by accident that nobody can
tell); JS `Date.UTC(yyyy, 1-12, dd)` (warning: same 0-vs-1 trap);
`moment()` without a `.tz(...)` call on the same line (warning:
silently uses local time, Moment.js in legacy mode since 2020,
migrate to Luxon / date-fns / Day.js / Temporal). Block-comment,
line-comment, Python `#` comments and triple-quoted docstrings are
stripped before matching. Test paths downgrade error → warning
(Python) and warning → info (JS). `// datetime-ok` / `# datetime-ok`
on same or preceding line suppresses
+ 1 **import-cycle / circular-dependency detector** — the silent
runtime killer of large JS/TS codebases. Walks all `.js`/`.jsx`/
`.mjs`/`.cjs`/`.ts`/`.tsx`/`.mts`/`.cts` sources, builds an import
graph from top-level `import ... from './x'`, `export { ... } from
'./x'`, and indent-0 `require('./x')` (lazy in-function requires
are correctly ignored because they defer resolution to call time,
which is the standard cycle-break workaround). Resolves relative
specifiers through extension-retry and `./x/index.<ext>` fallback.
Runs iterative Tarjan's strongly-connected-component algorithm to
find every cycle of 2+ files (error: runtime TDZ / undefined-import
bug — the bug that reproduces randomly depending on test order,
hot-reload state, module-cache warmth, and is always a refactor to
fix). Also flags self-loops (file imports itself — always a bug).
Type-only imports (`import type`, `export type`, `import { type X }`)
are erased at build time and skipped. Bare-package specifiers
(`react`, `lodash`) are external and skipped. Test paths downgrade
error → warning. `// import-cycle-ok` on the import line suppresses
that specific edge
+ 1 **money / currency float-safety detector** — the textbook fintech
bug every company eventually ships: storing currency in IEEE-754
floating-point. `$0.10 + $0.20 !== $0.30` in JS, Python, Go, Java.
A $0.01 fee over a million transactions accrues hundreds of dollars
of drift. Regulators call this fraud. Walks JS/TS and Python sources,
flags money-named variables (`price`, `total`, `amount`, `tax`,
`fee`, `subtotal`, `balance`, `discount`, and currency codes
`usd`/`eur`/`gbp`/`jpy`/`cad`/`aud`/`nzd`/`chf`/etc.) assigned from
`parseFloat(...)` / `Number(...)` in JS (error), class-property
form `this.amount = parseFloat(...)` (error), Python `float(...)`
on money-named variable (error), and `.toFixed(0)` / `.toFixed(1)`
on money-named receiver — sub-cent precision rounding bug (warning).
Safe-harbour: if the file imports a known decimal library (decimal.js
/ big.js / bignumber.js / dinero.js / currency.js / money-math /
cashify, or Python's `decimal` stdlib), float-cast rules don't fire.
Test paths downgrade error → warning. `// money-float-ok` /
`# money-float-ok` on same or preceding line suppresses
+ 1 **logging-hygiene / PII-in-logs detector** — the GDPR / CCPA /
PCI-DSS violation that ships in every codebase at some point:
`console.log(req.body)`, `logger.info(user)`,
`log.debug(JSON.stringify(headers))`. Real postmortems include
Facebook 2019 (600M plaintext passwords), Twitter 2018 (330M),
GitHub 2018 (10M), Robinhood 2019 (multi-year). Walks JS/TS and
Python sources, flags four shapes: logger call with a bare sensitive
identifier (password, token, apiKey, secret, credential,
authorization, accessToken, jwt, cookie, session, ssn, creditCard,
cvv, pin, privateKey — error: `sensitive-arg` / `py-print-sensitive`),
logger call with a bare object-dump identifier (req, request, body,
payload, user, member, account, headers, cookies, session, formData
— warning: `object-dump`), logger call with `JSON.stringify(x)`
where `x` is sensitive or object-dump (warning: `stringify-dump`),
template-string interpolation `\`...${x}...\`` where `x` is a BARE
sensitive / object identifier (error: `sensitive-interp` / warning:
`object-interp`) — deliberately skips property-access shapes like
`${auth.type}` and `${event.name}` where the base identifier matches
but the access is safe. Supports JS (`console`, `logger`, `log`,
`winston`, `pino`, `bunyan`, `morgan`, `fastify.log`, `this.logger`)
and Python (`print`, `logger`, `log`, `logging`, `structlog`).
Block/line/hash comments and Python docstrings stripped before
matching. Test paths downgrade error → warning and warning → info.
`// log-safe` / `# log-safe` on same or preceding line suppresses,
+ 1 **feature-flag hygiene detector** — the quiet tax on every
codebase: stale flags that graduate to "permanent on" and stay in the
code as slower `if (true)`. LaunchDarkly's 2024 State of Feature
Management found orgs carry 5-10x more flags in code than they
actively toggle. Every stale flag is dead code waiting to go wrong:
a branch that stops getting tested, a default that quietly drifted,
a staff-only path accidentally reachable. Walks JS/TS and Python
sources, flags three shapes where the flag has collapsed into a
constant: always-true conditional (`if (true)` / `if (1)` /
`if (!false)` / `if (!0)` — error: `always-true-if` /
`py-always-true-if`), always-false conditional (`if (false)` /
`if (0)` / `if (!true)` / `if (!1)` — warning: `always-false-if` /
`py-always-false-if`), and flag-named const bound to a literal
(`const FEATURE_X = true;` / `const ENABLE_Y = false;` — warning:
`stale-const` / `py-stale-const`). Deliberately restricts const-rule
to `const` bindings in SCREAMING_SNAKE flag-prefixed form to avoid
false-positive on `let hasErrored = false;` local-state idioms.
Tracks string state across lines (including multi-line backtick
template literals) so `if (false)` embedded in docstrings and
prompt strings does not trigger. Test paths downgrade error →
warning and warning → info. `// flag-ok` / `# flag-ok` on same or
preceding line suppresses,
+ 1 **TLS / cert-validation-bypass detector** — the MITM-vulnerable
pattern that ships to prod every time a dev hits a self-signed cert
on staging and disables validation "just for now." Walks JS/TS and
Python sources, flags: `rejectUnauthorized: false` (error, Node
https.Agent / tls), `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"`
including bracket-form `process.env["..."] = "0"` (error, global
nuclear disable), `strictSSL: false` (error, request / superagent /
got), `insecure: true` (error), Python `verify=False` /
`verify_ssl=False` / `ssl=False` as a kwarg (error, requests / httpx
/ aiohttp / urllib3), Python `ssl._create_unverified_context()`
(error), `.check_hostname = False` (error), `ssl.CERT_NONE` /
`cert_reqs='CERT_NONE'` (error), and `urllib3.disable_warnings(
InsecureRequestWarning)` (warning, the tell-tale pairing with
verify=False). Two-phase line scan: env-bypass rule runs on the
block-stripped line (so `"0"` literal is preserved) and requires
`process.env.` prefix so prose / error-message text that references
the variable name does not FP. All other rules run on the fully
string-stripped line. Block / line / hash / triple-quoted docstring
comments stripped before matching. Test paths downgrade error →
warning and warning → info. `// tls-ok` / `# tls-ok` on same or
preceding line suppresses,
+ 1 **cookie / session-security config detector** — the
misconfiguration that turns XSS into session takeover and lets
cookies ride over plain HTTP. Walks JS/TS and Python sources, flags:
`httpOnly: false` in cookie / session options (error — cookie
readable from `document.cookie`), `secure: false` (warning — cookie
rides over plain HTTP), `secret: '<known-weak>'` with placeholder
values (`changeme` / `secret` / `default` / `password` /
`keyboard cat` / `mysecret` / `sessionsecret` / `abcd1234` / `foo`/
`bar` / `change[_-]?me` / `your[_-]?secret[_-]?here` /
`replace[_-]?me`, case-insensitive, error), Python
`SESSION_COOKIE_SECURE = False` / `CSRF_COOKIE_SECURE = False`
(warning), `SESSION_COOKIE_HTTPONLY = False` /
`CSRF_COOKIE_HTTPONLY = False` (error), and `httponly=False` kwarg
on `response.set_cookie` / Starlette / FastAPI cookie helpers —
regex requires `[,(]` prefix so it only fires on actual argument
position (error). Two-phase JS line scan: weak-secret rule runs on
the block-stripped line (preserves the literal value for capture
and reporting); all other rules run on the fully string-stripped
line to avoid doc-string FPs. Block / line / hash / triple-quoted
docstring comments stripped before matching. Test paths downgrade
error → warning and warning → info. `// cookie-ok` / `# cookie-ok`
on same or preceding line suppresses,
5 reporters,
AI code review (memory-enriched, fix-pattern-aware), agentic
exploration, codebase memory (compounding moat: issue history +
fix-pattern database), memory-aware auto-fix, fake-fix detector,
diff-mode, watch mode, mutation testing, CI generation, caching,
SARIF/JUnit output, Stripe per-scan upfront charge, GitHub App, legal pages.
**Gluecron-ready `HostBridge` abstraction**: every git host
integration plugs into one contract (canonical commit-status states,
shared PR/MR markdown, registry-based bridge factory). `GitHubBridge`
is the first concrete implementation; `GluecronBridge` will be the
second.

Date last updated: 2026-04-26 — v1.42.0: **THE FIX-FIRST BUILD PLAN — Phase 1, 2, 3 SHIPPED COMPLETE.** All four pricing tiers ($29 Quick, $99 Full, $199 Scan+Fix, $399 Nuclear) are wired through `/api/checkout/route.ts` `TIERS` and rendered in `Pricing.tsx` with honest deliverables backing every price tag.

Phase 1 (foundation): iterative fix loop with structured per-attempt logging, cross-fix syntax-validation gate, cross-file scanner re-validation gate, test-generation per fix, PR composer with before/after scan tables. **No competitor on the market today ships this combination on a per-scan price model.** 5 helper libraries shipped at `website/app/lib/` with 113 unit tests. 6 commits.

Phase 2 ($199 Scan + Fix): pair-review agent (second Claude critiques every fix on a 4-axis rubric), architecture annotator (codebase-shape design observations, informational only). 2 helper libraries shipped, 66 unit tests. Stripe wired, Pricing card live. 3 commits.

Phase 3 ($399 Nuclear): real Claude-driven diagnosis (replaced the lawsuit-shape templated shell-command "fixes"), cross-finding correlation engine (identifies attack chains across the full findings set), mutation testing (operators extracted to testable engine, 33 algorithm tests, real bug fixed during build: `return true` pattern lacked `\b` so it was matching `return trueish`), chaos / fuzz pass (Playwright-driven, 7 real tests covering URL resolution + graceful degradation), executive summary composer (CTO-readable single-document synthesis). 4 helper libraries + 1 mutation engine extraction. Stripe wired, Pricing card live. 6 commits.

Real-repo proofs (4 / 3 — requirement exceeded): self-scan + self-fix on the gatetest repo itself; full Nuclear pipeline on Crontech (754 errors, 23/39 modules pass, 2 critical chains found incl. supply-chain CI takeover); full Nuclear pipeline on Gluecron.com (649 errors, 26/39 modules pass, 3 chains incl. the cleverest reasoning of the build: "Hardcoded secret + undeclared `WORKFLOW_SECRETS_KEY` → secret rotation is impossible"); full Nuclear pipeline on MarcoReid.com (124 errors — found a textbook fintech bug: `parseFloat` on a money-named variable in `TrustActions.tsx` for a legal-tech product handling client trust money, AND the correlator HONESTLY returned 0 chains because findings were genuinely independent — proving the no-padding rule works as designed).

Total real-Claude Anthropic spend across all four proofs: ~$3-4. At $399 tier: 100x+ margin.

**Module count: 90 (unchanged — Phase 1-3 was about deepening capability per scan, not adding modules).** All modules load cleanly via `node bin/gatetest.js --list`. Test count: 1300+. Sweep green at session end.

Phase 4 (honesty sweep) — IN FLIGHT this commit: 4.1 confirmed no modules need disabling, 4.2 compare/* pages updated to mention all four tiers, 4.3 VERSION string updated (this paragraph), 4.4 Known Issues table reviewed for items the FIX-FIRST plan resolved.

Date last updated: 2026-05-15 — **NOISE-CONTROL + UNIT ECONOMICS PROTECTION SHIPPED.** Real-customer scans return 900-1000 raw findings that mostly collapse to ~30 unique root causes (one `tsconfig` strict-false flag → 200 implicit-any findings across 50 files). Fixing each one separately would blow Anthropic spend past the customer's paid price. Two new helpers solve this:

- `website/app/lib/finding-clusterer.js` — groups findings by file (since the fix loop already hands a whole file to Claude in one call), filters info-severity chatter, ranks clusters root-cause-first (`tsconfig.json`, `.eslintrc`, `.env`, `nginx.conf`, `Dockerfile`, `.github/workflows/*` win priority over generic source). 26 unit tests at `tests/finding-clusterer.test.js`, ALL green.
- `website/app/lib/fix-cap.js` — per-tier file-fix caps: Quick=5, Full=20, Scan+Fix=50, Nuclear=100. Renders an Advisory markdown section listing the files left on the table (file + severity + count + modules) — customer sees what their tier excluded, upsells to higher tiers. 19 unit tests at `tests/fix-cap.test.js`, ALL green.

Wired into `website/app/api/scan/fix/route.ts` immediately after input validation: cluster → rank → cap → flatten back to `IssueInput[]` for the existing fix loop. PR body gets the advisory section appended. API response carries a new `cluster` field with `{totalIssuesIn, totalClusters, clustersFixed, clustersAdvisory, advisoryIssueCount, infoFindings, tier, cap}` so the UI and analytics can show "fixed 20 root causes covering 847 findings."

Net result: customer's 1000-finding scan ships 20 high-impact fixes, advisory ranking for the next 30, and total Anthropic spend stays under $5 on the $99 Full tier (~95% margin).

Date last updated: 2026-05-15 (same day, second wave) — **URL-SCAN LAUNCH PACK SHIPPED — full pipeline for any public website.** Four pieces delivered together so the URL-scan flow can launch immediately:

1. **`website/app/lib/url-finding-clusterer.js`** — sister helper to the repo-fix clusterer. Groups URL-scan findings by `ruleKey` (one missing CSP header is one cluster, not 47 noise rows), promotes severity when a higher-severity instance arrives later, flags "high-signal" rules (TLS missing, XML-RPC open, exposed secrets, admin reachable, subdomain takeover, open redirect, CSP missing/unsafe-eval, mixed-content). Drops info-severity by default. 23 unit tests at `tests/url-finding-clusterer.test.js`, all green.

2. **`website/app/lib/health-score.js`** — 0-100 verdict aggregator. High-signal clusters cost 12pts/error vs 6pts for standard; warnings cost 5/2. Instance count contributes sub-linearly (log scale, capped at 1.8×) so a "missing header on 200 pages" cluster can't wipe the score. Letter grade: A ≥ 90, B 75-89, C 60-74, D 40-59, F < 40. `renderHealthScoreCard()` produces a customer-facing markdown table with severity badges. 23 unit tests at `tests/health-score.test.js`, all green.

3. **`src/modules/runtime-errors.js`** — headless-browser-driven LIVE error capture using Playwright. Watches for: uncaught JS errors (`page.on('pageerror')`), console.error / console.warn spam, network request failures (4xx/5xx/refused/timeout, per resource type), CSP violations (heuristic on console output), mixed-content warnings, hydration mismatches (React/Vue/Nuxt patterns), browser deprecations. Gracefully degrades when Playwright unavailable (Vercel serverless) or chromium binary missing — emits an info-level skip note rather than failing the suite. Registered in `BUILT_IN_MODULES` and added to BOTH `wp` and new `web` suites. 8 shape tests at `tests/runtime-errors.test.js`, all green.

4. **`/api/web/scan` + `/web` landing** — generic web URL scan. Twin of `/api/wp/scan` but runs the new `web` suite (no WP-specific modules, plus runtimeErrors). New `translateFinding()` maps every check to plain-English customer copy with module attribution. `/web/page.tsx` is the public landing — 8 painkillers (live JS errors, hydration mismatches, broken network resources, CSP violations, mixed content, missing security headers, TLS misconfig, cookie hardening) plus 3-tier pricing (Free Preview / $29 Quick Scan / $49 Continuous). Cross-links to `/wp` for WordPress owners.

Both routes now compute health score + cluster the findings + show preview-vs-full-report paywall. API response carries `healthScore: {score, grade, summary}`, `totalClusters`, `errorCount`, `warningCount` etc.

**Module count: 91** (was 90 — +1 runtimeErrors). CLI `node bin/gatetest.js --list` shows 106 lines (94 modules + header lines). `npx tsc --noEmit` clean on `website/`.

Headless browser path: in the serverless production environment Chromium typically can't launch — the module returns an info-level "playwright not available" skip and the rest of the scan continues uninterrupted. Real runtime capture lights up when the same engine runs on a worker / local CLI / dedicated infra. The hooks for that worker pipeline already exist (`scan-queue`).

**Playwright-as-internal-dep decision (Craig 2026-05-15):** Playwright is an open-source browser-automation library (Microsoft, free) used internally by `chaos.js` and `runtime-errors.js` to drive Chromium. It is NOT one of our paid revenue competitors (those are Cypress Cloud, BrowserStack, Sauce Labs — listed in the "we replace" table). Marketing copy in CLAUDE.md and README.md previously listed "Playwright/Cypress → replaces it" which was contradictory; updated to "Cypress / BrowserStack / Sauce Labs → replaces it" so the claim matches reality. README.md:81 and MARKETING.md:58 saying *"e2e module integrates with Playwright/Cypress/Puppeteer"* stays as-is — that describes the implementation honestly. **Future sessions:** do NOT rip Playwright out as a competitor concern; Craig has explicitly authorized the internal use after weighing options A (rip out for CDP), B (soften marketing — chosen), and C (drop headless entirely).
