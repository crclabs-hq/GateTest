# GateTest Module Reference

The full competitive tool-replacement table — which of the 120 modules replaces which market tool.

> Split out of CLAUDE.md (the Bible) 2026-07-07 to keep every session's context lean.
> The Bible holds rules + current truth; this file holds the detail. Nothing was deleted.

## COMPETITIVE POSITION

### We replace 10+ tools with ONE:
| They use | GateTest replaces it with |
|----------|--------------------------|
| Jest/Vitest/Mocha | `gatetest --module unitTests` |
| Cypress / BrowserStack / Sauce Labs | `gatetest --module e2e` |
| ESLint/Stylelint | `gatetest --module lint` |
| Snyk/npm audit | `gatetest --module security` |
| Renovate/Dependabot (hygiene only) | `gatetest --module dependencies` |
| hadolint / dockle / docker bench | `gatetest --module dockerfile` |
| actionlint / StepSecurity / zizmor | `gatetest --module ciSecurity` |
| shellcheck / bashate / shfmt | `gatetest --module shell` |
| squawk / gh-ost safety checks / pg-osc / Strong Migrations | `gatetest --module sqlMigrations` |
| tfsec / Checkov / Terrascan / KICS | `gatetest --module terraform` |
| kube-score / kubeaudit / Polaris / Kubesec | `gatetest --module kubernetes` |
| LLM Guard / Lakera Guard / Rebuff (static config + prompt-shape slice — bundled keys, no max_tokens, deprecated models, injection-surface templates) | `gatetest --module promptSafety` |
| Promptfoo / Garak / Lakera Red (dynamic behavioural / scenario testing of deployed LLM endpoints — jailbreak, injection, PII leak, hallucination, tool exfil, cost-DoS, schema integrity, topic constraints) | `gatetest --module aiGuardrails` (Nuclear tier; requires customer-supplied endpoint URL + auth) |
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
