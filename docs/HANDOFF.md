# HANDOFF — carry on from here without delay

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
