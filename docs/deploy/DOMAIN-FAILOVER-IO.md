# Bringing GateTest back online on gatetest.io

**Status:** ready to execute — every step below is verified, none has been run.
**Blocked on:** Craig. Boss Rule #4 (domain/DNS), #5 (production deploy).
**Written:** 2026-07-30, during the KI #93 outage.

---

## The situation in one paragraph

`gatetest.ai` entered **redemption period** at the registry on 2026-07-29 08:14 UTC
and now returns NXDOMAIN everywhere — the site is unreachable by name. **Nothing
is wrong with the server.** The box still serves a correct HTTP 200 when DNS is
bypassed, running the current commit. Meanwhile `gatetest.io` is already
registered to the same Cloudflare account, is healthy, expires 2027-04-08, and
currently points at the **retired Vercel deployment** (it serves
`DEPLOYMENT_NOT_FOUND`).

So the fastest route back online is not the redemption — it is pointing the
domain we still control at the server that is already working.

### Verified facts

| Check | Result |
|---|---|
| `dig gatetest.ai` | NXDOMAIN (registry delegation pulled) |
| RDAP `gatetest.ai` | `["client transfer prohibited","redemption period"]`, changed 2026-07-29T08:14:34Z |
| `curl --resolve gatetest.ai:443:66.42.121.161` | **HTTP 200**, correct `<title>`, `/api/platform-status` healthy on commit `56ce9f1` |
| `dig gatetest.io` | resolves to `216.150.16.65` — Vercel, serving `DEPLOYMENT_NOT_FOUND` |
| RDAP `gatetest.io` | registrar **Cloudflare, Inc**, registered 2026-04-08, expires 2027-04-08, status healthy |
| `gatetest.io` nameservers | `aitana.ns.cloudflare.com`, `major.ns.cloudflare.com` — Cloudflare-managed, so an A-record edit is all that's needed |

The two domains share a registrar and were registered four days apart, which is
why `.io` is assumed to be Craig's. **Confirm that before step 1** — if the
registrant is someone else, stop and redeem `.ai` instead.

---

## Step 1 — DNS (Cloudflare dashboard)

In the `gatetest.io` zone, replace the Vercel records:

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `@` | `66.42.121.161` | DNS only (grey cloud) |
| A | `www` | `66.42.121.161` | DNS only |
| A | `mcp` | `66.42.121.161` | DNS only |

**Grey cloud, not orange.** Traefik on the box terminates TLS via Let's Encrypt;
Cloudflare's proxy in front of it will fail the HTTP-01 challenge and you will get
a cert error instead of a working site.

Delete or overwrite whatever currently points at Vercel — leaving it means
requests race between two answers.

## Step 2 — Traefik routing (on the box)

The routers live in Coolify's Traefik dynamic config. **Add** `.io` alongside
`.ai` — do not replace it, so the site works the instant redemption resolves.

```bash
ssh root@jarvis
docker exec coolify-proxy sh -c "sed -i \
  's/Host(\`gatetest.ai\`) || Host(\`www.gatetest.ai\`)/Host(\`gatetest.ai\`) || Host(\`www.gatetest.ai\`) || Host(\`gatetest.io\`) || Host(\`www.gatetest.io\`)/g' \
  /traefik/dynamic/gatetest-web.yaml"

docker exec coolify-proxy sh -c "sed -i \
  's/Host(\`mcp.gatetest.ai\`)/Host(\`mcp.gatetest.ai\`) || Host(\`mcp.gatetest.io\`)/g' \
  /traefik/dynamic/gatetest-mcp.yaml"
```

Traefik watches this directory and reloads automatically — no restart. Let's
Encrypt provisions the new certs on first request, which takes a few seconds.

Verify before moving on:

```bash
docker exec coolify-proxy sh -c "grep rule: /traefik/dynamic/gatetest-*.yaml"
```

## Step 3 — Application base URL

**As of 2026-07-30 the code already defaults to `https://gatetest.io`.** The
default in `website/app/lib/site-url.js` and `src/core/site-url.js` is the new
domain, and 650+ host occurrences were rewritten across the app, engine, CLI,
MCP server, GitHub Action, WordPress plugin, editor extensions and workflows.

So this step is now **belt-and-braces, not load-bearing** — a fresh build serves
`.io` canonicals with no env var set at all. Set the vars anyway: they are what
makes the move reversible without a code change, and `NEXT_PUBLIC_BASE_URL` is
what a rollback would flip.

```bash
ssh root@jarvis
cd /opt/gatetest
cp website/.env.local website/.env.local.bak-$(date +%Y%m%d-%H%M%S)

# set (or add) both names
grep -q '^NEXT_PUBLIC_BASE_URL=' website/.env.local \
  && sed -i 's|^NEXT_PUBLIC_BASE_URL=.*|NEXT_PUBLIC_BASE_URL=https://gatetest.io|' website/.env.local \
  || echo 'NEXT_PUBLIC_BASE_URL=https://gatetest.io' >> website/.env.local

grep -q '^GATETEST_PUBLIC_BASE_URL=' website/.env.local \
  && sed -i 's|^GATETEST_PUBLIC_BASE_URL=.*|GATETEST_PUBLIC_BASE_URL=https://gatetest.io|' website/.env.local \
  || echo 'GATETEST_PUBLIC_BASE_URL=https://gatetest.io' >> website/.env.local
```

`NEXT_PUBLIC_BASE_URL` is inlined into the client bundle **at build time**, so a
rebuild is required — restarting the service is not enough:

```bash
cd /opt/gatetest/website && npm run build && systemctl restart gatetest-web
```

### Badges follow the new origin (reversal of this doc's first version)

Leave `GATETEST_BADGE_ORIGIN` unset. `BADGE_ORIGIN` tracks `SITE_URL`, so newly
generated badge snippets will point at `gatetest.io`.

The first version of this runbook said the opposite — pin badges to `.ai` so
every customer stays on one origin. That reasoning assumed `.ai` was still
serving. It is not: it is NXDOMAIN. Pinning would mint new badges that are
**born broken**, which is strictly worse than splitting old from new.

Already-pasted badges in READMEs we cannot edit are fixed the only way they can
be — by redeeming `.ai` and 301'ing it, below. Not by generating dead URLs.

### E-mail deliberately did NOT move

Every address is still `@gatetest.ai`: `hello@`, `watchdog@` (the Resend `From`),
and the bot commit identities. This is not an oversight.

A URL on a dead domain is a **visible** error a customer will report. A sending
domain the ESP has not verified is a **silent** one — Resend rejects the send or
it lands in spam, and nobody finds out for weeks. Mail moves only after the new
domain is verified.

To move it, in this order:

1. Add `gatetest.io` in the Resend dashboard and publish the SPF/DKIM records it
   gives you in the Cloudflare zone. Wait for it to read *verified*.
2. Set `RESEND_FROM='GateTest <watchdog@gatetest.io>'`.
3. Set `GATETEST_SUPPORT_EMAIL=hello@gatetest.io`, and set up forwarding for it
   first — otherwise support mail is accepted and then dropped.
4. `tests/site-url.test.js` asserts the support address is still on `.ai`.
   Update that assertion in the same commit, so the guard keeps meaning
   something instead of being deleted later by someone who thinks it is stale.

## Step 4 — Verify (do not skip)

```bash
curl -sI https://gatetest.io | head -1                      # expect 200
curl -s https://gatetest.io/api/platform-status | head -c 200   # healthy + current commit
curl -s https://gatetest.io | grep -o '<link rel="canonical"[^>]*>'  # must say gatetest.io
curl -sI https://www.gatetest.io | head -1
curl -sI http://gatetest.io | head -1                       # expect 301 → https
node scripts/ops/readiness-probe.js                         # full journey
```

The canonical check is the one that matters. If it still says `gatetest.ai`, the
rebuild did not pick up the env var — `NEXT_PUBLIC_BASE_URL` is build-time.

---

## Step 5 — third-party consoles (the domain also lives OUTSIDE this repo)

Steps 1–4 make **our** code and server serve the new domain. They do nothing
about the places the old domain is written down in someone else's system. Each
of these is a separate login, all are Boss Rule #4/#6/#7, and the ones marked
**breaks silently** give no error anyone will notice.

| Where | What to change | If skipped |
|---|---|---|
| **Cloudflare** (`gatetest.io` zone) | Step 1 — A records off Vercel onto `66.42.121.161`, grey cloud | Site unreachable |
| **Vercel** | Disconnect `gatetest.io` from the retired project | Two answers race; stale deploy may still serve |
| **GitHub App** settings | Homepage, Setup URL `/github/setup`, Callback URL `/api/github/callback`, Webhook URL `/api/webhook` | **Breaks silently** — push/PR events post to a dead host, no commit statuses |
| **Stripe** → Developers → Webhooks | Endpoint URL → `https://gatetest.io/api/stripe-webhook` | **Breaks silently** — customer pays, scan never starts |
| **Resend** | Verify `gatetest.io`, publish SPF/DKIM, then set `RESEND_FROM` | **Breaks silently** — all mail rejected or spam-foldered |
| **Sentry** OAuth app | Redirect URI → `https://gatetest.io/api/integrations/sentry/callback` | Sentry connect flow 400s on callback |
| **GitHub Marketplace** listing | Every URL in `integrations/marketplace/listing.md` (already updated in-repo) | Listing points at a dead domain mid-review |
| **Google Search Console** | Add `gatetest.io` property, submit sitemap, file Change of Address from `.ai` | Rankings restart from zero instead of transferring |
| **Bing Webmaster** + **IndexNow** | Add the site; host the IndexNow key at `https://gatetest.io/<key>.txt` | IndexNow rejects every batch (host mismatch) |
| **npm** | Republish `@gatetest/cli` + `@gatetest/mcp-server` so registry metadata and the MCP base URL default update | Installed CLIs keep calling the old host until upgraded |
| **MCP registry** | Resubmit `server.json` | Registry lists a dead endpoint |
| **WordPress.org** | New plugin release (readme + `GATETEST_API_BASE` already updated in-repo) | Installed plugins keep calling the old API host |
| **VS Code Marketplace / Open VSX** | Republish so `homepage` updates | Cosmetic only |
| **Homebrew tap** | `integrations/homebrew/gatetest.rb` homepage (updated in-repo) | Cosmetic only |
| **Tallrig dashboard** (the platform — was Vapron) | `NEXT_PUBLIC_BASE_URL` + `GATETEST_PUBLIC_BASE_URL` = `https://gatetest.io` | Falls back to the code default, which is already `.io` — so harmless, but set it |

### The ones that bite hardest

**The GitHub App webhook and the Stripe webhook.** Both fail without raising
anything a human sees: a customer's push produces no commit status, or a
customer pays and no scan starts. Neither surfaces as an error page. Change
those two first, and then actually test them — push a commit to a repo with the
App installed, and run one test-mode checkout.

---

## Still do the redemption

This gets the product reachable; it does not make the `.ai` problem go away.

1. **Redeem `gatetest.ai` anyway.** Redemption windows are ~30 days from
   2026-07-29; after that it goes to pendingDelete and becomes publicly
   registrable.
2. **The reason it matters even after moving:** every badge in every customer
   README points at `gatetest.ai`. If someone else registers it, they control an
   image URL that renders inside our customers' repos — and the GitHub
   Marketplace listing, the MCP key-delivery emails, and every inbound link
   still name it. Losing it is worse than an outage.
3. **Fix the cause.** A domain dropping to redemption two years before its
   nominal expiry points at a failed payment or chargeback on the Cloudflare
   account, not a lapse. Check the billing on that account or this recurs.
4. Once redeemed, keep `.ai` 301'ing to `.io` permanently rather than retiring it.

## Rollback

Every step is additive and reversible.

- **DNS:** repoint the `gatetest.io` A records at Vercel.
- **Traefik:** the `.ai` rules were never removed — reverse the `sed` to drop the
  `.io` clauses.
- **App:** restore `website/.env.local` from the timestamped backup, rebuild,
  restart.
