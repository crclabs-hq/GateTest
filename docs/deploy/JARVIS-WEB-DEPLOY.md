# GateTest website deploy — gatetest.ai on box 161

Deployed by Jarvis session 50, 2026-07-08. Companion to `JARVIS-MCP-DEPLOY.md` (mcp.gatetest.ai).
Implements the two-box-estate-model (Craig, 2026-07-08): box 161 hosts and serves the web pages;
box 158 (Vapron, 149.28.119.158) provides backend services (email/SMS/storage/AI) over HTTPS only.
Never SSH between boxes. DNS follows hosting: `gatetest.ai` A → 66.42.121.161, never → 158.

## Topology

```
Cloudflare DNS (gatetest.ai, www → A 66.42.121.161, DNS-only)
  → coolify-proxy (Traefik v3.6 container, owns :80/:443 on this box)
      file-provider route: /data/coolify/proxy/dynamic/gatetest-web.yaml
  → http://10.0.1.1:3000  (host gateway IP on the `coolify` docker network)
  → gatetest-web.service  (systemd, Next.js 16, /opt/gatetest/website)
```

- **Front-door decision (deliberate, per onboarding brief):** written doctrine mentioned a
  bun-gateway owning 80/443, but Traefik (`coolify-proxy`) is what actually listens and already
  serves gluecron.com and mcp.gatetest.ai. Traefik serves gatetest.ai. Revisit only as part of a
  planned front-door migration (Vapron/other) — swing the route, don't run two owners of :80/:443.
- **Bind address:** the app binds `10.0.1.1:3000` only (`-H 10.0.1.1`). Literal 127.0.0.1-only is
  impossible here — Traefik runs in a container and cannot reach host loopback. 10.0.1.1 is not
  publicly routable and UFW default-denies anyway (verified: `curl 66.42.121.161:3000` fails).
- **Firewall:** `ufw allow from 10.0.1.0/24 to any port 3000 proto tcp` (comment
  `gatetest-web: traefik->host service`) — same pattern as the MCP rule for :8787. Without it,
  Traefik → host times out and the site 504s.
- **TLS:** Traefik ACME (`certResolver: letsencrypt`, HTTP-01), cert in
  `/data/coolify/proxy/acme.json`, SANs `gatetest.ai` + `www.gatetest.ai`. Auto-renews.

## Pieces

| Piece | Path |
|---|---|
| App checkout | `/opt/gatetest/website` (use `/opt/gatetest`, not the stale `/root/gatetest` registry path) |
| Env (chmod 600) | `/opt/gatetest/website/.env.local` — Next.js loads it itself at runtime |
| systemd unit | `/etc/systemd/system/gatetest-web.service` (enabled; `Restart=always`) |
| Traefik route | `/data/coolify/proxy/dynamic/gatetest-web.yaml` (hot-reloaded; append-only, never edit co-tenant files) |
| Build log | build of 2026-07-06 (commit 3d48fc2) reused; rebuild with `cd /opt/gatetest/website && npm run build` |

## Deploy / update procedure

```
cd /opt/gatetest && git pull
cd website && npm ci && npm run build     # NEXT_PUBLIC_* vars bake in at build time
systemctl restart gatetest-web
curl -s -o /dev/null -w '%{http_code}' https://gatetest.ai/   # expect 200
```

## Vapron backend wiring (strict — old providers being cancelled)

- `VAPRON_BASE_URL=https://api.vapron.ai/api/platform` (set in `.env.local`).
- `VAPRON_API_KEY` / `VAPRON_API_TOKEN`: the issued vpk_ key was never saved on this box.
  **Craig: Vapron dashboard → Connected Apps → gatetest → Rotate key**, then set BOTH vars to the
  new value (the website's client, `app/lib/vapron-dispatch.js`, sends `VAPRON_API_TOKEN` as
  Bearer) and `systemctl restart gatetest-web`.
- `VAPRON_DISPATCH_SECRET`: HMAC shared secret for dispatch signatures + inbound
  `/api/web/scan/runtime-callback` verification — obtain from the Vapron side.
- Do NOT add SendGrid, Twilio, S3/AWS, OpenAI-direct, or Vercel/Render/Cloudflare SDKs/env vars.

## Still pending (site serves without them; features degrade gracefully)

`DATABASE_URL` (Neon), `SESSION_SECRET`, OAuth client ids/secrets (GitHub/GitLab/Google),
`ANTHROPIC_API_KEY`, `STRIPE_*`, `CRON_SECRET`, `RESEND_*`, Sentry DSNs — copy real values from
the old Vercel project env into `.env.local`, then restart. Full reference: `.env.example`.
Note: Vercel cron jobs (`/api/watches/tick`, `/api/scan/worker/tick`) no longer fire after leaving
Vercel — schedule replacements (systemd timers or Vapron) when those features are needed.

## Verify (Rule 2 artifacts, all green 2026-07-08)

```
https://gatetest.ai/        → 200, LE cert (issuer C=US O=Let's Encrypt)
https://www.gatetest.ai/    → 200
http://gatetest.ai/         → 301 → https
curl 66.42.121.161:3000     → unreachable (bind + ufw)
co-tenants: https://gluecron.com 200 · mcp.gatetest.ai app answering (404 on /, 405 on GET /mcp — normal for POST-only MCP endpoint)
systemctl is-active gatetest-web → active, survives restart
```

## Incident — 2026-07-16: box sat 8 days behind main, redeployed

`/opt/gatetest` had drifted to commit `b6a9f85` (2026-07-08) while `origin/main` moved on ~110
commits — nobody had run the deploy procedure above since the initial 2026-07-08 setup. Symptom:
`gatetest.ai/` served a cached "Page Not Found" page (200 status, `s-maxage=31536000` — a stale
Next.js response cached for a year), `/api/status`, `/api/mcp`, `/icon.png` all 404.

Also found: the live DNS zone had a **second** `A gatetest.ai → 149.28.119.158` record (and one
for `www`) alongside the correct `66.42.121.161` one — direct violation of this doc's own "DNS
follows hosting... never → 158" rule above. Port 443 on 158 isn't listening at all (it's a
backend-only box per the two-box model), so any client whose DNS resolver picked that IP in the
round-robin would just hang. **Craig still needs to remove those two 158 A records** — not done
as part of this fix (DNS changes are his call).

Two local-only commits existed on the box (`3d48fc2`, `b6a9f85`, both Craig-authored 2026-07-06,
never pushed) — preserved on branch `jarvis-box-local-20260706-preserve` (pushed to origin) before
resetting the box to `origin/main`, so nothing was lost. Redeployed per the procedure above;
`gatetest-web` and `gatetest-mcp` both restarted clean, all previously-404ing paths verified 200.

**Takeaway for future sessions:** there is no automated deploy-on-push for this box. A push to
`main` does **not** reach production by itself — someone (or some future CI hook) has to run the
update procedure above. Consider this the next real gap to close if pushes should auto-deploy.
