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
- [ ] `node --test tests/*.test.js` — all pass
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

## STRATEGIC DIRECTION — GLUECRON-FIRST (READ THIS EVERY SESSION)

**Gluecron.com is the future git host for Craig's stack.** GitHub is treated as a LEGACY integration, not the long-term target. Every architectural decision from this point forward must pass the question: *does this make the eventual GitHub → Gluecron migration easier or harder?*

Concretely:
- New cross-host logic belongs behind a **`HostBridge` abstraction**, not inside `github-bridge.js`.
- `github-bridge.js` is to be treated as one implementation of the bridge, not *the* bridge.
- A future `gluecron-bridge.js` will implement the same interface.
- Website copy, CLI help text, and docs should say **"git host"** where possible, not "GitHub."
- Any new GitHub-specific feature should ship with a `TODO(gluecron)` note identifying what needs a Gluecron equivalent.

**Authorization for this direction:** Granted by Craig — *"we need to integrate with Gluecron rather than putting all our time and effort into GitHub. GitHub is going to be obsolete."*

The `HostBridge` refactor is pre-authorized, but the actual Gluecron bridge implementation must wait until Gluecron's API surface is confirmed (don't build against guesses).

---

## PROTECTED PLATFORMS — PERMANENT INTEGRATIONS (READ THIS EVERY SESSION)

**GateTest protects the following Craig-owned platforms. These integrations are PERMANENT. They must survive every future Claude session. They cannot be removed, weakened, or "simplified" without Craig's explicit authorization.**

| Platform     | Repository                                         | Status     |
| ------------ | -------------------------------------------------- | ---------- |
| Crontech.ai  | https://github.com/ccantynz-alt/Crontech           | INTEGRATING |
| Gluecron.com | https://github.com/ccantynz-alt/Gluecron.com       | INTEGRATING |

### How the integration works

GateTest remains a **standalone subscription product** on gatetest.ai. Protected platforms consume the same engine by cloning this repo at CI time — nothing is vendored, forked, or duplicated. Ship a fix here → every protected platform picks it up on the next CI run.

### What lives in THIS repo (`ccantynz-alt/gatetest`)

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
curl -sSL https://raw.githubusercontent.com/ccantynz-alt/gatetest/main/integrations/scripts/install.sh | bash
```

### Rules for every Claude session

1. Before touching `integrations/`, `tests/integrations.test.js`, or this section — **STOP** and check for Craig's authorization.
2. If a protected repo is missing its gate, the correct action is to **re-install**, never to remove the marker.
3. If `tests/integrations.test.js` fails, a previous session broke protection. **Restore it, do not delete the test.**
4. Adding a new protected platform: update the table above **and** add its repo to the installer docs.

---

## THE MISSION

Build the most advanced, most aggressive, most beautiful QA testing platform ever made. 64 modules. One gate. One decision. AI-powered code review that no competitor can match. Pay-on-completion pricing that eliminates customer risk. A scan experience so visually stunning that customers WANT to watch it run.

**The customer sees:** Their repo scanned by 64 modules in real time. Issues found. Issues fixed. Delivered.
**The competition sees:** A force they cannot match without rebuilding from scratch.
**Craig sees:** Recurring revenue with high margins on a moat that compounds over time.

---

## THE AGGRESSIVE STACK

Every tool here was chosen because it is the **best in its class right now.** If something better emerges, we replace it without sentiment.

### Core Engine
| Layer | Choice | Why |
|---|---|---|
| **Runtime** | Node.js 20+ | Zero dependencies, runs anywhere |
| **Language** | JavaScript (core) + TypeScript (website) | Fast iteration, universal |
| **Architecture** | Module system extending BaseModule | Every check is a self-contained module |
| **Runner** | EventEmitter-based with severity levels | error/warning/info, parallel execution, auto-fix |
| **Reporters** | 5 formats (Console, JSON, HTML, SARIF, JUnit) | Covers every CI/CD system |

### Website & Frontend
| Layer | Choice | Why |
|---|---|---|
| **Framework** | Next.js 16 (App Router) | Latest, fastest, Vercel-native |
| **Styling** | Tailwind CSS 4 | Utility-first, dark theme, zero unused CSS |
| **Hosting** | Vercel | Auto-deploy from main, serverless |
| **Domain** | gatetest.ai | Secured |

### Payments
| Layer | Choice | Why |
|---|---|---|
| **Billing** | Stripe | Hold-then-charge via Payment Intents with manual capture |
| **Model** | Pay on completion | Customer only charged after scan delivers |

### AI Layer
| Layer | Choice | Why |
|---|---|---|
| **AI Code Review** | Claude API (Anthropic) | Best reasoning, finds real bugs not patterns |
| **Model** | claude-sonnet-4-20250514 | Fast, accurate, cost-effective |

### GitHub Integration
| Layer | Choice | Why |
|---|---|---|
| **GitHub App** | GateTestHQ | Auto-scan on push/PR, commit statuses, PR comments |
| **Auth** | JWT (RS256) from .pem private key | Standard GitHub App auth |
| **Access** | Resilient bridge with retry, circuit breaker, multi-strategy | Never fails on 503 |

---

## THE AGGRESSIVE ARCHITECTURE

### Scan Flow (Direct — No Webhooks)
```
Customer pays → Redirect to /scan/status → Page calls /api/scan/run →
Scan reads repo via GitHub API → Runs all module checks → Returns result →
Updates Stripe metadata → Captures payment → Customer sees results
```
**ONE call. ONE response. No polling. No webhooks. No shared state.**

### GitHub App Flow
```
Developer pushes code → GitHub sends webhook → /api/webhook receives →
JWT auth → Read repo via API → Run checks → Post commit status + PR comment
```

### Module Architecture
```
BaseModule (abstract)
  └── Every module extends this
  └── run(result, config) → adds checks with severity
  └── Registered in src/core/registry.js
  └── Added to suites in src/core/config.js
```

### Serverless Rules (Vercel)
- **NO in-memory state between requests** — every function is stateless
- **NO long-running async after response** — Vercel kills the function
- **NO shared memory between function instances** — use external storage
- **ALL scan work completes WITHIN the function response**
- **Stripe metadata is the persistence layer** for scan results

---

## THE QUALITY BAR — ZERO TOLERANCE

### 1. Tests & Build

- [ ] All 200+ tests pass (`node --test tests/*.test.js`)
- [ ] Website builds clean (`cd website && npx next build`)
- [ ] All 64 modules load (`node bin/gatetest.js --list`)
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
- [ ] Hold-then-charge working (manual capture)
- [ ] Session metadata includes repo_url and tier
- [ ] Scan completes and captures payment
- [ ] Failed scans cancel payment (release hold)

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
- [ ] All 64 modules listed in README and CLI help

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
9. **Never patch symptoms.** Find and fix the root cause.
10. **Never make chicken scratchings.** Go big or go home.
11. **Never deploy to production without Craig's authorization.**
12. **Never modify Stripe configuration without Craig's authorization.**
13. **Never add a dependency not in the approved stack without authorization.**
14. **Never delete user data without explicit user action.**
15. **Never let an error bubble unhandled to the user.** Wrap, log, recover.
16. **Never silently fail.** Errors are visible.
17. **Never ship a feature without updating this file.**
18. **Never approve something you didn't test end-to-end.**
19. **Never build an 80s website.** We are AI builders. The output must be stunning.
20. **Never ask Craig "do you want me to fix this?"** If it's broken, FIX IT.
21. **Never delete, rename, or weaken `integrations/`** — that directory protects Crontech and Gluecron. See **PROTECTED PLATFORMS**.
22. **Never delete or weaken `tests/integrations.test.js`** — it is the tripwire that keeps protection intact across sessions.
23. **Never remove the PROTECTED PLATFORMS section from this file.** It must be read at every session start.
24. **Never soft-fail the gate** with `continue-on-error: true` on the GateTest step itself.

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

1. `node --test tests/*.test.js` — ALL pass
2. `cd website && npx next build` — ZERO errors
3. `node bin/gatetest.js --list` — all 64 modules load
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

## COMPETITIVE POSITION

### We replace 10+ tools with ONE:
| They use | GateTest replaces it with |
|----------|--------------------------|
| Jest/Vitest/Mocha | `gatetest --module unitTests` |
| Playwright/Cypress | `gatetest --module e2e` |
| ESLint/Stylelint | `gatetest --module lint` |
| Snyk/npm audit | `gatetest --module security` |
| Renovate/Dependabot (hygiene only) | `gatetest --module dependencies` |
| hadolint / dockle / docker bench | `gatetest --module dockerfile` |
| actionlint / StepSecurity / zizmor | `gatetest --module ciSecurity` |
| shellcheck / bashate / shfmt | `gatetest --module shell` |
| squawk / gh-ost safety checks / pg-osc / Strong Migrations | `gatetest --module sqlMigrations` |
| tfsec / Checkov / Terrascan / KICS | `gatetest --module terraform` |
| kube-score / kubeaudit / Polaris / Kubesec | `gatetest --module kubernetes` |
| Promptfoo / LLM Guard / Lakera / Rebuff | `gatetest --module promptSafety` |
| ts-prune / knip / unimport / Vulture (Python) | `gatetest --module deadCode` |
| gitleaks (age analysis) / secretlint / dotenv-linter | `gatetest --module secretRotation` |
| securityheaders.com / Mozilla Observatory / helmet | `gatetest --module webHeaders` |
| type-coverage / `@typescript-eslint/no-explicit-any` / `tsc --noEmit` strictness audits | `gatetest --module typescriptStrictness` |
| eslint-plugin-jest-no-focused-tests / eslint-plugin-jest-no-disabled-tests / flaky-test retry plugins | `gatetest --module flakyTests` |
| eslint `no-empty` / `no-floating-promises` / `handle-callback-err` (fragmented across ESLint rules) | `gatetest --module errorSwallow` |
| New Relic / Datadog runtime N+1 profiling + prisma-lint-find-many (per-ORM, one-at-a-time) | `gatetest --module nPlusOne` |
| (no direct equivalent — nobody statically scans for retry-backoff / retry-jitter / unbounded retry loops) | `gatetest --module retryHygiene` |
| (no direct equivalent — SonarQube has 2 Java-specific concurrency rules, nobody scans JS/TS) | `gatetest --module raceCondition` |
| (no direct equivalent — runtime profilers only catch leaks after the process falls over) | `gatetest --module resourceLeak` |
| Semgrep (narrow per-language rules) / Snyk (function-signature flags only) / SonarQube (one Java rule) | `gatetest --module ssrf` |
| (no unified tool — SonarQube has a 127.0.0.1-only rule; ESLint has no rule; Semgrep has narrow localhost patterns) | `gatetest --module hardcodedUrl` |
| (no unified tool — `dotenv-linter` checks only `.env` syntax; `@dotenvx/dotenvx diff` compares two `.env` files; nothing cross-references `.env.example` with actual `process.env` / `os.environ` / `os.Getenv` reads in source) | `gatetest --module envVars` |
| (nothing unifies it — ESLint `no-async-promise-executor` catches only `new Promise(async ...)`, `@typescript-eslint/no-misused-promises` is opt-in / narrow / skips `.reduce`, SonarQube covers `forEach` only) | `gatetest --module asyncIteration` |
| (fragmented — Semgrep has one bidi rule, SonarQube has one bidi rule, ESLint has none; GitHub warns in diff view only; nothing unifies bidi + mixed-script identifiers + zero-width + control chars) | `gatetest --module homoglyph` |
| (no unified tool — `openapi-cli lint` only validates spec syntax, `dredd` is runtime contract tests not static drift, `schemathesis` is fuzzing; nothing statically cross-references `openapi.yaml` against Express / Fastify / Next.js App Router routes) | `gatetest --module openapiDrift` |
| Danger.js (needs a Dangerfile + CI config per repo) / GitHub's built-in "diff too large" warning (UI-only, no gate) | `gatetest --module prSize` |
| `safe-regex` (unmaintained since 2021, high FP rate) / ESLint `no-misleading-character-class` (narrow subset only) / `recheck` (accurate but opt-in CI setup) / SonarQube (one rule only) | `gatetest --module redos` |
| crontab.guru (web-only, not a linter) / actionlint (syntax only, no impossible-date semantics) / node-cron runtime errors (if you're lucky) — nothing unifies validation across GitHub Actions + k8s CronJob + Vercel + source code | `gatetest --module cronExpression` |
| (no unified tool — ESLint has nothing on naive datetimes; `pylint`/`ruff` flag `datetime.utcnow` in Py 3.12+ but don't cross-reference `datetime.now()` missing tz; `moment-deprecation-handler` is a runtime shim; SonarQube has one Java-only rule on `java.util.Date`; nothing unifies Python naive-datetime + JS 0-vs-1 month + moment legacy at the gate) | `gatetest --module datetimeBug` |
| `madge --circular` (standalone CLI, separate install, no gate integration) / `eslint-plugin-import/no-cycle` (opt-in, slow, TS-alias-blind) / `dependency-cruiser` (heavy config) / `tsc` catches nothing — nothing gate-native for JS+TS import cycles with suppression markers | `gatetest --module importCycle` |
| SonarQube has one Java-only rule on `float`/`double` for money; ESLint / pylint / ruff have nothing; Semgrep has a handful of community rules with high FP — nothing unifies JS `parseFloat`/`Number` + Python `float()` + `.toFixed(0)`/`.toFixed(1)` on money-named variables with library-aware safe-harbour (decimal.js / big.js / dinero.js / Python `decimal`) at the gate | `gatetest --module moneyFloat` |
| ESLint has nothing on logger-PII; Pylint has nothing; Semgrep has a few community rules with high FP; SonarQube has one PHP-only rule on `var_dump`; Snyk Code catches some but requires their SaaS — nothing gate-native unifies `console.log`/`logger.info`/`log.debug`/`winston`/`pino`/`bunyan` with sensitive-identifier + object-dump + `JSON.stringify()` + template-string-interpolation detection across JS + Python | `gatetest --module logPii` |
| ESLint `no-constant-condition` (catches `if (true)` but not `!true` / `!false` idioms and misses flag-named const lies); SonarQube has a scattered "always true/false" family (JS only); LaunchDarkly's `ld-find-code-refs` catches *their* flag API specifically, no cross-vendor detection; Pylint / Ruff / Pyflakes have nothing on feature-flag hygiene — nothing gate-native unifies always-true-if + dead-branch + flag-named SCREAMING_SNAKE const + multi-line template-literal awareness across JS + Python | `gatetest --module featureFlag` |
| SonarQube `javascript:S4830` (JS `rejectUnauthorized: false` — misses `strictSSL: false` and env-bypass); Bandit catches Python `requests.verify=False` only (misses httpx / aiohttp / urllib3 PoolManager); Snyk Code catches subsets behind SaaS; ESLint has nothing cross-cutting — nothing gate-native unifies Node `rejectUnauthorized` + `NODE_TLS_REJECT_UNAUTHORIZED=0` env bypass + `strictSSL` + Python `verify=False` / `_create_unverified_context` / `check_hostname=False` / `CERT_NONE` / `disable_warnings` with `process.env.` prefix disambiguation and test-path downgrade | `gatetest --module tlsSecurity` |
| SonarQube `javascript:S2092` (JS `secure: false`) and `javascript:S3330` (JS `httpOnly: false`) — JS-only, misses Python framework configs entirely; Bandit has `hardcoded_password_string` (weak-secret adjacent) but nothing on `SESSION_COOKIE_*` flags; OWASP ZAP catches insecure cookies only at runtime against a deployed environment; ESLint / Pylint / Ruff have nothing — nothing gate-native unifies Express / Next `httpOnly:false` + `secure:false` + placeholder `secret:'changeme'` detection with Django / Flask `SESSION_COOKIE_SECURE`/`_HTTPONLY = False` + FastAPI / Starlette `httponly=False` kwarg detection at the gate | `gatetest --module cookieSecurity` |
| Lighthouse | `gatetest --module performance` |
| axe/pa11y | `gatetest --module accessibility` |
| Percy/Chromatic | `gatetest --module visual` |
| SonarQube | `gatetest --module codeQuality` |
| git-secrets/truffleHog | `gatetest --module secrets` |
| broken-link-checker | `gatetest --module links` |

Plus 12 more modules they don't have: AI code review, **fake-fix detector (catches AI chicken-scratching symptom patches)**, mutation testing, chaos testing, autonomous exploration, live crawling, data integrity, documentation validation, compatibility analysis, integration test detection, CI generation, and SARIF output.

### Revenue model: Pay on completion
| Tier | Price | Modules |
|------|-------|---------|
| Quick Scan | $29 | 4 modules |
| Full Scan | $99 | All 64 modules |
| Scan + Fix | $199 | 64 modules + auto-fix PR |
| Nuclear | $399 | Everything + mutation + crawl + chaos |
| Continuous | $49/mo | Scan every push |

---

## PROJECT ARCHITECTURE (BUILT — DO NOT RECREATE)

```
GateTest/
├── CLAUDE.md               ← THIS FILE — THE BIBLE
├── MARKETING.md            ← Positioning, pricing, website copy
├── package.json            ← CLI tool (name: gatetest, bin: gatetest)
├── bin/gatetest.js         ← CLI entry point (20+ flags)
├── bin/gatetest-mcp.js     ← MCP stdio server entry point (Claude Code / Cursor / Cline / Windsurf)
├── src/
│   ├── index.js            ← Main library entry
│   ├── core/               ← Config, runner, registry, cache, CI gen, GitHub bridge
│   ├── mcp/                ← Model Context Protocol stdio server (zero-dep, JSON-RPC 2.0, protocol 2024-11-05)
│   ├── modules/            ← 67 TEST MODULES (see VERSION section for the full breakdown)
│   ├── reporters/          ← Console, JSON, HTML, SARIF, JUnit
│   ├── scanners/           ← Continuous scanner
│   └── hooks/              ← Pre-commit, pre-push
├── tests/                  ← 200+ tests (MUST ALL PASS)
└── website/                ← gatetest.ai (Next.js 16 + Tailwind 4)
    └── app/
        ├── page.tsx                 ← Main page
        ├── layout.tsx               ← Root layout
        ├── globals.css              ← Dark theme, animations
        ├── api/checkout/            ← Stripe checkout
        ├── api/scan/run/            ← Direct scan execution
        ├── api/scan/status/         ← Scan status reader
        ├── api/stripe-webhook/      ← Stripe webhook (backup)
        ├── api/webhook/             ← GitHub App webhook
        ├── api/github/callback/     ← GitHub App install callback
        ├── scan/status/             ← Live scan page
        ├── checkout/success/        ← Post-checkout redirect
        ├── checkout/cancel/         ← Checkout cancelled
        ├── github/setup/            ← GitHub App install page
        ├── github/installed/        ← Post-install success
        ├── legal/terms/             ← Terms of Service
        ├── legal/privacy/           ← Privacy Policy
        ├── legal/refunds/           ← Refund Policy
        └── components/              ← 13 React components
```

---

## KEY FILES — READ BEFORE MODIFYING

| File | What it controls | Read before... |
|------|-----------------|---------------|
| `MARKETING.md` | All marketing copy, pricing | Any website change |
| `src/index.js` | All public exports, reporter wiring | Adding exports |
| `src/core/runner.js` | Severity, auto-fix, diff-mode, gate | Changing how checks work |
| `src/core/config.js` | Thresholds, suite definitions | Changing what modules run |
| `src/core/registry.js` | Module registration | Adding new modules |
| `src/core/memory.js` | Persistent codebase memory — the compounding moat | Changing memory schema or persistence |
| `src/modules/memory.js` | Surfaces memory, runs FIRST, enriches `config._memory` | Before any module that consumes memory |
| `src/modules/agentic.js` | AI agent that investigates memory-informed hypotheses | Changing agentic prompts / flow |
| `src/core/universal-checker.js` | Pattern engine + `LANGUAGE_SPECS` for Python/Go/Rust/Java/Ruby/PHP/C#/Kotlin/Swift | Adding language support, changing detection patterns |
| `src/modules/dependencies.js` | Polyglot dependency hygiene scanner — npm/pip/Pipenv/Poetry/go.mod/Cargo/Bundler/Composer/Maven/Gradle. Flags wildcards, `latest` pins, deprecated packages, missing lockfiles, git-without-rev. Zero network calls | Adding a new ecosystem or deprecation entry |
| `src/modules/dockerfile.js` | Dockerfile security + hygiene scanner — root user, :latest tags, curl\|sh, apt hygiene, pip cache, chmod 777, ADD URLs, secrets baked into layers | Adding a new Dockerfile pattern or hardening rule |
| `src/modules/ci-security.js` | CI workflow security — GH Actions pinning (SHA > tag > branch), pwn-request, shell injection via `${{ github.event.* }}`, secret-echo, missing `permissions:`, Bible-forbidden soft-fail of the gate | Adding a new CI/CD platform or hardening rule |
| `src/modules/shell.js` | Shell script hardening scanner — curl\|sh, unsafe `rm -rf $VAR`, `eval` injection, hardcoded secrets, missing `set -euo pipefail`, `#!/bin/sh` using bashisms, backtick command substitution | Adding a new shell-script rule or ecosystem |
| `src/modules/sql-migrations.js` | SQL migration safety — DROP COLUMN/TABLE, ADD COLUMN NOT NULL w/o default, SET NOT NULL, CREATE/DROP INDEX without CONCURRENTLY, CONCURRENTLY inside BEGIN, RENAME during rolling deploy, ALTER TYPE rewrites, ADD CONSTRAINT w/o NOT VALID, TRUNCATE | Adding a new migration-ecosystem hook or unsafe-pattern rule |
| `src/modules/terraform.js` | Terraform / IaC security — public S3 ACL, 0.0.0.0/0 on SSH/RDP/DB ports, RDS/EBS/EFS unencrypted, IAM Principal="*" wildcards, hardcoded AWS keys, user_data `curl\|sh`, long-lived IAM users, missing cost-allocation tags | Adding new AWS/GCP/Azure resource rules or a Pulumi/CDK backend |
| `src/modules/kubernetes.js` | Kubernetes manifest security + reliability — privileged, hostNetwork/PID/IPC, allowPrivilegeEscalation, runAsUser:0, :latest images, docker.sock mount, dangerous capabilities, LoadBalancer open to world, inline secrets in env, missing resources.limits, missing readiness/liveness probes | Adding new K8s resource kinds or Pod Security Standards rules |
| `src/modules/prompt-safety.js` | Prompt / LLM safety — browser-bundled `NEXT_PUBLIC_*_API_KEY` / `VITE_*_SECRET`, openai/anthropic calls with no `max_tokens` (cost DoS), prompt templates interpolating user input without a delimiter (injection surface), deprecated models (claude-v1, claude-2.0, text-davinci-*, palm-2), `temperature >= 1.5` | Adding new AI SDKs or prompt-injection heuristics |
| `src/modules/dead-code.js` | Dead code — unused JS/TS/Python exports, orphaned files (nothing imports them), 10+ line commented-out code blocks; respects Next.js route conventions (page/layout/route, robots, sitemap, opengraph-image) and segment config (`dynamic`, `revalidate`, `runtime`, `maxDuration`) | Adding entry-point conventions or framework-reserved export names |
| `src/modules/secret-rotation.js` | Secret rotation — credential-shaped strings dated via `git log --format=%at` (error > 90 days, warning > 30 days), `.env` ↔ `.env.example` drift, placeholder values in `.env.example` that still match a real credential shape. Detects AKIA/ASIA, GitHub PAT/OAuth/server/fine-grained, Stripe live/restricted, Slack, Google, Anthropic, private keys, JWTs | Adding credential shapes or rotation windows |
| `src/modules/web-headers.js` | Web headers + CORS — reads next.config.{js,mjs,ts}, vercel.json, netlify.toml, _headers, nginx.conf, and Express/Fastify source. Flags CSP `unsafe-eval` (error) / `unsafe-inline` (warning), wildcard CORS origin + credentials:true (error), HSTS max-age below 180 days, missing CSP / HSTS / X-Frame-Options (or CSP frame-ancestors) / X-Content-Type-Options | Adding server-side header APIs or deploy targets |
| `src/modules/typescript-strictness.js` | TypeScript strictness — walks `tsconfig.json` / `tsconfig.*.json` (JSONC-aware, string-safe comment stripper), flags `strict: false` (error), `noImplicitAny: false` (error), `skipLibCheck: true` / `strictNullChecks: false` / `strictFunctionTypes: false` (warning); scans `.ts`/`.tsx`/`.mts`/`.cts` sources for `@ts-nocheck` (error), unreasoned `@ts-ignore` / `@ts-expect-error` (warning), exported signatures with `: any`, and `as any` casts. `*.test.ts`/`*.spec.ts` and `*.d.ts` are allowed to use `any`; `tsconfig.test.json` is allowed to relax strictness | Adding new suppression directives or tsconfig flags |
| `src/modules/flaky-tests.js` | Flaky-test detector — scans `*.test.*` / `*.spec.*` and files under `tests/`, `__tests__/`, `spec/`. Flags committed `.only` / `fit` / `fdescribe` (error), `.skip` / `xit` / `xtest` (warning, string-aware so diff-fixtures don't false-positive), `.todo` with no issue link (info), `Math.random()` (warning), `Date.now()` / `new Date()` with no `useFakeTimers` in the file (warning), real `fetch`/`axios`/`http.request` calls with no `nock`/`msw`/`vi.mock` (warning), `setTimeout`/`setInterval` without fake timers (warning), `process.env.X = ...` without a matching `afterEach` restore or `delete` (warning), test titles containing "flaky"/"intermittent"/"sometimes" (warning) | Adding new test-framework shapes or mock libraries |
| `src/modules/error-swallow.js` | Error-swallow detector — walks `.js`/`.jsx`/`.mjs`/`.cjs`/`.ts`/`.tsx`/`.mts`/`.cts`. Flags empty `catch {}` blocks (error / warning in tests), catch blocks that only `console.log`/`logger.error` without re-throwing or calling `next(err)` (error), `.catch(() => {})` / `.catch(() => null)` / `.catch(noop)` (error), `process.on('uncaughtException' | 'unhandledRejection')` handlers that neither re-throw nor `process.exit` (warning), Node-callback `(err, ...) => {}` whose body never references `err` (warning), fire-and-forget statement-level calls to promise-returning methods (`.save()`, `.commit()`, `.send()`, `.fetch()`, etc.) with no `await` / `.then(...)` / `.catch(...)` (warning, skipped in test files) | Adding new promise-returning method names or swallow patterns |
| `src/modules/n-plus-one.js` | N+1 query detector — ORM-agnostic, line-heuristic. Builds a loop-range map (string-aware brace + paren matching) for block-form `for`/`while`/`do` and callback-form `.map`/`.forEach`/`.filter`/`.reduce`/`.some`/`.every`/`.flatMap`. Inside each loop body, looks for `await` (or `.then(`) + a query-shaped call across Prisma (`prisma.<model>.find*/create/update/delete/upsert/count/aggregate/groupBy`, `$queryRaw`), Sequelize (`Model.findOne/findAll/findByPk/...`, `sequelize.query`), TypeORM (`.manager.save/find/...`, `getRepository`, `repo.findOne/findOneBy/...`), Mongoose (`Model.findOne/find/create/updateOne/...`), Knex (`knex(...)`, `db('t').where/select/first`), node-pg/MySQL (`client.query`, `pool.execute`, `db.query`), Drizzle (`db.select().from(...)`). Recognises `await Promise.all(arr.map(async () => ...))` as batched-ok and emits info instead of error | Adding new ORM shapes or loop openers |
| `src/modules/retry-hygiene.js` | Retry-hygiene scanner — finds retry-shaped loops (`while (...)` / `for (...)` bodies that contain an HTTP call or a literal sleep) across `fetch`/`axios`/`got`/`node-http`/`needle`/`superagent`. Flags `while (true)` / `for (;;)` without a `break` or max-attempts marker (error: unbounded-loop), literal `setTimeout`/`sleep`/`delay`/`new Promise(..setTimeout)` with no `attempt`-based multiplier (warning: no-backoff), literal sleeps with no `Math.random()`/`crypto.randomInt()` jitter (warning: no-jitter), retry blocks referencing 4xx status without a `throw`/`return`/`break` bail-out guard (warning: retry-on-4xx). Recognises `async-retry`/`p-retry`/`retry`/`cockatiel`/`opossum` as library-backed retry and emits info-level `library-ok` | Adding new HTTP clients, retry libraries, or sleep primitives |
| `src/modules/race-condition.js` | Race-condition / check-then-act detector — walks JS/TS sources looking for TOCTOU patterns: `fs.exists*`/`fs.stat`/`fs.access` followed within 15 lines by a destructive fs op (`unlink`/`rm`/`rename`/`chmod`/`chown`/`copyFile`/`truncate`) on the same path expression (error, warning inside test files); `fs.stat` followed by ANY mutating fs op (broader: symlink-race vector). Prisma/Sequelize/Mongoose/TypeORM `findFirst`/`findUnique`/`findOne` followed by `create`/`update`/`upsert`/`save`/`delete` on the same model with no visible `$transaction` / `FOR UPDATE` / `ON CONFLICT` / upsert / `P2002`/`23505`/`ER_DUP_ENTRY` handler (warning: get-or-create lost-update). Argument-matching on the first param of the mutate call avoids cross-function false-positives; idempotent `if (!exists) mkdirSync(.., { recursive: true })` setup is not flagged | Adding new TOCTOU shapes, ORM model surfaces, or tx markers |
| `src/modules/resource-leak.js` | Resource-leak detector — walks JS/TS and flags unclosed `fs.createReadStream`/`createWriteStream` (error), `fs.open`/`fs.promises.open` file handles (warning), `new WebSocket`/`EventSource`/`ReconnectingWebSocket`, `net.createConnection`/`createServer` (warning). setInterval: bare calls with discarded return value (error) and captured handles that are never `clearInterval(...)`-ed (warning). Recognises `stream.pipeline(x, ...)` / `stream.finished(x, ...)` as cleanup, plus escape paths through `return`/`module.exports`/`export`/property-assignment (`this.timers = ...`) and array push/set/add — so legitimate handle-storage patterns don't false-positive. Block-comment / JSDoc aware | Adding new resource-acquiring APIs or escape-path shapes |
| `src/modules/ssrf.js` | SSRF / URL-validation gap detector — tracks taint from `req.body`/`req.query`/`req.params`/`req.headers`/`ctx.request`/`event.body` to HTTP client calls (`fetch`/`axios`/`got`/`http.request`/`https.request`/`needle`/`superagent`/`request`/`undici`/`ky`). Flags: inline tainted URLs (error), tainted variables handed to the client without intermediate validation (error), hardcoded metadata-service endpoints (AWS 169.254.169.254, GCP metadata.google.internal, Azure metadata.azure.com, Alibaba 100.100.100.200) (error), suspicious-named variables (`webhookUrl`, `callbackUrl`, `redirectUrl`, `imageUrl`, `targetUrl`, etc.) with no visible validation (warning). Suppresses on `validateUrl`/`isValidUrl`/`allowedHosts.includes`/`new URL(x).hostname` guards. Records info-level `library-ok` for `ssrf-req-filter` / `request-filtering-agent` / `safe-url` / `ssrfcheck` imports | Adding new HTTP clients, taint sources, validators, or cloud metadata endpoints |
| `src/modules/hardcoded-url.js` | Hardcoded-URL / localhost / private-IP leak detector — walks JS/TS sources and flags string-embedded URLs pointing at `localhost`/`127.0.0.1`/`0.0.0.0` (error), RFC1918 ranges (10/8, 172.16/12, 192.168/16) (error), link-local 169.254/16 (error), internal TLDs (`.internal`/`.local`/`.lan`/`.corp`) and staging subdomains (`staging.`/`dev.`/`qa.`/`uat.`) (warning), non-TLS `http://` external URLs (warning). Suppresses on: test/e2e/stories/fixture paths (downgrades to info), files matching `playwright.config.*` / `vitest.config.*` / etc., URLs used as filter patterns (`.startsWith`/`.includes`/`.match`/`===`/`new RegExp`), the env-fallback pattern (`process.env.X \|\| "http://..."`), dev-context variable names (`DEV_URL`/`LOCAL_URL`), `NODE_ENV !== 'production'` guards on the current or preceding 3 lines, and doc-example URLs (example.com, etc.). Block-comment / line-comment aware | Adding new URL shapes, dev-guard patterns, or doc allowlist entries |
| `src/modules/env-vars.js` | Env-vars contract scanner — cross-references declared env vars (`.env.example`/`.env.*.example`/`vercel.json`/`netlify.toml`/`docker-compose*.yml`/`.github/workflows/*.yml`) against actual reads in JS/TS (`process.env.X` / `process.env["X"]`), Python (`os.environ["X"]` / `os.environ.get("X")` / `os.getenv("X")`) and Go (`os.Getenv("X")` / `os.LookupEnv("X")`). Flags: referenced-but-not-declared (error: `missing-from-example`), declared-but-unreferenced (warning: `unused-in-code`), `NEXT_PUBLIC_*` / `VITE_*` / `REACT_APP_*` client-bundled keys (info: `client-exposed`). Runtime-allowlisted keys (`NODE_ENV`, `PORT`, `CI`, `VERCEL_*`, `GITHUB_*`, `AWS_*`, `PATH`, etc.) never flag. Test paths, dev-config files (`playwright.config.*`/`vitest.config.*`/`jest.config.*`/`cypress.config.*`), JSDoc block comments, line comments, and Python `"""` docstrings are skipped | Adding new declaration sources, new language grammars, or runtime-allowlist entries |
| `src/modules/async-iteration.js` | Async-iteration detector — flags `.reduce(async ...)` / `.reduceRight(async ...)` (error: silent-serialisation + Promise accumulator), `.filter(async ...)` / `.some(async ...)` / `.every(async ...)` / `.find*(async ...)` (error: Promise-truthy predicate), `.forEach(async ...)` (warning: enclosing function returns before inner awaits), and `.map(async ...)` / `.flatMap(async ...)` not wrapped in `Promise.all` / `Promise.allSettled` / `Promise.any` / `Promise.race` and not chained with `.then`/`.catch`/`.finally` (warning: unwrapped-map). String, line-comment, and block-comment contexts are skipped; test-path hits downgrade error → warning; `// async-iteration-ok` on the same or preceding line suppresses. Paren-depth walk backwards from the call site detects whether `.map` is inside a Promise combinator argument, avoiding false-positives on `Promise.all(arr.map(...))` | Adding new iterator methods, Promise combinators, or suppression markers |
| `src/modules/openapi-drift.js` | OpenAPI ↔ code drift detector — walks `openapi.{yaml,yml,json}` / `swagger.*` / `api-spec/*` and builds a (method, path) set. Walks JS/TS source and harvests routes from Express/Connect (`app.get`/`router.post`/etc.), Fastify (`fastify.get` + `fastify.route({ method, url })` object form), Koa + koa-router, Hono, and Next.js App Router (`app/api/**/route.{ts,js}` with exported `GET`/`POST`/`PATCH`/`PUT`/`DELETE`/`OPTIONS`/`HEAD` functions). Normalises Express-style `:id` to OpenAPI-style `{id}` and fuzzy-matches `{id}` ~= `{userId}` so param-name differences don't false-positive. Flags: code route missing from spec (error: `undocumented-route`), spec path with no matching handler (warning: `spec-ghost-route`). Test paths are excluded from code-harvest. Module is a no-op when no spec file is present | Adding new framework route shapes, new spec file conventions, or new method forms |
| `src/modules/cron-expression.js` | Cron-expression validator — harvests cron strings from `.github/workflows/*.yml` (GitHub Actions `schedule: [{ cron: "..." }]`), Kubernetes `CronJob` `spec.schedule`, `vercel.json` `crons[].schedule`, and source-code call sites: node-cron `cron.schedule('...')`, croner `new Cron('...')`, node-schedule `schedule.scheduleJob('...')`, APScheduler `CronTrigger.from_crontab('...')` (Python), Spring `@Scheduled(cron = "...")` (Java/Kotlin). Validates: field count (5 standard / 6 with seconds / predefined alias — error), per-field value ranges (minute 0-59, hour 0-23, DoM 1-31, month 1-12/JAN-DEC, DoW 0-7/SUN-SAT — error), step/range/list syntax, Quartz extensions (L/W/#), and impossible dates (Feb 30/31, Apr/Jun/Sep/Nov 31 — error, silent-killer). Warns on `* * * * *` every-minute cron and typo aliases (`@weely`). Test paths downgrade error → warning. `# cron-ok` / `// cron-ok` suppresses | Adding new cron harvest sources (Temporal schedules, Celery beat, AWS EventBridge cron), extended syntax (`?`/`L`/`W`/`#`), or alias lists |
| `src/modules/datetime-bug.js` | Datetime / timezone bug detector — walks JS/TS and Python sources for the five classic clock bugs: Python `datetime.now()` with no `tz=` argument (error: naive datetime — CI and prod use different timezones), Python `datetime.utcnow()` (error: deprecated in 3.12+, still returns naive), JS `new Date(yyyy, 1-12, dd)` (warning: months are 0-indexed — ambiguous between `Feb` bug and `Dec` correct-by-accident), JS `Date.UTC(yyyy, 1-12, dd)` (warning: same 0-vs-1 trap), `moment()` without a `.tz(...)` call on the same line (warning: silently uses local time, library in legacy mode since 2020). Block-comment, line-comment, Python `#` comments and triple-quoted docstrings are stripped before matching. Test paths downgrade error → warning (Python) and warning → info (JS). `// datetime-ok` / `# datetime-ok` on same or preceding line suppresses | Adding new clock-bug shapes (Luxon naive `DateTime.local()`, date-fns `startOfDay` without tz, Java `java.util.Date`, Go `time.Now()` without `Location`), or extending suppression markers |
| `src/modules/import-cycle.js` | Import-cycle / circular-dependency detector — walks JS/TS sources (`.js`/`.jsx`/`.mjs`/`.cjs`/`.ts`/`.tsx`/`.mts`/`.cts`), builds an import graph from top-level `import ... from './x'`, `export { ... } from './x'`, top-level `require('./x')` (indent-0 only — lazy in-function requires are correctly ignored), resolves relative specifiers through extension-retry and `./x/index.<ext>` fallback, then runs iterative Tarjan's SCC algorithm to find every strongly-connected component of size ≥ 2. Reports: cycle of 2+ files (error: runtime TDZ / undefined-import bug), self-loop (error: file imports itself), summary (info). Skips: type-only imports (`import type` / `export type` / `import { type X }` — erased at build time), bare-package specifiers (`react`, `lodash` — external, cannot form cycles with local files). Test paths downgrade error → warning. `// import-cycle-ok` on the import line suppresses that edge | Adding new import forms (dynamic `import(...)` with string literal, tagged templates), TypeScript path-alias resolution via `tsconfig.json` paths, or new suppression markers |
| `src/modules/tls-security.js` | TLS / cert-validation-bypass detector — walks JS/TS and Python sources for the pattern that ships MITM-vulnerable code to prod: a developer disables TLS validation once for staging self-signed certs, forgets to re-enable. Nine rule classes: (1) JS `rejectUnauthorized: false` in https.Agent / tls options (error: `js-reject-unauthorized`). (2) JS `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` global nuclear disable in both dot-form and bracket-form `process.env["..."] = "0"` — regex requires `process.env.` prefix so prose references don't FP (error: `js-env-bypass`). (3) JS `strictSSL: false` in request / superagent / got family (error: `js-strict-ssl`). (4) JS `insecure: true` (error: `js-insecure-flag`). (5) Python `verify=False` / `verify_ssl=False` / `ssl=False` as a kwarg — regex requires `[,(]` prefix to ensure it's an argument, not a type annotation (error: `py-verify-false`). (6) Python `ssl._create_unverified_context()` (error: `py-unverified-context`). (7) Python `.check_hostname = False` (error: `py-check-hostname-false`). (8) Python `ssl.CERT_NONE` / `cert_reqs='CERT_NONE'` (error: `py-cert-none`). (9) Python `urllib3.disable_warnings(InsecureRequestWarning)` (warning: `py-disable-warnings`). Two-phase JS line scan: env-bypass rule runs on block-stripped line (preserves `"0"` literal); all other rules run on fully string-stripped line (handles multi-line backtick templates). Python-side strips block/line/hash/triple-quoted-docstring comments. Test paths downgrade error → warning and warning → info. `// tls-ok` / `# tls-ok` on same or preceding line suppresses | Adding new bypass shapes (Go `tls.Config{InsecureSkipVerify: true}`, Java `TrustAllCerts`, .NET `ServerCertificateValidationCallback`), hostname-spoofing detection, cert-pinning enforcement, or cert-expiry scanning |
| `src/modules/cookie-security.js` | Cookie / session-security config detector — walks JS/TS and Python sources for the misconfigurations that turn XSS into session takeover and let cookies ride over plain HTTP. Six rule classes: (1) JS `httpOnly: false` in cookie / session options (error: `js-httponly-false`) — cookie readable from `document.cookie`. (2) JS `secure: false` in cookie / session options (warning: `js-secure-false`) — cookie rides over plain HTTP. (3) JS `secret: '<known-weak>'` where the value is an obvious placeholder (`changeme`, `secret`, `default`, `password`, `keyboard cat`, `test`, `mysecret`, `sessionsecret`, `session-secret`, `abcd1234`, `foo`, `bar`, `change[_-]?me`, `your[_-]?secret[_-]?here`, `replace[_-]?me`, case-insensitive) (error: `js-weak-secret`). (4) Python `SESSION_COOKIE_SECURE = False` / `CSRF_COOKIE_SECURE = False` (warning: `py-cookie-secure-false`). (5) Python `SESSION_COOKIE_HTTPONLY = False` / `CSRF_COOKIE_HTTPONLY = False` (error: `py-cookie-httponly-false`). (6) Python `httponly=False` kwarg on `response.set_cookie` / Starlette / FastAPI cookie helpers — regex requires `[,(]` prefix to ensure it's an argument (error: `py-fastapi-httponly-false`). Two-phase JS line scan: weak-secret rule runs on block-stripped line (preserves the string literal value for capture and reporting); other rules run on fully string-stripped line to avoid doc-string FPs. Python-side strips block/line/hash/triple-quoted-docstring comments. Test paths downgrade error → warning and warning → info. `// cookie-ok` / `# cookie-ok` on same or preceding line suppresses | Adding new cookie-setter libraries (cookie-session, iron-session specific shapes), Go `http.Cookie{Secure: false, HttpOnly: false}`, Java `Cookie.setHttpOnly(false)`, or stronger weak-secret heuristics (entropy-based detection) |
| `src/modules/feature-flag.js` | Feature-flag hygiene detector — walks JS/TS and Python sources for stale flags collapsed into compile-time constants. Three rule classes: (1) always-true conditional — `if (true)` / `if (1)` / `if (!false)` / `if (!0)` in JS/TS (error: `always-true-if`) and `if True:` / `if 1:` / `if not False:` in Python (error: `py-always-true-if`) — flag flipped permanently on, conditional forgotten. (2) always-false conditional — `if (false)` / `if (0)` / `if (!true)` / `if (!1)` (warning: `always-false-if`) and `if False:` / `if 0:` / `if not True:` (warning: `py-always-false-if`) — dead branch. (3) flag-named const bound to literal — JS `const FEATURE_X = true;` / `const ENABLE_Y = false;` in SCREAMING_SNAKE FEATURE_/ENABLE_/DISABLE_/FLAG_/USE_/SHOW_/HIDE_ prefix (warning: `stale-const`), Python module-level `FEATURE_X = True` (warning: `py-stale-const`). Deliberately restricts const-rule to `const` (not `let`/`var`) to avoid FP on `let hasErrored = false;` local mutable state. String-state tracker blanks out content of single/double/backtick strings so `if (false)` inside docstrings and multi-line prompt template literals does not trigger. Block-comment and line-comment stripped before matching. Minified files (`.min.js`, `.bundle.js`, `.prod.js`) skipped entirely. Test paths downgrade error → warning and warning → info. `// flag-ok` / `# flag-ok` on same or preceding line suppresses | Adding flag-API-vendor-specific detection (LaunchDarkly / Unleash / Split.io / Flagsmith / Optimizely / ConfigCat call-site patterns), stale-flag-age tracking (git blame), or duplicate-flag-string detection across files |
| `src/modules/log-pii.js` | Logging-hygiene / PII-in-logs detector — walks JS/TS and Python sources for the compliance-violation bug that ships in every codebase: `console.log(password)`, `logger.info(req.body)`, `log.debug(JSON.stringify(user))`. Four rule classes: (1) logger call (`console.{log,debug,info,warn,error}`, `logger.*`, `log.*`, winston/pino/bunyan/morgan/fastify.log) with a BARE sensitive identifier argument — password, passwd, pwd, token, apiKey, secret, credential, authorization, accessToken, refreshToken, idToken, jwt, bearer, cookie, session, ssn, creditCard, cardNumber, cvv, cvc, pin, privateKey (error: `sensitive-arg`, error on JS, `py-print-sensitive` on Python). (2) logger call with a BARE object-dump identifier — req, request, body, payload, user, member, account, profile, customer, headers, cookies, authHeader, session, formData (warning: `object-dump` on JS, `py-object-dump` on Python). (3) logger call with `JSON.stringify(x)` where `x` is sensitive or object-dump (warning: `stringify-dump`). (4) template-string interpolation `\`...${x}...\`` where `x` is a BARE sensitive/object identifier — the closing `}` must be directly after the identifier, so `${auth.type}` (safe label access) is correctly NOT flagged (error: `sensitive-interp` / warning: `object-interp`). Block-comment / line-comment / Python `#` and triple-quoted docstrings stripped before matching. Test paths downgrade error → warning and warning → info. `// log-safe` / `# log-safe` on same or preceding line suppresses | Adding new logger libraries, new sensitive-identifier names (pgp, ssh-key, mfa, otp), tuning the object-dump identifier list, or extending suppression markers |
| `src/modules/money-float.js` | Money / currency float-safety detector — walks JS/TS and Python sources for the "store-money-in-float" anti-pattern that causes `$0.01 * 1_000_000 = $9999.99...` accumulation drift and regulator-attention-grade rounding fraud. Flags: JS money-named variable (`price`, `total`, `amount`, `tax`, `fee`, `subtotal`, `balance`, `discount`, `usd`/`eur`/`gbp`/`jpy`/`cad`/`aud`/`nzd`/etc.) assigned from `parseFloat(...)` / `Number(...)` (error: `js-parse-float`), class/object property form `this.amount = parseFloat(...)` (error: `js-parse-float-prop`), Python money-named variable assigned from `float(...)` (error: `py-float-cast`), and JS `.toFixed(0)` / `.toFixed(1)` on any money-named receiver (warning: `insufficient-precision` — sub-cent rounding bug). Safe-harbour: if the file imports a known decimal library (decimal.js / big.js / bignumber.js / dinero.js / currency.js / money-math / cashify / `new Decimal()` / `new Big()` / `new BigNumber()` / `Dinero()`) or the Python `decimal` stdlib (`from decimal import Decimal`, `import decimal`), the float-cast rules don't fire. Block-comment, line-comment, Python `#` and triple-quoted docstrings stripped before matching. Test paths downgrade error → warning. `// money-float-ok` / `# money-float-ok` on same or preceding line suppresses | Adding new currency codes, money-named identifiers, decimal-safe libraries, or language backends (Go `float64` on money, Java `double`) |
| `src/modules/redos.js` | ReDoS / catastrophic-regex detector — walks JS/TS/Python sources and extracts regex patterns from literal form (`/pattern/flags`), constructor form (`new RegExp("...")` / `RegExp("...")`), and Python `re.compile` / `re.match` / `re.search` (both `r"..."` raw and `"..."` regular). Constructor-form patterns are unescaped one level so `"\\d+"` is analysed as `\d+`. Tests for three shape-based rules: nested quantifier where the inner element can match empty or has its own quantifier (error: catastrophic backtracking, `(a+)+`, `(.*)*`, `(?:[abc]+)*`), alternation with overlapping branches inside a quantified group (error: `(a|a)*`, `(\d|\d+)*`), and greedy `.*`/`.+` with unanchored polynomial backtracking (warning). Plus one data-flow rule: `new RegExp(req.*.*)` / `RegExp(userInput)` etc. — user-controlled regex construction (error, CWE-1333 injection). Line / block / Python hash comments are stripped before extraction. Test paths downgrade error → warning. `// redos-ok` on same or preceding line suppresses | Adding new regex-source forms (tagged templates, .sregex), new catastrophic shapes, new taint sources |
| `src/modules/pr-size.js` | PR-size enforcer — resolves a git diff against a base ref (config.against, or auto-detect via staged / working-tree / HEAD~1), parses `git diff --numstat` output (with fallback to unified-diff bodies, including numstat rename shapes `old => new` and `src/{a => b}/file`) and enforces four independent limits: total files (soft 50 / hard 100 — warning / error), total lines added+removed (soft 500 / hard 1000), per-file lines (soft 300 / hard 500), and top-level directory sprawl (warning at >3, catches mixed-concern PRs). Auto-excludes lockfiles (package-lock, yarn.lock, pnpm-lock, Gemfile.lock, Cargo.lock, poetry.lock, composer.lock, go.sum, mix.lock, flake.lock), build output (`dist/`, `build/`, `out/`, `.next/`, `coverage/`, `node_modules/`, `vendor/`, `target/`, `bin/`), minified/bundled files (`*.min.*`, `*.bundle.*`), snapshot tests (`*.snap`), and source-maps (`*.map`). Summary line always fires (info). No-op outside a git repo or when no diff is available | Adding new exclusion patterns, new thresholds, or a new diff-parse form |
| `src/modules/homoglyph.js` | Homoglyph / Unicode-lookalike detector — flags bidirectional-override / isolate characters (U+202A..U+202E, U+2066..U+2069) as Trojan Source attack shape (error, CVE-2021-42574), Cyrillic / Greek letters embedded inside otherwise-Latin identifiers (error: supply-chain / code-review bypass vector; covers `а` U+0430, `е` U+0435, `о` U+043E, `р` U+0440, `с` U+0441, `х` U+0445, `у` U+0443, `ѕ` U+0455, Greek `ο` U+03BF, `ρ` U+03C1, etc.), zero-width chars U+200B/U+200C/U+200D/U+2060/U+FEFF mid-file (warning: identifier-shadow vector), and other non-printable control chars (warning). Identifier scan uses a string-and-comment stripper so translation-string contents don't false-positive. Locale paths (`locales/`, `i18n/`, `lang/`, `translations/`, `intl/`, `l10n/`), locale extensions (`.po`/`.pot`/`.xliff`/`.arb`/`.mo`), and doc extensions (`.md`/`.mdx`/`.rst`) are exempt. BOM on the first byte of the first line is allowed | Adding new lookalike letters, locale-path patterns, or control-char allowlist |
| `src/core/host-bridge.js` | Abstract `HostBridge` base, bridge registry (`createBridge`/`registerBridge`), canonical commit-status vocabulary, shared PR/MR markdown formatter | Before adding a new host integration or touching cross-host logic |
| `src/core/github-bridge.js` | Concrete `GitHubBridge` extending `HostBridge` — GitHub-specific REST calls, circuit breaker, retry, JWT auth | Anything GitHub-specific; prefer `HostBridge` for cross-host work |
| `bin/gatetest.js` | CLI flags, help text, watch mode, `gatetest mcp` subcommand dispatch | Adding CLI features |
| `bin/gatetest-mcp.js` | Standalone MCP stdio server entry — what MCP clients spawn | Changing how MCP clients launch the server |
| `src/mcp/server.js` | Zero-dep MCP (Model Context Protocol) stdio server. JSON-RPC 2.0 over stdin/stdout, protocol 2024-11-05. Exposes three tools: `gatetest_version`, `gatetest_list_modules`, `gatetest_scan`. **CRITICAL: uses a bare GateTestRunner with zero reporters** — if a future change wires `gt._run()` here, ConsoleReporter will write to stdout and silently corrupt the protocol channel for every AI client (Claude Code, Cursor, Cline, Windsurf). | Adding tools, changing wire format, touching reporter wiring |
| `tests/mcp-server.test.js` | Protocol-contract tests — without these a regression in `src/mcp/server.js` would silently break every AI-client integration | Before changing the MCP server surface |
| `docs/MCP.md` | Setup guide for Claude Code / Cursor / Cline / Windsurf / Continue | Adding a new MCP client or new tool |
| `website/app/api/scan/run/route.ts` | The actual scan execution | Changing scan logic |
| `website/app/scan/status/page.tsx` | Live scan page | Changing scan UX |
| `website/app/api/checkout/route.ts` | Stripe checkout creation | Changing payment flow |
| `website/app/page.tsx` | How website sections compose | Changing page structure |
| `website/app/globals.css` | Dark theme, animations | Changing visual style |
| `integrations/github-actions/gatetest-gate.yml` | CI gate shipped to protected platforms | Any change to protection workflow |
| `integrations/husky/pre-push` | Local pre-push gate for protected platforms | Any change to local enforcement |
| `integrations/scripts/install.sh` | One-command installer into a protected repo | Any change to install flow |
| `tests/integrations.test.js` | Tripwire that prevents silent removal of protection | DO NOT modify without Craig auth |

---

## ENVIRONMENT VARIABLES (Vercel)

| Variable | Purpose |
|----------|---------|
| `STRIPE_SECRET_KEY` | Stripe API (sk_live_... or sk_test_...) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe client key |
| `NEXT_PUBLIC_BASE_URL` | https://gatetest.ai |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing |
| `GLUECRON_BASE_URL` | Gluecron deployment URL (default https://gluecron.com) |
| `GLUECRON_API_TOKEN` | Gluecron PAT (scope: `repo`, format `glc_<64hex>`) |
| `ANTHROPIC_API_KEY` | Claude API for AI review |
| `GATETEST_ADMIN_PASSWORD` | Admin console password for `/admin` (bypasses Stripe) |

---

## KNOWN ISSUES — QUEUED FOR FIX

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Scan page needs fresh checkout — stale sessions show "cancelled" | MEDIUM | DONE (2026-04-16) — `/api/scan/status` now returns a new `status: "expired"` state when `piStatus === "canceled"` AND no `scan_status` metadata exists (i.e. session expired BEFORE scan ran). Page renders a dedicated slate-palette "Session Expired" block with a prominent "Start New Scan" CTA, distinct from the amber failure state. |
| 2 | Website design needs major upgrade — current is basic | HIGH | IN PROGRESS (2026-04-17) — Shipped this session under Craig's "just do it all" authorization: animated hero grid background with radial mask + 40s drift, gradient-shimmer on `.gradient-text`, gradient section dividers, enhanced card hover (teal glow + lift + inner highlight), enhanced `btn-primary` with active-state press + larger shadow, terminal scanline animation, footer teal accent bar. Modules.tsx fully restructured from 13-active/8-soon to all 67 modules across 9 categories (Source & quality / Security / Reliability / Web & UX / Infrastructure / Developer hygiene / AI & advanced / Scanning & testing / Language coverage). Remaining wishlist (for post-launch): navbar dual-layer glass, stats counter-animation on scroll, comparison-bar fill-on-scroll, module-card 3D perspective. |
| 3 | Stripe test keys not yet swapped in | MEDIUM | Craig action |
| 4 | GitHub App not yet installed on test repo | MEDIUM | Craig action |
| 5 | Crontech.ai protection — workflow shipped in `integrations/`, needs `install.sh` run from that repo | HIGH | Craig action (or expand MCP scope) |
| 6 | Gluecron.com protection — workflow shipped in `integrations/`, needs `install.sh` run from that repo | HIGH | Craig action (or expand MCP scope) |
| 7 | MCP GitHub scope currently restricted to `ccantynz-alt/gatetest` — blocks pushing protection into Crontech/Gluecron directly. Expand to owner-wide scope. | HIGH | Craig action — see `.claude/` config |
| 8 | Gluecron-first direction ratified in the Bible — still need Gluecron's API surface (endpoints, auth, webhook model) before the `HostBridge` refactor can ship a `GluecronBridge`. | HIGH | DONE (2026-04-19) — GluecronBridge shipped, website callers swapped off GitHub App. `src/core/gluecron-bridge.js` implements the HostBridge contract; `website/app/lib/gluecron-client.ts` replaces `github-app.ts` in scan/run, scan/fix, scan-executor, and admin/health. `/api/webhook` now returns 410 Gone (push events land at `/api/events/push`). Env migrated to `GLUECRON_BASE_URL` + `GLUECRON_API_TOKEN`. `src/core/github-bridge.js` kept as a sibling implementation per the HostBridge architecture. |
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
| 21 | **scan/status page could stick at "Scanning..."** — `/scan/status/page.tsx` only recognised `complete`/`failed`/`expired`. Any other status from `/api/scan/run` (pending/running/cancelled/malformed) left the header reading "Scanning..." with a full progress bar. | MEDIUM | DONE (2026-04-18) — Unknown statuses are normalised to `failed` with an `error: "Scan returned unexpected state: X"` so the user always reaches a resolved UI and sees retry CTA. |
| 22 | **GitHub App `installation_id` not persisted** (`/api/github/callback/route.ts:17`). Without this, webhooks carry an `installation_id` but we can't map it to a billing customer → multi-org customers lose correlation. Flagged by scan/payment + GitHub-App audits 2026-04-18. | HIGH | Craig action — requires schema extension (new `installations` table or equivalent in Neon) and touches user data. Bible Boss Rule #9 triggers. |
| 23 | **PR comments are not idempotent** — `/api/webhook/route.ts:438` posts a fresh comment per push. On a busy PR the thread fills with dupes. | MEDIUM | Post-launch polish — find-and-edit prior bot comment, or collapse into a single updating comment. |
| 24 | **GitHub file-tree fetch is unbounded** on `?recursive=1` — monorepos with 100k+ files will exhaust Vercel's per-function budget. | MEDIUM | Post-launch — add pagination / file-count ceiling / graceful degradation message when a repo is too large. |
| 25 | **Rate-limit wait cap** in `github-bridge.js:138` only waits if backoff < 120s. GitHub resets can be 60 minutes out, meaning we skip the wait and hammer 429. | MEDIUM | Post-launch — queue and respect longer resets, or refuse scans during the cool-down window. |
| 26 | **No `vercel.json` maxDuration** for `/api/scan/run` — full scan targets <60s but no hard cap is pinned at the platform layer. If a scan hangs it'll be killed mid-way at Vercel's plan-default. | MEDIUM | Craig action — pin `maxDuration: 300` once deployment plan is confirmed (Boss Rule #5 / deployment config). |
| 27 | **`gatetest` not yet published to npm** — `npm view gatetest` returns 404. Until it ships, `npm install -g gatetest` (the one-line install in the MCP doc and on the website) does not work; users have to clone and `npm link`. Distribution channel blocked. | HIGH | Craig action — first-time `npm publish` is Boss Rule #9 (public-facing release). Code is launch-ready; tests green, zero-dep, MIT licensed, `bin/gatetest` + `bin/gatetest-mcp` declared. Recommend running `npm publish --dry-run` first to verify the tarball. |
| 28 | **Version drift Bible ↔ package.json** — Bible says `v1.41.0`, `package.json` still says `"version": "1.0.0"`. `gatetest --version` and the MCP `gatetest_version` tool both report 1.0.0 so customers will see the wrong number. | MEDIUM | Craig action — version bump is adjacent to release strategy (semver, changelog) so pairing it with the `npm publish` decision. Suggest bumping to `1.41.0` to match the Bible at the same time as publish. |
| 29 | **MCP server shipped — needs distribution channels lined up** to actually reach AI-coding-agent users. Channels: (a) submit to Claude Code MCP registry / awesome-mcp-servers list, (b) Cursor's `mcp.json` examples in their docs, (c) Cline / Windsurf / Continue plugin galleries, (d) `mcp-server` + `model-context-protocol` npm keywords (done), (e) Show HN / Product Hunt post on launch day. | HIGH | Craig action — every channel is brand/marketing (Boss Rule #8) + public-facing comms (Boss Rule #9). I can draft the copy for each channel; Craig posts. |
| 30 | **`errorSwallow` flags 39 hits in `src/` library code** — empty catches in `claude-md-generator.js`, log-and-eat in `registry.js` / `config.js`, catch-noop x10 in `explorer.js`, etc. None in customer-facing `website/app/api/*`. Most are intentional best-effort patterns (graceful module loading, autonomous explorer that must survive individual probe failures). Needs a thorough pass to either fix or add `// error-swallow-ok` markers per case. | MEDIUM | Pre-authorized — library-code hygiene within the existing stack. Pick up next session. |
| 31 | **`admin-auth.ts` length-leak fix (2026-05-13) is uncovered by tests** — the file is TypeScript so adding a `node:test` against it requires either runtime compilation or porting the logic to a .js shim like `stripe-webhook-verify.js`. Fix is mechanically obvious (hash both inputs to 32 bytes before `timingSafeEqual`) but Bible Quality Bar #1 says untested code does not exist. | MEDIUM | Pre-authorized — port `verifyAdminPassword` to `website/app/lib/admin-auth-verify.js`, write tests, re-import from the TS file. |
| 32 | **Stripe webhook replay-attack defence shipped (2026-05-13)** — added 300s timestamp tolerance + extracted `verifyStripeSignature` to `website/app/lib/stripe-webhook-verify.js` with 21 contract tests. Closes the gap where a captured `checkout.session.completed` signature could be replayed indefinitely. | HIGH | DONE (2026-05-13) — see commit. |

---

## SESSION PROTOCOL

### At the START of every session:
1. Read this file end to end
2. `git status && git log --oneline -10`
3. `git branch` — verify on correct branch
4. Check "Known Issues" section
5. Check what needs to be done
6. If unclear, ask Craig

### At the END of every session:
1. Run ALL tests — `node --test tests/*.test.js`
2. Build website — `cd website && npx next build`
3. Verify all 64 modules load — `node bin/gatetest.js --list`
4. Update "Known Issues" if anything found
5. Commit and push everything
6. Leave the codebase in a WORKING state

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

GateTest v1.41.0 — **MCP server shipped** (Model Context Protocol stdio
server, zero-dep, protocol 2024-11-05 — lets Claude Code, Cursor, Cline,
Windsurf, Continue and any MCP-capable agent invoke GateTest natively;
three tools exposed: `gatetest_version`, `gatetest_list_modules`,
`gatetest_scan`). 67 modules (24 core + 9 universal language checkers
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
SARIF/JUnit output, Stripe pay-on-completion, GitHub App, legal pages.
**Gluecron-ready `HostBridge` abstraction**: every git host
integration plugs into one contract (canonical commit-status states,
shared PR/MR markdown, registry-based bridge factory). `GitHubBridge`
is the first concrete implementation; `GluecronBridge` will be the
second.

Date last updated: 2026-05-13
