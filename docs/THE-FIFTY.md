# The GateTest Fifty — the current work queue

Fifty moves to take GateTest from a scanner that could not fail a customer's
build to the gate developers brag about, ordered by what decides adoption:
precision first. Opened 2026-09-04; this file is the repo-side record and is
updated whenever a move lands. Items marked **Craig** touch pricing, brand,
public communication, dependencies or money and need authorisation first.

Status legend: **done** (merged or in the open PR, with evidence) · **partial**
· **open** · **Craig**.

## Where we are (measured, 2026-09-05)

| Metric | Now | Was |
|---|---|---|
| Real repos in the corpus at their ceilings | 20 / 20 — all eight languages, four monorepos | 6, all blocked |
| Blocking on express · django · rails | 0 · 64 · 46 | 2 · 89 · 56 (first contact) |
| PR diff scan | 8s | 17s, and it scanned everything |
| Full self-scan | 65s (mutation deferred to nightly) | never finished |
| Tests passing | 9,302 (470 files, every one reporting its summary through `scripts/run-tests.js`) | 7,790 |

The corpus, the ceilings and the runner: `reliability-corpus/real-world.json`,
`scripts/real-world-precision.js`; rendered at `/precision`.

## A. Precision (01–12)

| # | Move | Status | Evidence |
|---|---|---|---|
| 01 | Split zod's 50 into scope vs rule precision | done | 50 → 20; harness scope + guarded-catch classifier (PR #419) |
| 02 | Wire every module to one file walk | done | 36 walks → `_collectFiles`, file sets proven identical; KI #104 (PR #423) |
| 03 | No rule ships without a control pair | done — policy | `docs/DOCTRINE.md` §3; every 2026-09-05 fix shipped both |
| 04 | Grow the real-world corpus to 20 repos | done | Rust (axum 28→6), PHP (laravel 28→4), C# (CleanArchitecture 39→13), Kotlin (ktor 21→7), Swift (vapor 6→1); then the monorepos — nest 39→9, trpc 33→8, apollo-server 4→0, prisma 90→16 — all 2026-09-05, PR #426 |
| 05 | Add Django, Rails, Spring, a Go service | done | seven rule defects, each a real line (PR #422); the remaining five languages followed under 04 |
| 06 | Ratchet the ceilings on a schedule | done | `--ratchet` in `scripts/real-world-precision.js` lowers `maxBlocking` to the measured count (never raises, never touches floors); `dogfood-nightly.yml` runs it and ships the manifest on the rolling PR, so every improvement becomes a ceiling within a day |
| 07 | Per-rule false-positive rate from the flywheel | done | the recorder now ships per-rule `fired` / `silenced` counts (ids only, `src/core/rule-identity.js`); the store keeps them (`scan_findings.rules`); `website/app/lib/rule-noise.js` ranks the silenced rate (thin below 5 scans); `/noise` + `GET /api/telemetry/noise` publish it, worst first, and say "not available" / "no data yet" instead of inventing a table |
| 08 | Retire any rule above 20% FP that can't be fixed | open | depends on 07 |
| 09 | Recalibrate confidence against the corpus | done | measured: confidence is a product of a few discrete multipliers, so a full corpus run produces seven values (1.0, 0.6, 0.4, 0.3, 0.24, 0.2, 0.12) and no finding anywhere near 0.7 — every threshold in (0.6, 1.0] gives the identical gate; 0.6 would admit 87 more findings on the clean repos and 0 more on NodeGoat. The signals soften close to half the error findings on real code (194 of 416) at a cost of 1 of 58 on NodeGoat (a `$where` inside a comment). `src/core/confidence-calibration.js` computes bands / sweep / gap / cost; the corpus runner writes it into `precision.json` on every run; `/precision` renders the sweep; `tests/confidence-calibration.test.js` holds the shipped `BLOCK_THRESHOLD` to the calibrated one and inside a band gap — the day a signal produces a band at 0.7 the suite fails and the number needs a reason |
| 10 | Hunt the substring-vs-segment shape everywhere | done | guard extended to src/core, bin, website analysers; five recall holes closed (PR #423) |
| 11 | Audit every early return that assumes a framework | done | 15/15 — `src/core/route-grammar.js` (4, PR #423); webHeaders, integrationTests, webhookPayload, cacheHeaders, monorepoConstraints + `src/core/workspaces.js` (5, PR #426); promptSafety, zodSchema, trpcContract, dataIntegrity, sqlMigrations, shell, bashSafety, ciSecurity, seo + `migration-dirs.js`, `shell-files.js` (KI #106 closed, corpus 20/20 at ceilings) |
| 12 | Publish the precision numbers, including the bad ones | done | `/precision`, generated, sync-tested (PR #422) |

## B. Honesty (13–22)

| # | Move | Status | Evidence |
|---|---|---|---|
| 13 | Full scan under 60 seconds | done | 65s with mutation deferred; PR diff 8s |
| 14 | Audit every fail-open path | done | nine "reports success while doing nothing" shapes fixed (PR #419) |
| 15 | Make `typescript` resolvable in production | **Craig** | devDependency on the paid fix path |
| 16 | Ban the bare `catch {}` around a retry | done | errorSwallow classifies every empty catch |
| 17 | Every report says what it did *not* check | done | PR comment: partial scan, coverage, not-checked modules (PR #423) |
| 18 | Never derive a metric from a timeout | done — policy | mutation: timeouts are inconclusive |
| 19 | Deterministic scans: same SHA, same findings | done | `scripts/determinism-check.js` + CI job; failure path tested (PR #423) |
| 20 | Never write to the user's tree without saying so | done | mutation writes every mutant into a sandbox copy (`src/core/tree-copy.js`: the tree minus walk-excluded dirs, node_modules symlinked, bounded — past the bound it reports NOT RUN, never falls back to the real tree); the report says so; the restore-the-user's-file machinery is gone with the write. The exclude list has one home (`src/core/walk-excludes.js`) |
| 21 | Signed, reproducible scan reports | done | provenance + HMAC; `gatetest verify-report` (PR #423) |
| 22 | Public status page | partial | `/status` + `GET /api/status/public` (2026-09-16): seven components — Website, Hosted scans, Scan worker, GitHub App webhooks, API, MCP hosted endpoint, Payments — each derived from a probe that already runs (`/api/status` readiness + queue, the build stamp, `scan_queue` activity, a GET of `/api/mcp`), mapped by the pure `website/app/lib/public-status.js` (never throws; any failed reading is "unknown", never green; a leak guard replaces any detail shaped like an env name, host, IP or error). 14-day incident list from `website/app/data/incidents.json`, seeded with the 2026-09-15 e-mail-provider abuse (bystander) and the 2026-09-16 deploy pause. `tests/public-status.test.js`: control pairs per state, hostile-input leak test, incident schema. Remaining: deploy to production (Craig) and, once the worker has run there, confirm the heartbeat and last-delivery rows read from real traffic |

## C. The gate itself (23–30)

| # | Move | Status | Evidence |
|---|---|---|---|
| 23 | Make the baseline a first-class onboarding step | done | blocked full scan with no baseline leads its recap with `gatetest --baseline` (`src/core/plain-summary.js`, controls: diff-scoped and already-baselined runs stay quiet); README Action quickstart and `integrations/README.md` say what the first run does |
| 24 | PR comments show only what's new | done | line-level attribution, `changed-lines.js` (PR #423) |
| 25 | Suggest the `.gatetestignore` line | done | `suggestLine`, CLI + PR reply (PR #423) |
| 26 | A policy file teams can review in a PR | done | the policy IS `.gatetest.json` + `.gatetestignore`; fakeFixDetector now reads those two files (and only the policy rules read them): `policy-ignore-line-added` and `policy-gate-softened` warn on the PR that widens a suppression, disables a module, sets report-only or raises the threshold — quiet on comments and on tightening; a suppression-only PR is no longer scoped out as "nothing changed"; provenance carries both files' SHA-256 and `verify-report` prints them |
| 27 | Merge-queue and monorepo path filters | done | one diff base for every module (`src/core/diff-base.js`: explicit → --since/--pr → merge_group payload → GITHUB_BASE_REF → origin/main → a local main only without an origin) — the runner had asked for a stale local main first and prSize/fakeFix each decided differently; `merge_group` handled by action.yml, the drop-in workflow and `--pr`; `.gatetest.json` `paths` include/exclude at `_collectFiles` + the runner, reported in the console line and the signed provenance (`src/core/scan-paths.js`) |
| 28 | One-command local reproduction of a CI failure | done | blocked gate leads with `gatetest replay <run-url>` (PR #423) |
| 29 | Lead with the fake-fix detector | **Craig** | positioning |
| 30 | Make `test.skip` in a "fix" commit block | done | measured first: eleven `.skip` additions in ~14,000 commits across ten real repos, none in a fix-shaped commit. Now: `fake-fix:test-skip-added` scores 1.0 in a test file (it was soft), fakeFixDetector diffs a PR against its base instead of its last commit, and the finding blocks only when a commit touching the file calls itself a fix — otherwise a warning, still reported |

## D. The website as a machine (31–40)

| # | Move | Status | Evidence |
|---|---|---|---|
| 31 | Ship `/pricing` as a real page | done | PR #419 |
| 32 | Ship `/enterprise` | done | PR #419 |
| 33 | Put the precision table on the site | done | `/precision`, nightly regeneration (PR #422) |
| 34 | Surface the 121 module pages in navigation | done | PR #419 |
| 35 | Turn the bug hunts into the blog | **Craig** | — |
| 36 | Badges as the distribution channel | done | graded badge redirect; free scan ends with the badge (PR #423) |
| 37 | Free scan as the primary call to action | **Craig** | — |
| 38 | Keep the comparison pages dated and factual | done | git-dated `ComparisonReviewed` (PR #423) |
| 39 | A real changelog page | done | the structured source is the main branch itself: `scripts/generate-changelog.js` reads the first-parent history into `website/app/data/changelog.json` (PR, date, area by file count, modules touched via the registry, version bumps as facts on the commit that made them; direct commits included as such) — regenerated at website prebuild on a full clone and on the nightly; `/changelog` renders it, `tests/changelog-sync.test.js` holds the file to the repo and the page to the file |
| 40 | Three case studies with numbers | **Craig** | — |

## E. Enterprise readiness (41–46)

| # | Move | Status | Evidence |
|---|---|---|---|
| 41 | A security page that answers the questionnaire | **Craig** | — |
| 42 | Self-hosted / air-gapped mode | done | `gatetest --offline` / `GATETEST_OFFLINE=1` (`src/core/offline.js`): no telemetry upload (flush returns before fetch), `--fix` / `--auto-pr` refused out loud and the scan continues, `gatetest fix` exits 2, `--doctor` skips the API ping; the summary, console line and signed provenance record the mode; measured end to end with a dead proxy. README section + trust page |
| 43 | SSO, roles, audit log | **Craig** | — |
| 44 | DPA, subprocessor list, SOC 2 roadmap | **Craig** | — |
| 45 | Invoicing, POs, annual terms | **Craig** | — |
| 46 | Compliance mapping as a report | done | `gatetest --compliance` writes the evidence pack (`src/core/compliance-evidence.js` + `src/reporters/compliance-reporter.js`): OWASP / SOC 2 / CIS control by control, three-state (pass / fail / warn / not checked / no module), unattributed modules listed not filed, raw results + provenance + signature so `verify-report` holds. The mapping table moved to `src/core/compliance-mappings.js` (website shim) and SARIF reads its OWASP tag from it — redos and kubernetes had drifted between the two lists |

## F. The compounding moat (47–50)

| # | Move | Status | Evidence |
|---|---|---|---|
| 47 | Open-source the real-world corpus | **Craig** | — |
| 48 | Finish the MCP registry submission | **Craig** | KI #35: `mcp-publisher login github` is a device-flow login in Craig's own browser, then `validate` → `publish ./server.json`; runbook `docs/marketing/SUBMISSION-RUNBOOK.md` §1b. No code action remains |
| 49 | Pick one editor extension and ship it | **LANDED 2026-09-16** | `vscode-extension/` is the one tree (`editors/vscode/` deleted 2026-09-14). It runs the engine in-process — `@gatetest/cli` bundled, loaded in a `worker_threads` worker (#517 → #521 repair after the #516 collision) — nine commands, diagnostics, status bar, cancel, MCP on request only. Published by Craig as **GateTestHQ.gatetest 1.1.0**, validated + public 2026-09-16 04:36Z: https://marketplace.visualstudio.com/items?itemName=GateTestHQ.gatetest. The first upload was refused as "suspicious content" until the metadata lost its threat language and competitor keywords (#523). Open: new icon (1.1.1), Cursor/Windsurf install check. |
| 50 | Make fix recipes the network effect | **Craig** | the store exists (`src/core/recipe-store-remote.js`, writes gated by `GATETEST_RECIPE_STORE_TOKEN`); what is missing is the policy KI #74f names — how a recipe earns promotion across customers (recommendation on file: count independent re-derivations). Cross-customer sharing of fix patterns is user data — Boss Rule #9 |

## G. Customer visibility (51)

| # | Move | Status | Evidence |
|---|---|---|---|
| 51 | Usage meter — "the best most intelligent usage meter for customers to monitor what they are doing" (Craig 2026-09-16) | **partial** | **Landed:** the ledger `usage_events` (`website/app/lib/usage-ledger.js`, idempotent schema on `DATABASE_URL`, no new env var); identity = hashed customer e-mail so web, hosted fix, push and REST land in one view (fallbacks namespaced, never dropped); writers on hosted fix completion (tracker tokens + price-table USD, BYOK flagged, incl. the 402 budget-exceeded path), `/api/scan/run`, the Stripe checkout job and the worker tick (`ai_calls` 0 for deterministic scans) — every writer best-effort, one warning, never a failed scan; `GET /api/v1/usage` (same auth as `/api/v1/scans`, `from`/`to`, `{ summary, series, bySurface, recent }`, scoped to the caller's own keys); the AI scan module now reports its token counts beside `costUsd`; `tests/usage-ledger.test.js`. **Next:** the dashboard page (`/dashboard` usage panel reading the same helper through the session cookie), `gatetest usage` in the CLI, the extension status bar, alerts at 50 / 80 / 100 % of a ceiling (the Continuous AI allowance and the per-tier caps already exist as the ceilings), and writers for the local surfaces (`action`, `mcp`, `cli`, `vscode`) through the telemetry upload. |

## Next, in order

Move 51 (usage meter) is partial and pre-authorised: dashboard panel, `gatetest usage`, extension status bar, ceiling alerts, local-surface writers — in that order.
Nothing pre-authorised is left in the original Fifty (20, 39 and 42 merged). KI #77 closed on both halves 2026-09-05 (the 22 split/join pairs, then the twenty-six private string guards — one stripper, #458); KI #96 shipped (#443 / #444); KI #108 (the action's swallowed exit codes, #461) closed the same day. What remains in the Known Issues is Craig's: deploy (KI #79), the two Vapron secrets (#80), the Resend env typo (#82), the domain failover (#93), the Gluecron env values (#103), the Marketplace listing (#29), the MCP registry (#35), and the network-call policy that gates both cve-feed (#32) and live link checking (#52). Move 08 waits on flywheel data that cannot exist until production ships.
Waiting on Craig: 15, 22, 29, 35, 37, 40, 41, 43, 44, 45, 47, 48, 49, 50.
Nothing pre-authorised is left in the Fifty (20, 39 and 42 merged). KI #77 closed on both halves 2026-09-05 (the 22 split/join pairs, then the twenty-six private string guards — one stripper, #458); KI #96 shipped (#443 / #444); KI #108 (the action's swallowed exit codes, #461) closed the same day. What remains in the Known Issues is Craig's: deploy (KI #79), the two Vapron secrets (#80), the Resend env typo (#82), the domain failover (#93), the Gluecron env values (#103), the Marketplace listing (#29), the MCP registry (#35), and the network-call policy that gates both cve-feed (#32) and live link checking (#52). Move 08 waits on flywheel data that cannot exist until production ships.
Waiting on Craig: 15, 29, 35, 37, 40, 41, 43, 44, 45, 47, 48, 49, 50. Move 22 is partial — the page and endpoint are built; what is left is the deploy.
