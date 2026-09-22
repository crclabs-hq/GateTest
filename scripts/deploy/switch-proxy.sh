#!/usr/bin/env bash
# switch-proxy.sh <new-port> — flip the reverse proxy so gatetest.io traffic
# goes to <new-port> instead of whichever port is currently active.
#
# NOT IMPLEMENTED ON PURPOSE. CLAUDE.md's Deployment Doctrine (2026-09-11,
# "DEPLOYMENT DOCTRINE — GATETEST.IO RUNS ON TALLRIG") is explicit:
#
#   "Reverse proxy: the platform's bun gateway (tallrig-bun-gateway) owns
#   80/443, ALL TLS termination, and ACME certificates. Caddy, nginx,
#   certbot, and every other proxy are BANNED — never suggest, install, or
#   configure one. Public hostnames are added on the Tallrig side, not here."
#
# scripts/deploy/blue-green-restart.sh (issue #663, the 502-during-restart
# fix) needs SOME way to flip the box's real front door from the old build's
# port to the new one, but that front door's config lives on the Tallrig
# side, outside this repo's reach — writing a Caddy or nginx config here
# would both violate the doctrine above and not even be the proxy that is
# actually running in production. So this is a pluggable hook, not a
# hardcoded implementation:
#
#   - Craig / the Tallrig side implements the real switch in this file (or
#     points PULL_DEPLOY_PROXY_SWITCH_CMD at a script that does), once it is
#     known how tallrig-bun-gateway's upstream can be flipped from the box
#     side (a config file it watches, an admin API, a signal — TBD, a
#     Tallrig-side decision, Boss Rule #4/#7: domain routing + new
#     integrations need Craig's authorization).
#   - Until then, this refuses loudly rather than silently doing nothing
#     (Bible Engineering Doctrine #1 — never report success while doing
#     nothing). blue-green-restart.sh treats a non-zero exit here as "abort,
#     old instance stays live, exit non-zero" — the safe failure mode: no
#     downtime, no traffic ever pointed at nothing, just a build that is
#     ready and healthy on the alternate port and cannot go live
#     automatically yet.
#
# A box that cannot wire this up yet should run with PULL_DEPLOY_INPLACE=1
# instead (see docs/deploy/PULL-DEPLOY.md "Blue/green"), which restarts the
# single existing unit exactly as pull-deploy.sh always has.
set -euo pipefail

NEW_PORT="${1:?usage: switch-proxy.sh <new-port>}"

echo "[switch-proxy] ERROR: no proxy-switch mechanism is configured for this box." >&2
echo "[switch-proxy]        tallrig-bun-gateway fronts gatetest.io and its upstream" >&2
echo "[switch-proxy]        config lives on the Tallrig side (CLAUDE.md Deployment" >&2
echo "[switch-proxy]        Doctrine bans Caddy/nginx here) — implement the real" >&2
echo "[switch-proxy]        switch in this file, or point PULL_DEPLOY_PROXY_SWITCH_CMD" >&2
echo "[switch-proxy]        at a script that does, before relying on blue/green." >&2
echo "[switch-proxy]        Requested switch to port $NEW_PORT was NOT performed." >&2
exit 1
