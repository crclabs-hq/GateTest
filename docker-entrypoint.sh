#!/bin/sh
# The image serves the gatetest.io website by default (CMD ["node","server.js"]),
# but the CLI scan engine ships in the same image at /app/bin/gatetest.js. A
# user who runs `docker run ghcr.io/crclabs-hq/gatetest --project /repo
# --suite quick` expects a scan, not a server that ignores its flags — so if
# the container's arguments look like CLI flags, run the scan engine instead
# of falling through to the default CMD. Anything else (the bare default CMD,
# or an explicit `node server.js` / `node /app/bin/gatetest.js ...` override)
# execs exactly as given, unchanged from before this script existed.
set -e

case "${1:-}" in
  -*)
    exec node /app/bin/gatetest.js "$@"
    ;;
esac

exec "$@"
