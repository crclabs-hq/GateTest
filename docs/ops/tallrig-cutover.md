# Tallrig cutover — the box-side flip (Craig only)

The platform GateTest runs on and dispatches to was renamed **Vapron → Tallrig**
(Craig, 2026-09-14: "vapron is no longer, we've had a name change to
Tallrig.com"). The code side is done on `chore/tallrig-rename`: every default in
`website/app/lib/platform-config.js` is the Tallrig value, and every reader goes
through it with the precedence `TALLRIG_<NAME>` → `VAPRON_<NAME>` (deprecated) →
`CRONTECH_<NAME>` (legacy). Nothing on the box has to change for the site to keep
working — a `.env.local` that still says `VAPRON_*` is read as before. What is
left is the env rename on the production box, so that `/api/status` stops
reporting the platform as `mixed` and every variable resolves from the new name.

Nothing in this file touches DNS, Cloudflare, GitHub settings or the Tallrig
side. It is the env file, one restart, and three curls.

## What is live today (measured 2026-09-15, curl from the dev box)

| URL | Result | Meaning |
|---|---|---|
| `https://tallrig.com/` | 200, body "Tallrig", footer "Tallrig Labs LLC" | the new product host |
| `https://www.tallrig.com/` | 200 | |
| `https://api.tallrig.com/` | 404 at root; `/api/health` → 200 `{"status":"ok"}` | the new API host (root 404 is normal — api.vapron.ai was the same) |
| `https://tallrig.com/api/health/status` | 200, public, `overall: "ok"` + services | the inter-platform status document (`TALLRIG_STATUS_URL` default) |
| `https://api.tallrig.com/api/health/status` | 200, same document | |
| `https://tallrig.com/api/platform/email/send` | 401 | the mail endpoint exists and is key-gated (`TALLRIG_MAIL_URL` default) |
| `https://api.tallrig.com/api/platform/<anything>` | 401 on every path | the dispatch base is key-gated before routing — a 401 is not proof a route exists (same trap as api.vapron.ai, see `platform-siblings.js`) |
| `https://crontech.ai/` | 301 → `https://tallrig.com/` | the legacy redirect already lands on the new host |
| `https://vapron.ai/`, `https://www.vapron.ai/` | 200, same IP (149.28.119.158), same Tallrig-branded page | old name still serving during the transition window — it is NOT a redirect |
| `https://api.vapron.ai/api/health` | 200 | old API name still up |
| `https://tallrig.io/` | 404 | ops host, nothing there yet |
| `https://tallrig.net` | no TLS (http 308) | mail/infra host, not serving yet |
| `https://gatetest.io/api/status` → `platform` | `name: "Vapron", pointed_at: "mixed", dispatch: {BASE_URL: "vapron", API_TOKEN: null, DISPATCH_SECRET: null}, mail_url: "default", status_url: "default"` | the box has VAPRON_BASE_URL only; the token and secret were never set (KI #80) |

## 1. Deploy the branch

Merge `chore/tallrig-rename` (via `integration/launch-ready-2026-09-14`) and
deploy as usual (`deploy-box.yml` → `deploy-on-box.sh`: git pull, `npm run build`
in `website/`, restart `gatetest-web`). The `NEXT_PUBLIC_PLATFORM_*` values are
inlined at build time and default to Tallrig, so the copy, the footer, the /stack
page, the legal sub-processor row ("Tallrig", "Tallrig Labs LLC",
`https://tallrig.com`) and `/api/status`'s `platform.name` flip with the build,
no env needed.

## 2. `.env.local` on the box (`/opt/gatetest/website/.env.local`, chmod 600)

Add these lines. Values are typed on the box, never through chat.

```
# ── Platform: Tallrig (renamed from Vapron 2026-09-14). Canonical names.
# Runtime-scan dispatch. All three must be set from the SAME prefix or /api/status
# reports pointed_at: "mixed". Today only VAPRON_BASE_URL exists on the box.
TALLRIG_BASE_URL=https://api.tallrig.com/api/platform
TALLRIG_API_TOKEN=<the key the Tallrig dashboard issues for the gatetest app — Connected Apps → gatetest → Rotate key; never set before, KI #80>
TALLRIG_DISPATCH_SECRET=<openssl rand -hex 32 — the SAME value must be held on the Tallrig side; never set before, KI #80>

# Optional — the defaults are already the Tallrig values below; set only to override.
# TALLRIG_MAIL_URL=https://tallrig.com/api/platform/email/send
# TALLRIG_STATUS_URL=https://tallrig.com/api/health/status
# PLATFORM_CANONICAL_HOST=tallrig.com

# Only if the box's systemd units are still named vapron-* (check: systemctl list-units | grep -E 'vapron|tallrig').
# The code defaults to tallrig-* and heal/ssh falls back to vapron-*/crontech-* anyway.
# PLATFORM_SERVICE_PREFIX=vapron

# Mail — NOT part of this flip. Resend stays live while MAIL_PROVIDER is unset.
# When you are ready to move e-mail onto the platform, prove it first:
#   set -a; . /opt/gatetest/website/.env.local; set +a
#   MAIL_PROVIDER=tallrig node scripts/ops/mail-test.js support@gatetest.io
# then add:
# MAIL_PROVIDER=tallrig          (`vapron` still works and logs one deprecation warning)
# TALLRIG_API_KEY=<same key as TALLRIG_API_TOKEN unless the dashboard issues a separate mail key>
```

Then remove (or comment out) the old names so nothing reads them by accident:

```
VAPRON_BASE_URL=        ← delete; TALLRIG_BASE_URL replaces it
VAPRON_API_TOKEN=       ← delete if present
VAPRON_DISPATCH_SECRET= ← delete if present
CRONTECH_DISPATCH_SECRET= ← delete if present
```

Keeping them does no harm (TALLRIG_* wins), but `/api/status` will keep saying
`pointed_at: "mixed"` for any variable that is only set under the old name.

Do NOT set `NEXT_PUBLIC_PLATFORM_NAME`, `_ENTITY`, `_ID`, `_URL`, `_API_URL` —
their defaults are the Tallrig values and they need a rebuild to change.

## 3. Restart

```
sudo systemctl restart gatetest-web
```

## 4. Verify (three curls, in this order)

```
curl -s https://gatetest.io/api/status | jq .platform
#   expect: { "name": "Tallrig", "pointed_at": "tallrig",
#             "dispatch": { "BASE_URL": "tallrig", "API_TOKEN": "tallrig", "DISPATCH_SECRET": "tallrig" },
#             "mail_url": "default", "status_url": "default" }
#   "mixed"  → one of the three dispatch vars is still under VAPRON_/CRONTECH_ or unset; the dispatch map names it.
#   "unset"  → none of the three resolve; the env file was not reloaded (restart) or the lines did not save.

curl -s https://gatetest.io/api/platform-status | jq .siblings
#   expect the platform entry under the key "tallrig" → "https://tallrig.com/api/health/status"
#   (the key was "vapron" — anything on the Gluecron/Tallrig side that read siblings.vapron must read siblings.tallrig)

node integrations/smoke/empire-smoke.js
#   expect: platform-home PASS/WARN(slow), platform-api-health PASS, crontech-redirect PASS,
#           cert-platform PASS/WARN — the crontech-redirect probe is what was red before the rename.
```

## 5. After the flip

- The `VAPRON_*` env aliases, the `vapron` MAIL_PROVIDER alias, the heal/ssh
  `vapron-*` unit fallbacks and the `vapron-dispatch.js` filename stay until
  the Tallrig side announces the vapron.* sunset date. When it does: drop
  `VAPRON_` from `ENV_PREFIXES` in `platform-config.js`, and the tests that
  say "still read" will tell you what else to remove.
- `docs/deploy/VAPRON-DEPLOY.md` and
  `docs/integrations/VAPRON-RUNTIME-SCAN-SPEC.md` keep their filenames (links
  and `tests/cron-endpoint-methods.test.js` resolve them); both open with the
  rename banner.
- Not settled by this branch, needs the Tallrig side or you: whether the box's
  systemd units were renamed (`vapron-bun-gateway` → `tallrig-bun-gateway`);
  whether `github.com/ccantynz-alt/Vapron` was renamed; whether the Tallrig side
  has actually implemented `POST /api/jobs/web-runtime-scan` (the 401 proves
  only the key gate); tallrig.net has no TLS yet.
