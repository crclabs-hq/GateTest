# The Docker image — what it is, what it needs

## What the image is

`Dockerfile` builds **the gatetest.io website** (the Next.js app in
`website/`, served by its standalone `server.js`) with **the scan engine
bundled in** (`src/`, `lib/`, `bin/` — the hosted scan and fix routes
`require` it at runtime). `docker-compose.yml` runs that one image twice,
next to a Postgres 16 container:

| service    | what it runs                                   | port                 |
|------------|------------------------------------------------|----------------------|
| `app`      | `node server.js` — the website + API           | `3000` → host `3000` |
| `worker`   | `node /app/scripts/sandbox-worker.js` — fires the scan-queue / watch / learning tick routes on a schedule (the job Vercel cron did) | none |
| `postgres` | `postgres:16-alpine`, data in the `postgres_data` volume | `5432` on loopback only |

**It is not the CLI.** `npx -p @gatetest/cli gatetest --suite quick` runs
on the customer's machine with no image involved. Production (gatetest.io)
does not run this image either — it builds on the box from a git pull and
runs under systemd (`scripts/deploy/deploy-on-box.sh`). The image is for
self-hosting the site and for the CI job that proves it still builds.

## Build and run

```bash
cp website/.env.example .env.local          # then fill in the values below
GIT_COMMIT=$(git rev-parse HEAD) docker compose up --build
curl -s http://localhost:3000/api/health     # {"ok":true}
curl -s http://localhost:3000/api/status     # which required vars are still missing
curl -s http://localhost:3000/api/platform-status   # the commit the image was built from
```

`GIT_COMMIT` is a build-arg: there is no `.git` in the build context
(`.dockerignore` drops it, along with `node_modules`, tests, corpora and
docs — the context is a few MB, not 1.9 GB), so the commit stamped into
`/api/platform-status` comes from the shell. Leave it unset and the stamp
reads `unknown`, which is honest but useless.

The base image is pinned to a Node minor and its digest
(`node:22.23.2-alpine@sha256:…`). To bump: `docker pull node:22-alpine`,
read the version and digest, change both in the `FROM` line.

`.github/workflows/docker-build.yml` builds the image (no push) on every PR
that touches the Dockerfile, the website, the engine or the scripts, and
every Monday, then starts it and waits for `/api/health`.

## Environment variables

Compose sets these itself — override in the shell, not in `.env.local`:

| variable            | default    | meaning                                                            |
|---------------------|------------|--------------------------------------------------------------------|
| `POSTGRES_USER`     | `gatetest` | Postgres role; also used to compose `DATABASE_URL` for both services |
| `POSTGRES_PASSWORD` | `gatetest` | its password — change it for anything reachable from a network      |
| `POSTGRES_DB`       | `gatetest` | database name                                                      |
| `DATABASE_URL`      | derived    | `postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB?sslmode=disable` — the app's and the worker's connection string |
| `NEXT_PUBLIC_BASE_URL` | `http://localhost:3000` | the public origin; every redirect, callback URL and e-mail link is built from it (**inlined at build time** — a different origin needs a rebuild) |
| `GATETEST_BASE_URL` | `http://app:3000` | worker only: where it POSTs the tick routes                   |
| `GIT_COMMIT`        | `unknown`  | build-arg, see above                                               |

Everything else comes from `.env.local` (`env_file:` on both services; the
file is optional so a first `docker compose config` works, but the site is
not usable without the required block). `website/.env.example` is the full
annotated list; these are the ones that decide whether the stack works at
all. `/api/status` reports which of them are missing on a running app.

**Required — a core flow breaks without it:**

| variable            | meaning                                                                       |
|---------------------|-------------------------------------------------------------------------------|
| `SESSION_SECRET`    | encrypts customer and admin sessions; long random string                      |
| `ANTHROPIC_API_KEY` | AI review, auto-fix and the watch tick all throw without it                   |
| `STRIPE_SECRET_KEY` | creates checkout sessions (test key locally — `sk_test_…`)                    |
| `STRIPE_WEBHOOK_SECRET` | verifies Stripe webhooks; fail-closed — unset, every paid scan is rejected with 401 |
| `CRON_SECRET`       | the worker sends it as `Authorization: Bearer` to the tick routes, which fail closed without it; falls back to `GATETEST_ADMIN_PASSWORD` if unset |
| `GATETEST_ADMIN_PASSWORD` | admin console password login (`/admin`); also the worker's fallback bearer |

**Needed for a specific feature (the feature reports itself disabled otherwise):**

| variable | meaning |
|----------|---------|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_OAUTH_REDIRECT_URI` | customer "Sign in with GitHub" |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | the other two OAuth logins |
| `GATETEST_APP_ID` / `GATETEST_PRIVATE_KEY` / `GATETEST_WEBHOOK_SECRET` | the GitHub App: commit statuses, PR comments, private-repo scans |
| `GLUECRON_API_TOKEN` / `GLUECRON_EMITTER_SECRET` | the Gluecron host: repo reads and the push ingress |
| `RESEND_API_KEY`, `MAIL_FROM` | outbound e-mail (MCP API-key delivery, digests) |
| `GATETEST_INTERNAL_TOKEN` | HMAC key CI uses to publish the self-scan badge (`/api/internal/self-scan-status`); without it the homepage shows the last committed measurement, dated |
| `TALLRIG_BASE_URL` / `TALLRIG_API_TOKEN` / `TALLRIG_DISPATCH_SECRET` (`VAPRON_*` legacy names) | runtime-scan dispatch to the platform worker tier |
| `GATETEST_RECIPE_STORE_TOKEN` | bearer for fix-recipe writes; writes answer 503 without it |
| `OPENAI_API_KEY` | second-agent consensus on the Forensic tier only |
| `INDEXNOW_KEY`, `ADMIN_TOKEN`, `GATETEST_SSH_*`, `NEXT_PUBLIC_LAUNCH_HN`, `NEXT_PUBLIC_LIVE_COUNTER`, `ARENA_REPO`, `NEXT_PUBLIC_PLATFORM_*` | optional, documented inline in `website/.env.example` |

`APP_VERSION` and `NEXT_OUTPUT_STANDALONE` are build-time only: the
Dockerfile sets the second (it makes `next build` emit the standalone
server the image runs) and the box must not, because `next start` cannot
serve a standalone build.
