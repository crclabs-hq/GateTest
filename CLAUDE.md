# GATETEST — THE BIBLE

> **This document is the single source of truth for GateTest.**
> **Read it FIRST. Reference it ALWAYS. Violate it NEVER.**

---

## THE PRIME DIRECTIVE

**GateTest kills SonarQube. GateTest kills Snyk. GateTest kills every fragmented QA tool.**

Code quality has never been unified. Teams duct-tape 10+ tools together — different configs, different dashboards, different billing. We are the unification. There is no second place. We dominate or we die. Every line of code, every component, every decision, every commit must serve this mission.

**The standard:** 80-90% ahead of every competitor at all times. Not 10%. Not 30%. Eighty to ninety percent.

If a competitor closes the gap, we accelerate. If new technology threatens our lead, we absorb it. We are not in a race — we are lapping the field.

---

## THE BIBLE RULE

**Before ANY new build, ANY refactor, ANY significant change — READ THIS FILE FIRST.**

This file is read at the start of every session. It is referenced before every architectural decision. It is updated at the end of every session. No work happens outside the framework defined here.

**No scatter-gun. No drift. No "just this once." No chicken scratchings.** Every action ties back to this document.

### The Bible's library — where the detail lives

The Bible holds **rules + current truth only**. Deep reference material lives in `docs/` — read the one that matches your task BEFORE building:

| File | Read it when... |
|---|---|
| `docs/ARCHITECTURE.md` | Touching the stack, module system, serverless rules, key files, or env vars |
| `docs/MODULES.md` | Adding/changing a module, or writing competitive/marketing copy about module coverage |
| `docs/ROADMAP.md` | Picking up new work — evolution tiers, Inclusive Agentic QA spec, **open Known Issues**, remote-MCP distribution plan |
| `docs/HISTORY.md` | Wondering whether something was already built/decided — completed build plans, all version changelogs, resolved Known Issues |

**Session-start rule:** read this file end to end, then `docs/ROADMAP.md` for open work. Never re-implement something without checking `docs/HISTORY.md` first.

---

## THE BOSS RULE — CRAIG MUST AUTHORIZE

The following actions require **explicit authorization from Craig BEFORE execution**:

1. **Major architectural changes** — swapping frameworks, changing core stack
2. **New dependencies not already approved** — we don't add bloat
3. **Pricing changes** — any modification to plans, tiers, or billing logic
4. **Domain or DNS changes** — anything touching gatetest.ai
5. **Production deployments** — first-time deploy and any rollback
6. **Stripe configuration** — webhook URLs, price IDs, plan structures
7. **External API integrations** — adding new third-party services
8. **Brand/marketing changes** — copy on landing page, logos, taglines
9. **Anything that touches money, users' data, or public-facing communication**

**The rule:** When in doubt, ask Craig. Cost of asking = 30 seconds. Cost of acting wrong = days of damage.

**The exception:** Craig has pre-authorized continuous building of features within the existing build plan and stack. Routine code, bug fixes, refactors within the approved architecture, and committing/pushing to main do NOT require additional authorization.

---

## ALWAYS-ON MODE — NEVER IDLE (READ THIS EVERY SESSION)

**Idle Claude = lost revenue. Craig's directive:** *"if you're coding and you see something that's broken you fix it, if you think you have an advanced feature that needs adding just add it. We can't have you sitting idle — that's loss of revenue, downtime, loss of coding time."*

### The rule

While working on any task in this repo, if you observe any of the following, **act on it before ending the turn** — do not wait to be asked, do not report and move on:

1. **Broken state** — failing test, failing build, unloaded module, dead link, runtime error, TypeScript error, lint error, broken user flow, dependency drift.
2. **Bible violations** — anything on the Forbidden List, missing protection artifact, `continue-on-error: true` on the gate, in-memory state on serverless, unhandled error path.
3. **Obvious missing capability** — a competitor ships a feature we don't have; a module has a known false-positive; an untested module; a `TODO` / `FIXME` left in the code; a Known Issue marked `HIGH` that falls under the pre-authorization.
4. **Drift from the Bible** — a file changed and this document wasn't updated; a new module added but not registered in the version section; a tier missing a new module name.

### The loop

Every turn ends with the **sweep checklist**:
- [ ] `node --test --test-force-exit --test-timeout=60000 tests/*.test.js` — all pass (the bare `node --test` form hangs for HOURS locally — a leaked timer/socket keeps the runner alive; CI got the same force-exit fix in `180bf7c`)
- [ ] `node --test --test-force-exit --test-timeout=120000 tests/heavy/*.test.js` — heavy suite (subprocess/CLI tests moved here in v1.57.1); non-blocking in CI but must be green before shipping
- [ ] `cd website && npx next build` — zero errors
- [ ] `node bin/gatetest.js --list` — all modules load
- [ ] `grep -rn "TODO\|FIXME" src/ website/app/ --include="*.js" --include="*.ts" --include="*.tsx"` — none left unresolved in code you touched
- [ ] Known Issues table reviewed — any HIGH item still in the pre-authorization scope gets picked up

If the sweep is red, **fix it before stopping**. The Stop hook enforces this.

### Boundaries

This rule does NOT override **THE BOSS RULE**. The Boss Rule's 9 items still require Craig's explicit authorization — never auto-act on pricing, DNS, Stripe config, production deploys, new dependencies, brand copy, external-API integrations, major architectural changes, or anything touching money/user-data/public comms. When a "broken" thing is one of those, report it to Craig and move on.

**Authorization for this mode:** Granted by Craig — *"if you see something that's broken you fix it... if you think you have an advanced feature that needs adding just add it."*

### The operational floor

- **No "nothing to do" ending.** If the sweep is green and Craig's current ask is satisfied, pick the next HIGH-priority Known Issue that falls under pre-authorization and start it. Only stop when everything pre-authorized is clear.
- **No "I'll note that for later."** You either do it now (pre-auth) or escalate to Craig now (Boss Rule). There is no third option.
- **Commit as you go.** A broken-then-fixed state must be captured in a commit, not left in the working tree.

---

## STRATEGIC DIRECTION — DUAL-HOST, GLUECRON-LONG-TERM (READ THIS EVERY SESSION)

**Gluecron.com is the future git host for Craig's stack — but GitHub is the distribution channel NOW.** Since 2026-04-22 GateTest is DUAL-HOST: push / PR events arrive from either GitHub App webhooks (`/api/webhook`) or Gluecron's Signal Bus (`/api/events/push`), both landing in the same `scan_queue`. Shutting off GitHub before Gluecron had paying customers was a commercial misstep; the webhook is alive again and will stay alive until Gluecron reaches revenue parity.

The long-term direction is still Gluecron-first — the `HostBridge` abstraction exists so the migration can happen once the customer base follows. Every architectural decision must still pass: *does this make the eventual GitHub → Gluecron migration easier or harder?*

Concretely:
- New cross-host logic belongs behind a **`HostBridge` abstraction**, not inside `github-bridge.js`.
- `github-bridge.js` and `gluecron-bridge.js` are both concrete implementations of the same interface — neither is "the" bridge.
- Website copy, CLI help text, and docs should say **"git host"** where possible, not "GitHub."
- New host-specific features should ship with equivalents for the other host (or a `TODO(host-parity)` note identifying the gap).

**Authorization for this direction:** Originally granted by Craig — *"we need to integrate with Gluecron rather than putting all our time and effort into GitHub. GitHub is going to be obsolete."* Dual-host revival authorized by Craig 2026-04-22 — *"how do we get the product in front of people how do they even know it's there"* → GitHub Marketplace is the distribution channel; the webhook must be live for that to work.

The `HostBridge` refactor is pre-authorized, and both bridges (GitHub + Gluecron) are pre-authorized as first-class. Host-specific billing integrations (GitHub Marketplace subscriptions, Gluecron's Signal Bus, etc.) still require Craig's authorization per the Boss Rule.

---

## PROTECTED PLATFORMS — PERMANENT INTEGRATIONS (READ THIS EVERY SESSION)

**GateTest protects the following Craig-owned platforms. These integrations are PERMANENT. They must survive every future Claude session. They cannot be removed, weakened, or "simplified" without Craig's explicit authorization.**

| Platform     | Repository                                         | Status     |
| ------------ | -------------------------------------------------- | ---------- |
| Vapron (formerly Crontech.ai — renamed per Craig 2026-06-12) | https://github.com/Gate-Test/Crontech | INTEGRATING |
| Gluecron.com | https://github.com/ccantynz-alt/Gluecron.com       | INTEGRATING |

### How the integration works

GateTest remains a **standalone subscription product** on gatetest.ai. Protected platforms consume the same engine by cloning this repo at CI time — nothing is vendored, forked, or duplicated. Ship a fix here → every protected platform picks it up on the next CI run.

### What lives in THIS repo (`crclabs-hq/gatetest`)

Under `integrations/`:
- `integrations/github-actions/gatetest-gate.yml` — drop-in CI workflow
- `integrations/husky/pre-push`                    — local pre-push hook
- `integrations/scripts/install.sh`                — one-command installer
- `integrations/README.md`                         — the integration spec

Guarded by:
- `tests/integrations.test.js` — fails the suite if any artifact is removed or weakened.

### What lives in a PROTECTED repo (e.g. Crontech, Gluecron)

After running the installer:
- `.github/workflows/gatetest-gate.yml` — the CI gate
- `.husky/pre-push`                      — the local gate
- `.gatetest.json`                       — the protection marker

### Install command (from the protected repo's root)

```bash
curl -sSL https://raw.githubusercontent.com/crclabs-hq/gatetest/main/integrations/scripts/install.sh | bash
```

### Rules for every Claude session

1. Before touching `integrations/`, `tests/integrations.test.js`, or this section — **STOP** and check for Craig's authorization.
2. If a protected repo is missing its gate, the correct action is to **re-install**, never to remove the marker.
3. If `tests/integrations.test.js` fails, a previous session broke protection. **Restore it, do not delete the test.**
4. Adding a new protected platform: update the table above **and** add its repo to the installer docs.

---

## THE MISSION

Build the most advanced, most aggressive, most beautiful QA testing platform ever made. 120 modules. One gate. One decision. AI-powered code review that no competitor can match. Pay-per-scan pricing that eliminates customer risk. A scan experience so visually stunning that customers WANT to watch it run.

**The customer sees:** Their repo scanned by 120 modules in real time. Issues found. Issues fixed. Delivered.
**The competition sees:** A force they cannot match without rebuilding from scratch.
**Craig sees:** Recurring revenue with high margins on a moat that compounds over time.

---

## THE QUALITY BAR — ZERO TOLERANCE

### 1. Tests & Build

- [ ] All fast tests pass (`node --test --test-force-exit --test-timeout=60000 tests/*.test.js`)
- [ ] Heavy tests pass (`node --test --test-force-exit --test-timeout=120000 tests/heavy/*.test.js`) — non-blocking in CI but green before shipping
- [ ] Website builds clean (`cd website && npx next build`)
- [ ] All modules load (`node bin/gatetest.js --list`)
- [ ] Fake-fix detector flags symptom patches on diffs
- [ ] Zero TypeScript errors in website
- [ ] Zero syntax errors in source files

### 2. Code Quality

- [ ] No console.log in library code
- [ ] No debugger statements
- [ ] No eval() in production code
- [ ] No TODO/FIXME left unresolved
- [ ] Function length under 50 lines
- [ ] File length under 300 lines
- [ ] All error paths handled

### 3. Security

- [ ] No hardcoded secrets, API keys, or tokens
- [ ] No secrets in git history
- [ ] All user input validated
- [ ] All database queries parameterised
- [ ] No eval() or innerHTML with unsanitised content

### 4. Website & UX

- [ ] All links verified — no dead anchors or placeholder hrefs
- [ ] All buttons functional — every onClick does something
- [ ] All user flows tested end-to-end (click through, not just compile)
- [ ] Scan page handles every state: pending, scanning, complete, failed
- [ ] Mobile responsive — 320px to 2560px
- [ ] Lighthouse Performance 95+, Accessibility 100, SEO 100

### 5. Stripe & Payments

- [ ] Test keys used for testing (never live keys)
- [ ] Charge-upfront at checkout (Craig 2026-05-18 — no manual-capture holds; subscriptions use inline recurring price_data)
- [ ] Session metadata includes repo_url and tier
- [ ] Paid scan starts after checkout.session.completed webhook (fail-closed signature verification)
- [ ] Failed scans marked failed in DB; refunds handled via support (no auto-refund)

### 6. Serverless Architecture

- [ ] NO in-memory state between requests
- [ ] NO long-running async after response
- [ ] ALL scan work completes within function response
- [ ] Stripe metadata used for persistence (not Maps or variables)

### 7. GitHub App

- [ ] Webhook receives push/PR events
- [ ] JWT auth with private key works
- [ ] Commit status posted (pass/fail)
- [ ] PR comment posted with scan results

### 8. Documentation

- [ ] README accurate and up-to-date
- [ ] CLAUDE.md updated with any changes
- [ ] Legal pages current (Terms, Privacy, Refunds)
- [ ] All modules listed in README and CLI help

### 9. Performance

- [ ] Quick scan under 15 seconds
- [ ] Full scan under 60 seconds
- [ ] API responses under 500ms
- [ ] Website FCP under 1.0s

### 10. Accessibility

- [ ] All images have alt text
- [ ] All interactive elements keyboard-accessible
- [ ] Focus indicators visible
- [ ] ARIA labels on non-text elements
- [ ] Dark mode renders correctly

### 11. SEO & Metadata

- [ ] Meta title and description set
- [ ] Open Graph tags set
- [ ] Canonical URL set to gatetest.ai
- [ ] Structured data valid

### 12. Deployment

- [ ] Vercel deploys from main branch
- [ ] Root Directory set to website
- [ ] All 9 environment variables set
- [ ] DNS pointing to Vercel

### 13. Pre-Launch

- [ ] Fresh checkout → scan → result works end-to-end
- [ ] GitHub App installed and posting commit statuses
- [ ] Legal pages accessible from footer
- [ ] Stripe webhook endpoint configured
- [ ] Email forwarding set up for hello@gatetest.ai

---

## THE FORBIDDEN LIST

**NEVER do these things. Ever. Without exception:**

1. **Never ship code that "compiles but doesn't work."** "It compiles" is not testing.
2. **Never use in-memory storage on Vercel serverless.** Functions don't share memory.
3. **Never depend on webhooks for critical user flows.** Direct API calls only.
4. **Never let the scan page sit at 0% or loop.** Every state must be handled.
5. **Never test with live Stripe keys.** Test keys only. Card 4242 4242 4242 4242.
6. **Never commit secrets.** Env vars only.
7. **Never skip tests for "speed."** Untested code does not exist.
8. **Never say "it's ready" without testing the actual user flow.** Click every button.
9. **Patch the root cause when possible; a documented mitigation that unblocks the customer NOW beats a perfect refactor in two weeks.** Wrapped retries, feature flags, and surgical guards are acceptable when (a) tracked as a Known Issue with a follow-up plan and (b) they actually unblock the customer's work. The wrong fix at the wrong time is worse than a small fix today.
10. **Never make chicken scratchings on customer-facing products.** Internal tooling, one-line bug fixes, and surgical patches are fine — sometimes a five-line change IS the right change. "Go big or go home" applies to product surfaces, not every commit.
11. **Never deploy to production without Craig's authorization.**
12. **Never modify Stripe configuration without Craig's authorization.**
13. **Never add a dependency not in the approved stack without authorization.**
14. **Never delete user data without explicit user action.**
15. **Never let an error bubble unhandled to the user.** Wrap, log, recover.
16. **Never silently fail.** Errors are visible.
17. **Never ship a tier name change, module count change, or pricing change without updating the `## VERSION` section of this file.** Bug fixes and feature work do NOT require a Bible update — write the code, ship it, move on. The Bible is for source-of-truth facts, not changelogs.
18. **Never approve something you didn't test end-to-end.**
19. **Never build an 80s website.** We are AI builders. The output must be stunning.
20. **Never ask Craig "do you want me to fix this?"** If it's broken, FIX IT. (Boss Rule items in the 9-item authorization list still require explicit go — that exception still applies.)
21. **Never delete, rename, or weaken `integrations/`** — that directory protects Crontech and Gluecron. See **PROTECTED PLATFORMS**.
22. **Never delete or weaken `tests/integrations.test.js`** — it is the tripwire that keeps protection intact across sessions.
23. **Never remove the PROTECTED PLATFORMS section from this file.** It must be read at every session start.
24. **Never soft-fail the gate** with `continue-on-error: true` on the GateTest step **in CI workflows.** Local pre-push hooks may be advisory — they surface findings without blocking developer flow; the CI gate is the actual enforcement layer.
25. **Never let GateTest block its own author or admin operators on admin-owned projects.** We are the painkiller, not the bottleneck. Admin paths (env `GATETEST_ADMIN=1`, or `.gatetest.json` with `"owner": "crclabs-hq"` or `"admin": true`) auto-fix and pass. Customer paths surface findings and let CI's auto-fix PR flow do the heavy lifting. The hard "blocked because broken" experience only ships when payment is owed and unpaid.

---

## PRE-BUILD CHECKLIST (BEFORE EVERY BUILD)

Before writing a single line of new code:

1. Read the relevant section of this CLAUDE.md
2. Confirm the task aligns with the build plan
3. Confirm it doesn't require Craig's authorization
4. Confirm existing patterns to follow (check similar files)
5. Confirm dependencies are in the approved stack
6. Identify which tests need to be added
7. Plan the commit message in advance

---

## POST-BUILD CHECKLIST (BEFORE COMMITTING)

After writing the code:

1. `node --test --test-force-exit --test-timeout=60000 tests/*.test.js` — ALL pass
1b. `node --test --test-force-exit --test-timeout=120000 tests/heavy/*.test.js` — heavy suite green
2. `cd website && npx next build` — ZERO errors
3. `node bin/gatetest.js --list` — all modules load
4. No `console.log` left in library code
5. Every new route/page works (actually click it)
6. Every user flow tested end-to-end (not just "it compiles")
7. CLAUDE.md updated if anything changed
8. Conventional commit message ready
9. Push to main

---

## GATE RULES — NON-NEGOTIABLE

1. **ZERO TOLERANCE**: Any error-severity check failure blocks the pipeline. No exceptions.
2. **NO MANUAL OVERRIDES**: Checks pass or the build is rejected. Craig only.
3. **NO PARTIAL DEPLOYS**: Everything passes or nothing ships.
4. **EVIDENCE REQUIRED**: Every gate pass produces a timestamped report.
5. **TEST THE TESTS**: Mutation testing validates tests catch bugs.
6. **FIX IMMEDIATELY**: If it's broken, fix it. Don't ask. Don't wait.
7. **ROOT CAUSE ONLY**: Never patch symptoms. Find and fix the real problem.
8. **END-TO-END VERIFICATION**: "It compiles" is not testing. Click every button.

## FAILURE RESPONSE PROTOCOL

When something breaks:

1. **STOP** — Do not proceed with other work
2. **IDENTIFY** — What exactly failed? Which file? Which line? What state?
3. **ROOT CAUSE** — Why did it fail? Not the symptom. The CAUSE.
4. **FIX** — Fix the root cause, not the symptom
5. **VERIFY** — Test the fix end-to-end. Actually use it.
6. **ENSURE NO REGRESSIONS** — Run all tests. Build website. Load modules.
7. **COMMIT** — Push the fix immediately
8. **NEVER ask Craig "should I fix this?"** — YES. ALWAYS. FIX IT.

---

## PRICING — REVENUE MODEL

### Revenue model: Per-scan upfront payment (one-time tiers) + subscriptions
| Tier | Price | Deliverable |
|------|-------|---------|
| Quick Scan | $29 | 4 modules (scan-only, no auto-fix) |
| Full Scan | $99 | All 120 modules (scan-only, no auto-fix) |
| Scan + Fix | $199 | 120 modules + auto-fix PR + pair-review + architecture annotator |
| Forensic (renamed from Nuclear, Craig 2026-06-02) | $399 | Everything on the website-only scan: full deep scan, per-finding Claude diagnosis, cross-finding correlation, auto-fix PR, pair-review, executive summary, board-ready CISO report. Mutation testing + chaos / fuzz pass are NOT part of the website-only flow — they ship via the GitHub Action (`mutation: true` / `chaos: true`) because they need a CI runner to execute the customer's test suite and a headless browser. |
| Continuous | $49/mo | Scan every push — **LIVE** (Craig green-light 2026-06-12). Stripe subscription checkout (mode=subscription, inline recurring price_data — no dashboard product needed). Unlimited deterministic scans (near-zero marginal cost); AI reviews metered by `continuous_ai_ledger` monthly allowance (default $10/mo, env `CONTINUOUS_AI_BUDGET_USD`). Fix PRs NOT included — per-scan upsell. Store: `website/app/lib/continuous-subscription-store.js` (19 tests). Lifecycle synced via `customer.subscription.updated/deleted` webhooks. |
| MCP | $29/mo | Premium MCP tools (Eyes/Ears/Hands + debug tools) gated behind `GATETEST_API_KEY` (`gtmcp_` prefix, 70 chars), delivered by email after Stripe checkout — **LIVE** (Craig-authorized 2026-07-04). Free without a key: `check_health`, `list_modules`, `get_badge`, `scan_url`, `scan_local` (quick suite). Store: `website/app/lib/mcp-subscription-store.js`. |

**Honesty note (Bible Forbidden #1 / Boss Rule #8):** the website-only Nuclear path cannot run mutation testing or chaos / fuzz pass — those two modules need the customer's CI environment (Vercel serverless cannot safely run a customer's test suite, and Chromium typically cannot launch inside the function). Both modules are first-class in the engine and run cleanly via the GitHub Action where `mutation.js` and `chaos.js` have a real runner. Marketing copy must reflect this on every public surface; future sessions DO NOT regress this wording back to "every Nuclear scan includes mutation + chaos."

---

## SESSION PROTOCOL

### At the START of every session:
1. Read this file end to end
2. `git status && git log --oneline -10`
3. `git branch` — verify on correct branch
4. Check open Known Issues in `docs/ROADMAP.md`
5. Check what needs to be done (`docs/ROADMAP.md` is the work queue)
6. If unclear, ask Craig

### At the END of every session:
1. Run ALL tests — `node --test --test-force-exit --test-timeout=60000 tests/*.test.js` (fast) + `node --test --test-force-exit --test-timeout=120000 tests/heavy/*.test.js` (heavy)
2. Build website — `cd website && npx next build`
3. Verify all modules load — `node bin/gatetest.js --list`
4. Update Known Issues in `docs/ROADMAP.md` if anything found (resolved ones move to `docs/HISTORY.md`)
5. Commit and push everything
6. Leave the codebase in a WORKING state

### MCP Debug Protocol — MANDATORY
When debugging ANY issue in this repo or any customer repo via GateTest MCP:
1. **ALWAYS run `scan_local` FIRST** — never manually inspect files for bugs before scanning. The 120-module engine finds in seconds what manual inspection takes minutes to locate.
2. **ALWAYS run `run_tests` after editing** — never assume a fix worked without verification.
3. **ALWAYS call `get_production_errors` before deciding what to fix** on live customer issues.
4. **Full debug loop:** `scan_local` → `explain_finding` → `fix_issue` → `run_tests` → `verify_fix`
5. **Never bypass GateTest** to "just look at the code." The 120-module engine finds what manual inspection misses.

### When something breaks:
1. **FIX IT.** Don't ask. Don't wait. Don't patch symptoms.
2. Find the ROOT CAUSE.
3. Fix the root cause.
4. Test the fix END TO END.
5. Commit. Push.

---

## THE AGGRESSIVE MANDATE (REPRISE)

**This is not a hobby project. This is a business. Craig needs revenue.**

Every feature must be the BEST implementation available. Every check must be DEEPER than the competition. Every report must be more ACTIONABLE. Every module must catch REAL bugs.

The website must look like it was built in 2026 by the most advanced AI on the planet — because it was. Not the 80s. Not "functional but ugly." STUNNING.

The scan experience must be CINEMATIC. Customers watch their repo get scanned in real time with animations, progress, and drama. They WANT to watch it.

If a competitor does something we don't, that's a GateTest bug. Fix it.

**No scatter-gun. No drift. No chicken scratchings. No "just this once."**

**GateTest dominates or GateTest dies. There is no second place.**

---

## VERSION

GateTest v1.59.0 — **120 modules**, **hybrid AI layer** (Craig 2026-07-07;
Sonnet 5 upgrade + user-selectable model + BYOK Craig 2026-07-10):
**Fable 5** (`claude-fable-5`) on the paid fix tiers (Scan+Fix, Forensic),
**Sonnet 5** (`claude-sonnet-5`) on free/cheap/high-volume paths, **Opus
4.8** (`claude-opus-4-8`) as the Fable refusal fallback. Model selection lives
in `website/app/lib/engine-models.js` + `src/core/engine-models.js`
(`modelForTier` + the `ALLOWED_FIX_MODELS` user allow-list); the paid-tier
budget caps fund deeper Fable analysis (Scan+Fix $30, Forensic $60) and
`budget-tracker.js` prices each call at the model that ran it.
**User-selectable model** (sonnet | opus | fable): CLI `--model`, MCP `model`
arg on fix_issue/explain_finding, website `model` field on /api/scan/fix.
Precedence: explicit choice > `GATETEST_FIX_MODEL` env (now honored by CLI +
MCP + website — flip Fable off with it if data retention ever drops below 30
days; Fable is unavailable under ZDR) > per-tier default.
**BYOK**: CLI + MCP always run on the user's own `ANTHROPIC_API_KEY` (their
machine, their spend); the website fix route accepts optional
`anthropicApiKey` (sk-ant-*, per-request only, never stored/logged/echoed) —
BYOK lifts the USD cap, keeps the tier token cap as runaway protection.
**Six tiers live** — Quick $29 / Full $99 / Scan+Fix $199 / Forensic $399
(one-time) + Continuous $49/mo + **MCP $29/mo** (Craig-authorized 2026-07-04).
The MCP tier gates premium Eyes/Ears/Hands tools behind a `GATETEST_API_KEY`
delivered by email after Stripe checkout; BYOK does NOT bypass that gate
(open question for Craig — until he rules, the gate stays). MCP + CLI fix
paths default to Sonnet (flat-rate / no per-scan payment — Fable isn't funded
there, but BYOK users may pick it since the spend is theirs).
MCP server: `bin/gatetest-mcp.mjs`, 24 tools (run_tests / stream_logs / query_db / http_request restored to tools/list 2026-07-11 — they had handlers but were never registered).
**Flywheel (v1.59.0, 2026-07-11):** EVERY scan (not just fixes) now feeds the
flywheel — anonymized module+count signal to `~/.gatetest/telemetry/scan-findings.jsonl`
+ best-effort upload to `POST /api/telemetry/scan` (opt-out: `GATETEST_NO_TELEMETRY=1`
or `.gatetest.json {telemetry:false}`; NEVER code/paths/findings). **False-positive
control:** repo-root `.gatetestignore` suppresses findings (`module:rule` | `module`
| `*:rule` | `module:rule@glob` | `path/**`); `gatetest --noise` shows noisy modules;
chronically-dismissed high-fire modules auto-soften below the block threshold. See
`src/core/{scan-telemetry,telemetry-uploader,ignore-file,noise-model}.js`.
Date stamp last fully reconciled: 2026-07-11 (core-engine program: every-scan
flywheel + false-positive control + entry-level CLI recap).

**Full version-by-version changelog:** see `docs/HISTORY.md`.
