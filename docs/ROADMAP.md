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
| 22 | **GitHub App `installation_id` not persisted** (`/api/github/callback/route.ts:17`). Without this, webhooks carry an `installation_id` but we can't map it to a billing customer → multi-org customers lose correlation. Flagged by scan/payment + GitHub-App audits 2026-04-18. | HIGH | Craig action — requires schema extension (new `installations` table or equivalent in Neon) and touches user data. Bible Boss Rule #9 triggers. |
| 23 | **PR comments are not idempotent** — `/api/webhook/route.ts:438` posts a fresh comment per push. On a busy PR the thread fills with dupes. | MEDIUM | Post-launch polish — find-and-edit prior bot comment, or collapse into a single updating comment. |
| 24 | **GitHub file-tree fetch is unbounded** on `?recursive=1` — monorepos with 100k+ files will exhaust Vercel's per-function budget. | MEDIUM | Post-launch — add pagination / file-count ceiling / graceful degradation message when a repo is too large. |
| 25 | **Rate-limit wait cap** in `github-bridge.js:138` only waits if backoff < 120s. GitHub resets can be 60 minutes out, meaning we skip the wait and hammer 429. | MEDIUM | Post-launch — queue and respect longer resets, or refuse scans during the cool-down window. |
| 42 | **`ai-guardrails` tests flake on local Windows only** — all 30 subtests always pass, but the file intermittently (~1-in-4) trips `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` in `src\win\async.c` when `--test-force-exit` calls `process.exit()` while undici's global fetch pool is mid-teardown. **CI is unaffected** — it runs `ubuntu-latest` and this assertion is Windows-only. Mitigated 2026-07-14 by adding `Connection: close` to `src/modules/ai-guardrails/probe.js` (one-shot probes gain nothing from pooling), which reduces but doesn't eliminate it; a full fix needs undici's global dispatcher closed in teardown, but undici is Node-internal and not requireable. | LOW | Local-only cosmetic — revisit if Node exposes a dispatcher-close API. |
| 41 | **Cron endpoints have no scheduler outside Vercel** — `/api/scan/worker/tick` (queue processor) and `/api/watches/tick` are driven by `website/vercel.json` crons. On Vapron (or any non-Vercel host, per Craig 2026-07-14 "Vapron will be our backend today") NOTHING calls them → queued push-scans never run and watches never fire. Vapron must schedule HTTP hits to both endpoints (worker every 2 min, watches every 5 min, `CRON_SECRET` header) — or an external cron (e.g. GitHub Actions schedule) as a stopgap. | HIGH | Craig action — part of the Vapron cutover checklist (Boss Rule #5). |
| 29 | **GitHub Marketplace listing itself** — distribution channel. Requires Craig's action: create Marketplace listing in GitHub App settings, upload logo/screenshots, choose free-tier-with-upsell model, approval workflow (~2-3 weeks). Out of scope for code agents; listing copy can be drafted in the repo for Craig's review. | HIGH | Craig action (Boss Rule #8 — public-facing comms). |
| 31 | **Scan-speed reality vs claims (claims audit 2026-06-09)** — measured on this repo: quick suite (41 modules) = 34-52s wall; full suite did not finish inside 20 minutes locally (heavy modules: e2e/visual/mutation run real work). Public copy claiming "full 110-module scan in under 60 seconds" (compare/deepsource, compare/sonarqube, Install.tsx, regulation pages) was softened to "minutes" in the same audit. Bible Quality Bar #9 ("Quick <15s, Full <60s") needs either real benchmarks on representative customer-size repos to re-justify harder numbers, or the bar itself revised. **2026-07-15 self-scan re-measured: quick suite had regressed to 363s (6m4s), driven by `lint` running `npx eslint .` against `website/` with no cache and a 120s internal timeout that was silently misreported as a crash (see commit `4efe693`) — NOT a config-vs-reality gap, an actual engine bug. Fixed same day (direct-binary resolution + `--cache` + honest timeout message, raised to 180s): quick suite now 228s (3m49s), a real ~37% cut, but still nowhere near the 34-52s baseline this Known Issue was originally about.** The 34-52s number itself needs re-validation — either it was measured on a smaller repo shape, or more has been added to the quick suite's per-file cost since 2026-06-09. | MEDIUM | OPEN — re-run the original 34-52s benchmark methodology on this repo to see if it still holds; if not, restore harder public numbers with fresh proof or amend Quality Bar #9. |
| 43 | **Self-scan 2026-07-15/16 found modules flagging their own test fixtures as real findings.** First 3 (`tls-security`, `cookie-security`, `cross-file-taint`) fixed 2026-07-15 (commit `4efe693`) with `BaseModule#_isInsideStringLiteral` + shared regex-literal-aware `_stripJsStrings`. **`redos` and `cronExpression` fixed 2026-07-16**: both harvest regexes matched fixture text like `write(tmp, 'src/a.ts', 'cron.schedule("60 0 * * *", run);')` because they didn't check whether the match sat nested inside an outer string literal in the scanned line. Applied the same `_isInsideStringLiteral` guard at every extraction point (`redos.js`: regex-literal extraction, `RegExp()`/`new RegExp()` ctor match, taint-source ctor match; `cron-expression.js`: the JS/Python/Spring harvest-regex loop). Verified against this repo: `redos` warnings 22→11 (remaining 11 are real hits in `website/app/lib/*`), `cronExpression` warnings 13→1 (remaining 1 is the real every-minute cron in `vercel.json`). 6 new regression tests (3 per module: nested-in-string is silent, same pattern unquoted still fires). `asyncIteration` checked and found already clean — its 4 warnings are real `.map(async...)` hits in website code, no fixture noise. Full fast suite 6302/6305 (2 pre-existing unrelated Windows-only flakes, KI #42), heavy suite 305/305, website build clean, all ~120 modules load. | MEDIUM | **RESOLVED** — redos/cronExpression/asyncIteration all clear. Broader ask (audit remaining regex/text-matching modules for the same self-match class) still open if a future self-scan turns up more. |
| 32 | **Two fully-built modules never registered: `src/modules/cve-feed.js` + `src/modules/sbom.js`** (claims audit 2026-06-09). **SBOM registered 2026-06-18** — CycloneDX 1.4 generator is file-system only (no network), now registered as module 111, added to `full` + `nuclear` suites. US EO 14028 / EU CRA compliance artifact. **Website marketing list caught up 2026-07-09** — `sbom` was in the CLI engine but missing from `website/app/components/howitworks/modules-data.ts` (the site's single-source-of-truth for the public module count), silently undercounting it as 119 instead of 120; added. **CVE feed still dormant** — likely requires network calls to pull CVE data; confirm Craig's policy on external-data fetches (Boss Rule #7) before registering. | MEDIUM | **PARTIAL** — sbom ✓ registered + ✓ on website. cve-feed: Craig action — network-call policy confirmation needed. |
| 34 | **Continuous-tier AI-allowance enforcement point pending** — the $49/mo ledger (`continuous_ai_ledger`) and gate (`checkAiAllowance`) shipped 2026-06-12, but push-scan jobs currently run deterministic suites only (zero Claude spend), so nothing consults the meter yet. When AI-on-push or the weekly scheduled deep scan ships, the worker must call `findActiveByRepo` → `checkAiAllowance` before any Claude call and `recordAiSpend` after. Consume/record API is ready and tested. | MEDIUM | OPEN — wire at the point AI joins the push-scan path. |
| 35 | **MCP registry submission to Anthropic still not done** (Craig, 2026-07-09: "really urgent"). `mcp-publisher` is a Go binary from `modelcontextprotocol/registry` GitHub releases, not npm — no Windows build exists as of 2026-07 (confirmed same day; the docs previously had a wrong `npm install -g @modelcontextprotocol/publisher` command, fixed). Flow: `mcp-publisher login github` (device flow, Craig's own browser) → `validate` → `publish ./server.json`. Full steps in `docs/marketing/SUBMISSION-RUNBOOK.md` §1b. Also gated on Known Issue #36 below — registry crawlers/health-checks may hit the stale live site. | HIGH | Craig action — needs his own GitHub device-flow login from WSL/Linux/a Go toolchain checkout; no code action possible. |
| 36 | **gatetest.ai serves a stale build off Server 161** (66.42.121.161) — hosting moved off Vercel 2026-07-09; the box runs Coolify + Traefik (Docker PaaS), not a bare host, and has no deploy automation wired to it yet. Confirmed live: `/api/status`, `/api/mcp`, `/icon.png` all 404 on gatetest.ai right now. `scripts/deploy/deploy-on-box.sh` + `.github/workflows/deploy-box.yml` were built (commit c0f75fa) assuming a bare-host pm2/systemd model that doesn't match the actual Coolify setup — likely need rework or replacement once the real deploy path is confirmed. **Craig's explicit call (2026-07-09): do not chase this — Vapron is expected to replace this hosting setup soon, fixing Coolify now would be thrown-away work.** Any site fixes landing in `main` won't be visible live until this is resolved. | HIGH | Craig action — wait for Vapron, then redo the deploy investigation against whatever the new setup is. |
| 38 | **MCP-tier pricing-threshold design shelved** ("first 2000 signups at $29/mo, then $49/mo" — counter in `mcp-subscription-store.js` keyed off the Stripe webhook activation point, threshold check in `checkout/route.ts`'s `TIERS["mcp"]`). Fully scoped 2026-07-09, not built. Carved out of resolved Known Issue #37 (the rest — engine-first messaging, model choice, BYOK — shipped v1.58.0, 2026-07-10; see HISTORY). Pricing = Boss Rule #3. | LOW | Craig action — ready to build if/when MCP tier pricing work resumes. |
| 39 | **BYOK × $29/mo MCP gate** — does a BYOK user (own Anthropic key funds the AI calls) still need the `gtmcp_` subscription for premium tools? Shipped default: yes, gate stays (removing it is a pricing change → Boss Rule). Asked 2026-07-10, unanswered. | MEDIUM | Craig decision. |
| 40 | **Full-suite scan hangs indefinitely on the Gluecron.com repo** (found 2026-07-12 during the Hall of Scans refresh). Reproduced twice on a fresh shallow clone: once with the default full suite (killed after ~45 min), once with `--skip-module unitTests --skip-module e2e` (killed after ~50 min; only `.gatetest/memory` was created, no report written). The Crontech repo (3.7k files) completed in 8.8 min on the same machine, so this is repo-shape-specific, not size. A hang with no output is exactly what a paying customer must never hit — needs a per-module wall-clock timeout in the runner (kill + record `timed out` as a module result, keep scanning) plus a repro to find which module spins on Gluecron's tree. | HIGH | OPEN — pre-authorized engine work; per-module timeout is the root fix, Gluecron repro identifies the offender. |
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
