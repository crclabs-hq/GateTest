# THE LAUNCH PLAYBOOK — Craig's copy

> Written 2026-08-26, for Craig. Plain language on purpose. This is the
> single ordered path from "everything is built" to "real users are paying
> and telling us things." Do the phases in order — each one exists because
> the next one fails without it. Nothing here assumes expertise: every step
> says exactly what to click or type, and what "it worked" looks like.

---

## How we split the work (read this first)

**Claude does, every session:** all code, all tests, all deploys, watching
the metrics, drafting copy, fixing what feedback surfaces, keeping this
playbook current. If it can be done from the repo or the tailnet, it is
mine and you should never have to think about it.

**Only you can do:** things that need your accounts (GitHub App settings,
Resend, Stripe, the attorney), your money, or your voice (the HN post is
signed by you, the feedback calls are with you). This playbook exists so
that when a step is yours, you know exactly what to do and why.

**The rule that keeps this simple:** after any step, if what you see does
not match what the playbook says you should see — stop and tell me exactly
what you saw. Do not debug alone. That is what I am for.

---

## Phase 0 — The Sitting (~25 minutes, unlocks everything)

One sitting, five fixes. Every feature we have shipped waits behind these.

### 0.1 The GitHub App (10 min)

Open: `github.com/organizations/crclabs-hq/settings/apps/gatetest-hq`
(app **3766251** — the LIVE App; its private key is on the box as
`GATETEST_APP_ID=3766251`. Until 2026-09-10 this page named `gatetesthq`
(3322634, `Gate-Test` org) instead and told you to delete 3766251 — that
would have deleted production.)

1. ~~**Webhook URL**~~ — **done 2026-09-10**: a real webhook completed end to
   end through 3766251, and `external_url` is already `https://gatetest.io`.
2. **Permissions** → Contents: **Read and write** (it is Read — the auto-fix
   branch cannot push); Commit statuses: **Read and write** (absent — the
   pass/fail on each commit cannot post). Issues is already Read and write.
   Remove **Checks** (write) — nothing we ship calls the Checks API.
3. **Subscribe to events** → tick **Workflow run** (CI-fix) and **Issue
   comment** (the `@gatetest ignore` suppression feature). Only push +
   pull_request are ticked today.
4. **Description** → still says "102 modules", "Nuclear" and "Pay per scan"
   — the copy the 2026-05-14 rejection cited. Paste the short description
   from `integrations/marketplace/listing.md` (Free-only, 121 modules).
5. ~~**Private keys**~~ — **done 2026-09-10**: the real `.pem` for 3766251 is
   on the box.
6. Retire the STALE duplicate **gatetesthq** (app 3322634, `Gate-Test` org):
   make it private, uninstall it from `crclabs-hq`, then delete it — so a
   Marketplace reviewer sees one app, not two. **Never delete 3766251.**

`node scripts/marketplace-preflight.js` reads all of the above off the live
App and prints exactly what is still wrong.

### 0.2 ~~Put the key on the box~~ — done 2026-09-10

SSH to the box (`ssh root@jarvis` on the tailnet), then edit
`/opt/gatetest/website/.env.local`:

- `GATETEST_APP_ID` = the App ID shown at the top of the App settings page
- `GATETEST_PRIVATE_KEY` = the full contents of the downloaded `.pem`
  (replace the placeholder that's there now)

Then: `systemctl restart gatetest-web`

**It worked when:** `node scripts/ops/readiness-probe.js --base https://gatetest.io`
no longer shows the `config/placeholders` failure.

### 0.3 Email (5 min) — this is a PAID feature right now silently broken

1. In **Resend** (resend.com): add domain `gatetest.io`, and it will show
   you 2–3 DNS records. Add those records in **Cloudflare** (the DNS for
   gatetest.io already lives there). Wait for Resend to show "verified".
2. Create an API key in Resend.
3. ~~On the box, in the same `.env.local`: set `RESEND_API_KEY`~~ — **done
   2026-09-10** (`/api/status` reports it present). Still to set once the
   domain verifies: `RESEND_FROM=GateTest <watchdog@gatetest.io>`. Restart again.
4. Confirm `hello@gatetest.ai` forwarding still reaches an inbox you read —
   send yourself a test email. Every feedback affordance we shipped points
   there.

### 0.4 Two small tokens (2 min, same .env.local)

- `GATETEST_RECIPE_STORE_TOKEN` = any long random string (recipe writes
  are 503 until it exists)
- Optional: `gh secret set CRON_SECRET` on the repo with the box's value
  (redundant second queue-drain; the box timers already work).

### 0.5 Tell me it's done

Say "sitting done" in any session. I will immediately run the drill
(Phase 1) and report. That's it — your part of Phase 0 is over.

---

## Phase 1 — Prove the loop (same day, ~10 minutes, mostly mine)

One command, on the box:

```bash
node scripts/ops/fire-test-webhook.js --repo octocat/Hello-World
```

It fires a real signed push at production and watches both the queue and
the commit status a customer would see. **Exit 0 = the loop is closed for
the first time in GateTest's life.** I can run this via the tailnet — just
tell me the sitting is done.

Then the first REAL push: install the App on the gatetest repo itself
(github.com/apps/gatetest-hq → Install → choose the repo), push any commit,
and watch a pending status appear on it, then a result, then a PR comment
on the next PR. When you see that comment appear on your own commit — that
is the product, working. Take the screenshot; we'll want it later.

---

## Phase 2 — Dogfood week (7 days, we are customer zero)

Install the App on **gatetest**, **Vapron**, and **Gluecron.com**. Then we
just... work, for a week, with GateTest riding every push.

- **Mine, daily:** read `/api/admin/metrics/launch` — is the loop moving,
  how fast is push→comment, did anything dead-letter, what did we suppress.
  Fix every annoyance the same day (pre-authorized). Anything a real
  customer would have hated becomes a fix before a real customer exists.
- **Yours, daily (5 min):** when a GateTest comment appears on your PR,
  read it as if you were a stranger. If anything is confusing, wrong, slow,
  or ugly — tell me in one sentence. That sentence is the most valuable
  QA data that exists.
- **Exit condition:** three straight days where the comments were fast,
  correct, and nothing needed suppressing that shouldn't have fired. Also:
  our first three honest "here's what it caught" stories for the website.

## Phase 3 — Soft launch: 10 friendly repos (1–2 weeks)

Not the public. Ten teams who agreed to try it — that's where social proof
and honest feedback come from before strangers see us.

**Where to find them (in order of ease):**
1. People you know with a JS/TS product — offer to set it up for them.
2. Small teams in communities you're already in (Discord/Slack groups).
3. A quiet "we're pre-launch, want a free deep scan + auto-fix PR in
   exchange for 15 minutes of feedback?" post where builders hang out.

**Never** scan someone's repo and open issues/PRs uninvited — that's how
tools get a bad name. Offer; let them install.

**The deal:** free Forensic-level treatment + white-glove setup (me),
in exchange for one 15-minute call with you. **Your five questions:**
1. What did you expect it to do that it didn't?
2. Which finding was most useful? Which was noise?
3. Would you pay $49/month for your whole org? If not, what's missing?
4. What almost made you stop during setup?
5. Who else should try this?

**Mine during this phase:** watching the metrics per repo, fixing every
piece of friction within 24h, and turning their findings into anonymized
proof points (with permission).

## Phase 4 — Paperwork (parallel with Phase 3)

- **Attorney pass on /legal/terms and /legal/privacy** — they still render
  "DRAFT". This is the one launch blocker with an external clock, so start
  it now. (A solo-founder-friendly tech lawyer reviewing our existing
  drafts is days, not weeks.)
- **Marketplace resubmission** — only AFTER soft launch has proven the
  install flow, and only when `node scripts/marketplace-preflight.js` says
  ready. You said it yourself: we may not get a fourth try. We spend it
  when we cannot fail it.

## Phase 5 — The public launch (one morning, you and me together)

A **Show HN** post, with the free scan as the hook. HN is where our exact
buyer lives, and it rewards precisely the honesty we've built.

Draft (edit into your own voice — it must sound like you):

> **Show HN: GateTest — a code-quality gate that shows its evidence (and
> publishes its misses)**
>
> I got tired of quality tools that cry wolf — hundreds of findings, a
> handful real. So I've been building GateTest: 121 checks, one PR
> comment, hard rules about honesty: every AI finding must quote the code
> it's flagging or it gets discarded; the PR comment is capped at 5 ranked
> findings; if you think a finding is noise you reply "@gatetest ignore
> <rule>" and it commits the suppression to your repo and tunes the
> engine; and our benchmark page includes what we MISS, not just what we
> catch. Fixes arrive as PRs that must pass a re-scan and your tests
> before they ship.
>
> Free scan of any public repo, no signup: [link]. Pricing is flat per
> org — no seats, no lines-of-code cliffs. I'm here all day; tell me
> where it's wrong.

**Launch morning rules:** you answer every comment, fast, honestly,
especially the critical ones — "you're right, that's a gap, here's the
plan" earns more trust on HN than any feature. I sit in a live session
fixing anything that breaks under load, in real time.

## The ongoing rhythm (after launch — this is the whole job)

- **Monday, 10 min:** we read the metrics together — completed scans,
  push-to-comment p95, dead letters, top suppressed rules, MRR.
- **Every email answered within 24h.** Early users forgive bugs; they
  never forgive silence. (Say the word and I'll draft replies for you.)
- **One improvement from real feedback shipped every week** — and tell the
  person who asked. "You mentioned X — it's live" converts users into
  advocates for free.
- **Precision reviews stay evidence-based:** the suppression table tells
  us which rules are earning distrust; we fix those first, always.

## What NOT to do (as important as the rest)

- **Don't buy ads** — nothing to retarget yet; word of mouth is the channel.
- **Don't discount when someone hesitates** — find out what's missing instead.
- **Don't add features nobody asked for** — the roadmap after launch is
  written by the metrics and the feedback calls, not by us guessing.
- **Don't rush the Marketplace** — it's a channel, not the launch.
- **Don't read one angry comment as the market** — read ten before reacting.

---

*Kept current by Claude. When a phase completes, it gets marked here with
the date and what we learned.*
