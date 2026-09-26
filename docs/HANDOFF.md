# HANDOFF — carry on from here without delay

> **Start with `docs/LAUNCH_BOARD.md`** (added 2026-09-25): the live customer-ready
> gate, the do-not-redo list with PR numbers, and the 20 product moves with status.
> This file is the dated history behind it. Owner-only items: issue #532.


Same section numbers as `docs/HANDOFF.md` in Gluecron.com and Tallrig, so a
session on any platform, under any of Craig's three accounts
(ccantynz@gmail.com, ccantyusa@gmail.com, ccanty48co@gmail.com), reads the same
map. The living copy with the resume table is the Claude doc
"Cross-platform testing loop — handoff" (2026-09-22); this file is the repo
record for any machine. Update both when state changes. Verify every claim
below against the live system before repeating it (CLAUDE.md doctrine #8).

## 1. Hierarchy (owner's standing order, 2026-09-22)

Craig owns every credential, infrastructure, payment, legal-filing,
production-data and public-content decision. An escalated proposal is resolved
only by Craig, never by an agent.

```
Craig — owner
└─ Marco (CEO) — the always-on brain on box 161; every officer reports to it, it reports to Craig
   ├─ CTO   builds, deploys, fix proposals      → site-medic × 9 platforms (GateTest is one)
   ├─ COO   self-heal, backups, fleet timers
   ├─ CFO   ledgers, budgets                    → accountant × NZ AU US UK SG
   ├─ CLO   contracts, compliance               → legal × NZ AU US UK SG
   ├─ CMO   social, SEO                         → social-media × 9, seo × 9
   ├─ CRO   market intel, audits; holds the cross-platform scoreboard
   ├─ CSO   secrets, access, perimeter, integrity, incidents
   │        → box-integrity, secrets-warden, perimeter-sentinel (daily);
   │          access-reviewer, dependency-auditor (weekly); incident-commander (on demand)
   │        [built 2026-09-22, held]
   └─ Curator  Marco's memory flywheel
```

Box 161 (66.42.121.161, tailnet `jarvis`) is both Marco's home and GateTest's
production host. A finding a session cannot fix itself becomes a proposal up
this chain; anything on Craig's list stops at Craig.

## 2. The way of working (owner, 2026-09-21/22)

- The audience is DevOps engineers and senior full-stack developers. Every
  finding and every fix meets the bar one of them would respect: evidence, an
  explicit "not checked" list, journeys walked by a machine on a schedule.
- All nine platforms test each other as paying customers, daily, and push
  each other hard. "Better than" means a number measured the same way against
  the incumbent (GitHub, Vercel, Cloudflare, Render, Mailgun, Twilio,
  SonarQube/Semgrep/CodeQL, Intruder/Astra). Testing never stops.
- Never stop production. Defects are fixed forward through a PR with CI and
  deployed by the box's own pull timer. No rollbacks, no pauses, no test that
  degrades a live service (the pen-test probes stay off).
- Evidence shape for every finding, in this order: id + severity; URL or
  command with time and source host; expected; observed; raw line; repro;
  competitor measured against. The owner answers same day with a PR + sha, the
  code line proving a false positive, or "already known" + id. Silence is not
  an answer. Proof is the re-run.
- A false positive in a scanner is a defect in the scanner (doctrine #9). Fix
  with a control pair, retract to the peer with the code line.
- Usage doctrine (CLAUDE.md): at most two agents at a time, scout/builder/
  reviewer, no polling, a green quiet session is a valid end state. Merge only
  green; admin merges and SSH to any box are blocked for desktop sessions.
- Public copy follows `docs/VOICE.md` and names no AI vendor; both are tests.

## 3. How to reach the other sessions

From a Claude Code session on Craig's desktop (DESKTOP-TNJ2FN8, tailnet
100.99.126.88): `ListAgents`, then `SendMessage` by name. Names on 2026-09-22:
"Tallrig - 20-09-26", "Gluecron-Code recommendations"; Marco's own session is
reached through the bridge session "Full stack development platforms
hierarchy". Names change per session; search by platform name and prefer the
row marked "on this machine". Never paste secret values in a message; say
where a value is set.

Repos on this PC: GateTest `C:\dev\crclabs-hq\GateTest` (GitHub
crclabs-hq/GateTest); Tallrig `C:\dev\ccantynz-alt\Tallrig`; Gluecron
`C:\dev\ccantynz-alt\Gluecron.com`. Memory for this project lives at
`C:\Users\ccant\.claude\projects\C--dev-crclabs-hq\memory` and is shared by
all three accounts on this PC (keyed by project path); read MEMORY.md first.

## 4. GateTest: exact state right now (2026-09-22 06:20Z)

| Thread | State | First command or action |
| --- | --- | --- |
| Production | live gatetest.io = ec3b8cc9 (built 04:04Z); main = 6e3635d8 (operator-voice copy #624, flat design #625). Pull-deploy timer installed on box 161 ~05:40Z, had not deployed by 05:52Z | `curl -s https://gatetest.io/api/platform-status`; if behind, Craig reads `/var/lib/gatetest/pull-deploy-status.json` and `journalctl -u gatetest-pull-deploy -n 40` on the box |
| PR #629 chase-workflow fix | CI on 2ce9dd36 after the bashSafety gate rejected `set +e` | `gh pr checks 629`; when green merge, then `gh workflow run pre-listing-chase.yml --ref main`, read the comment on #627 |
| Crawler fixes | builder in the MAIN checkout on `fix/crawler-loop-findings`: script-embedded hrefs, `rel=preconnect` hints, stale/shared report file, per-page timeout, compression probe without Accept-Encoding. Staged, not committed | `git status`; `node scripts/run-tests.js --timeout 60000 tests/*.test.js`; `npx eslint src tests`; commit, push, PR; send the sha to Gluecron and Tallrig for the re-crawl |
| Free-scan result honesty (Tallrig F1–F5) | builder in worktree `GateTest-wt-scanui` on `fix/free-scan-result-honesty`: grade from blocking findings only, `owner/repo @ sha · scanned <time> · report <id>`, honest timing label, fix button only for owners, permalink. Staged, not committed | same, plus `cd website && npx tsc --noEmit`; PR; sha to Tallrig for the re-walk |
| Issue #630 | CLI quick suite >10 min on a 76-package monorepo; no file count/ETA up front | append Tallrig's per-module timing; profile `--suite quick --json` on a large workspace |
| Marketplace listing | preflight READY (0 blockers); blocked on the webhook secret and duplicate App 3322634 | issue #627; Craig only |
| Worktrees | `GateTest-wt-chase` (ops/chase-fix), `GateTest-wt-scanui`, `GateTest-wt-handoff` live; other `GateTest-wt-*` folders are dead leftovers | `git worktree list`; remove only after the PR merges |
| Dev preview | `next dev --webpack` when node_modules is a junction (Turbopack refuses it) | launch config example in memory note gatetest-launch-readiness-2026-09-22 |

Fleet crawl schedule proposed for Marco (until Marco sets one): daily 06:00Z
`--server` probe on every platform; daily `--crawl --crawl-max 60`, one platform
at a time, never concurrent; weekly authenticated journey with
`--crawl-storage-state` from a throwaway account (file on the box, never in
chat); weekly head-to-head number on the CRO scoreboard; two misses in a row
escalates.

## 5. Findings ledger (2026-09-22)

GateTest → Gluecron (crawl + server probe, 05:53Z):
- G1 MEDIUM — 7× HTTP 429 on /login and /register during one client's 60-page
  crawl. Accepted; Gluecron fix on `fix/gatetest-crawl-findings` (tight buckets
  count only POST/PUT/PATCH/DELETE; page views 120/min). Proof: 60-page re-crawl
  with zero 429s once the sha arrives.
- G3 LOW — no Permissions-Policy (fixed in the same branch); `'unsafe-inline'`
  in script-src (open, their next move #4). G4 INFO — no AAAA (DNS escalation).
- G2 RETRACTED — "no compression" was our probe sending no Accept-Encoding.

GateTest → Tallrig (server probe + crawl, 05:54–06:02Z):
- T1 — tallrig.com first byte 0.31 / 4.34 / 1.17 / 1.15 / 1.89 s: box 158
  stall mode, real, extinguished by the move to box B. The 32 s reading was our
  own concurrent crawl and was withdrawn. Crawl timed out at the 120 s module
  ceiling with zero pages; re-run after the per-page timeout lands and against
  box B when its address arrives.

Tallrig → GateTest (customer walk, 06:0xZ), all accepted, fix branch
`fix/free-scan-result-honesty`: F1 grade F from warnings only; F2 no
sha/branch/time/id; F3 "0.1 s" times read as fake; F4 fix button for
non-owners pre-sign-in; F5 no permalink. G2 (CLI): quick suite on their
76-package monorepo ran >10 min → issue #630.

GateTest defects found by the loop, fix branch `fix/crawler-loop-findings`:
script-embedded `href="$2"` reported as a 404; `rel=preconnect` hints checked
as links; two concurrent crawls shared one report and a timed-out run
reprinted the previous report; no per-page timeout; compression probe without
Accept-Encoding. The gate also caught `set +e` in our own workflow (#629).

Known gaps not to re-report until the item closes: Marketplace webhook 503
(#627); production behind main (section 4); hosted web-runtime dispatch into
Tallrig 404s (KI #111, needs TALLRIG_API_TOKEN on box 161).

## 6. Escalations — Craig's line only (status, never re-ask)

- SSH to any box: blocked for desktop sessions by policy. Craig runs box
  commands; a session provides the exact command.
- Marketplace webhook secret (box env + App 3766251 settings), duplicate App
  3322634 uninstall, repo secrets CRON_SECRET and GATETEST_ADMIN_PASSWORD:
  issue #627, chased weekly by `pre-listing-chase.yml`. Deferred by Craig
  while Tallrig moves to box B; none depends on that move.
- TALLRIG_API_TOKEN on box 161: waits for Tallrig on box B to mint one.
- Marketplace submit, pricing, Stripe, DNS, brand decisions, new third-party
  services, insurance and terms for the pen-test product: Craig.
- Next product sequence (decided 2026-09-22, memory note
  gatetest-next-product-sequence-2026-09-22): Live Security Scan first ($999
  first test, $249/mo retest), Compliance Evidence second; pentest blockers are
  a lawyer and insurance, not code.

## 7. Next moves for GateTest (in order)

1. Land `fix/crawler-loop-findings` and `fix/free-scan-result-honesty`; send
   shas to Gluecron and Tallrig; re-crawl both and re-walk the free scan.
2. Merge #629, dispatch the chase, confirm the comment on #627.
3. Confirm the pull-deploy timer deploys main; until then each merge needs
   Craig's manual deploy.
4. Profile and fix #630 (quick suite on large workspaces; print file count +
   ETA before scanning).
5. Get from Marco the nine platforms' hostnames and the scoreboard location;
   stand up the fleet crawl schedule as a repo workflow (deterministic, no
   model call), one platform at a time.
6. When box B is public, run the real Tallrig crawl and write the fresh
   GateTest onboarding checklist against `scripts/deploy/deploy-on-box.sh` +
   `install-pull-deploy.sh` for Tallrig's FINISH LINE walk.

## 8. Traps that cost time this week

- `gh run list --workflow "<display name with (parentheses)>"` fails to
  resolve; use the file name. Under the runner's `bash -e` that killed the
  step. Never `set +e` — the bashSafety gate blocks it; tolerate per command.
- Two `--crawl` runs at once shared one report file; a timed-out run printed
  the previous report as its own. Run crawls sequentially until the fix lands.
- Our server probe measured TTFB while our own crawl hammered the host and
  reported 32 s; five clean samples read 0.3–4.3 s. Measure alone, then report.
- Turbopack refuses a junctioned node_modules in a worktree; use
  `next dev --webpack` / `next build --webpack` locally.
- A PR branch behind main cannot be merged without admin; merge main into the
  branch (never rebase or force-push) and let CI re-run.
- The desktop's SSH key was regenerated 2026-09-19; box 161 trusted only the
  old one. `ssh -i ~/.ssh/gatetest_deploy jarvis` worked; then append the new
  public key on the box.
- The pull-deploy timer is NOT installed by the recovery deploy; it is a
  one-time `sudo scripts/deploy/install-pull-deploy.sh` on the box.
- Bot-authored PRs (github-actions) trigger no CI; a human-account empty
  commit starts it.
- "Up to date" is not "built". On 23–24 Sep the box's checkout matched main
  while website/.next had no BUILD_ID; pull-deploy.sh reported up-to-date and
  deploy-on-box.sh exited early on every tick for 36 hours while the running
  process served a bare 500 on every static route (API routes stayed 200, so
  every health signal was green). Verify a deploy by fetching / from outside:
  200, a real body, the expected commit. Never by /api/health. PR #727 makes
  an unbuilt box rebuild itself; PR #724 gates the switch on / and /pricing.
- A `next dev` run on the box leaves .next/dev/types/validator.ts naming
  routes that may no longer exist; `next build` type-checks it and fails
  (TS2307 on app/preview/* after #719). Delete website/.next before building;
  deploy-on-box.sh now clears .next/dev and .next/types itself (#727).
- On this Windows desktop the deploy shell tests spawn `bash`; the default
  PATH finds WSL's bash, which mangles Windows paths. Put
  C:\Program Files\Git\bin first; the real-run cases still skip for lack
  of flock, so CI on ubuntu is the proof for scripts/deploy changes. New
  worktrees come out CRLF (core.autocrlf): set it false and re-checkout
  before running bash on them.

## 9. Exact state at 2026-09-23 17:15Z — resume here from any account

Written for the three owner accounts (ccantynz, ccantyusa, ccanty48co) so any session continues without re-discovery. The launch board artifact is private to the account that made it; this file and the repo are the shared truth. The GateTest session on the desktop is addressed as "Gatetest" in ListAgents; Tallrig's session as "Tallrig (fork)"; Gluecron holds cross-session messages for approval, so use ccantynz-alt/Gluecron.com#140 for anything that must reach them.

### What is live (production = main, verified by platform-status)
- gatetest.io serves main. The box unfroze at 14:39Z on 23 Sep after 16 hours stuck on 7026fbec. Every merge since deploys within about eight minutes.
- Live today: homepage v2 defect fixes and iPad scroll fix (#688), the site-wide v2 design system with the system/light/dark toggle (#696), every restyled public page (#712, #705), self-hosted font so builds never touch the network (#689), pull-deploy fallback to in-place when blue/green is not installed (#685), the readiness probe comparing live to main (#700), the Tallrig push-event receiver at /api/integrations/tallrig/events (#674), and the rule-precision rounds #654 through #692 verified by Tallrig on their tree (438 → 237 blocking findings, prompt-safety 21 → 3 errors).
- The v2 homepage is still served at /preview, not at /. The swap is the last step of #686 and a builder holds three unpushed commits for it (see "Builders" below).

### Open PRs (all should merge with auto-merge; Craig's rule: always push and merge)
- #710 deploy pipeline fails loud (closes #706): CI red on two no-op catch blocks in scripts/ops/deploy-stalled-issue.js and a status-file reader that parses the whole file; a builder holds the fix unpushed on branch fix-710.
- #702 admin shell with both themes (closes #691 and #690): CI red on a test password literal in scripts/ops/admin-screenshots.js, the colour-literal test miscounting the admin token file, and a smoke test leaking a handle in teardown; a builder holds the fixes unpushed.
- #717 public-api-key rule needs client-flow evidence (closes #713): green, arm auto-merge if it is not.
- Draft PR for the /stack cross-sell (Refs #715) is being written by the marketer brief; it needs Gluecron's block and Craig's approval, never auto-merge.

### Open issues (after the 23 Sep clean-up: 9 → 5)
- #706, #691, #690, #713 close with the PRs above. #715 is the cross-platform copy decision (see below). #532 is the automated owner list, regenerated from docs/ops/blocking-on-craig.json (#714 added the seven owner items found this week).

### Decisions Craig made on 23 Sep (do not re-ask)
- Homepage v2: ship it and carry the design to every page (#686). Done except the / swap.
- Light and dark for customers and admin (#690): shipped for customers in #696; admin side in #702.
- Always push and merge: arm auto-merge on every PR; merge green PRs at once (admin path when only "behind" and no file overlap); never merge red checks.
- Cross-platform copy: each platform is complete on its own; GateTest is an optional audit layer; copy naming Gluecron or Tallrig ships only after that platform supplies its own sentence and Craig approves the paragraph (#715). Tallrig's block is on #715 verbatim; Gluecron's is pending on ccantynz-alt/Gluecron.com#140. A marketer role exists at .claude/agents/marketer.md with these rules.
- A clean board: issues closed when done, duplicates folded into #532, the launch board shows open work first with shipped rows folded.

### Owner-only items (the box and accounts), in the order that unblocks most
1. Box 161 env: rotate the refused GitHub token; set GOOGLE_CLIENT_SECRET, TALLRIG_API_TOKEN, GATETEST_DAILY_API_BUDGET_USD, GATETEST_ADMIN_PASSWORD (admin login fails until set), a fresh CRON_SECRET (also in the repo secret and the cron workflow); restart gatetest-web.
2. Blue/green install from docs/deploy/PULL-DEPLOY.md "Blue/green" (removes the 502 blip on every merge). Until then #685's fallback keeps deploys working.
3. Tallrig console: pushEvents.register with target https://gatetest.io/api/integrations/tallrig/events; set TALLRIG_PUSH_SECRET and TALLRIG_PUSH_KEY_ID on the box; then tell the GateTest session so Tallrig fires the cross-test.
4. GitHub, signed in: Marketplace listing (logo, EU declarations, webhook secret, Request publish); retire duplicate App gatetesthq; repo secrets GATETEST_ADMIN_PASSWORD and GATETEST_APP_PRIVATE_KEY.
5. CLAUDE.md doctrine: the proxy in front of gatetest.io is Coolify's Traefik on box 161 (verified by Tallrig), not the Tallrig gateway.
6. DNS (DMARC p=reject, MCP registry TXT); box-158 secret rotations; WordPress.org submit; Cursor/Windsurf checks.

### Builders (worktrees under .claude/worktrees/, resumable by agent id from the desktop session that spawned them)
- a099e9eb2d1f82d70: homepage swap (#686 phase 3), three commits unpushed on worktree-agent-a099e9eb2d1f82d70.
- a9fb7f049b8c400ca: #710 CI fixes on branch fix-710, unpushed.
- ada7b464b8d3245ff: #702 CI fixes, twelve commits unpushed.
- a1f6bc9cc749738b6: marketer draft for #715, starting.
If a new session cannot resume them, the branches above are the state; start a fresh builder from the worktree's branch, never from scratch.

### Cross-platform loop (docs/HANDOFF.md sections 3 and 5 still apply)
- Tallrig owes nothing; we owe them merge shas as PRs land and the buyer re-walk request in both themes once / shows the v2 page. Their clean build fd8298b1 crawled all clear from our seat.
- Gluecron: briefed on #140 with the deadline, the handoff, our nine-finding verdict on their repo (four real, four our false positives now fixed in #694), and the copy asks. No reply as of 17:15Z on 23 Sep.

### Traps added this week
- Restarts of the desktop session stop background builders; their worktrees survive. Check `git status` and `git log origin/main..HEAD` in each before assuming work landed.
- GitHub's PR head can lag a push by a minute; confirm with `git ls-remote`.
- The Turbopack build fails inside worktrees because website/node_modules is a junction outside the root; use `npx next build --webpack` there.
- A merge into main puts every other PR "behind"; branch protection is strict, so each merge restarts the others' CI. Merge green PRs with the admin path when files do not overlap.

## 10. Exact state at 2026-09-24 18:00Z — the launch-day outage and what changed

- **Outage.** gatetest.io / and /preview served a bare 500 from 23 Sep 17:47Z (first
  readiness-probe red) to the moment the box was rebuilt; from 17:51Z on 24 Sep the whole
  site was 502 for a few minutes after a restart with no build on disk. Root cause: the
  box's production build failed on every tick since #719 (stale .next/dev/types naming the
  removed /preview route), a killed hung build had already emptied .next, and both deploy
  scripts treated "HEAD == origin/main" as nothing to do. Not memory: the kernel OOM kills
  on the box are jarvis-audit's, and 4.9 GB was free.
- **Fix on the box (owner, one command):** delete website/.next, `npm run build`,
  `systemctl restart gatetest-web`, then GET / must be 200 on main's commit.
- **Code:** #724 merged (blue/green switch requires the new instance to serve / and
  /pricing 200 with a 1 KB+ body; in-place smoke includes / and fails loudly). #727
  (unbuilt box rebuilds with --force-build and records "rebuilt: build output was
  missing"; deploy-on-box.sh clears .next/dev and .next/types before every build).
  Still open on #723: the readiness probe must open the stalled-deploy issue on a
  surface failure, not only on lag.
- **Also today:** #725 — the heavy suite on main has been red since #702
  (admin-signed-in-smoke times out at 120 s, non-blocking, so nobody saw it).
  Marketplace preflight says DO NOT SUBMIT while / is 500; it clears itself when
  the homepage is back. Tallrig is holding the free-scan re-walk (their F1–F5) until the
  fix sha is live; Gluecron's G1 closed on our proof crawl.
- **Domains:** gatetest.ai is not registrable at list price (Name.com/Porkbun show
  "make offer"); Craig bought gatestest.ai, gatetest.dev and gatetest.app — all three
  need DNS to box 161 and a permanent 301 to gatetest.io in the Traefik dynamic file.
- **Handoff copies:** this file (repo), the Claude doc "Cross-platform testing loop —
  handoff" (resume table kept current), and the shared memory dir on the desktop
  (keyed by project path, so all three accounts see it).

## 11. Customer-readiness audit, 2026-09-25 — what was code, what is the owner's

Asked "are we customer ready?" and answered it from the tree and the probe, not
from memory. Main was `9d6f458`; no open PRs; fast suite 567 files green once
`node_modules` existed (a fresh clone has none — the first run's 13 failures were
that, not code). Production is on main (verify-deploy IN SYNC). What the
readiness probe (run 36100584069) said was broken, and where each went:

- **`surface/` — home page missing `id="pricing"`.** Code. #719 promoted the v2
  page without the anchor; 25 links across the site pointed at `/#pricing`, plus
  two dead `/#features` and two `/#modules`. Fixed; `tests/homepage-anchors.test.js`
  resolves every `/#anchor` in the app against the ids the home page renders.
- **`product/scan` — "could not read repo file tree".** Code AND owner. The canary
  (this repo) is over the 40 MB archive cap, so the loader fell to the tree API with
  the box's refused token and never asked anonymously. Fixed in
  `gluecron-client.ts` (anonymous tree + raw.githubusercontent.com as last rungs,
  failed snapshots memoised 30 s). The token itself is still the owner item
  `box-github-token`; private-repo scans stay broken until it is rotated.
- **`config/important` — `GOOGLE_CLIENT_SECRET`, `TALLRIG_API_TOKEN` missing.**
  Owner only (`box-secrets`).
- **Cron Ticks workflow 401 on every run.** Owner only (`cron-secret-repo`); Tallrig
  Cron is the caller that should stay, the workflow is the stopgap.
- **Heavy suite red since #702 (#725).** Code. `admin-signed-in-smoke` finished
  28/28 and was cancelled at 120 s because SIGKILL to the `sh -c` wrapper orphaned
  `next start`, whose pipe kept the file alive. Process-group kill + pipe destroy;
  77 s, exit 0.
- **Docs lying about the present:** ROADMAP rows 79/93 said production was stale
  and gatetest.ai was down (resolved, marked); 80/82 date-stamped to today's names;
  `docs/ops/GO_LIVE_RUNBOOK.md` bannered as superseded (Vercel steps are forbidden).

**Still not customer-ready until the owner does, in this order:** box secrets
(`box-secrets`, `box-github-token`, `admin-password-box-env`), the CRON_SECRET
rotation, the Resend re-key (`anthropic-key-rotate` step 8 — until then no MCP key
e-mail and no billing portal), then the Marketplace submission
(`github-app-public`, `mp-webhook-secret`). All in `docs/ops/blocking-on-craig.json`
and the pinned `craig-only` issue.

## 12. Exact state at 2026-09-25 17:30Z — mandate, division of labour, what is parked

Owner mandate today: this file is kept current at every state change because build
usage is shared across three accounts (ccantynz, ccantyusa, ccanty48co); a session
on any of them resumes from here. Also today: "nothing visible may say Vapron", box
158 is retired (Tallrig now serves from box B: 64.177.13.38 / tailnet
100.92.50.104 / `tallrig-b`; GateTest and Gluecron stay on 161), and every platform
session pushes against the others ("20X mandate").

### Corrections to §9 (verified live 2026-09-25 16:50Z)
- v2 homepage IS live at `/` (#719); `/preview` 308s. §9 "swap unpushed" is stale.
- #514 (CLI `--format json`/`--file` + VS Code in-process), #515, #516 are MERGED.
- Production = main = 8b3fab9b, healthy. `/api/status`: ready; missing_important =
  `GOOGLE_CLIENT_SECRET`, `TALLRIG_API_TOKEN` only. Readiness Probe red for those
  two; Cron Ticks red (CRON_SECRET mismatch); every other scheduled workflow green.
- Marketplace: `github.com/apps/gatetest-hq` 200; `github.com/marketplace/gatetest-hq`
  404 (listing not submitted); `POST /api/marketplace/webhook` 503 (secret unset).
- Owner items live in `docs/ops/blocking-on-craig.json` → issue #532 (16 items, P1:
  anthropic-key-rotate, box-secrets, box-uncommitted-changes, cron-secret-repo,
  admin-password-box-env, mp-webhook-secret, blue-green-install, box-github-token).

### Division of labour with the other platform sessions (agreed 2026-09-25)
- "DavenRoe Platform quality" session owns the internet complaint crawl, the
  solved/partial/missing map (rows C1-C23), the ranked 20 moves and the
  consolidated four-platform launch board. GateTest session owns every code change
  in this repo, the receipt per map row (command + output), and cross-tests GateTest
  runs against siblings. Receipts delivered: suites quick 42 / standard 46 / full 89
  / nuclear 96 (`security` only in full and nuclear; default is standard); corpus
  20 repos, 212 blocking, express/got/gin/vapor/apollo-server at 0; fix-PR flow
  NOT proven (see arena). Receipts owed: C17 (pa11y WCAG2AAA + includeWarnings
  default), C20 (unknown flag exits 0 unless --strict/CI, then 2 — #496), C22 (scan
  writes `.gatetest/` into the checkout, no opt-out flag), C23 (fix-loop
  convergence guard).
- AlecRae session journeys gatetest.io as a first-hour customer and sends findings
  in the §2 shape; GateTest owes them a full scan + journey of alecrae.com and
  api.alecrae.com at 1440 and 390 (agent killed at the owner's stop order; restart
  it, stub at the session scratchpad `alecrae-crosstest.md`).
- Gluecron session builds deploy keys and `docs/VS-GITHUB-PARITY-2026-09-25.md`
  (inside-out); GateTest owes the outside-in GitHub-parity walk of gluecron.com,
  skipping deploy keys until their merge sha (agent killed at the stop order).

### Public proof repo is broken (new; owned by code, not the owner)
crclabs-hq/gatetest-arena has 12 injected-bug PRs open since 2026-09-20 (#352-#363).
Every CI run on them is `action_required`: inject-bug.yml opens PRs with
`ARENA_BOT_PAT || GITHUB_TOKEN` and the repo's only secret is ANTHROPIC_API_KEY, so
GitHub withholds workflow approval for the bot-authored PR, the gate never runs and
no fix PR is opened. Fix without an owner secret: a scheduled workflow (every 15 min,
GITHUB_TOKEN) that lists open `arena/bug-*` PRs, checks out each head, runs the gate
and the fixer, pushes the fix commit to the PR branch and comments; the fixer step
must fail loud on a rejected key. Not built yet; the owner's PC was unstable.

### Parked and killed at the owner's stop order (PC unstable, ~17:00Z)
- The PR carrying this section also carries the `/api/status` change: three
  `missing_important` hints no longer name the pre-rename alias, and
  `platformPointing()` maps every pre-rename prefix to `legacy` (`pointed_at`:
  tallrig | legacy | mixed | unset). Env aliases stay readable silently. Trap: in the
  main checkout any edit to route.ts or platform-config.js shows as a whole-file
  line-ending diff; edit them in a fresh worktree from origin/main and the diff is
  the real 16+/10-.
- Both cross-test agents killed mid-run; no findings delivered. Restart them one at
  a time when the machine is stable (usage doctrine: two agents max, foreground
  scans only).
- `.claude/worktrees/` again holds ~20 agent worktrees, all on merged branches; one
  (`agent-a099e9eb2d1f82d70`) has 5 unpushed commits from the old homepage-swap
  builder that #719 superseded. Remove after confirming nothing in them is wanted.

### Addendum 2026-09-25 19:30Z — receipts, an open decision, cleanup
- Receipts for the complaint map (rows the DavenRoe quality session owned; that
  session is gone, so they live here): **C17** accessibility module runs WCAG 2.2
  AA + AAA-aligned checks in-process (no pa11y; `src/modules/accessibility.js`
  contrast thresholds 7:1 / 4.5:1), there is no `includeWarnings` switch.
  **C20** unknown flag: exit 0 by default, exit 2 under `--strict` or `CI=true`
  (measured on an empty dir, 2026-09-25). **C22** every scan writes
  `.gatetest/reports/` into the scanned checkout; only `reporting.outputDir` in
  config moves it, no CLI opt-out. **C23** the fix loop has a hard ceiling
  (`maxAttempts`, default 3, `website/app/lib/fix-attempt-loop.js`), no
  same-diff convergence check.
- **Open product decision, never made anywhere in the repo or its history:**
  should `security` (injection/XSS/auth probes) join the default `standard`
  suite? Today it runs only in `full` and `nuclear`; a plain `gatetest` on
  NodeGoat passes its injections. Owner declined to rule on 2026-09-25; do not
  re-ask, decide it when the customer-facing claims are next reviewed.
- gatetest-arena: `.github/workflows/arena-repair.yml` (scheduled, GITHUB_TOKEN
  only) is being built on branch `fix/arena-repair-schedule`; the 12 stuck bug
  PRs plus ~370 stale `arena/bug-*` branches since June are the cleanup after it
  proves itself.
- `.claude/worktrees/`: 44 merged, clean agent worktrees removed; 7 kept because
  they hold unpushed or dirty work (`agent-a099e9eb2d1f82d70` 5 unpushed,
  `agent-ada7b464b8d3245ff` 12 unpushed, five with dirty trees). Stale
  `GateTest-wt-main` registration removed; `main` checks out again.

### Addendum 2026-09-25 21:00Z — cleanup done, arena reset waiting on the owner
- **Cleanup done (owner: "we don't want dirty files"):** 50 fully merged remote
  branches deleted; 261 dead `arena/bug-*` branches (closed/merged PRs) deleted in
  gatetest-arena; 50 agent worktrees removed (44 clean + 6 whose only diff was
  line endings or work superseded by #719/#702 — their branches are kept); the
  eleven untracked `GateTest-wt-*` folders and the 13 Sep `gt-main` scratchpad
  worktree deleted; stale `GateTest-wt-main` registration removed so `main`
  checks out again. Kept: `.claude/worktrees/agent-a842420db01639ab4`
  (`feat/build-staging-swap`, 90 real uncommitted lines from 22 Sep, likely
  superseded by #724 blue/green — owner or a builder decides).
- **Owner decision, listed once:** 34 unmerged remote branches older than 30 days
  (April-May `claude/*`, `audit/legal-*`, `ci/bulletproof-defaults-and-collisions`,
  `claude/incremental-scan-since-pr`, three June `flywheel/*` pairs,
  `jarvis-box-local-20260706-preserve`, `jarvis/fix-874`). Nothing on main needs
  them; deleting is the owner's call.
- **Arena (public proof repo) — root cause deeper than §12 said:** main has been
  RED since 2026-06-04 because bug PRs #1-#4 were merged into main instead of
  fixed; every later injection (100 open PRs, not 12) sat on that broken base.
  gatetest-arena#364 (CI green, 17/17) restores `src/math.js`, adds the scheduled
  repair workflow (GITHUB_TOKEN only, every 15 min, merges its own green fix,
  fails loud on a rejected key). Auto-merge is disabled on that repo and the
  desktop classifier refuses bulk merges/closures, so the OWNER runs:
  `gh pr merge 364 -R crclabs-hq/gatetest-arena --squash --delete-branch`, then
  closes the 100 stale `arena/bug-*` PRs with branch deletion (they are all
  based on the broken main); the injector opens a fresh one within 6 h and the
  repair loop takes it. Until then gatetest.io/testing shows a broken arena.
- gatetest.io/testing itself renders "Arena not reachable — github-api-401"
  because the box's GitHub token is refused; a builder is adding an anonymous
  fallback (the repo is public) on branch `fix/testing-page-anonymous-arena`.

### Addendum 2026-09-25 22:00Z — arena repaired on main; what the owner still closes
- Owner merged gatetest-arena#364: arena main green at d492f56 (first green since
  2026-06-04), scheduled repair workflow live. gatetest.io/testing anonymous read
  is PR #738 (auto-merge armed).
- 99 stale `arena/bug-*` PRs remain open on the old broken base; the owner closes
  them with branch deletion (desktop classifier refuses bulk closure). Until then
  the repair loop spends each 15-minute cycle on three of them.
- GateTest remote branches are down to six: main plus five September branches that
  are all superseded (chore/platform-hostnames-env-driven,
  claude/aggressive-testing-repair-checks-ihovku,
  fix/vscode-extension-in-process-engine, integration/green-board-2026-09-13,
  worktree-agent-a3bc45a30d229a29b); the 34 older ones were deleted. Local
  worktrees: one kept (feat/build-staging-swap, 90 real uncommitted lines).

### Addendum 2026-09-25 22:30Z — arena reset complete
- Owner closed the 99 stale `arena/bug-*` PRs (script
  `%USERPROFILE%\Downloadsrena-close-stale.ps1`; the one-liner had failed on
  quoting). gatetest-arena: 0 open PRs, 0 `arena/bug-*` branches, main green.
  Injector fires at :17 every two hours; the repair workflow (every 15 min,
  GITHUB_TOKEN only) takes the next PR. First proof of the loop = a bug PR
  closed by an `arena(fix)` squash with the `<!-- arena-repair -->` comment;
  if instead the comment says "AI fixer key rejected", ANTHROPIC_API_KEY on the
  arena repo is dead and rotating it is the owner's item.
- GateTest #736, #738, #740 merged; gatetest.io/testing reads the arena
  anonymously after the next pull-deploy.

### Addendum 2026-09-25 23:15Z — five moves in PRs, arena loop under test
- Owner lifted the two-agent cap for the launch push and set "no restrictions
  while building out"; five sonnet builders ran at once, each in its own
  `GateTest-wt-*` worktree with junctioned node_modules.
- Move PRs (auto-merge armed unless noted): #747 accepted-risk overrides
  (move 3); #748 `--report-dir` / `--no-artifacts` (move 17; SARIF/JUnit and a
  few module writers still hardcode their path — follow-up); #750 convergence
  guard for fix and crawl loops (move 16); #751 `verdictSource` on every finding,
  model-judged never blocks by default (move 14); #749 security in the standard
  suite (move 1) — NO auto-merge, owner decides; evidence: NodeGoat standard
  BLOCKED 14→35 (injections now caught), express 0→0, self 0→0, +1 s / +9 %.
  Four of the five touch bin/gatetest.js in different places; expect one
  rebase as they land.
- Arena: the owner merged bug PR #366 by hand at 22:33Z (June failure mode);
  restored in gatetest-arena PR 371 (merged, main green at f8e293b) and bug
  PRs are now opened as DRAFTS the merge button refuses; the repair loop marks
  a PR ready only after its own fix passes. arena-repair.yml was invalid YAML
  until PR 367 (multi-line bodies broke the run block) — the first real cycle
  is draft PR #372 (clamp-swap-bounds) with the repair run dispatched 23:05Z.
  Rule for humans: never merge an `arena(bug):` PR.
- GitHub App listing: the three "GateTest" entries on the personal Marketplace
  page are OAuth Apps (sign-in), not the App; production uses client id
  Ov23lifAW5wP8PsU2P5p; the App to list is 3766251 (client Iv23lisxbZrS1IJ8c1hk)
  under the crclabs-hq org context.

### Addendum 2026-09-26 06:10Z — first arena cycles ran; the fixer ran and did not fix
- Loop mechanics work: injector opened #372, #375, #377 as drafts; the repair
  workflow ran at 23:05Z, 00:52Z and 05:44Z, checked out each, ran the tests
  (red), ran `gatetest fix` from GateTest main, re-ran the tests (still red) and
  commented "Fixer ran but tests still fail: clamp: bounds the value". No PR was
  fixed. The loud "AI fixer key rejected" path never fired.
- What the fix log shows (run 36221671792, group PR #372): the scan BLOCKS on
  `unitTests: unit-tests:run` only — the fix engine treats a failing test as
  advice ("Fix failing tests before committing"), not as a fix target; PR #754
  (move 8) addresses exactly this. Second line: `src/math.js:32 [AI] AI provider
  call failed for this hunk` from `src/modules/fake-fix-detector.js:952`
  (`ai:call-error`, severity warning). The real error text lives only in the
  finding's `explanation` field in the JSON report; the console line carries no
  status code, so arena-repair.yml's `grep 401|403|invalid|unauthorized` over the
  console log cannot see an auth failure. Whoever owns the loop next: grep the
  JSON report for `ai:call-error` explanations, and check the model id the
  workflow sets (`CLAUDE_MODEL: claude-sonnet-4-7`) against
  `src/core/engine-models.js` before assuming the key is fine.
- Division: this session (Gate) stands down from GateTest code while the five
  move builders and #754/#757 land, to avoid the 16 Sep overlap lesson; it still
  owes the AlecRae and Gluecron cross-tests (killed at the stop order; owner's PC
  had 0.6 GB free RAM at 20:00Z) and will run them one at a time when told the
  machine is stable. #738 (testing page anonymous read) is live: /testing now
  renders "Cycles 40, Auto-fixed 0 / 40" — honest, and it will stay ugly until a
  cycle closes.

### Addendum 2026-09-26 09:40Z — Gluecron outside-in walk delivered; invite-only blocks the write path
- Ran from a cloud sandbox (public internet only, no local load). Headline for the
  owner: gluecron.com sign-up is invite-only (/register needs invite_code; /signup
  302→/register; raw "Gluecron is in build-out and invite-only for now."), so a
  prospect cannot trial it and no write-path capability could be measured from a
  customer's seat (push, tokens, webhooks UI, protection, CI re-run, PR review
  actions, projects, org/teams, audit, 2FA, import, deploy keys). Sent to the
  Gluecron session with a request for one invite code for an authenticated pass
  against their main 8475507 (deploy keys live there since 09:25Z).
- Gaps found without an account (all with repro, GitHub measured alongside): no
  OpenAPI/Swagger (404); REST pagination has no Link header (offset/nextOffset in
  body); Actions API casing drift (their #6903); no CI re-run endpoint; no SSH
  clone tab; /pulls/N/files 404 (only ?tab=files); flagship repo 0 tags / 0
  releases; login throttle not observed in 10 tries at 1/s; password min 8;
  public copy names AI vendors/models (owner's no-vendor rule applies to every
  platform).
- Advantages, measured: anon API 1000/60 s vs GitHub 60/h; cross-repo impact on
  every PR; AI PR-size/changelog/review included; dedicated Symbols tab; mobile
  390 px diff keeps Unified/Split; home page 0.44-0.49 s / 85 KB vs GitHub
  0.53-0.64 s / 576 KB. Parity confirmed on private-repo 404, README render,
  blame/history/anchors, code search, CI logs, rate-limit headers, TLS, HSTS.
- Full report: session scratchpad `gluecron-crosstest-remote.md`. AlecRae
  cross-test (local, browser journey) running at the time of writing.
