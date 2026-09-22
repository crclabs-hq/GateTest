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
