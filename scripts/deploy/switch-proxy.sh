#!/usr/bin/env bash
# switch-proxy.sh <new-port> <expected-commit> — flip gatetest.io's real
# front door from whichever port is currently active to <new-port>, then
# verify the public endpoint actually serves <expected-commit> before
# returning success.
#
# CORRECTED 2026-09-22 (read-only verification on box 161 by the platform
# team): CLAUDE.md's Deployment Doctrine describes the intended end state
# (Tallrig's own `tallrig-bun-gateway` fronting the box), but that migration
# has not happened — nothing of Tallrig's is in front of gatetest.io today.
# Ports 80/443 belong to the `coolify-proxy` container: Traefik v3.6, file
# provider, `--providers.file.watch=true`. gatetest.io's route is one file,
# `/data/coolify/proxy/dynamic/gatetest-web.yaml` — router `gatetest-web` ->
# service `gatetest-web` -> a single-server loadBalancer pointed at
# `http://10.0.1.1:<port>`. Traefik reloads a watched file WITHOUT dropping
# connections, which is exactly the zero-downtime primitive issue #663
# needs. See docs/deploy/PULL-DEPLOY.md "Blue/green" for the full story —
# this is a factual correction to that deploy doc, not to CLAUDE.md's
# doctrine (which still describes the intended Tallrig end state and is left
# untouched here).
#
# Deliberately ONE server in the loadBalancer, never two-plus-healthCheck:
# while both ports are healthy Traefik round-robins across builds, and a
# page served by one build fetching /_next/static assets hashed by the
# OTHER build 404s. Single server, atomic file rewrite, verify through the
# real front door — never a rolling failover.
#
# The `mv` onto the watched file is the atomic switch. The curl through the
# public hostname (not localhost — the whole point is proving the REAL
# front door serves the new build, not just that the file changed) is the
# receipt.
#
# SELF-RESTORING ON A FAILED RECEIPT (platform-team review of 338242e4,
# 2026-09-22): a prior version left the file pointing at the unverified port
# on a failed receipt and relied on the CALLER (blue-green-restart.sh) to
# roll back. That has a real gap: if the caller dies between this script's
# non-zero exit and its own rollback call (OOM, SSH drop, Ctrl-C), the site
# stays dark on a port nothing ever proved was healthy through the real
# front door — nobody asked it to serve, and it's what's left pointing at
# it. So this script now copies the file's own bytes before rewriting it,
# and if the receipt loop below times out, restores those exact bytes with
# the same atomic `mv` before exiting non-zero — the pointer never rests on
# a target that did not answer, regardless of what happens to the caller
# afterward. blue-green-restart.sh still calls this same script again with
# the OLD port and OLD commit on a failed switch, belt-and-braces: since the
# file is already back to that state, that call is a same-content rewrite
# (mv onto itself) that verifies immediately and succeeds — it is not
# required for correctness any more, but it stays as an explicit, logged
# confirmation and must not itself fail just because there was nothing left
# to fix.
set -euo pipefail

P="${1:?usage: switch-proxy.sh <new-port> <expected-commit>}"
EXP="${2:?usage: switch-proxy.sh <new-port> <expected-commit>}"
f="${PULL_DEPLOY_TRAEFIK_FILE:-/data/coolify/proxy/dynamic/gatetest-web.yaml}"
host="${PULL_DEPLOY_BIND_HOST:-10.0.1.1}"
public="${PULL_DEPLOY_PUBLIC_HOST:-gatetest.io}"
# Parameterized for tests only — production always gets the defaults below
# (30 attempts * 0.5s = 15s), matching the verified box behaviour exactly.
ATTEMPTS="${PULL_DEPLOY_TRAEFIK_VERIFY_ATTEMPTS:-30}"
INTERVAL_S="${PULL_DEPLOY_TRAEFIK_VERIFY_INTERVAL_S:-0.5}"

if [ ! -f "$f" ]; then
  echo "[switch-proxy] ERROR: Traefik dynamic file not found: $f" >&2
  exit 1
fi

if ! grep -q "http://${host}:300[01]" "$f"; then
  echo "[switch-proxy] ERROR: no http://${host}:3000 or :3001 upstream found in $f — refusing to guess, nothing changed" >&2
  exit 1
fi

# Byte-exact copy of the pre-switch file, kept only until we know the switch
# either verified (then discarded) or didn't (then restored). $$ (this
# script's own pid) is enough to avoid colliding with a concurrent run —
# pull-deploy.sh's flock already serializes deploys, so this is belt and
# braces, not the only thing preventing a collision.
BACKUP="$f.pre-switch.$$"
cp -p "$f" "$BACKUP"

sed "s#http://${host}:300[01]\b#http://${host}:${P}#" "$f" > "$f.tmp"
mv -f "$f.tmp" "$f"
echo "[switch-proxy] $f now points at http://${host}:${P}"

c=""
for i in $(seq 1 "$ATTEMPTS"); do
  c=$(curl -s -m 3 --resolve "${public}:443:127.0.0.1" "https://${public}/api/platform-status" | grep -o '"commit":"[0-9a-f]*"' | cut -d'"' -f4 || true)
  if [ "$c" = "$EXP" ]; then
    echo "[switch-proxy] verified: ${public} now serves commit $EXP"
    rm -f "$BACKUP"
    exit 0
  fi
  sleep "$INTERVAL_S"
done

echo "[switch-proxy] ERROR: proxy still serving ${c:-nothing}, expected $EXP — restoring $f to its pre-switch state" >&2
if ! mv -f "$BACKUP" "$f"; then
  echo "[switch-proxy] ERROR: restore of $f ALSO failed — it may still point at the unverified port ${P}; fix by hand from $BACKUP" >&2
  exit 1
fi
echo "[switch-proxy] $f restored — never left pointing at the unverified port ${P}" >&2
exit 1
