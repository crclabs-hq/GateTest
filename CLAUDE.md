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
| `docs/DOCTRINE.md` | Before touching the engine or a rule — the fourteen working principles, each with the defect that proved it and the method that prevents it |
| `docs/THE-FIFTY.md` | Picking up new work — the current fifty-move plan with status and evidence per move; the work queue |

**Session-start rule:** read this file end to end, then `docs/DOCTRINE.md`, then `docs/THE-FIFTY.md` and the Known Issues in `docs/ROADMAP.md` for open work. Never re-implement something without checking `docs/HISTORY.md` first.

---

## THE SYNC RULE (Craig 2026-07-30, extended 2026-08-05, STRICT)

**"All changes must reflect on the website at the same time."** (2026-07-30)
**"Whatever we do we have to be in sync with the website and our GitHub
Marketplace listing and Marketplace app."** (2026-08-05)

There are **four** surfaces that describe this product, and they move together
in the SAME commit:

| # | Surface | Lives in | Enforced by |
|---|---|---|---|
| 1 | **The engine** | `src/`, `bin/` | it *is* the truth |
| 2 | **The website** | `website/app/` | `tests/module-count-sync.test.js` |
| 3 | **The Marketplace listing** | `integrations/marketplace/listing.md` | `tests/marketplace-sync.test.js` |
| 4 | **The Marketplace App config** | GitHub, not this repo | `tests/marketplace-sync.test.js` + `scripts/marketplace-preflight.js` |

Surface 4 is the dangerous one: **it lives on github.com and cannot be edited
from this repo.** A commit can therefore leave it stale without any local
signal. So the rule for surface 4 is: when a change alters what the App needs
(a new API call, a new webhook event, a changed URL), **declare it in
`src/core/github-app-permissions.js` in that same commit** — the test then
fails until the listing and install page agree, and the preflight script checks
the live App the next time it runs with `gh` authenticated. Anything still
needing Craig's hands goes in `docs/marketplace/CRAIG-PRE-SUBMIT-CHECKLIST.md`,
not a code comment.

Never ship a product change and leave a surface describing the old product;
never defer copy to "a later pass."

**Why:** the site is the product's only public description. A gap between what
ships and what the site claims is a correctness bug in the customer's view of the
product, not a cosmetic follow-up.

**This overrides the instinct to defer counts and capability copy to Craig under
Boss Rule #8.** Factual sync — module counts, capability lists, what a tier
includes — is expected work. Boss Rule #8 still governs genuine *brand*
decisions: taglines, logos, positioning, pricing. "We have 121 modules, not 120"
is a fact, not a brand decision.

**Two things it does NOT mean:**
1. **Never rewrite dated evidence.** A page recording "scanned with the
   120-module engine on 2026-07-12, 137 errors" is a measurement, not a claim.
   Updating it falsifies the record. `website/app/scans/page.tsx` is excluded
   for exactly this reason.
2. **Prefer generated values over hardcoded ones**, so the sync cannot rot:
   `website/app/data/site-stats.json` derives the module count from a real
   `gatetest --list` via `scripts/generate-site-stats.js`. Wire new claims to
   that rather than typing a number.

**Enforced by two tests** — remembering a rule is weaker than a test that fails:
- `tests/module-count-sync.test.js` — any three-digit "N modules" claim in
  shipped copy must equal the live module count.
- `tests/marketplace-sync.test.js` — the listing, the install page, and the
  preflight script must all agree with `src/core/github-app-permissions.js`,
  **and that file must cover every GitHub endpoint the bridge actually calls.**
  That last assertion is the one that matters: copy going stale is the symptom,
  code quietly gaining an API call nobody disclosed is the cause. It found two
  such gaps the first time it ran.

**Never hand-write a permission list, a webhook-event list, or a module count.**
Import it. The 2026-08-05 audit found `Contents` disclosed as `Read` on both the
install page and the listing while the App-installed fix path pushes a branch
(`contents: write`) — we were promising customers *less* access than GitHub's
install prompt actually requests, which is the exact disclosure mismatch a
Marketplace reviewer audits.

---

## THE BOSS RULE — CRAIG MUST AUTHORIZE

The following actions require **explicit authorization from Craig BEFORE execution**:

1. **Major architectural changes** — swapping frameworks, changing core stack
2. **New dependencies not already approved** — we don't add bloat
3. **Pricing changes** — any modification to plans, tiers, or billing logic
4. **Domain or DNS changes** — anything touching gatetest.io
5. **Production deployments** — first-time deploy and any rollback
6. **Stripe configuration** — webhook URLs, price IDs, plan structures
7. **External API integrations** — adding new third-party services
8. **Brand/marketing changes** — copy on landing page, logos, taglines
9. **Anything that touches money, users' data, or public-facing communication**

**The rule:** When in doubt, ask Craig. Cost of asking = 30 seconds. Cost of acting wrong = days of damage.

**The exception:** Craig has pre-authorized continuous building of features within the existing build plan and stack. Routine code, bug fixes, refactors within the approved architecture, and committing/pushing to main do NOT require additional authorization.

---

## ENGINEERING DOCTRINE (READ THIS EVERY SESSION)

Fourteen principles, each paid for by a defect that reached this codebase.
The method for each — how to write the control pair, how to run the corpus,
how to brief an agent — lives in `docs/DOCTRINE.md`. The principles:

1. **The bug that matters most is "reports success while doing nothing."** Prefer three-state answers: clean, found, **not checked** — and print the third.
2. **Precision is measured on code we did not write.** `scripts/real-world-precision.js` over `reliability-corpus/real-world.json`; ceilings only ratchet down; NodeGoat is a floor. A rule change is unvalidated until the corpus says otherwise.
3. **No rule ships without a control pair** — the real line that fires it, and the idiom beside it that must stay quiet. A probe that reports *silence* needs its own positive control first.
4. **One definition, imported.** Files a module sees, test paths, harness dirs, route handlers, the import graph, a finding's identity, the ignore line, the domain, the counts — each has one home (table in `docs/DOCTRINE.md` §4). A second answer to any of these is a bug.
5. **Segments, not substrings; tokens, not substrings.** `includes('.git')` matches `.github`; `/==[^=]/` matches inside `===`. `tests/test-path-canonical.test.js` forbids the shape — extend its word list, don't fix one instance.
6. **Say what was not checked** wherever the report is read: console, PR comment, JSON provenance. A pass from a fallback never wears the green tick.
7. **Generated over typed.** Counts, corpus numbers, dates, permission lists come from scripts and are import-checked by tests.
8. **Verify in the environment that decides, after the last edit.** Fast suite plain **and** under `GITHUB_ACTIONS=true`; quick self-scan last; corpus on rule changes; determinism check on module changes.
9. **Our own scanner reviewing our own PR is the best bug report we get.** Every bot finding on this repo is closed against one defendant — the code or the rule — never ignored.
10. **Expect the worst of prior work, and prove it either way.** Run a subsystem end to end on real input before trusting its comments; reconstruct and diff when replacing.
11. **Parallelise mechanical work; verify by reconstruction.** Agents get exact files, the tests to run, the control to show, and "do not commit"; the orchestrator runs the sweep and commits in units.
12. **Edit files the way their bytes are stored.** CRLF and BOMs survive scripted edits; a diff far larger than the change is a line-ending accident.
13. **Commit as coherent units; push and merge without being asked** (Craig). One cause per commit with the measurement in the message; a red PR is never "waiting on review".
14. **Speed is a precision feature.** Measure wall-clock before and after any change to the runner, a walker, or a file set.

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

Every turn ends with the **sweep checklist**, in this order — the self-scan and the corpus go LAST because they judge the tree as it will be pushed:
1. `node scripts/run-tests.js --timeout 60000 tests/*.test.js` — `SUITE: PASSED`, every file reported its summary (2026-09-05: the `node --test --test-force-exit` form this replaces exited as soon as the tests it had heard of were done — the same tree reported 50, 77 and 61 tests on three runs, exit 0 each time; the bare `node --test` form hangs for hours on a leaked handle. The runner runs one plain `node --test` per file and ends it after its summary line, so a leak cannot hang it and a file that ends before its summary is a failure)
2. The same suite under the Actions environment — `GITHUB_ACTIONS=true CI=true GITHUB_REPOSITORY=crclabs-hq/GateTest GITHUB_RUN_ID=1 node scripts/run-tests.js …` — `src/index.js` auto-attaches two reporters under that env and anything keyed on it is invisible locally (2026-09-05: four reporter tests green here, red in CI)
3. `node scripts/run-tests.js --timeout 120000 tests/heavy/*.test.js` — heavy suite; non-blocking in CI but green before shipping
4. `npx eslint .` — exit 0 (the root config ignores `website/`; `cd website && npx eslint` covers it)
5. `cd website && npx tsc --noEmit && npx next build` — zero errors
6. `node bin/gatetest.js --list` — 121 modules, matches `src/core/registry.js`
7. `grep -rn "TODO\|FIXME" src/ website/app/ --include="*.js" --include="*.ts" --include="*.tsx"` — none left in code you touched
8. **If a rule's recall or scope changed:** `node scripts/real-world-precision.js` — 11/11 at ceilings. **If a module's file set or the runner changed:** `node scripts/determinism-check.js`.
9. **Last:** `GATETEST_NO_TELEMETRY=1 node bin/gatetest.js --suite quick --parallel` — GATE: PASSED, 0 blocking, run AFTER the final edit (2026-09-05: an env var read without a `.env.example` line blocked CI's self-scan; the earlier green scan predated the edit)
10. Known Issues (`docs/ROADMAP.md`) and `docs/THE-FIFTY.md` reviewed — any HIGH item in the pre-authorisation scope gets picked up; any move that landed gets its status and evidence

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
| Vapron (formerly Crontech.ai — renamed per Craig 2026-06-12) | https://github.com/ccantynz-alt/Vapron | **INTEGRATED — bespoke** (verified live 2026-07-20) |
| Gluecron.com | https://github.com/ccantynz-alt/Gluecron.com       | **INTEGRATED — bespoke** (verified live 2026-07-20) |

**Verified 2026-07-20 (prior "INTEGRATING" status and the `Gate-Test/Crontech` repo URL above were both stale):**
- **Vapron**: has its own `.gatetest.json` (module config, severity overrides, doctrine cross-references — see `docs/BUILD_BIBLE.md` BLK-007 in that repo) and its own `gatetest-gate.yml`, which SHA-pins every GitHub Action it uses instead of trusting a mutable tag. That SHA-pinning practice was good enough that it's been back-ported into `integrations/github-actions/gatetest-gate.yml` in *this* repo (2026-07-20).
- **Gluecron.com**: its generic clone-based CI gate is **deliberately disabled** (`GATETEST QUALITY GATE — DISABLED (auto-triggers off)`, "Authorized by Craig 2026-04-30") because the clone kept failing against a private dev repo. The real, live integration is a direct API webhook: `src/hooks/post-receive.ts` calls `POST /api/hooks/gatetest` on every push (HMAC/bearer-authed, own `gate_runs` table, in-app notifications, audit log — spec in that repo's `GATETEST_HOOK.md`).
- Both repos' `.gatetest.json` point `gatetest_source` at `https://github.com/ccantynz-alt/gatetest` rather than `crclabs-hq/GateTest` — confirmed to be the **same physical repository** reachable under both owner names (identical commit history, size, `fork:false`/`parent:null` on both — an org-transfer artifact, not a fork/divergence risk).
- **Lesson for future sessions:** before running `install.sh` against a protected repo, check whether it already has a *bespoke* integration — a repo missing the generic template is not the same as a repo missing protection. Blindly overwriting Vapron's or Gluecron's setup would have destroyed real customization and, in Gluecron's case, re-enabled a workflow Craig explicitly turned off.

### How the integration works

GateTest remains a **standalone subscription product** on gatetest.io. Protected platforms consume the same engine — either by cloning this repo at CI time via the generic `integrations/` template (Vapron does this, with its own SHA-pinning hardening layered on top), or via a bespoke integration that calls GateTest a different way (Gluecron's API webhook). Either is a valid protection mechanism; what matters is that the platform is actually gated, not that every platform uses an identical file. Ship a fix here → every protected platform that consumes the generic template picks it up on the next CI run; bespoke integrations (like Gluecron's webhook) need their own update if the API contract changes.

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
2. If a protected repo is missing its gate, first check whether it actually has a **bespoke** integration instead of the generic one (clone the repo, look for `.gatetest.json` / any `gatetest-gate.yml` / a hook file before assuming it's unprotected). Only run `install.sh` once you've confirmed there's genuinely nothing there — never to remove the marker.
3. If `tests/integrations.test.js` fails, a previous session broke protection. **Restore it, do not delete the test.**
4. Adding a new protected platform: update the table above **and** add its repo to the installer docs.

---

## THE MISSION

Build the most advanced, most aggressive, most beautiful QA testing platform ever made. 121 modules. One gate. One decision. AI-powered code review that no competitor can match. Pay-per-scan pricing that eliminates customer risk. A scan experience so visually stunning that customers WANT to watch it run.

**The customer sees:** Their repo scanned by 121 modules in real time. Issues found. Issues fixed. Delivered.
**The competition sees:** A force they cannot match without rebuilding from scratch.
**Craig sees:** Recurring revenue with high margins on a moat that compounds over time.

---

## THE QUALITY BAR — ZERO TOLERANCE

### 1. Tests & Build

- [ ] All fast tests pass (`node scripts/run-tests.js --timeout 60000 tests/*.test.js` — `SUITE: PASSED`)
- [ ] Heavy tests pass (`node scripts/run-tests.js --timeout 120000 tests/heavy/*.test.js`) — non-blocking in CI but green before shipping
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
- [ ] Canonical URL set to gatetest.io
- [ ] Structured data valid

### 12. Deployment

- [ ] Production runs on **Vapron** (Craig 2026-07-14, re-confirmed 2026-07-23 — "zero old services"); deploy per `docs/deploy/VAPRON-DEPLOY.md`
- [ ] Built with `npm run build` in `website/` (prebuild stamps the git SHA — `/api/platform-status` must show the deployed commit, never "unknown")
- [ ] All required environment variables set on Vapron (`/api/status` lists what's missing)
- [ ] Cron scheduler hitting `/api/scan/worker/tick` (~2 min) + `/api/watches/tick` (~5 min) with `Authorization: Bearer $CRON_SECRET` — nothing fires them off-Vercel otherwise (KI #41)
- [ ] DNS pointing to Vapron; Vercel project retired/disconnected (no second deployment processing the shared queue with stale code)

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

1. `node scripts/run-tests.js --timeout 60000 tests/*.test.js` — `SUITE: PASSED`
1b. `node scripts/run-tests.js --timeout 120000 tests/heavy/*.test.js` — heavy suite green
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
| Full Scan | $99 | All 121 modules (scan-only, no auto-fix) |
| Scan + Fix | $199 | 121 modules + auto-fix PR + pair-review + architecture annotator |
| Forensic (renamed from Nuclear, Craig 2026-06-02) | $399 | Everything on the website-only scan: full deep scan, per-finding Claude diagnosis, cross-finding correlation, auto-fix PR, pair-review, executive summary, board-ready CISO report. Mutation testing + chaos / fuzz pass are NOT part of the website-only flow — they ship via the GitHub Action (`mutation: true` / `chaos: true`) because they need a CI runner to execute the customer's test suite and a headless browser. |
| Continuous | $49/mo | **ORG-FLAT (Craig-authorized 2026-07-23): one subscription covers every repo under the same owner/org** — no per-seat, no per-repo; `findActiveByRepo` matches by host/owner prefix, exact-repo match preferred; the AI allowance is shared org-wide. Scan every push — **LIVE** (Craig green-light 2026-06-12). Stripe subscription checkout (mode=subscription, inline recurring price_data — no dashboard product needed). Unlimited deterministic scans (near-zero marginal cost); AI reviews metered by `continuous_ai_ledger` monthly allowance (default $10/mo, env `CONTINUOUS_AI_BUDGET_USD`). Fix PRs NOT included — per-scan upsell. Store: `website/app/lib/continuous-subscription-store.js` (19 tests). Lifecycle synced via `customer.subscription.updated/deleted` webhooks. |
| MCP | $29/mo | **REPOSITIONED (Craig-authorized 2026-07-23, closes KI #39): the LOCAL stdio MCP server is now 100% free — `GATED_TOOLS` in `bin/gatetest-mcp.mjs` is empty; every tool runs on the user's own machine/keys (principle: free where it runs on your machine, paid where it runs on ours).** The $29/mo tier now sells the HOSTED remote MCP endpoint (claude.ai web/mobile, locked-down machines; `mcp-remote-core.cjs` keeps its gate) + hosted scan history, behind `GATETEST_API_KEY` (`gtmcp_` prefix, 70 chars), delivered by email after Stripe checkout — **LIVE** (Craig-authorized 2026-07-04). Free without a key: `check_health`, `list_modules`, `get_badge`, `scan_url`, `scan_repo`, `scan_local` (quick suite). `scan_repo` was fixed onto this list 2026-07-20 — it was already documented as free in the tool's own description/quick-start prompt, but `GATED_TOOLS` in `bin/gatetest-mcp.mjs` charged for it anyway; the code now matches. Store: `website/app/lib/mcp-subscription-store.js`. |
| Enterprise | Contact | **Contact-based (Craig 2026-07-23)** — no fixed price, no Stripe tier; negotiated per deal (custom scan volume, raised AI-review budget, priority support, invoicing). Pricing-page card links mailto:hello@gatetest.ai. |

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
1. Run ALL tests — `node scripts/run-tests.js --timeout 60000 tests/*.test.js` (fast) + `node scripts/run-tests.js --timeout 120000 tests/heavy/*.test.js` (heavy)
2. Build website — `cd website && npx next build`
3. Verify all modules load — `node bin/gatetest.js --list`
4. Update Known Issues in `docs/ROADMAP.md` if anything found (resolved ones move to `docs/HISTORY.md`); update `docs/THE-FIFTY.md` status for any move that landed
5. Commit and push everything; open the PR as a draft, drive it green, merge it, restart the branch from `main` — a branch left unmerged is work the customer cannot use
6. Leave the codebase in a WORKING state
7. If a principle in `docs/DOCTRINE.md` was proven or disproven this session, change it there and say why

### MCP Debug Protocol — MANDATORY
When debugging ANY issue in this repo or any customer repo via GateTest MCP:
1. **ALWAYS run `scan_local` FIRST** — never manually inspect files for bugs before scanning. The 121-module engine finds in seconds what manual inspection takes minutes to locate.
2. **ALWAYS run `run_tests` after editing** — never assume a fix worked without verification.
3. **ALWAYS call `get_production_errors` before deciding what to fix** on live customer issues.
4. **Full debug loop:** `scan_local` → `explain_finding` → `fix_issue` → `run_tests` → `verify_fix`
5. **Never bypass GateTest** to "just look at the code." The 121-module engine finds what manual inspection misses.

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

GateTest v1.61.0 — **121 modules** (spineHealth added 2026-07-30), **hybrid AI layer** (Craig 2026-07-07;
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
flywheel — anonymized module+count signal, and since 2026-09-05 per-rule
`fired` / `silenced` counts (rule IDS only, `src/core/rule-identity.js`), to
`~/.gatetest/telemetry/scan-findings.jsonl` + best-effort upload to
`POST /api/telemetry/scan` (opt-out: `GATETEST_NO_TELEMETRY=1` or `.gatetest.json
{telemetry:false}`; NEVER code/paths/findings/repo names). The silenced rate is
published rule by rule at `/noise` (the Fifty, move 07). **False-positive
control:** repo-root `.gatetestignore` suppresses findings (`module:rule` | `module`
| `*:rule` | `module:rule@glob` | `path/**`); `gatetest --noise` shows noisy modules;
chronically-dismissed high-fire modules auto-soften below the block threshold. See
`src/core/{scan-telemetry,telemetry-uploader,ignore-file,noise-model}.js`.
**v1.60.0 (2026-07-25):** authenticated crawls — `--crawl-header` /
`--crawl-cookie` / `--crawl-storage-state` (+ hosted `/api/web/scan` auth,
same-origin-gated engine-side); self-serve Stripe billing portal
(gatetest.io/billing); npm publishing via OIDC trusted publishing (token-free).
Date stamp last fully reconciled: 2026-07-11 (core-engine program: every-scan
flywheel + false-positive control + entry-level CLI recap).

### v1.61.0 (2026-07-30) — spineHealth: structural analysis, module #121

**The first module that asks what it COSTS TO CHANGE the codebase**, rather than
whether a line is wrong. Every other module scans files; this one analyses the
dependency graph, where cost of change actually lives. A file can be clean by
every lint rule and still be the most dangerous file in the repo because 230
files transitively depend on it.

Reports (all **warning** severity, deliberately — these are refactor-scale
observations and blocking a build on "your fan-in distribution got worse" would
make us the bottleneck, Forbidden #25; runtime cycles stay in `importCycle`
where they block):
- `fragile-spine` — load-bearing AND untested/oversized/high-fan-out
- `layering-violation` — an import against the direction dependencies
  demonstrably flow between two directories, with the grain **inferred from the
  codebase** so it needs no config and cannot go stale
- `god-file` — high fan-in AND high fan-out; cannot be moved
- `unstable-dependency` — a widely-depended-on module importing a volatile one
  (Martin's Stable Dependencies Principle)
- `coupling-trend` — **the flywheel**: delta vs the last scan of this repo, from
  `.gatetest/memory.json`, behind the same consent gate as all telemetry. A
  coupling index of 0.83 means nothing in isolation; the direction of travel is
  what a team can act on.

New shared core: **`src/core/import-graph.js`** (one definition of "what depends
on what" — extracted from `import-cycle.js`, which had it private; verified
byte-identical on 1191 files / 930 static edges before the swap) and
**`src/core/spine-metrics.js`** (pure maths, no fs, so it can be tested against
hand-built graphs with known answers). The extraction also surfaced **199
coupling edges the engine previously could not see** — 179 lazy `require`s and
20 type-only imports, which do not form cycles but are absolutely still coupling.

**Thresholds are calibrated per repo, never hardcoded** — percentiles over
files that *participate* (non-zero degree), with absolute floors, nothing below
20 source files. Three false positives were found by measurement and fixed
before shipping: test files inflating fan-in (an entrypoint imported by its own
8 tests was called a god file), percentiles over all files putting p90 at 2, and
the "untested" signal firing whenever `tests/` was outside the scan scope.
Tests include **negative controls** that plant a real god file / layering
violation and assert the rules fire — without them, tightening thresholds until
the repo goes quiet is indistinguishable from the rule working.

**The website was synced in the same pass** — 231 count claims across 104 files
(comparison pages, blog, glossary, quickstart, MCP tools, PR footers, OG images,
package descriptions, the Marketplace listing, editor extensions). I had first
deferred this as brand/marketing copy under Boss Rule #8; Craig ruled otherwise
the same day — see **THE WEBSITE-SYNC RULE** below. `tests/module-count-sync.test.js`
now enforces it, so the next module cannot ship with the site selling the old
number.

**Not swept:** `website/app/scans/page.tsx` labels dated scan results
("Full suite · 120-module engine", 2026-07-12, 137 errors). Those runs really
were on 120 modules; rewriting the label falsifies evidence instead of updating
a claim.

### v1.61.2 (2026-09-05) — current truth

- **The gate enforces for customers.** `integrations/github-actions/gatetest-gate.yml` and `action.yml` block on PRs (`--diff` / `--pr` scope) and on full runs against `.gatetest/baseline.json`; `--report-only` is forbidden on the gate by `tests/integrations.test.js`. Before 2026-09-04 every customer ran advisory.
- **Precision is measured on twenty third-party repositories — all eight advertised languages and four monorepos** (`reliability-corpus/real-world.json`; ceilings after the 2026-09-05 passes: express 0, flask 2, fastify 3, got 14, hono 23, zod 5, django 60, rails 41, spring-petclinic 8, gin 2, axum 5, laravel 4, CleanArchitecture 11, ktor 7, vapor 0, nest 9, trpc 7, apollo-server 0, prisma 13; NodeGoat floor 40, measured 57 — hono / trpc / prisma ratcheted down when importCycle learned type-only elision: every cycle it had blocked on was deferred or type-only). The monorepos were first-contact 39 / 33 / 4 / 90 — every drop was a scanner defect with the line that exposed it, and every ceiling drop since is diffed engine-against-engine on a fresh clone before it is accepted. CI job "real repos must not be blocked"; rendered at `/precision` from `website/app/data/precision.json`, regenerated nightly.
- **Diff scans report only the diff** (runner-level `_scopeResultToChangedFiles`), one file walk for 36 modules, quick `--diff` on a PR ≈ 8s; full self-scan ≈ 65s with mutation deferred to `mutation-nightly.yml`.
- **Every JSON report carries provenance and a signature** (`src/core/report-provenance.js`, `GATETEST_REPORT_SIGNING_KEY`, `gatetest verify-report`). SARIF reports the level the gate used. A CI job asserts same tree → same findings. **`gatetest --compliance` writes the compliance evidence pack** (OWASP / SOC 2 / CIS control by control, three-state, signed the same way; `src/core/compliance-evidence.js`); the mapping table lives in `src/core/compliance-mappings.js` and the website + SARIF import it.
- **Hosted PR comments** attribute findings by line (`inDiff` / `inChangedFile`), say what was not checked, and carry the exact `@gatetest ignore …` reply per finding. The CLI prints the exact `.gatetestignore` line and, in CI, the `gatetest replay` command under a blocked gate.
- **The test suite is run by `scripts/run-tests.js` (2026-09-05).** One plain `node --test` per file, ended after its summary is read; a file that ends without a summary, reports zero tests, fails or is cancelled (its event loop never drained — a leaked timer, socket or child) fails the suite, and the total says how many files did not finish. The `node --test --test-force-exit` form it replaces exited before every file had reported and counted only what had finished (the same tree: 50, 77, 61 tests on three runs, exit 0 each) — every green suite between `180bf7c` and this fix was evidence about the tests that finished first. `npm test`, CI, publish, the nightly dogfood sweep and the site-stats generator all call the runner; `tests/run-tests.test.js` is its control pair.
- **KI #106 closed (2026-09-05):** no module decides "nothing to check" from a framework marker its rules do not need — 15 of 15 fixed, three new one-definition homes (`src/core/workspaces.js`, `migration-dirs.js`, `shell-files.js`), corpus 20/20 at ceilings. **Open, measured:** KI #105 — stale Code Scanning categories need an API delete; KI #107 — prSize on the Dogfood job's depth-1 checkout.

The narratives for 2026-09-04/05 (how each number was reached, which fixes regressed and were caught) live in `docs/HISTORY.md` under "VERSION CHANGELOGS".

### THE DOMAIN — gatetest.io (moved 2026-07-30)

**The canonical domain is `gatetest.io`. It was `gatetest.ai`.** Craig decided to
keep the GateTest name and move the TLD (`baretest.ai` was considered and
rejected on the merits — do not re-open it). The move became urgent rather than
cosmetic when `gatetest.ai` entered **registry redemption on 2026-07-29** and
started returning NXDOMAIN; see Known Issue #93 in `docs/ROADMAP.md`.

**Never write a `gatetest.io` literal in runtime code.** The domain is ONE
environment variable, resolved in two places:

| File | Used by |
|---|---|
| `website/app/lib/site-url.js` | the Next app (reads `NEXT_PUBLIC_BASE_URL` as a static member expression so it inlines into client bundles) |
| `src/core/site-url.js` | the engine, CLI, MCP server, reporters (standalone — the npm package ships `src/` + `bin/` without `website/`) |

Precedence: `NEXT_PUBLIC_BASE_URL` → `GATETEST_PUBLIC_BASE_URL` → default.
`tests/site-url.test.js` fails the suite if the two copies drift, or if a
literal reappears in a guarded file. Import `siteUrl()` / `badgeUrl()` /
`botUserAgent()` / `apiBaseUrl()` / `FIXTURE_EMAIL` instead.

**E-mail moved to `gatetest.io` on 2026-09-11 (Craig verified the domain in
Resend and confirmed MX receiving into real mailboxes).** The mailboxes that
exist are **`admin@`, `support@`, `billing@`** — there is no `hello@`. The
site's contact address is `support@gatetest.io` (`SUPPORT_EMAIL` default in
both `site-url.js` copies; `tests/site-url.test.js` now forbids the `.ai`
domain and any mailbox that does not exist), and Resend sends from
`watchdog@gatetest.io` (`DEFAULT_FROM` in `digest-mailer.js`; `RESEND_FROM`
overrides). `gatetest.ai` is NXDOMAIN, so any address there bounces — never
reintroduce one.

**One thing deliberately did NOT move. Do not "fix" it without reading why:**

1. **Historical records were not rewritten** — `docs/HISTORY.md`, `docs/proofs/`,
   `docs/benchmarks/`, captured scan reports, and dated code comments still say
   `gatetest.ai` because that is what was true when they were written. Editing
   them would falsify evidence, not migrate a domain.

**The old domain must keep serving or 301'ing indefinitely**, because badge
markdown pasted into customers' READMEs is a URL we can never edit. Retiring
`.ai` turns every customer's build status into a broken image, and if it reaches
pendingDelete someone else can serve images inside our customers' repos.

**Full version-by-version changelog:** see `docs/HISTORY.md`.
