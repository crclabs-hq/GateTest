# Deploying gatetest.io to Tallrig (file named for the platform's previous name, Vapron)

> **Renamed 2026-09-14 — the platform is Tallrig (tallrig.com), formerly Vapron.**
> Craig: "vapron is no longer, we've had a name change to Tallrig.com". This file
> keeps its pre-rename filename so every link to it still resolves. Read
> `VAPRON_*` below as `TALLRIG_*` — the canonical env names are `TALLRIG_*`, the
> `VAPRON_*` (and older `CRONTECH_*`) names are still read as aliases, and the
> exact box-side flip is in `docs/ops/tallrig-cutover.md`.

> **Why this exists:** the live site spent days serving a stale build —
> "118 modules", "Sonnet 4.6", "18 tools" — while `main` was already correct.
> This runbook + the `/api/platform-status` commit stamp make that impossible
> to miss. Follow it top to bottom for every deploy.

Deploy target: **Tallrig** (Craig's platform — named Vapron when this was written on 2026-07-14, renamed 2026-09-14).

> ### ⚠️ Resolved 2026-08-05 — this page's "retired path" line was wrong
>
> It previously read *"This replaces the retired Coolify/Server-161 path — do
> not use `scripts/deploy/deploy-on-box.sh`."* That instruction contradicted
> `.github/workflows/deploy-box.yml`, which runs exactly that script, and the
> Marketplace pre-submit checklist recorded the contradiction as something only
> Craig could settle.
>
> **DNS settles it.** `gatetest.io` resolves to **<box-ip>** — the box
> `deploy-on-box.sh` is written for and the host `deploy-box.yml` SSHes into.
> That box is serving production right now (`/api/platform-status` answered
> from it on 2026-08-05).
>
> So: **`scripts/deploy/deploy-on-box.sh` is the live deploy path**, and
> `deploy-box.yml` automates the correct thing once `BOX_SSH_KEY` /
> `BOX_SSH_HOST` are set. The environment-variable and cron sections below are
> still authoritative — they describe what the app needs wherever it runs.
>
> Moving to Vapron proper is still the intent, but it has not happened, and a
> runbook that describes the intent as though it were the state is how
> production sat 60 commits stale without anyone noticing which host to push to.

---

## 1. Build

The site lives in `website/` (Next.js 16, Node 20+). Build with **`npm run build`**,
NOT a bare `next build` — the `prebuild` step stamps the real git commit so
`/api/platform-status` can prove the deploy is fresh.

```bash
cd website
npm ci
npm run build      # runs prebuild (git-SHA stamp) → next build
```

The build must run inside the git checkout (so `git rev-parse HEAD` works). If
Tallrig builds from a tarball with no `.git`, set `GIT_COMMIT=$(git rev-parse HEAD)`
in the build env instead.

Serve with `npm run start` (or Tallrig's Node process manager) on the app port.

---

## 2. Environment variables (set ALL of these on Tallrig)

Hit `GET /api/status` after deploy — it lists exactly which of these are
missing. The site returns `503` until every REQUIRED var is set.

**Required (site is broken without them):**
| Var | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres — scans, customers, subscriptions, waitlist |
| `ANTHROPIC_API_KEY` | AI fix / diagnosis / chat (supplied-key path) |
| `SESSION_SECRET` | customer + admin session encryption |
| `STRIPE_SECRET_KEY` | checkout / payments (use `sk_live_` in production; no publishable key — checkout is Stripe-hosted, nothing loads Stripe.js) |
| `NEXT_PUBLIC_BASE_URL` | `https://gatetest.io` — redirect + callback URLs |

**Important (features silently degrade without them):**
| Var | Purpose |
|---|---|
| `STRIPE_WEBHOOK_SECRET` | verify Stripe webhooks (subscriptions, MCP key email) |
| `RESEND_API_KEY` | **MCP $29/mo API-key emails** — subscriber pays, key never arrives if unset (webhook now 500s until set) |
| `CRON_SECRET` | authorizes the cron endpoints below |
| `GATETEST_ADMIN_PASSWORD` | admin console password login (unset → "Admin access is not configured") |
| `TALLRIG_BASE_URL` (alias `VAPRON_BASE_URL`) | GateTest → Tallrig runtime-scan dispatch (`vapron-dispatch.js` → `POST {base}/api/jobs/web-runtime-scan`); without all three TALLRIG vars, /web and /wp scans ship static probes only ("runtime checks unavailable") |
| `TALLRIG_API_TOKEN` (alias `VAPRON_API_TOKEN`) | bearer auth on the dispatch call |
| `TALLRIG_DISPATCH_SECRET` (alias `VAPRON_DISPATCH_SECRET`) | HMAC signing of outbound jobs + verification of Tallrig's result callbacks (`VAPRON_*` / `CRONTECH_*` aliases still honored) |

---

## 2b. Login / OAuth (why login is currently "not working")

Customer login supports **three providers, all already built and wired** into
the sign-in modal — GitHub, GitLab, Google. Each just needs its credentials
set, and each needs a redirect URI registered in that provider's console.
`SESSION_SECRET` + `NEXT_PUBLIC_BASE_URL` (above) are required for all of them.

| Var | Provider | Redirect URI to register in the provider console |
|---|---|---|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub | `https://gatetest.io/api/auth/callback` |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | GitLab | `https://gatetest.io/api/auth/gitlab/callback` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google | `https://gatetest.io/api/auth/google/callback` |

**Google setup (Google Cloud Console):** APIs & Services → Credentials →
Create OAuth client ID → **Web application** → add the redirect URI above →
copy Client ID + Secret into the two env vars. Scopes used: `openid email profile`.

Any provider whose vars are unset returns `503` and its modal button is dead —
that (plus the stale build) is why login looks broken today. `/api/status`
now lists each missing OAuth var by name.

---

## 3. Cron scheduler (CRITICAL — Known Issue #41)

`website/vercel.json` defines two crons that **only run on Vercel**. Off-Vercel,
nothing calls them and queued push-scans silently stall forever. Tallrig must
schedule authenticated HTTP hits:

| Endpoint | Frequency | Header |
|---|---|---|
| `POST` or `GET` `/api/scan/worker/tick` | every ~2 min | `Authorization: Bearer $CRON_SECRET` |
| `POST` or `GET` `/api/watches/tick` | every ~5 min | `Authorization: Bearer $CRON_SECRET` |

Both endpoints accept **either method**. That matters because schedulers
differ — Vercel's built-in cron issues GET, while curl, systemd timers and the
GitHub Actions stopgap POST. `/api/watches/tick` was GET-only until
2026-07-26, so every POST scheduler got a silent `405` and watches never ran
off-Vercel while the scheduler still reported success. `tests/cron-endpoint-methods.test.js`
now pins both methods on every path declared as a cron in `website/vercel.json`.

Any scheduler works (Tallrig's own cron, a systemd timer, or a GitHub Actions
`schedule:` as a stopgap). Without this, the Continuous ($49/mo) tier does nothing.

---

## 4. Post-deploy verification (do NOT skip)

```bash
# 1. Build is FRESH — commit must match `git rev-parse HEAD` on main, NOT "unknown"
curl -s https://gatetest.io/api/platform-status | jq '{version, commit, builtAt}'

# 2. Config is complete — ready:true, no missing_required
curl -s https://gatetest.io/api/status | jq '{ready, missing_required, stripe}'
```

Then eyeball the live site:
- Hero says **121 modules** and **Sonnet 5** (not 118 / Sonnet 4.6).
- `/mcp` says **24 tools** (not 18 / 22).
- Nav has no "Stack" / "Hall of Scans".
- Run one free URL scan from the hero — it returns a result.
- Start a checkout (Stripe **test** card `4242 4242 4242 4242` if in test mode).

If `platform-status` shows the wrong commit, the deploy didn't take — redeploy
before doing anything else. That one check is the whole point of this document.
