# GateTest launch board — START HERE

Read this before doing anything, from any of the three owner accounts
(ccantynz, ccantyusa, ccanty48co). It is the repo record of the launch gate and
of the 20 product moves. Every status below was checked on 2026-09-30 02:00-02:30Z
against `origin/main` (9f17e6c6), `gh`, or a read-only GET of the live site, and
the evidence is in the row. Verify again before repeating a claim (CLAUDE.md
doctrine #8). `docs/HANDOFF.md` holds the dated history;
`docs/ops/blocking-on-craig.json` (rendered daily into issue #532) holds the
owner-only items, but it was last edited 2026-09-23 and misses the pull-deploy kill
(item 1), Gluecron OAuth (part of 3), the 1.62.0 release (6) and the arena key (8),
so this section outranks #532. Update this file in the same PR as any
change of state (owner mandate, 2026-09-25).

## 0. Launch blockers, in order (what stops a paying customer today)

OWNER = only Craig's hands (box, account, secret, registry). CODE = a builder can do it.

| # | Who | Blocker | Evidence (30 Sep) | Exact next step |
|---|---|---|---|---|
| 1 | OWNER | Production serves a 26 Sep build, 224 commits behind main; every pull-deploy run is killed mid-build. Nothing merged since (sign-in with Google / Gluecron / password, "Install Gluecron" header, estate, `/api/health/deep`, secrets panel, every false-positive fix) is live. | `/api/platform-status`: commit `0baf4e93`, built 2026-09-27T14:26Z; `lastPullDeploy` 02:07:38Z `failed`, "killed before it could record its own status (systemd OnFailure safety net)". `git rev-list --count 0baf4e93..origin/main` = 224 at `9f17e6c6` (216 at `11407db5`). Issues #796, #797 open; `Deploy to production box` failed on its last 4 completed runs ("lagging by 215 commits"). | Box 161 is reachable only over the tailnet: `ssh jarvis`, and run the Linux commands INSIDE that shell, not in PowerShell. `journalctl -u gatetest-pull-deploy -n 80 --no-pager`, then `ssh -t jarvis "cd /opt/gatetest && git fetch origin main && git show origin/main:scripts/deploy/deploy-on-box.sh \| DEPLOY_RECOVER=1 GATETEST_APP_DIR=/opt/gatetest bash -s"`. Then fix the cause (30-min `TimeoutStartSec` or OOM under co-tenants: `MemoryMax` + `LimitCORE` drop-ins, hold a commit that failed to build). Done when `/api/platform-status.commit` equals `origin/main`. |
| 2 | CODE | `main` is red on "real repos must not be blocked": apollo-server 2 blocking, ceiling 0. Red on the 5 completed main pushes from `cb26ff38` through `11407db5` (the `9f17e6c6` run was still in progress at 02:35Z); every PR inherits it and it fires the AI CI Fixer. | Run 36657931591 on `11407db5`: `apollo-server: 2 blocking findings, ceiling is 0`. Fix exists only as `wip/fix/corpus-apollo-regression` (95c90b9b: `confidence.js`, `test-paths.js`, `security.js` + tests); no PR yet. | Finish that branch, open the PR, `node scripts/real-world-precision.js --repo apollo-server` must print 0 (never raise the ceiling). Being fixed in another session; do not duplicate. |
| 3 | OWNER | Production env is missing what sign-in and the admin need, so even after (1) Google and Gluecron buttons stay hidden and `/admin` login fails. | Open in `blocking-on-craig.json`: `box-secrets` (since 13 Sep), `admin-password-box-env` (19 Sep). `/api/status` no longer lists missing names (returns only ok / healthy / version / commit), so this cannot be read from outside until (1) ships `/api/health/deep`. | On box 161 in `/opt/gatetest/website/.env.local`: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`; `GLUECRON_OAUTH_CLIENT_ID` / `_SECRET` (create the app at gluecron.com/settings/applications/new, redirect `https://gatetest.io/api/auth/gluecron/callback`); `GATETEST_ADMIN_PASSWORD`; `GATETEST_INTERNAL_TOKEN` (same value as the repo secret); `TALLRIG_API_TOKEN`. Then `sudo systemctl restart gatetest-web`. Secrets-panel install: `docs/ops/secrets-panel.md`. Never paste a value in chat. |
| 4 | CODE, done | Admin security (per the handoff: auth bypass on `hn-launch` / `seo` admin routes, SSH heal that could hit our own box). Merged; ships with item 1. | PR #851 MERGED 2026-09-30T02:32:56Z as `9f17e6c6` ("one admin gate on every route, honest Accounts tab, SSH heal only for our hostnames"). Not live until item 1. | Nothing to do but deploy (item 1). Then run the admin routes against production as an anonymous caller and expect 401 / redirect. |
| 5 | OWNER | GitHub Marketplace App is not listed, so the install path the site describes does not exist. | `github.com/marketplace/gatetest-hq` 404; `github.com/apps/gatetest-hq` 200. Open: `github-app-public` (since 14 May), `mp-webhook-secret` (19 Sep). | `node scripts/marketplace-preflight.js`, then `https://github.com/marketplace/new` -> gatetest-hq -> Free plan -> paste `integrations/marketplace/listing.md`; set the Marketplace webhook secret in the listing and in the box env. |
| 6 | OWNER | The published product is 873 commits behind main: npm CLI, the Action `@v1` and the MCP server all predate this week. Tallrig's 38 false `missing-title` findings are fixed on main only. | npm `@gatetest/cli` 1.61.1; `v1` = `v1.61.1` = `1fd44421` (15 Sep); `git rev-list --count 1fd44421..origin/main` = 873; `packages/mcp-server` is 1.2.1 in tree, 1.2.0 on npm. | Bump `package.json` to 1.62.0 by PR, then `git tag v1.62.0 && git push origin v1.62.0` (`publish.yml` checks tag == version, publishes via Trusted Publisher, advances `v1`, attaches the WordPress zip). Publish `packages/mcp-server` 1.2.1 in the same sitting, then `npm deprecate` 1.60.0 and earlier (they still post telemetry to the dropped gatetest.ai, #801) and, per the handoff, 1.61.1 (false `missing-title`). |
| 7 | OWNER | Secrets that lived on the compromised box 158 are still unrotated, and Cron Ticks fails on main (the tick bearer is a burned value). | Open: "Rotate every production secret that also lived on box 158" (since 10 Sep), `cron-secret-repo`, `box-github-token`. `Cron Ticks (off-Vercel stopgap)` failed 30 Sep 01:35Z on `f92440f2`. | Rotate at each issuer in the order written in that item in `blocking-on-craig.json`, then box env, restart, then repo secrets. All over SSH, never in chat. |
| 8 | OWNER | Public proof repo cannot repair its own bugs: the AI-fixer key on `gatetest-arena` is rejected, 19 draft bug PRs are stacked. | Run 36658211096 (30 Sep 02:05Z): job green, log says "AI fixer key rejected ... (owner rotation)". `gh pr list -R crclabs-hq/gatetest-arena` = 19 open drafts. | Rotate the arena repo's AI-fixer key secret, or declare the arena injection-only on `/testing`. |

Not blockers, owner decisions waiting: telemetry default (`TELEMETRY_DEFAULT = 'on'`,
issue #801); Gluecron open sign-ups (the header sends visitors to an invite wall);
wordpress.org submission (`wordpress.org/plugins/gatetest-health-check/` 301 -> search,
not listed); MCP registry entry is still `ai.gatetest.www/gatetest` (111 / 120-module text,
no `io.gatetest` entry); which repo the parked white-site redesign belongs to.

## 1. Customer-ready gate — verified live 2026-09-30 02:15Z, main = `9f17e6c6`, prod = `0baf4e93`

| Surface | State | Evidence | What still blocks |
|---|---|---|---|
| Production deploy | RED | Served `0baf4e93` (26 Sep 18:34Z) vs main `9f17e6c6`: 224 commits behind. `lastPullDeploy` 2026-09-30T02:07:38Z result `failed`, reason "gatetest-pull-deploy.service was killed before it could record its own status (systemd OnFailure safety net)", `consecutiveFailures` null, `firstFailedAt` = the same tick (resets each run) | OWNER, §0 item 1 |
| Website + checkout | PASS (old build) | `/` 200, `/pricing` 200 ($29 / $99 / $199 one-time tiers listed), `/api/platform-status` healthy true v1.61.1. Stripe checkout and the free preview were not re-run (POST, outside this read-only pass) | nothing new; ships with §0 item 1 |
| npm CLI | PASS | `@gatetest/cli` 1.61.1 = `package.json` on main; bins `cli`, `gatetest`, `gatetest-mcp`, `gatetest-reliability`; latest = 1.61.1 | main is 873 commits past its tag (§0 item 6) |
| MCP server | DRIFT | npm `@gatetest/mcp-server` 1.2.0; `packages/mcp-server/package.json` on main 1.2.1 (unpublished); `server.json` 1.2.0; homepage gatetest.io | publish 1.2.1 (§0 item 6); registry rename (owner) |
| GitHub Action | PASS, stale | `@v1` -> `1fd44421` = tag `v1.61.1` (15 Sep), 873 behind main; Marketplace Action listing 200; `Action dogfood` green on `9f17e6c6` | moves with the release (§0 item 6) |
| Docker | PASS | GHCR anonymous tag list has `1.61.1`, `1.61`, `1`, `latest`, `main`, `sha-*`; `Docker image publish` green on `9f17e6c6` | nothing |
| VS Code | PASS | `GateTestHQ.gatetest` 1.1.3 on the Marketplace (updated 2026-09-16) and on Open VSX (1.1.3, only version) = `vscode-extension/package.json` | nothing |
| WordPress | PASS, not in directory | `gatetest-health-check.zip` on release v1.61.1 (2026-09-19) resolves 200, 14,269 bytes; `/wp` 200; wordpress.org plugin page 301s to search | wordpress.org submission (owner) |
| GitHub App / Marketplace App | OWNER | `github.com/apps/gatetest-hq` 200; `github.com/marketplace/gatetest-hq` 404; webhook not re-tested | §0 item 5 |
| Public proof repo (arena) | BROKEN | Main CI green (26 Sep); `Arena Repair` job green but logs "AI fixer key rejected"; 19 open draft bug PRs (recent ones show CI `action_required`) | §0 item 8 |
| CI on main | RED | `11407db5`: CI, Action dogfood, Docker green; `Reliability Corpus` red on the 5 completed pushes through `11407db5` (`9f17e6c6` in progress); `Cron Ticks` (01:35Z) and `Empire Smoke` (00:29Z) red; branch protection: strict, 4 required checks, admins not enforced | §0 items 2, 7 |

Env: production `/api/status` returns only `ok / healthy / version / commit` now, so
missing variables are not readable from outside (the old `missing_important` list is
gone); the owner list is in §0 item 3. The box env still uses the pre-rename
`VAPRON_*` names until the owner's cutover (`docs/ops/tallrig-cutover.md`).

## 2. Do NOT redo (already done, with the PR that did it)

Merged is not live: production serves `0baf4e93` (26 Sep 18:34Z), so every bullet below
that merged later, and every "unverified live until deployed", stays unverified until §0 item 1.

- Vendor-neutral public copy and engine output: #503, #506, #515, guard test
  `tests/public-copy-vendor-neutral.test.js`.
- Tallrig rename in code and docs: #504, #733; box env cutover is the owner's.
- v2 homepage live at `/`: #719. Site-wide v2 design: #696, #705, #712.
- Docs truth pass, `editors/vscode` deleted: #505. Handoff sections 9-12: dated.
- Arena repaired: gatetest-arena#364 (math restored, scheduled repair). Stale PRs
  and 261 dead branches removed 2026-09-25.
- Testing page reads the public arena anonymously: #738.
- Worktree and branch cleanup 2026-09-25: 50 merged branches, 34 old unmerged
  branches, ~60 worktrees and folders removed. One worktree kept:
  `feat/build-staging-swap` (90 real uncommitted lines).
- Complaint-map receipts: suites quick 42 / standard 46 / full 89 / nuclear 96;
  corpus 20 repos, 212 blocking, five repos at zero; unknown flag exits 0 unless
  `--strict`/`CI` (then 2); fix loop `maxAttempts` = 3; accessibility module is
  in-process WCAG 2.2 AA + AAA-aligned (no pa11y, no `includeWarnings`).
- Scan honours `.gitignore` + build-output defaults, `--include-ignored` flag:
  #776 (closes #767). `BaseModule._collectFiles` now skips gitignored paths and
  a built-in build-output name set by default; measured on AlecRae.com
  266→158 blocking, ~422s→159s wall time, 822 gitignored paths skipped.
- JSON report is a versioned contract: top-level `schemaVersion: 1` (also SARIF
  `runs[0].properties`, JUnit `<testsuites>`), pinned fields in
  `docs/api/report-schema.md` + `tests/report-schema-contract.test.js` (closes #803).
- `--crawl` honours `--module` / `--suite` (closes #802): crawl-capable members run against the site, the rest are named on one "not crawl-capable, skipped" line and in `summary.deferred`; none capable is exit 2 under `--strict`/CI. One list: `CRAWL_CAPABLE_MODULES` in `src/core/config.js`. Bare `--crawl` unchanged (liveCrawler only); `--crawl --suite web` is the hosted /web set.
- Telemetry host guard + `GATETEST_TELEMETRY` switch + first-run field list +
  `--telemetry-status`: #811 (refs #801); default stays `'on'` until the owner sets
  `TELEMETRY_DEFAULT`; `npm deprecate` of 1.60.0 and earlier is owner-only.
- Hosted web scan honesty: JSON API host skips HTML-only checks, navigation failure is not a
  broken link: #804 (#768 items 3 and 4).
- #771 GT-03 / GT-09 / GT-11 / GT-12 false positives closed against the AlecRae line
  (crossFileTaint query-string and verify-guarded redirects, deployScriptValidator
  upload-artifact paths, authBypass `GET /` / `/v1` / `/openapi.yaml` / `/v1/uptime`,
  logPii + dataIntegrity operator CLIs under `scripts/`): PR `fix/fp-taint-shell-auth-771`.
  Measured on AlecRae.com: crossFileTaint 3→0, deployScriptValidator 2→1 (the k8s
  `/api/health` probe that 404s live stays), authBypass 1 error→0, logPii 1→0,
  dataIntegrity PII-in-logs 11→6 (five `apps/api/scripts/*.ts` gone, nothing added).
  One definition each: `src/core/public-discovery-routes.js`, `src/core/operator-cli.js`.
- Hosted `/api/web/scan` keeps its own clock (issue #768 items 1, 2, 5): 50 s budget
  (`GATETEST_WEB_SCAN_BUDGET_MS`), then 200 + `partial: true` + unfinished modules
  not-checked + `streamUrl`; every response carries an absolute `reportUrl`;
  runtime-not-configured is explained in `notCheckedReasons`. Control pair
  `tests/web-scan-budget.test.js`. Live-verify after deploy (never run live).
- Crawler apex/canonical de-dup (closes #806), a11y component label prop and retry compare-bound
  (refs #771 GT-02 / GT-07): #820; AlecRae accessibility blocking 92 -> 12, retryHygiene 1 -> 0.
- #771 GT-04/05/10 false positives (unref'd setInterval and TS interface member, masked/abbreviated/gitleaks:allow/credential-free-redis secrets, echo redirected to a file): AlecRae blocking secrets 10→7, ciSecurity 1→0, resourceLeak 5→1; classes still open in #771: GT-02,03,06-09,11-14.
- First-hour sign-in journey: server-side gate (`/dashboard` 307 to `/login?next=`), `/login` entry, `/register` `/signup` `/sign-up` 301 to `/login`, `/docs` clean 307, `GET /api` JSON, crawler flags a redirect that carries an error page: #819 (closes #810, #812; unverified live until deployed).
- `estate` module (module 122, #807 R3, merged #822 63edf38f 29 Sep, `src/modules/estate.js`): host discovery from list /
  sitemap / TLS SAN / links, per-host verdict. Runs in `full`, `nuclear`, `wp`; not `quick` or
  `standard`. An NXDOMAIN from the system resolver is only "dead" once 1.1.1.1 or 8.8.8.8 agrees
  (the ISP resolver called five live hosts dead on 2026-09-28).
- Composite readiness `GET /api/health/deep`: db / queue / ai / mail / runtime sub-checks with status, latency and reason; 503 when a required one is down, optional ones report `not-configured`; `/api/health` stays the bare liveness ping. Pure composer `website/app/lib/health-composite.js`, control pairs `tests/health-composite.test.js`, live probe `tests/heavy/health-deep-live.test.js` (closes #809; unverified live until deployed).
- #807 honesty gaps, three-state verdicts (refs #807 R4/R5/R12): `apiHealth` NOT CHECKED when nothing was confirmed (the tallrig.com "26 checked — 0 broken" false green), `deploy/fresh` NOT CHECKED with nothing to compare the served sha against, `--server` DNS/mail posture stops passing apex `_dmarc` text / any-TXT DMARC / `+all` SPF and reads resolver failures as NOT CHECKED: #828. Local fixtures only; live tallrig.com re-run is the owner's after deploy.
- CI-step and toolchain honesty (refs #771 GT-13, GT-14a, GT-14b; #770): best-effort `|| true` shapes (chmod/chown/touch, a same-file function that prints its own verdict, a plumbing-named YAML step) are warnings; ESLint skips gitignored / build-output dirs; a build failure before any test ran is "not checked"; `--timings`: #825. Measured on AlecRae.com @ d9f61aa: bashSafety 18→9 blocking (45→45 total), ESLint 4254→298 errors.
- deployContract reads past `curl -o` / `--output` / `wget -O` and their value (refs #771; the item dropped from #821 for having no test): `-o $OUT` in a health-named workflow no longer blocks on `deploy-contract:/`, and the real URL after `-o /tmp/file` is now checked. Control pair `tests/deploy-contract-output-flag.test.js`, all three cases fail on the previous module.
- /login offers every configured provider (GitHub, Google, GitLab; decided server-side, one definition `website/app/lib/sign-in-providers.js`), honest "coming soon" lines for Gluecron and email + password (`PASSWORD_AUTH_ENABLED` in `auth-features.ts`, flipped by feat/password-auth), Google and GitLab carry `next` and land failures on `/login?error=`; header CTA is "Install Gluecron" (new tab, `rel="noopener"`), home hero keeps "Install the GitHub App" and adds "Install Gluecron" beside it (owner directive 2026-09-29). Google live needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on production — owner. Gluecron OAuth waits on Gluecron.
- "Sign in with Gluecron" (customer OAuth, same shape as GitHub / Google / GitLab): `GET /api/auth/gluecron` + `/api/auth/gluecron/callback`, PKCE S256, scope `read:user`, endpoints discovered from Gluecron's `/.well-known/oauth-authorization-server` once per process with the verified URLs as fallback, cookies `glc_oauth_state` / `glc_oauth_pkce` / `glc_oauth_next`, failures on `/login?error=gluecron_*`, fails closed until Gluecron's userinfo is live. Pure half `website/app/lib/gluecron-oauth.js`, control pairs `tests/gluecron-oauth.test.js`. Live needs `GLUECRON_OAUTH_CLIENT_ID` (+ optional `GLUECRON_OAUTH_CLIENT_SECRET`) and the OAuth app registered at gluecron.com with redirect URI `https://gatetest.io/api/auth/gluecron/callback` — owner. The /login button is the muted "coming soon" line until then.
- Email + password sign-in alongside GitHub / Google (owner directive 2026-09-29): `/login/password` (+ `/register`, `/forgot`, `/reset?token=`), `/account/password`, six `/api/auth/password/*` routes; scrypt via node:crypto (no native addon), verify / reset links single-use 1 h through the one mail transport, password active only after the emailed click, 10 failures per email + IP per 15 min counted in the database, same-origin check on every POST, same session cookie as OAuth. Additive schema (`customers.password_hash / email_verified_at / password_updated_at`, `auth_tokens`, `auth_login_failures`) applied by `password-auth-store.js ensureSchema` at first use and `POST /api/db/init`. One definition `website/app/lib/password-auth-core.js`, control pair `tests/password-auth.test.js`, live probe `tests/heavy/password-auth-live.test.js`. Switch `PASSWORD_AUTH_ENABLED` in `app/lib/auth-features.ts`. Unverified live until deployed: mail delivery, production schema apply.
- Per-page crawl (closes #815): under `--crawl --module/--suite`, webHeaders, cookieSecurity, accessibility and seo audit every crawled HTML page (`--crawl-check-pages`, default 25; pages past the cap are named on the "N pages not checked" line and in JSON `pageChecks`); each finding cites its page URL, identical findings across pages fold to one finding with `pages: [...]`. One page store (`liveCrawler` result `crawledPages`), one fold (`BaseModule#_foldLivePages`). Hosted `/web` scan unchanged (single entry page) until it sets `modules.liveCrawler.checkPages`. Control pair `tests/crawl-per-page.test.js`.
- #842 DR-1/2/3/5 false positives + retired-model severity (refs #842): security CSRF rule is a code shape and the JS stripper ends a quoted string at the line (an apostrophe in JSX text no longer inverts the mask), featureFlag `if` must sit at statement position / JSX text after a tag line is prose / Python `if False: yield` empty-generator idiom is quiet, performance event-cleanup skips service workers, promptSafety retired model id is error outside tests. DavenRoe @ 1dea3658: security 4→3 errors, featureFlag 6→0, performance 2→1, promptSafety 5→5 (config.py:29 warning→error); nothing added. DR-4/DR-6/DR-a are another PR.
- Accessibility findings name their line and fold by root cause (refs #842 DR-b, DR-c): every per-element a11y finding carries `line`/`column` via the one offset-to-line helper `src/core/line-at.js`, the secrets per-file finding names its first match's line, and an `<Input>`-shaped component the repo defines is reported once at its definition with `callSiteCount` and up to five call sites (DavenRoe @1dea3658: 1,785 findings with `line: null` -> 15 file-level ones; 27 call-site warnings fold into 2 definitions; 1,548 blocking unchanged, the rest are literal `<input>` elements one each). Control pairs `tests/accessibility.test.js`, `tests/secrets.test.js`, `tests/line-at.test.js`.
- Admin secrets panel API + store (owner directive 2026-09-30, copy Tallrig with its holes closed): `/api/admin/secrets/**` + `/api/admin/step-up`, AES-256-GCM with the name in the AAD and a dedicated `GATETEST_SECRETS_MASTER_KEY` (key id per row, NEXT-key rotation + `scripts/ops/secrets-rekey.js`), hash-chained audit, password-only step-up cookie, atomic fsynced render to `/var/lib/gatetest/unit-env/platform.env` (last EnvironmentFile of `gatetest-web@.service`, path unit runs the blue/green restart), shadow detector, alive/dead/cannot-tell probes, env catalogue moved to `website/app/lib/env-catalogue.js` with a drift test. Control pairs `tests/admin-secrets-{store,apply,wiring}.test.js`. Store + API #849 (cb26ff38, 29 Sep), UI #847 (11407db5, 30 Sep). Box install + migration are the owner's: `docs/ops/secrets-panel.md`. Unverified live until deployed.
- DavenRoe DR-4 / DR-6 / DR-a (refs #842): authBypass reads an HTTP-client call (`api.post(...)` on `axios.create`) as a consumer, never a route (`src/core/http-client-calls.js`), and grades FastAPI / Flask routes with `Depends(get_current_user)`, `APIRouter(dependencies=)` and `include_router(..., dependencies=)` as auth (`src/core/python-routes.js`) — DavenRoe @ 1dea3658 authBypass 73 → 3 errors (anonymous calculators in catch_up / daven_audit / us_tax that do not say they are public); `change-me` / `dummy` shapes are placeholders, one list in `src/core/env-placeholder.js` (secrets 1 → 0); dev-only tools (`scripts/`, `bin/`, `cli/`, package.json-named `tools/`; never under `public/`) are on record, not "the moment this ships" (`src/core/operator-cli.js`, hardcodedUrl 2 → 0 errors, dataIntegrity 7 → 5 PII lines); `gateStatus: REPORT_ONLY` under `--report-only` (additive enum member, schema v1, exit 0, console "REPORT ONLY — N errors, gate not applied"). Control pairs `tests/auth-bypass-http-client.test.js`, `tests/dev-tools-and-placeholders.test.js`, `tests/report-schema-contract.test.js`; quiet cases fail on origin/main.

## 3. The 20 moves — what a senior developer would recommend GateTest FOR

Source: the 2026-09-25 internet complaint crawl (SonarQube, Snyk, CodeQL,
Semgrep, CodeRabbit, Checkly, Lighthouse, Playwright/Cypress, G2/Capterra/HN)
mapped to the engine. Status re-verified 2026-09-30 against `origin/main` `9f17e6c6`
(PR state and merge sha from `gh`, "missing" measured by grepping the tree).
DONE means merged to main; none of it is live until §0 item 1.

| # | Move | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | Security probes in the default suite inside a time budget; deferred line says what was skipped | DONE | #749 merged 2026-09-26 (8ae43c23); `security` is in `standard` (`src/core/config.js:147`), `quick` discloses the omission |
| 2 | Public precision scoreboard per rule, regenerated by the nightly corpus run | DONE | #765 merged 2026-09-26 (26d4d2b1); `website/app/data/precision.json` on main now carries 93 `rules[]` (nightly 2026-09-29, c07a12df). The live `/precision` still shows the 2026-09-26 table with "will populate rules[]" until §0 item 1 |
| 3 | Recorded override `--accept-risk <id> --reason`, in report and PR comment, expiring | DONE | #757 merged 2026-09-26 (7ef96346, from #747 59bc7991); `.gatetest/accepted-risks.json`, report, PR comment, SARIF suppressions |
| 4 | Time-to-verdict contract: ETA first, per-module timing, `--budget` degrades and reports | DONE | #773 merged 2026-09-26 (1f8d99fa) |
| 5 | Test-impact analysis: `--diff` runs only tests the import graph touches | OPEN | Still true: `--diff` only narrows the file set each module scans (`runner.js` `_incrementalContext.changedFilesAbs`, `base-module.js`); `src/modules/unit-tests.js` never reads the changed-file list, and nothing maps changed source -> tests via `src/core/import-graph.js`. Missing: a selector that runs only the tests reaching a changed file, with the skipped tests named |
| 6 | Flaky-test ledger with auto-quarantine and a flake rate on the badge | IN PROGRESS | Ledger in `.gatetest/memory.json` (`src/core/flaky-ledger.js`, `test-outcomes.js`; node:test TAP + spec only, jest / mocha / pytest report "not measured"), 14-day expiring quarantine, `--no-quarantine`, `flaky[]` + `summary.flake` in JSON, PR comment section, badge `flake N%` / `flake not measured`. Missing: no CI-to-server path carries a repo's ledger into a scan record yet (hosted scans do not run customer tests), so live badges read "not measured" until one does |
| 7 | One PR comment, updated in place, top blocking first | DONE | `scripts/post-scan-summary-comment.js` PATCHes its own comment; `tests/post-scan-summary-comment.test.js` |
| 8 | Fix PR with proof: failing-to-passing output, tests added, fake-fix verdict, diff cap | DONE | #754 merged 2026-09-26 (fb47ce3f) |
| 9 | Self-host parity: Docker image, GitLab template, Bitbucket pipe, GitLab login | PARTIAL | GHCR image yes (tags 1.61.1 / latest, #516); GitLab CI template yes as a generator (`gatetest --ci-init gitlab`, `src/core/ci-generator.js:178`; the generated file was not run here); GitLab login in code (#836, 90c03589; live after deploy). Missing: a Bitbucket pipe or pipelines template (README only says the CLI works on "any other CI") |
| 10 | Pricing copy answers per-token and double-billing complaints; usage receipt per run | PARTIAL | Live `/pricing` says tiers are one-time, "billed per run", "Charged at checkout, no seats, no minimum". Missing: no per-token / double-billing answer on the page, and no per-run usage receipt in `src/` |
| 11 | Real analyzers for Go, Python, Java, Rust, measured on the corpus | OPEN | Still true: `go-lang.js`, `python.js`, `java.js`, `rust-lang.js` are 13-14 line wrappers over regex patterns in `src/core/universal-checker.js`; `standard` runs none of them (only `full` / `nuclear`). Missing: real analyzers and a per-language corpus measurement |
| 12 | Root cause on every red run: classifier verdict, blame commit, replay command | DONE | #774 merged 2026-09-26 (c012b042); `src/core/root-cause.js` |
| 13 | Site-scan honesty defaults: WCAG2AA, warnings off, TTFB sampled alone, per-page timeout | PARTIAL | `src/core/config.js:551-555` still says `accessibility.standard: 'WCAG2AAA'`, `includeWarnings: true`, and nothing in `src/` reads those keys (dead config that contradicts the move; delete or wire). TTFB is a median of 3 in `performanceBudget` (needs the runtime worker); crawler has per-request timeouts. Missing: an audited default set matching the four items |
| 14 | Every finding tagged deterministic vs model-judged; model-judged never blocks by default | DONE | #751 merged 2026-09-26 (8e5a1885) |
| 15 | Onboarding mode: `--report-only-until <date>`, baseline wizard | DONE | #787 merged 2026-09-26 (6ae7ae5c); `baseline --init` in `bin/gatetest.js` |
| 16 | Convergence guard on fix and crawl loops; never re-flag own fix | DONE | #750 merged 2026-09-25 (5cdca294); `src/core/convergence-guard.js` |
| 17 | Zero writes into the scanned checkout unless asked | DONE | #757 merged 2026-09-26 (7ef96346, from #748 c630a30e); `--report-dir`, `--no-artifacts` |
| 18 | Weekly public head-to-head vs Semgrep, CodeQL, Sonar on the same corpus | DONE | Scheduled run 2026-09-28 11:22Z green (run 36415305832); rolling PR #800 merged 2026-09-29 (c0eefef8); `head-to-head.json` on main generated 2026-09-28. Live `/precision` still shows 2026-09-26 data until §0 item 1. SonarQube / CodeQL stay "not measured" with a reason, by design |
| 19 | Editor loop: published extension running the real CLI, pre-commit `--diff` under 10 s | PARTIAL | Extension 1.1.3 on the VS Code Marketplace and Open VSX (#514). The 10 s bar is unmeasured: one `--suite quick --diff --parallel` probe on this Windows box (one changed source file, no `node_modules`, machine loaded) had not finished after 5 minutes and was stopped. Missing: a timed run on a normal machine and a CI guard on it |
| 20 | False-positive SLA: public form, corpus test per retraction, counter on the site | DONE | #763 merged 2026-09-26 (2eb38aea) |

Order of work after moves 1 and 17: 3, 14, 16, 4, 12, 2, 20, 8, then the rest.
Each move ships as one builder PR with a control pair and a line in this table.
Open by code: 5, 6, 11 (not started), 9, 10, 13, 19 (partial).

## 4. How to check the gate again (network only, no local load)

```
curl -s https://gatetest.io/api/platform-status        # commit == origin/main? lastPullDeploy result + reason
curl -s https://gatetest.io/api/status                 # ok/healthy/version/commit only; missing env is not listed
git rev-list --count <served-commit>..origin/main      # commits behind
npm view @gatetest/cli version bin ; npm view @gatetest/mcp-server version
curl -sI https://github.com/marketplace/actions/gatetest-quality-gate
curl -sIL https://github.com/crclabs-hq/GateTest/releases/latest/download/gatetest-health-check.zip
gh run list -R crclabs-hq/gatetest-arena --limit 5     # green job is not proof: read the repair log
gh issue view 532                                      # owner list; regenerated daily from a JSON last edited 23 Sep
```

## 5. Recall against the sibling platforms (owner direction 2026-09-28)

GateTest passed tallrig.com with 0 errors while Tallrig's own board showed 24 reds.
Recall is now measured against each platform's board (Tallrig, Gluecron, AlecRae,
DavenRoe); every red we miss is our gap. Epic: #807 (closed 2026-09-29 with R1-R12
carried here). Status re-verified 2026-09-30 against `origin/main`; a live re-run of
tallrig.com is the owner's after §0 item 1.

| # | Build | Status | Evidence / what is missing |
|---|---|---|---|
| R1 | `--crawl` runs the crawl-capable set, refuses loudly otherwise | DONE | #814 merged 2026-09-28 (338d3339), issue #802 closed; `estate` is deliberately not in `CRAWL_CAPABLE_MODULES` (`estate.js:57`) |
| R2 | Hosted scan: hard budget, partial results, permalink, runtime reason | DONE | #818 merged 2026-09-28 (2199d1d0) + #804; issue #768 closed. Live check (slow target returns `partial: true` near 50 s) owed after deploy |
| R3 | `estate`: every host from sitemap / cert SANs / list, per-host verdict | DONE | #822 merged 2026-09-29 (63edf38f); module 122, in `full` / `nuclear` / `wp`, not `quick` / `standard`. Tallrig run: five `*.tallrig.app` = gateway-up-app-dead, `vapron.ai` / `api.vapron.ai` = unexpected-ip |
| R4 | `dnsPosture` / `mailPosture`: SPF/DKIM/DMARC alignment, PTR, wildcard, delegation, 0x20, legacy domain -> uncontrolled IP | PARTIAL | SPF / DMARC honesty in `--server` merged in #828 (b6a6f870, 2026-09-29); legacy domain -> uncontrolled IP is `estate` `unexpected-ip`. Missing: PTR / HELO, wildcard, delegation, 0x20 — no such code in `src/scanners/`. Issue #829 open: `website/app/api/scan/{server,nuclear}/route.ts` repeat the old DNS claims |
| R5 | `deployFreshness`: served sha vs expected | DONE | #828 merged 2026-09-29 (b6a6f870); `deploy/fresh` is NOT CHECKED with nothing to compare (`src/core/readiness-probe.js`) |
| R6 | Blank render / hydration crash in runtimeErrors; CLI runs it when a browser exists | OPEN | Not started: `src/modules/runtime-errors.js` only matches hydration-mismatch console text; no check that a page rendered visible content. Missing: blank-render detection and a CLI path that runs it when Chromium exists |
| R7 | WordPress gap checks: dir listing, PHP notices in HTML, admin-ajax, brute-force probe, TTFB per page | OPEN | Not built for #807: the ten existing `wp*` modules cover exposed files, version leak, xmlrpc, CVEs, malware, users, admin protection, PHP EOL, themes, backups. Of the five named checks only the rate-limit half of brute-force is there (`wp-admin-protection.js`) and `liveCrawler` flags slow pages by threshold (not TTFB per page). Missing: directory listing, PHP notices in HTML, `admin-ajax` (no such code in `src/`), active brute-force probe, per-page TTFB |
| R8 | WordPress repair recipes per finding; automated fix + receipt on platforms we run | OPEN | Not started: no recipe / repair code in any `src/modules/wp-*.js` |
| R9 | Crawler apex double count / rel=canonical (retracted T-01) | DONE | #820 merged 2026-09-29 (f510ae8c); issue #806 closed. Known gap: a site-wide canonical to `/` would collapse a crawl (no guard) |
| R10 | Telemetry host guard + opt-in wiring (default = owner's line) | DONE (default is OWNER) | #811 merged 2026-09-28 (c25802e9). Issue #801 still open: `TELEMETRY_DEFAULT = 'on'` (`src/core/scan-telemetry.js:87`) is Craig's one-line decision; 1.60.0 and earlier still post to gatetest.ai until deprecated |
| R11 | Report `schemaVersion` + contract test + docs/api/report-schema.md | DONE | #813 merged 2026-09-29 (d79cfd5b), issue #803 closed; `docs/api/report-schema.md`, `tests/report-schema-contract.test.js` |
| R12 | `apiHealth` honesty: "0 broken" only over confirmed endpoints, NOT CHECKED when every probe was a guess | DONE | #828 merged 2026-09-29 (b6a6f870) |
