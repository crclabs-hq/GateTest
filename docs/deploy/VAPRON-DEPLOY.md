# Deploying gatetest.ai to Vapron

> **Why this exists:** the live site spent days serving a stale build —
> "118 modules", "Sonnet 4.6", "18 tools" — while `main` was already correct.
> This runbook + the `/api/platform-status` commit stamp make that impossible
> to miss. Follow it top to bottom for every deploy.

Deploy target as of 2026-07-14: **Vapron** (Craig's platform). This replaces
the retired Coolify/Server-161 path — do not use `scripts/deploy/deploy-on-box.sh`.

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
Vapron builds from a tarball with no `.git`, set `GIT_COMMIT=$(git rev-parse HEAD)`
in the build env instead.

Serve with `npm run start` (or Vapron's Node process manager) on the app port.

---

## 2. Environment variables (set ALL of these on Vapron)

Hit `GET /api/status` after deploy — it lists exactly which of these are
missing. The site returns `503` until every REQUIRED var is set.

**Required (site is broken without them):**
| Var | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres — scans, customers, subscriptions, waitlist |
| `ANTHROPIC_API_KEY` | AI fix / diagnosis / chat (supplied-key path) |
| `SESSION_SECRET` | customer + admin session encryption |
| `STRIPE_SECRET_KEY` | checkout / payments (use `sk_live_` in production) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe.js on the checkout page |
| `NEXT_PUBLIC_BASE_URL` | `https://gatetest.ai` — redirect + callback URLs |

**Important (features silently degrade without them):**
| Var | Purpose |
|---|---|
| `STRIPE_WEBHOOK_SECRET` | verify Stripe webhooks (subscriptions, MCP key email) |
| `RESEND_API_KEY` | **MCP $29/mo API-key emails** — subscriber pays, key never arrives if unset (webhook now 500s until set) |
| `CRON_SECRET` | authorizes the cron endpoints below |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | "Sign in with GitHub" |
| `GATETEST_ADMIN_PASSWORD` | admin console login |

---

## 3. Cron scheduler (CRITICAL — Known Issue #41)

`website/vercel.json` defines two crons that **only run on Vercel**. Off-Vercel,
nothing calls them and queued push-scans silently stall forever. Vapron must
schedule authenticated HTTP hits:

| Endpoint | Frequency | Header |
|---|---|---|
| `POST /api/scan/worker/tick` | every ~2 min | `Authorization: Bearer $CRON_SECRET` |
| `POST /api/watches/tick` | every ~5 min | `Authorization: Bearer $CRON_SECRET` |

Any scheduler works (Vapron's own cron, a systemd timer, or a GitHub Actions
`schedule:` as a stopgap). Without this, the Continuous ($49/mo) tier does nothing.

---

## 4. Post-deploy verification (do NOT skip)

```bash
# 1. Build is FRESH — commit must match `git rev-parse HEAD` on main, NOT "unknown"
curl -s https://gatetest.ai/api/platform-status | jq '{version, commit, builtAt}'

# 2. Config is complete — ready:true, no missing_required
curl -s https://gatetest.ai/api/status | jq '{ready, missing_required, stripe}'
```

Then eyeball the live site:
- Hero says **120 modules** and **Sonnet 5** (not 118 / Sonnet 4.6).
- `/mcp` says **24 tools** (not 18 / 22).
- Nav has no "Stack" / "Hall of Scans".
- Run one free URL scan from the hero — it returns a result.
- Start a checkout (Stripe **test** card `4242 4242 4242 4242` if in test mode).

If `platform-status` shows the wrong commit, the deploy didn't take — redeploy
before doing anything else. That one check is the whole point of this document.
