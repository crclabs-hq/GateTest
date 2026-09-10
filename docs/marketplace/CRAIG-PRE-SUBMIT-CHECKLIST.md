# Marketplace pre-submit checklist — Craig only

**Written 2026-08-04. Updated 2026-08-06 after deploying, then firing a real
signed webhook through the production pipeline end-to-end.**

> **Status 2026-09-10 — READ THIS BEFORE ANY LINE BELOW.** Every App
> identity in this document was **inverted** from 2026-08-04 until tonight.
> The LIVE App is **`gatetest-hq`, app_id `3766251`, owned by `crclabs-hq`**
> (Client ID `Iv23lisxbZrS1IJ8c1hk`): its private key is the one on the
> production box (`GATETEST_APP_ID=3766251`) and a real webhook completed end
> to end through it tonight. **`gatetesthq` (3322634, `Gate-Test` org) is the
> STALE duplicate to retire.** The old text told you to delete 3766251 —
> that would have deleted production. Manage the listing at
> `github.com/organizations/crclabs-hq/settings/apps/gatetest-hq`.
>
> Resolved tonight: **0** (App `external_url` is `https://gatetest.io` on
> 3766251 and the webhook delivers), **0b** (real private key on the box,
> `fire-test-webhook` completed), **3** (`RESEND_API_KEY` set). Still open
> on the live App, all found by `node scripts/marketplace-preflight.js` now
> that it audits the right App: `Contents` is Read (needs write), `Commit
> statuses` is absent, `workflow_run` + `issue_comment` are unsubscribed,
> the description still says "102 modules" / "Nuclear" / "Pay per scan",
> and `checks:write` is granted to code that never uses it. Plus the two
> legal DRAFT pages (being rebuilt separately). Rows below are corrected in
> place; dated evidence is left as written.

Context: the listing was rejected once (2026-05-14) and has been under review
since 2026-07-25. Craig's constraint — *"I may not get the third opportunity."*
So this is ordered by **what a reviewer hits first**, not by effort.

## The current answer: DO NOT SUBMIT — and Craig's 15-minute list

Run `node scripts/marketplace-preflight.js` for the live verdict, any time.
Everything fixable from the repo is fixed and deployed. What remains needs
Craig's accounts, in one sitting:

| # | Blocker | Where | Time |
|---|---|---|---|
| 0 | ~~**Webhook URL still `gatetest.ai` (dead)**~~ **RESOLVED 2026-09-10** — `external_url` is `https://gatetest.io` on the live App 3766251 and a real webhook completed end to end through it. (Row said "App 3322634" until tonight — the stale one.) | App 3766251 settings | done |
| 0b | ~~**No working GitHub credential on the box**~~ **RESOLVED 2026-09-10** — the real private key for App 3766251 is in `website/.env.local` (`GATETEST_APP_ID=3766251`); `scripts/ops/fire-test-webhook.js` completed end to end. | box `website/.env.local` | done |
| 1 | `/legal/terms` + `/legal/privacy` render **"DRAFT … not final legal terms"** | attorney | external |
| 2 | live App 3766251 has **`contents:read` (needs write — the auto-fix branch cannot push) and no `statuses` scope at all (the pass/fail on each commit cannot post)**. `issues:write` IS granted on 3766251 — the earlier "missing `issues:write`" was measured on the stale App. Also remove the unused **`checks:write`** — nothing we ship calls the Checks API | App 3766251 settings | 2 min |
| 2b | live App 3766251 is subscribed to **push + pull_request only** — must add **`workflow_run`** (CI-fix never fires without it) and **`issue_comment`** (added 2026-08-25 for suppression-in-place: `@gatetest ignore <rule>` replies) — an unsubscribed event fails silently | App 3766251 settings | 1 min |
| 2c | live App 3766251 **description still says "102 modules", "Nuclear" and "Pay per scan"** — the exact copy the 2026-05-14 rejection cited. Paste the short description from `integrations/marketplace/listing.md` (Free-only, 121 modules) | App 3766251 settings | 2 min |
| 3 | ~~`RESEND_API_KEY` unset~~ **RESOLVED 2026-09-10** — present per live `/api/status` | box `website/.env.local` | done |
| 4 | `CRON_SECRET` **repo secret** unset → the `cron-ticks` workflow is disarmed | repo secrets (optional) | 2 min |

### What the end-to-end test proved (2026-08-06)

A realistic HMAC-signed push event was fired at the **public**
`https://gatetest.io/api/webhook` from the box — identical to a GitHub
delivery except for who sent it. Verified working, in production, in sequence:

1. TLS edge + routing → 200
2. HMAC signature verification (fail-closed) → accepted
3. Enqueue → `scan_queue` row 1, `host='github'` — the first row ever
4. Immediate worker kick claimed it within the same second
5. Failure handling → correct backoff + retry, correct `last_error` recorded
6. The systemd timers drove subsequent attempts on schedule

It failed exactly where the credential audit predicted: `fetchTree` → 401,
because every GitHub token on the box is dead (item 0b). So the pipeline is
proven from the public edge to the GitHub API call, and blocked there by a
missing credential only Craig can place. **After 0 + 0b, a real push should
flow through with no further code changes.**

**That whole drill is now ONE COMMAND (added 2026-08-26).** On the box,
immediately after items 0 + 0b:

```bash
node scripts/ops/fire-test-webhook.js --repo octocat/Hello-World
```

It signs and fires the push, then watches both observable surfaces — the
`/api/status` queue counts and the commit-status the customer would see —
and exits 0 the moment a job completes end to end. Fallback detail:
`journalctl -u gatetest-tick.service -f` and
`SELECT status, last_error FROM scan_queue ORDER BY id DESC LIMIT 3;`

Note: real webhooks will carry the canonical `crclabs-hq/GateTest` name — the
`ccantynz-alt/gatetest` alias 301s at the API level (followed automatically
once a valid token exists).

Plus one warning: the STALE duplicate app `gatetesthq` (3322634, `Gate-Test`
org) is still installed on `crclabs-hq` alongside the live `gatetest-hq`
(3766251). Retire 3322634 — never 3766251. (This sentence named them the
other way round until 2026-09-10.)

**#4 is no longer functionally fatal.** The queue is now drained by systemd
timers on the box itself (`scripts/deploy/systemd/`), so scans run without
GitHub Actions. Setting the repo secret would add a redundant second driver;
both ticks are idempotent. Left on the list because the preflight still flags it.

**#3 is NOT the KI #82 typo** *(resolved 2026-09-10 — the key is now set)*. That KI theorised the key was stored as
`RESENDER_API_KEY`. Checked the box directly on 2026-08-05: there is **no
Resend key under any spelling** in `website/.env.local`. It has to be added.

⚠️ **Two things a reviewer would have hit that were NOT on the 2026-08-04 list,
because nobody had probed the running system:**

- **No queued scan had ever executed.** `/api/scan/worker/tick` was returning
  `{"ok":false,"error":"column q.host does not exist"}` under **HTTP 200** —
  production's `scan_queue` predated the dual-host column, and the worker never
  ran the migration the enqueue path runs. Fixed in `d3fe3738`.
- **Nothing ever called the ticks.** Quality bar #12 requires a scheduler;
  there was no cron entry and no timer on the box. Fixed in `39f4e3e1`.

Together those made the listing's central claim — *"scans run on every push"* —
false. A reviewer would have installed, pushed, and seen nothing at all.

---

## 0. Where the listing actually lives

The live app IS under `crclabs-hq`. There are three GateTest identities
(this table had the two Apps swapped from 2026-08-04 to 2026-09-10):

| Identity | What it is | Owns |
|---|---|---|
| **`crclabs-hq`** | Org, created 2026-05-18 | **`gatetest-hq`, app_id `3766251`, Client ID `Iv23lisxbZrS1IJ8c1hk`** — the LIVE app; its private key is on the production box (`GATETEST_APP_ID=3766251`), real webhook completed end to end 2026-09-10 |
| `Gate-Test` | Org, created 2026-04-08, 0 repos | the STALE duplicate `gatetesthq`, app_id `3322634` — retire it (make private, uninstall from `crclabs-hq`, delete) |
| `ccantynz-alt` | Personal account | this repo |

➡️ **Manage the listing at `github.com/organizations/crclabs-hq/settings/apps/gatetest-hq`. Never delete 3766251.**

---

## 1. ✅ Redeploy production — DONE 2026-08-05

Production was 66 commits behind, serving a 2026-07-29 build. **Deployed and
verified live:**

- [x] `/api/platform-status` → commit `96df6c52`+, version **1.61.0**
- [x] `/docs/configuration` → **200** (was 404)
- [x] `/pricing` → **121 modules** (was 120 / 88)
- [x] `/github/setup` → Contents and Issues both **Read & write**
- [x] the sibling discovery map no longer advertises the dead `gatetest.ai`

Three deploy-path bugs were found and fixed in the process. Each independently
guaranteed the deploy silently did nothing, which is why this drift persisted:

1. **`grep -q` under `set -o pipefail`** — `systemctl list-unit-files | grep -q`
   is false *exactly when it matches*, because `grep -q` exits early, `systemctl`
   dies with SIGPIPE (141), and pipefail reports 141. The restart step had
   therefore never fired on any host, under any unit name. Proven on the box.
2. **The clean-tree guard made the script single-use** — `npm install` and the
   website prebuild dirty tracked files (`package-lock.json`,
   `build-info.json`) *after* the guard, so run 2+ always aborted with
   "uncommitted changes — resolve manually first."
3. **Wrong unit name** — the box runs `gatetest-web.service`, not
   `gatetest.service`.

**Deploy command that works** (Craig is on the tailnet; `jarvis` = the box):

```bash
ssh root@jarvis 'cd /opt/gatetest && git fetch origin main -q \
  && git show origin/main:scripts/deploy/deploy-on-box.sh > /tmp/gt-deploy.sh \
  && GATETEST_APP_DIR=/opt/gatetest bash /tmp/gt-deploy.sh'
```

Running the script from `/tmp` avoids `git reset --hard` rewriting it
mid-execution; `GATETEST_APP_DIR` is then required, because the script otherwise
infers the repo from its own location.

**Then make it automatic** so this never recurs — the deploy workflow exists
but is inert:

- [ ] Settings → Secrets and variables → Actions → add `BOX_SSH_KEY` and
      `BOX_SSH_HOST`

Until those are set, every push shows a green "Deploy … success" that deployed
nothing. As of `5b8e5be3` it now says so loudly and reports how far behind
production is, but it still cannot deploy without the secrets.

### "We have Tailscale — do we still need those secrets?"

Yes, for CI. Tailscale solves **reachability**, not **CI identity**:

| Who is deploying | Needs the secrets? |
|---|---|
| Craig, from his own machine | **No** — he's on the tailnet, just SSH in and run the script |
| GitHub Actions | **Yes** — the runner is an ephemeral Azure VM with no tailnet membership |

Verified 2026-08-04: **port 22 on `66.42.121.161` is open to the public
internet** (`SSH-2.0-OpenSSH_8.9p1`), so `BOX_SSH_*` works today with no
Tailscale involvement at all.

The better long-term posture, since Tailscale already exists, is to **close
public 22** and have CI join the tailnet instead
(`tailscale/github-action` + `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET`). That's
a deliberate infra change, not something to do mid-review — but leaving SSH
open to the whole internet on the box that serves production is worth a
decision either way.

### ✅ Contradiction resolved 2026-08-05 — no longer a Craig decision

The previous version of this checklist asked Craig to rule on whether
production was Vapron or the box, because `docs/deploy/VAPRON-DEPLOY.md` said
*"do not use `scripts/deploy/deploy-on-box.sh`"* while `deploy-box.yml` runs
exactly that script.

**DNS answers it without needing Craig:** `gatetest.io` resolves to
**66.42.121.161** — the box that script targets — and `/api/platform-status`
answered from it on 2026-08-05. Production is the box; `deploy-box.yml`
automates the correct path. The runbook line was the stale half and has been
corrected.

- [x] ~~Craig: confirm which is authoritative~~ — settled by DNS + a live probe.
      Adding `BOX_SSH_*` automates the real path, not a retired one.

(Fixed regardless, in the same pass: the script built with `npx next build`,
skipping the `prebuild` SHA stamp — so it would ship new code while
`/api/platform-status` still reported the old commit, hiding the very drift
this checklist is about. Now `npm run build`.)

---

## 2. 🔴🔴 Point the App at the live domain — THE most important item

**This is now blocker #1, above the legal pages.** It is not just a dead link
in the listing; it severs the product.

Evidence chain, all measured 2026-08-05:

| Step | Measured |
|---|---|
| `scan_queue` row count in production | **0 — nothing has ever been enqueued** |
| `https://gatetest.ai/api/webhook` | **HTTP 000** (NXDOMAIN, registry redemption) |
| `https://gatetest.io/api/webhook` | **HTTP 200** |
| App `external_url` | still `https://gatetest.ai` |

So every push webhook GitHub has ever sent us has failed to deliver. That is
why the queue is empty — and it means the two fixes shipped today (the
`q.host` migration and the systemd timers) make the drain *work*, but there is
still **nothing arriving to drain** until the App is repointed.

Be precise about this: after today's work the pipeline is correct from
`/api/webhook` onward, and severed before it. Only Craig can reconnect it.

*(The App to edit is **3766251** / `gatetest-hq` — the LIVE one. The lines
below said 3322634 until 2026-09-10.)*

- [x] Set `external_url` → `https://gatetest.io` on app **3766251** — verified
      2026-09-10 (`gh api apps/gatetest-hq` → `https://gatetest.io`)
- [x] **Set Webhook URL → `https://gatetest.io/api/webhook`** — a real
      webhook completed end to end through 3766251 on 2026-09-10
- [ ] Setup URL → `https://gatetest.io/github/setup` (not readable from here
      — confirm on the settings page)
- [ ] Callback URL → `https://gatetest.io/api/github/callback` (same)
- [ ] Then confirm delivery: push to any installed repo and check
      `SELECT count(*) FROM scan_queue;` is non-zero, or watch
      `journalctl -u gatetest-tick.service -f` show a non-idle tick.

GitHub's App settings page has a **Recent Deliveries** tab — every entry there
should currently show a delivery failure against `gatetest.ai`. That is the
fastest confirmation of the above.

---

## 3. 🔴 Legal pages still say "DRAFT"

`/legal/terms` and `/legal/privacy` are live (HTTP 200) and render:

> **Draft notice.** … should not be treated as final legal terms until that
> review is complete.

Reviewers open the required legal URLs first. A "DRAFT" stamp there is the
single most likely rejection trigger.

- [ ] Attorney sign-off, then remove the `[DRAFT — requires attorney review]`
      markers
- [ ] Privacy policy: name the email sub-processor — it currently says **"TBD"**

---

## 4. 🟠 Broken sign-in buttons

Per live `/api/status`:

- [ ] `GOOGLE_CLIENT_SECRET` unset → **`/api/auth/google` returns 503**
- [ ] `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` unset → **`/api/auth/gitlab`
      returns 503**

Either set them or hide the buttons. A reviewer clicking a sign-in button and
getting a 503 is a failed review.

- [x] ~~`RESEND_API_KEY` unset~~ — **RESOLVED 2026-09-10** (present per live
      `/api/status`). While unset, the MCP $29/mo flow took the money and the
      API key never arrived (the webhook 500s) — a paying-customer bug
      independent of the Marketplace.

---

## 5. 🟠 Two of everything

A reviewer finding two listings for one product is its own risk.

| | Canonical | Retire / confirm |
|---|---|---|
| GitHub App | `gatetest-hq` 3766251 (`crclabs-hq`) — LIVE, key on the box | `gatetesthq` 3322634 (`Gate-Test`) — stale; retire (this row was inverted until 2026-09-10) |
| VS Code ext | `editors/vscode`, publisher `gatetest` | `vscode-extension` v1.0.1, publisher `GateTestHQ` |

- [ ] Decide which is canonical for each and retire the other

---

## 5b. 🔴 Grant the App the scopes the code actually calls

Settled in code 2026-08-05 — `src/core/github-app-permissions.js` is now the
single declaration, and `tests/marketplace-sync.test.js` proves it covers every
endpoint the bridge calls. **The live App still has to be granted them by hand**
(nothing in this repo can edit github.com):

| Permission | Level | Forced by |
|---|---|---|
| Contents | **Read & write** | `POST .../git/refs` + `POST .../git/commits` — the auto-fix branch |
| Pull requests | Read & write | `POST .../pulls` |
| Commit statuses | Read & write | `POST .../statuses/{sha}` |
| **Issues** | **Read & write** | `POST .../issues/{n}/comments` — the PR comment the listing promises |
| Metadata | Read | `GET /repos/{o}/{r}` |

Webhook events: `push`, `pull_request`, `workflow_run`, `issue_comment` (all
four are branched on in `website/app/lib/github-events.js`; the list is
`WEBHOOK_EVENTS` in `src/core/github-app-permissions.js`).

- [ ] Set all five scopes + all four events on app **3766251** (`gatetest-hq`,
      `crclabs-hq` — the LIVE App; this line said 3322634 until 2026-09-10).
      Measured 2026-09-10 on 3766251: Contents = Read, Commit statuses absent,
      events = push + pull_request only, plus an unused `checks:write` to remove.
- [ ] Note: `Contents` was disclosed to customers as **Read** on both the
      install page and the listing until 2026-08-05. Both now say Read & write,
      matching what GitHub's install prompt actually asks for. Tests mock the
      HTTP layer, so CI cannot catch a missing grant — only the live App can.
- [ ] Run `node scripts/marketplace-preflight.js` once `gh` is authenticated;
      it verifies the live grants, events, description and homepage
      automatically (it was querying the wrong org until 2026-08-05 and
      auditing the wrong App until 2026-09-10, so any previous "pass" from
      it meant nothing).

---

## 6. Final pass before clicking submit

- [ ] Confirm the uploaded logo/screenshots aren't stale from the rejected
      2026-05-14 submission (old module counts, "Nuclear" tier name)
- [ ] Confirm `hello@gatetest.ai` forwarding works — the last rejection notice
      reportedly sat unread ~2 months
- [ ] Re-read `integrations/marketplace/listing.md`: the 2026-05-14 rejection
      was for describing **paid** functionality without ≥100 installs. The
      listing is now correctly Free-only. Do not reintroduce paid plans.
