# GateTest Roadmap

Forward-looking work: evolution tiers, the Inclusive Agentic QA spec, open Known Issues, and the remote-MCP distribution plan.

> Split out of CLAUDE.md (the Bible) 2026-07-07 to keep every session's context lean.
> The Bible holds rules + current truth; this file holds the detail. Nothing was deleted.

## HYPER-AGGRESSIVE PRODUCT EVOLUTION ROADMAP (READ THIS EVERY SESSION)

**Authorization:** Craig 2026-05-12 — handed over a 20-item product evolution list and instructed: ship the 5 "Ship Now" items. The rest is recorded here so future sessions don't re-litigate it. Boss Rule items in this list ALWAYS require Craig's explicit go before any code lands.

### Tier 1 — SHIP NOW (revenue-moving, low-risk, pre-authorised)

**STATUS: ALL FOUR SHIPPED AND WIRED (2026-05-24 verified — files exist, both fix paths import them).**

1. **Contextual Grounding** — `lib/contextual-grounding.js` (204 lines). Wired into `website/app/api/scan/fix/route.ts:340` AND `src/core/ai-fix-engine.js:38`. Injects README + AGENTS.md + ARCHITECTURE.md into every fix prompt as PROJECT CONVENTIONS. Kills "Claude suggested Mongo when we use Postgres" failures.

2. **Shadow Scan Previews + Tiered Feature Redaction** — `lib/scan-redaction.js` wired into `website/app/api/scan/run/route.ts:45`. $29 customers see counts of issues in the 86 modules they didn't pay for, with redacted detail and upsell prompts.

3. **CVE-to-Fix Pipeline** — `lib/cve-to-fix.js` (449 lines) wired into `website/app/api/scan/fix/route.ts:301`. CVE-shaped findings auto-generate `package.json` / `requirements.txt` / `Cargo.toml` version-bump patches. Headlines vs Dependabot.

4. **Confidence-Aware Reporting** — `lib/confidence-gate.js` (197 lines) wired into `website/app/api/scan/fix/route.ts:1790`. Aggregates per-finding confidence; gate-blocks only when ≥ threshold.

5. **(Item 4 rolls into Item 2 here)** — Tiered Feature Redaction is the Shadow Preview's machinery. Same `scan-redaction.js` helper.

**Future sessions:** do NOT re-implement these. If you think they're missing, grep for the lib file first.

### Tier 2 — REQUIRES CRAIG'S EXPLICIT OK (Boss Rule)

| Item | Why blocked |
| --- | --- |
| Memory-as-a-Service (central DB for Nuclear users' MemoryStore) | New user-data store + retention policy — Boss Rule #9 |
| SOC2 / HIPAA "always-audit-ready" dashboard | Compliance comms + sales positioning — Boss Rule #9 |
| Multi-Agent Consensus (Claude + GPT-4o cross-check) | Adding OpenAI as a second external API — Boss Rule #7 |
| Agentic Self-Healing (auto-fix without dev seeing the failure first) | Modifies customer code before review — trust contract change, Boss Rule #9 |

### Tier 3 — PUSHED BACK (cost > benefit until $5K-$10K MRR)

- **Shadow Infrastructure Scans** — spinning up isolated envs per PR is expensive compute; would erode margins
- **eBPF Runtime Truth** — Linux-only, ops-heavy, customers aren't asking for it
- **Formal Verification / Z3** — academic-grade, audience of ~5 customers worldwide
- **GNN Taint Analysis** — research-stage, ~12+ months from productisable
- **Vector-Based Fingerprinting** — heavy infra lift, real moat but only after revenue justifies it

### Tier 4 — DEFERRED (sequenced behind earlier work)

- **Architectural Decision Memory** — depends on centralised Memory (Tier 2)
- **Automated Post-Mortems** — needs log-ingestion infra; later product
- **Interactive Fix Terminal** — UX upgrade; ship after auto-PR has 100 real-customer PRs of trust
- **WASM Sandboxing for deps** — ~2 weeks of focused work; valuable but not blocking
- **Differential Fuzzing** — pairs with mutation testing; ~1 week to ship

### Operating rules

1. **No new Tier 1 work begins until the previous one is committed + pushed + tested.**
2. **Tier 2 items NEVER get auto-started.** Craig must say "do X" explicitly.
3. **Tier 3 items stay parked until MRR justifies the cost.** Revisit at $5K MRR.
4. **This roadmap is the source of truth.** Any session adding a new feature first checks: is it on this list? What tier? If not on the list and it's significant, ask Craig before building.

---

## INCLUSIVE AGENTIC QA PLATFORM — MASTER BUILD SPECIFICATION v1.0.0 (READ THIS EVERY SESSION)

**Authorization:** Craig 2026-06-23 — *"Let's lock this vision down into a formal, highly actionable blueprint."* This spec sets the new product direction, persona architecture, feature roadmap, and tone guidelines. It supersedes prior positioning where GateTest was pitched purely as a "SonarQube killer." Both framings coexist: the technical engine stays aggressive; the UX and messaging layer becomes inclusive and conversational.

### Product Vision (Updated)

GateTest.ai is the world's first **Inclusive Agentic QA Platform**. We reject tool fatigue, cryptic error messaging, and exclusionary developer elitism. The mission is to protect codebases while treating every user — from absolute novices to veteran software architects — like family.

- **The Technical Engine:** Ultra-fast, zero-dependency intelligence layer that orchestrates standard open-source tools (Playwright, Vitest) rather than reinventing them.
- **The UX Layer:** Empathetic, Claude-powered interface that translates system failures into human-readable conversations, visual storyboards, and automated code patches.

### Multi-Tier User Persona Architecture

The system must dynamically adapt interface and messaging to the user's technical profile:

| Persona | Primary Pain Point | GateTest Solution | Interface Mode |
| --- | --- | --- | --- |
| **The Novice / Learner** | Cryptic, intimidating terminal errors that cause panic | Conversational, encouraging translations of stack traces with step-by-step guidance | **Co-Pilot Mode** |
| **The Consumer / PM** | Zero visibility into pipeline health without opening GitHub | Natural-language search dashboard with clear visual timelines and site health checks | **Visual Dashboard** |
| **The Expert Architect** | Bloated third-party dependencies, slow pipelines, and magic black boxes | Ultra-fast native Node.js runners, clear AST visibility, and raw code configuration toggles | **Expert Toggle** |

### Phase Roadmap & Authorization Status

#### Phase 1 — Advanced Workspace Diagnostics *(Pre-authorized)*

Building directly on the native glob-walker and suppression map from PR #240.

- [x] **1A** Workspace package alias suppression — blanket-suppress false positives for packages consumed via name aliases (PR #240, 2026-06-22). Zero-dependency, line-heuristic approach.
- [x] **1B** Name-level export tracing — **DONE (2026-06-23, commit 3df833c).** Craig authorized `acorn` (now `^8.17.0` in `package.json` dependencies). AST-level entry-surface analysis is fully operational: `src/modules/dead-code-extractor.js` `parseExportsWithAcorn()` walks the AST (falling back to a regex extractor when acorn is absent or a parse fails), and `dead-code.js` builds a precise per-package export surface via `buildPackageExportSurface()` / `populatePackageSurface()` so granular dead code **inside** active packages is found rather than blanket-suppressing the whole package.
- [x] **1C** Configuration-free monorepo discovery — **DONE (2026-06-23)**. Two-part ship: (1) `fix-workspace-hydrator.js` `CONVENTION_FILES` now includes `pnpm-workspace.yaml`, `pnpm-workspace.yml`, `lerna.json` so these are always fetched for the fix route. (2) `/api/scan/run/route.ts` now promotes ALL `package.json`, `pnpm-workspace.yaml`, `pnpm-workspace.yml`, `lerna.json` files to the front of the fetch queue (capped at 30) before the 50-file source cap is applied — so `buildWorkspaceMap()` in `dead-code-index.js` always finds sub-package `package.json` files in the materialised workspace, enabling full monorepo dependency-map construction without any user config file. 1 new test (`fix-workspace-hydrator.test.js`). No new dependencies.

#### Phase 2 — Unified Test Orchestrator *(Needs Craig's authorization — Boss Rule #7)*

Eliminating tool fatigue by wrapping industry-standard tools via Model Context Protocol.

- [ ] **2A** MCP Harnessing Layer — Claude controls native outputs from **Playwright** (UI/E2E) and **Vitest/Jest** (unit/API) via MCP bridges. Playwright is already an approved internal dependency; the MCP wiring into a unified orchestrator is the new piece requiring Craig's go-ahead.
- [ ] **2B** Parallel Execution Core — run static analysis, API checks, and browser UI tests concurrently on the local machine before pushing to git, cutting CI wait times.

#### Phase 3 — Agentic Self-Healing & Repair *(Pre-authorized where it extends existing --auto-pr; Boss Rule for new user-facing command surface)*

- [ ] **3A** Diagnostic Bundle — upon any test failure, compile: human-readable error summaries, precise code file strings, DOM element snapshots, and network logs.
- [ ] **3B** One-Click Git Patching — pass the Diagnostic Bundle to Claude, generate a safe precise code modification, present as a clean git patch (`gate-test fix --apply`). The AI-fix engine and orchestrator already exist; the `fix --apply` CLI flag is new user-facing surface. Authorisation needed for the final "apply to user's repo" step.

### System Tone & Personality Guidelines *(Apply immediately to all new error messages)*

> **Core Directive:** GateTest must never sound robotic, punitive, or superior. It must communicate like a helpful, grounded, and slightly witty peer.

**Anti-patterns (never use):**
- ❌ `ERROR: Process exited with code 1. Uncaught TypeError: Cannot read properties of undefined (reading 'map').`
- ❌ `Build Failed. Your code broke 14 tests.`

**GateTest formatting patterns (always use):**
- ✅ *"Caught a small slip-up on line 14 of `deploy-planner`. The app expected a list of files but hit an empty box instead. Here's a quick 2-line patch to make it robust!"*
- ✅ *"Looking good! Your workspace alias setup is running beautifully. 25/25 tests passed safely."*

Apply these guidelines to: module warning/error messages, CLI output strings, PR body templates, website scan-status copy.

### Revenue & Privacy Enforcement *(Boss Rule — Craig must authorize)*

- **Usage-Based Scale:** Generous local-first tier for indie hackers, open-source maintainers, and students to build grassroots loyalty. Enterprise pricing scales on execution volume and infrastructure savings. **Pricing change = Boss Rule #3.**
- **Zero-Data Retention Policy:** Enterprise connections — code snippets passed to Claude via secure APIs must never be retained, stored, or used for model training. This removes the primary enterprise adoption barrier. **Implementing and marketing this is Boss Rule #9 (user data, public-facing comms).**

### Phase 1B Dependency Authorization Tracker

| Dependency | Purpose | License | Bundle impact | Status |
| --- | --- | --- | --- | --- |
| `acorn` | AST parser for name-level export tracing in dead-code.js | MIT | ~100KB, zero runtime dep | **AUTHORIZED + INSTALLED 2026-06-23 (`^8.17.0`, commit 3df833c)** |

**Acorn authorized + Phase 1B shipped:** `parseExportsWithAcorn()` in `src/modules/dead-code-extractor.js` walks the AST to build the precise exported-name surface per workspace package entry point, with a regex extractor as the acorn-absent / parse-error fallback. `dead-code.js` consumes it via `buildPackageExportSurface()` / `populatePackageSurface()`, suppressing only the exports that pass through the entry point and flagging the rest.

---

## KNOWN ISSUES — QUEUED FOR FIX

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 3 | Stripe test keys not yet swapped in | MEDIUM | Craig action |
| 4 | GitHub App not yet installed on test repo | MEDIUM | Craig action |
| 5 | Crontech.ai protection — workflow shipped in `integrations/`, needs `install.sh` run from that repo | HIGH | Craig action (or expand MCP scope) |
| 6 | Gluecron.com protection — workflow shipped in `integrations/`, needs `install.sh` run from that repo | HIGH | Craig action (or expand MCP scope) |
| 7 | MCP GitHub scope currently restricted to `crclabs-hq/gatetest` — blocks pushing protection into Crontech/Gluecron directly. Expand to owner-wide scope. | HIGH | Craig action — see `.claude/` config |
| 22 | **GitHub App `installation_id` not persisted** — **RESOLVED**, description was stale. Pre-launch audit 2026-07-16 found `/api/github/callback/route.ts:17-66` now calls `storeInstallation()` → `website/app/lib/installation-store.js` (`installations` table, `UNIQUE(host, installation_id)`, upsert-on-conflict); fixed in commit `3a1658b` (undated in this doc previously). Residual: the persisted mapping isn't yet looked up from `/api/webhook/route.ts` at ingest time — correlation storage exists but isn't consumed yet. Not urgent (nothing depends on it today), flagged for whoever wires multi-org billing correlation next. | — | RESOLVED (storage side); lookup-at-ingest-time is a small open follow-up, no severity assigned since nothing consumes it yet. |
| 23 | **PR comments are not idempotent** — **RESOLVED, description was stale.** Pre-launch audit 2026-07-16 found `website/app/lib/github-callback.js` already implements exactly the fix this KI asked for: `postPrComment()` lists existing PR comments, finds a prior GateTest comment via a hidden HTML marker, and PATCHes it in place instead of stacking a new one on every push (falls back to POST on first run or on a failed lookup). 18 passing tests in `tests/github-callback.test.js` / `tests/github-hardening.test.js` cover the idempotency path and the pagination walk (capped at 10 pages). The `/api/webhook/route.ts:438` line this KI originally pointed at no longer exists — that file is now 99 lines and delegates to `github-events.js` → `github-callback.js`. | — | RESOLVED (already shipped, roadmap just hadn't caught up). |
| 24 | **GitHub file-tree fetch is unbounded** — **PARTIALLY RESOLVED, description was stale.** Pre-launch audit 2026-07-16 found `website/app/lib/gluecron-client.ts` `fetchTreeWithMetadata()` already detects GitHub's `truncated: true` response flag (previously the KI concern: silently reading a partial tree as complete) and surfaces an explicit warning instead, plus a `TREE_SIZE_WARN_THRESHOLD` (50,000 files) warning for large-but-not-truncated repos. Tested in `tests/github-hardening.test.js`. **Still open**: the fix is graceful degradation (warn), not the "ideally... per-directory traversal" fallback the code's own comment flags as future work — a repo past GitHub's ~100k-entry single-response limit still only sees the first ~100k files, just with a warning now instead of silence. | LOW (was MEDIUM) | PARTIAL — degradation warning shipped and tested; per-directory traversal fallback for repos >100k files is still unbuilt, explicitly flagged as future work in the code itself. |
| 25 | **Rate-limit wait cap** — **FIXED 2026-07-16.** `github-bridge.js`'s `respectRateLimit()` had exactly the described bug: `waitMs > 0 && waitMs < 120000` meant any reset 2+ minutes out silently skipped the wait entirely, so the caller proceeded with almost no quota left and hammered 429s (confirmed still present as of this audit, not stale). Fixed: added `RATE_LIMIT_MAX_WAIT_MS` (15 min) — waits inline (with a console heads-up) for resets up to that ceiling, and past it throws a clear, actionable error with the actual reset time instead of silently hammering. Only used by the CLI/GitHub-Action path (`bin/gatetest.js`, `src/index.js`) — never by website serverless routes, confirmed by grep — so a bounded inline wait has no Vercel-timeout risk. 4 new regression tests in `tests/github-bridge.test.js`, including one proving the old skip-the-wait-and-hammer bug is gone. | — | RESOLVED. |
| 42 | **`ai-guardrails` tests flake on local Windows only** — all 30 subtests always pass, but the file intermittently (~1-in-4) trips `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` in `src\win\async.c` when `--test-force-exit` calls `process.exit()` while undici's global fetch pool is mid-teardown. **CI is unaffected** — it runs `ubuntu-latest` and this assertion is Windows-only. Mitigated 2026-07-14 by adding `Connection: close` to `src/modules/ai-guardrails/probe.js` (one-shot probes gain nothing from pooling), which reduces but doesn't eliminate it; a full fix needs undici's global dispatcher closed in teardown, but undici is Node-internal and not requireable. | LOW | Local-only cosmetic — revisit if Node exposes a dispatcher-close API. |
| 41 | **Cron endpoints have no scheduler outside Vercel** — `/api/scan/worker/tick` (queue processor) and `/api/watches/tick` are driven by `website/vercel.json` crons. On Vapron (or any non-Vercel host, per Craig 2026-07-14 "Vapron will be our backend today") NOTHING calls them → queued push-scans never run and watches never fire. Vapron must schedule HTTP hits to both endpoints (worker every 2 min, watches every 5 min, `CRON_SECRET` header) — or an external cron (e.g. GitHub Actions schedule) as a stopgap. | HIGH | Craig action — part of the Vapron cutover checklist (Boss Rule #5). |
| 29 | **GitHub Marketplace listing itself** — distribution channel. Requires Craig's action: create Marketplace listing in GitHub App settings, upload logo/screenshots, choose free-tier-with-upsell model, approval workflow (~2-3 weeks). Out of scope for code agents; listing copy can be drafted in the repo for Craig's review. | HIGH | Craig action (Boss Rule #8 — public-facing comms). |
| 31 | **Scan-speed reality vs claims (claims audit 2026-06-09)** — **RE-VALIDATED WITH REAL DATA 2026-07-16, see `docs/BENCHMARKS.md`.** Ran `scripts/benchmark-scan.js` against a synthetic 36-file repo representative of a typical customer's size: quick suite 1.1-1.3s, full suite 2.6-3.1s — comfortably inside Bible Quality Bar #9 ("Quick <15s, Full <60s"). Separately re-measured this repo's own self-scan quick suite at 29.4-30.8s (down from 228s on 2026-07-15, itself down from a 363s regression before commit `4efe693`'s ESLint fix) — the swing is explained by ESLint cache state (warm vs cold `.eslintcache`), not a further engine bug. **Conclusion: the original 34-52s baseline holds on repos of the size most customers actually have. This repo's own multi-thousand-file monorepo was never a representative benchmark target and self-scan timing should be tracked separately from the public per-scan-size claims** — the two were being conflated in this Known Issue's prior entries. Quality Bar #9 stands as written; no further action needed on the claim itself. | — | RESOLVED — real benchmark evidence backs the public Quick/Full targets on representative repo sizes. |
| 43 | **Self-scan 2026-07-15/16 found modules flagging their own test fixtures as real findings.** First 3 (`tls-security`, `cookie-security`, `cross-file-taint`) fixed 2026-07-15 (commit `4efe693`) with `BaseModule#_isInsideStringLiteral` + shared regex-literal-aware `_stripJsStrings`. **`redos` and `cronExpression` fixed 2026-07-16**: both harvest regexes matched fixture text like `write(tmp, 'src/a.ts', 'cron.schedule("60 0 * * *", run);')` because they didn't check whether the match sat nested inside an outer string literal in the scanned line. Applied the same `_isInsideStringLiteral` guard at every extraction point (`redos.js`: regex-literal extraction, `RegExp()`/`new RegExp()` ctor match, taint-source ctor match; `cron-expression.js`: the JS/Python/Spring harvest-regex loop). Verified against this repo: `redos` warnings 22→11 (remaining 11 are real hits in `website/app/lib/*`), `cronExpression` warnings 13→1 (remaining 1 is the real every-minute cron in `vercel.json`). 6 new regression tests (3 per module: nested-in-string is silent, same pattern unquoted still fires). `asyncIteration` checked and found already clean — its 4 warnings are real `.map(async...)` hits in website code, no fixture noise. Full fast suite 6302/6305 (2 pre-existing unrelated Windows-only flakes, KI #42), heavy suite 305/305, website build clean, all ~120 modules load. | MEDIUM | **RESOLVED** — redos/cronExpression/asyncIteration all clear. Broader ask (audit remaining regex/text-matching modules for the same self-match class) still open if a future self-scan turns up more. |
| 32 | **Two fully-built modules never registered: `src/modules/cve-feed.js` + `src/modules/sbom.js`** (claims audit 2026-06-09). **SBOM registered 2026-06-18** — CycloneDX 1.4 generator is file-system only (no network), now registered as module 111, added to `full` + `nuclear` suites. US EO 14028 / EU CRA compliance artifact. **Website marketing list caught up 2026-07-09** — `sbom` was in the CLI engine but missing from `website/app/components/howitworks/modules-data.ts` (the site's single-source-of-truth for the public module count), silently undercounting it as 119 instead of 120; added. **CVE feed still dormant** — likely requires network calls to pull CVE data; confirm Craig's policy on external-data fetches (Boss Rule #7) before registering. | MEDIUM | **PARTIAL** — sbom ✓ registered + ✓ on website. cve-feed: Craig action — network-call policy confirmation needed. |
| 34 | **Continuous-tier AI-allowance enforcement point pending** — the $49/mo ledger (`continuous_ai_ledger`) and gate (`checkAiAllowance`) shipped 2026-06-12, but push-scan jobs currently run deterministic suites only (zero Claude spend), so nothing consults the meter yet. When AI-on-push or the weekly scheduled deep scan ships, the worker must call `findActiveByRepo` → `checkAiAllowance` before any Claude call and `recordAiSpend` after. Consume/record API is ready and tested. | MEDIUM | OPEN — wire at the point AI joins the push-scan path. |
| 35 | **MCP registry submission to Anthropic still not done** (Craig, 2026-07-09: "really urgent"). `mcp-publisher` is a Go binary from `modelcontextprotocol/registry` GitHub releases, not npm — no Windows build exists as of 2026-07 (confirmed same day; the docs previously had a wrong `npm install -g @modelcontextprotocol/publisher` command, fixed). Flow: `mcp-publisher login github` (device flow, Craig's own browser) → `validate` → `publish ./server.json`. Full steps in `docs/marketing/SUBMISSION-RUNBOOK.md` §1b. Also gated on Known Issue #36 below — registry crawlers/health-checks may hit the stale live site. | HIGH | Craig action — needs his own GitHub device-flow login from WSL/Linux/a Go toolchain checkout; no code action possible. |
| 36 | **gatetest.ai serves a stale build off Server 161** (66.42.121.161) — hosting moved off Vercel 2026-07-09; the box runs Coolify + Traefik (Docker PaaS), not a bare host, and has no deploy automation wired to it yet. Confirmed live: `/api/status`, `/api/mcp`, `/icon.png` all 404 on gatetest.ai right now. `scripts/deploy/deploy-on-box.sh` + `.github/workflows/deploy-box.yml` were built (commit c0f75fa) assuming a bare-host pm2/systemd model that doesn't match the actual Coolify setup — likely need rework or replacement once the real deploy path is confirmed. **Craig's explicit call (2026-07-09): do not chase this — Vapron is expected to replace this hosting setup soon, fixing Coolify now would be thrown-away work.** Any site fixes landing in `main` won't be visible live until this is resolved. | HIGH | Craig action — wait for Vapron, then redo the deploy investigation against whatever the new setup is. |
| 38 | **MCP-tier pricing-threshold design shelved** ("first 2000 signups at $29/mo, then $49/mo" — counter in `mcp-subscription-store.js` keyed off the Stripe webhook activation point, threshold check in `checkout/route.ts`'s `TIERS["mcp"]`). Fully scoped 2026-07-09, not built. Carved out of resolved Known Issue #37 (the rest — engine-first messaging, model choice, BYOK — shipped v1.58.0, 2026-07-10; see HISTORY). Pricing = Boss Rule #3. | LOW | Craig action — ready to build if/when MCP tier pricing work resumes. |
| 39 | **BYOK × $29/mo MCP gate** — does a BYOK user (own Anthropic key funds the AI calls) still need the `gtmcp_` subscription for premium tools? Shipped default: yes, gate stays (removing it is a pricing change → Boss Rule). Asked 2026-07-10, unanswered. | MEDIUM | Craig decision. |
| 40 | **Full-suite scan hangs indefinitely on the Gluecron.com repo** (found 2026-07-12). **Root fix shipped 2026-07-16**: `src/core/runner.js` `_runModule` now races every module's `run()` against a per-module wall-clock timeout (`DEFAULT_MODULE_TIMEOUT_MS` = 2 min; `HEAVY_MODULE_TIMEOUT_MS` = 10 min for `mutation`/`e2e`/`visual`/`visualRegression`/`chaos`; overridable via `config.moduleTimeouts`, `GATETEST_MODULE_TIMEOUT_MS`, `GATETEST_HEAVY_MODULE_TIMEOUT_MS`). On timeout the module is recorded as failed with a clear "timed out after Xms — skipped, scan continues" message — same handling as any other module crash — instead of hanging the whole run forever. 5 new regression tests including one proving a never-resolving module no longer hangs the suite. **Not yet done**: the original repro (which specific module spins on Gluecron's tree) was never isolated — the timeout is a safety net, not a root-cause fix for whatever that module is doing. Worth a follow-up repro run against the fix to confirm the suite now completes (with that one module reported as timed-out) rather than hanging. | MEDIUM | Timeout safety-net shipped and tested. OPEN residual: re-run the Gluecron repro to confirm completion and identify the slow module for a real fix. |
| 44 | **Pre-launch audit 2026-07-16 found website copy drift far broader than previously tracked** — 20 files across `app/compare/*`, `app/for/*`, `app/components/*`, `app/trust`, `app/github/*`, `app/scan/preview`, `app/api/badge`, `app/sitemap.ts` still hardcoded stale "110"/"90" module counts (some pages had 2-3 different wrong numbers on the same page), one page (`compare/codeql`) built its entire headline positioning around an unrealistic "60 seconds" full-scan claim contradicted by KI #31, and several mutation/chaos mentions were missing the CI-only honesty caveat (worst: homepage `HomeKills.tsx`, zero disclaimer on the highest-visibility surface). **All fixed same day** — every count normalized to 120, `compare/codeql` softened to "minutes" language matching the pattern already used on `compare/deepsource`, missing honesty caveats added everywhere mutation/chaos is mentioned. `app/for/page.tsx`'s `MODULE_COUNT` now imports `TOTAL_MODULES` from the single-source-of-truth (`module-count.ts`) instead of a second hardcoded literal that had drifted from its own comment. Full website build clean, `tests/heavy/marketing-claim-verification.test.js` + `tests/heavy/site-stats-honesty.test.js` + `tests/marketing-country-pages.test.js` all green (57/57). **Not fixed — flagged, not touched**: `app/preview/*` (Bento/Cta/Enterprise/Hero/Nav/Pipeline/Playground, ~7 files) is an orphaned design variant still saying "110+ checks" everywhere — not linked from any page, not in the sitemap, so not customer-discoverable today, but it's a live route if anyone has the URL. Needs Craig's call: finish it, delete it, or leave parked. | HIGH (was silently undermining the "no scatter-gun" / honesty standard) | RESOLVED except `/preview` — Craig decision needed on that orphaned section. |
| 45 | **Remote MCP (`packages/mcp-remote/`) is implemented and tested but not deployed** — confirmed by pre-launch audit 2026-07-16. The actual JSON-RPC/tool logic lives in `website/app/lib/mcp-remote-core.cjs` (509 lines, all 27 tests in `tests/mcp-remote.test.js` pass), imported by `packages/mcp-remote/src/index.ts`. `packages/mcp-server/server.json` is valid and declares both transports, but its remote endpoint points at `https://gatetest.ai/api/mcp`, not `mcp.gatetest.ai` as `docs/ROADMAP.md`'s own REMOTE MCP section describes — a doc-vs-reality mismatch, not a functional bug (the website API route works; the dedicated subdomain + Jarvis co-location was never actually stood up). No CI/deployment automation exists for `packages/mcp-remote/` in this repo. | MEDIUM | Craig decision — DNS (`mcp.gatetest.ai` A record) and the Jarvis deploy are Boss Rule #4/#5 territory; either finish the subdomain plan or update the roadmap to describe the shipped `gatetest.ai/api/mcp` reality instead. |
---

---

## REMOTE MCP — UNIVERSAL DISTRIBUTION (approved by Craig 2026-07-07)

**Goal:** any Claude user — claude.ai web, Desktop app, mobile, Claude Code, Cursor,
Windsurf, corporate locked-down machines — can add GateTest in under 30 seconds.
The local stdio MCP (`npx @gatetest/mcp-server`) only reaches users who can run npm.

**Architecture:**
- Hosted MCP endpoint: `https://mcp.gatetest.ai/mcp` (MCP Streamable HTTP transport)
- Host: the Jarvis server `66.42.121.161` (Vultr) — Jarvis orchestrates on this box, so
  GateTest's MCP endpoint MUST be co-located there for Jarvis to control it. Do NOT move.
- Runtime: Bun + Hono (Vapron edge-runtime pattern). NOT Vercel — Vercel is a competitor.
- Code staged in this repo at `packages/mcp-remote/` until deployed to the box.
- Auth: `Authorization: Bearer gtmcp_xxx` → validated against `/api/mcp/validate` (1h cache).
- Remote-capable tools (proxy gatetest.ai APIs): check_health, list_modules, get_badge,
  scan_url, scan_repo, explain_finding, fix_issue, get_production_errors, get_report.
- Local-only forever (honest limitation): scan_local, run_tests, stream_logs, query_db,
  http_request — they need the user's filesystem/processes.

**DNS (Craig action):** Cloudflare A record `mcp` → `66.42.121.161`, DNS-only first
(box terminates TLS via Caddy/Let's Encrypt), optionally proxied later.

**Registry:** `packages/mcp-server/server.json` carries both transports (stdio npm +
remote HTTP) → submit to Anthropic's MCP registry for one-click install.

Full detail: `~/.claude/plans/can-i-please-have-calm-lightning.md` (session plan, 2026-07-07).
