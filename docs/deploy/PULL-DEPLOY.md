# Pull-based deploy — the box deploys itself

> **Why this exists:** Box 161 closed public SSH (port 22) on 2026-09-16 as
> part of estate hardening ("CI keys never get a shell"). Before that,
> `.github/workflows/deploy-box.yml` SSHed a GitHub-hosted runner onto the box
> and ran `scripts/deploy/deploy-on-box.sh` there. With port 22 closed, every
> run of that path ends `ssh: connect to host … port 22: Connection timed
> out` — nothing inbound can reach the box any more, by design, permanently.
>
> The fix is not to re-open 22. It is to flip the direction: the box now
> **pulls**. A systemd timer on the box, `gatetest-pull-deploy.timer`, runs
> `scripts/deploy/pull-deploy.sh` every 5 minutes. It checks `origin/main` and,
> if it has moved, deploys itself using `scripts/deploy/deploy-on-box.sh` —
> exactly the same deploy script the old SSH path ran, unchanged. The common
> case (nothing new since the last tick) costs one `git fetch` and nothing
> else: no build, no restart, no work.

**Status (2026-09-19):** the box was recovered manually over the mesh at
15:02Z (`DEPLOY_RECOVER=1 bash scripts/deploy/deploy-on-box.sh`, see "How
recovery differs" below) — it is now clean, on `main`, at `4b63bada`. The
timer is not installed yet (see "One-time install"); once it is, its first
tick will see `up to date at 4b63bada` and do nothing, which is the point.

## "Up to date" ignores the deploy script's own dirty files

Every real deploy leaves the tree with a handful of tracked files modified —
`deploy-on-box.sh`'s own `SELF_DIRTIED` list: `package-lock.json`,
`website/package-lock.json`, `website/app/data/build-info.json`,
`website/app/data/changelog.json` (confirmed present after the 2026-09-19
15:02Z recovery deploy). `pull-deploy.sh`'s up-to-date fast path judges
"nothing to do" **purely by comparing commits** (`git rev-parse HEAD` vs
`git rev-parse origin/main`) — it never runs `git status` and never treats a
dirty tree as a reason to deploy or to refuse. Working-tree cleanliness is
`deploy-on-box.sh`'s own job (`SELF_DIRTIED` in that script), and it only
runs at all once `pull-deploy.sh` has already decided `origin/main` moved.
`tests/pull-deploy.test.js` pins this: a box with exactly those four files
dirty and `origin/main` unchanged still reports `up-to-date` and never
invokes the deploy script.

## Security model — read this before installing

Box 161 hosts other products. **Whoever can land a commit on this repo's
`main` effectively gets root on the box the moment this timer runs it** — the
timer runs as root (see "Recommended hardening" below) and executes whatever
`scripts/deploy/deploy-on-box.sh` says to do, straight from `origin/main`.
That is not a new risk pull-deploy introduces — the old SSH path had the exact
same property, just triggered from the other direction — but a timer that
polls unattended every 5 minutes deserves the guardrails spelled out, not
assumed.

**What actually stands between a contributor and the box today:** branch
protection on `main` — four required status checks (`Test + Build`,
`Pre-Merge Sweep`, `GateTest Quality Gate`, `GateTest Full Scan`) and no force
pushes allowed. Nobody merges to `main` without all four green, and nobody
rewrites `main`'s history once merged. `pull-deploy.sh`'s own checks below are
a **box-side backstop behind that gate, not a substitute for it** — they
protect against the gate being reconfigured, a compromised token that can
still push (but not force-push) to `main`, or `origin` on the box being
pointed somewhere else by mistake or by an attacker with disk access.

Before running anything piped from git, `pull-deploy.sh` refuses unless:

1. **`origin` is the expected repository.** `git remote get-url origin` must
   normalize to `https://github.com/crclabs-hq/GateTest` (the `https://` and
   `git@github.com:` forms both match, `.git` suffix optional). A remote
   pointed anywhere else — deliberately or by mistake — is refused with
   `origin remote is not the expected GateTest repository`, before any
   network call. (Overridable only by `PULL_DEPLOY_EXPECTED_ORIGIN`, which
   exists solely so `tests/pull-deploy.test.js` can point it at a throwaway
   repo — there is no operational reason to set it on the box.)
2. **`origin/main` is a fast-forward of the commit already deployed.** A
   force-pushed or rewritten `main` — which branch protection already
   forbids, but a backstop assumes the front stop can fail — is refused with
   `origin/main is not a fast-forward of the deployed commit` rather than
   deployed silently.

Both failures write `result: "failed"` to the status file with the reason,
and neither ever runs `scripts/deploy/deploy-on-box.sh`.

**Next step if the estate wants more than branch protection:** commit-signature
verification (`required_signatures` on the branch protection rule, or
`pull-deploy.sh` calling `git verify-commit` on `origin/main` before
deploying). Not implemented here — flagged for Craig, since it changes what a
contributor's local git setup must do to land a change at all.

## One-time install (someone with mesh access to the box, as root)

Three commands, from a checkout at `/opt/gatetest` (or `GATETEST_APP_DIR`):

```bash
cd /opt/gatetest
git pull   # make sure this file's changes are actually on the box first
sudo scripts/deploy/install-pull-deploy.sh
```

The installer copies the pull-deploy unit files plus the `gatetest-web@.service`
blue/green template into `/etc/systemd/system/`, runs `systemctl daemon-reload`,
enables and starts the timer, and prints
`systemctl list-timers gatetest-pull-deploy.timer` so you can see it scheduled
immediately. It is idempotent — re-run it any time a later commit ships an
updated unit file or a fixed `pull-deploy.sh`. It refuses to run as anything
but root, and it never touches `ufw`, `ssh`, or `tailscale` — those are
estate-managed and out of scope for a repo-shipped script. It does **not**
start a `gatetest-web@<port>` instance or touch the existing `gatetest-web`
unit — see "Blue/green" below for that one-time migration.

## Blue/green — no more 502s on every deploy (issue #663)

**The problem this replaces:** every deploy used to restart `gatetest-web` in
place — the old process stops, the new one starts, and for the few seconds in
between the reverse proxy has nothing to send traffic to and answers 502.
Tallrig's own express re-walk caught two such 502s during the `9a9b9d84`
deploy; a customer polling `/api/platform-status`, or mid-scan on the
playground, sees the same thing.

**The fix:** `pull-deploy.sh` now runs deploys through
`scripts/deploy/blue-green-restart.sh` instead of restarting the unit in
place. It starts the new build on whichever port is NOT currently live
(`gatetest-web@3000.service` / `gatetest-web@3001.service`, both instances of
the `gatetest-web@.service` template), polls that instance's
`/api/platform-status` **directly on localhost** (bypassing the proxy) until
it answers 200 with the commit that was just deployed, hands off to a
proxy-switch step, and only then stops the old instance. If the new instance
never becomes healthy within 120s, the script aborts — the old instance is
never touched, so production keeps serving the previous build — and exits
non-zero. After the switch, it polls the **public** `/api/platform-status`
(through the proxy) once a second for 30 seconds and exits non-zero with a
clear log line on the first non-200.

**Why the proxy-switch step is a pluggable hook, not a Caddy or nginx
config:** this repo's own `CLAUDE.md` ("DEPLOYMENT DOCTRINE — GATETEST.IO
RUNS ON TALLRIG", 2026-09-11) is explicit that the box's reverse proxy is
Tallrig's own `tallrig-bun-gateway`, that it owns 80/443 and all TLS
termination, and that *"Caddy, nginx, certbot, and every other proxy are
BANNED — never suggest, install, or configure one. Public hostnames are added
on the Tallrig side, not here."* Neither Caddy nor nginx is used anywhere in
this repo or on the box. Writing a config for either here would both violate
that doctrine and configure a proxy that is not the one actually running in
production.

So `blue-green-restart.sh` calls an external command,
`PULL_DEPLOY_PROXY_SWITCH_CMD` (default `scripts/deploy/switch-proxy.sh`),
with the new port as its only argument, and treats a non-zero exit from it
exactly like a failed health check: abort, old instance stays live, exit
non-zero. **`scripts/deploy/switch-proxy.sh` ships refusing on purpose** — it
does not know how to flip `tallrig-bun-gateway`'s upstream, because that
mechanism lives on the Tallrig side, out of this repo's reach, and inventing
one here would be the same doctrine violation. This is a genuine open item,
not a code gap this PR could close: **Craig / the Tallrig side needs to
decide how the box exposes a way to flip the gateway's upstream** (a config
file it watches, an admin API, a signal — TBD), and then either implement
that in `switch-proxy.sh` or point `PULL_DEPLOY_PROXY_SWITCH_CMD` at a script
that does.

**Until the proxy-switch command is wired up, every automatic deploy will
abort safely** (new build built and health-checked on the alternate port,
old build still serving, exit code non-zero, visible in
`journalctl -u gatetest-pull-deploy`) rather than silently doing nothing —
that is the intended, honest failure mode (Bible Engineering Doctrine #1:
never report success while doing nothing), not a bug. **A box that is not
ready for blue/green yet should set `PULL_DEPLOY_INPLACE=1`**, which restores
the exact old behaviour (restart `gatetest-web` in place, brief 502s, no
health check, no switch step) until the proxy-switch mechanism exists.

### Exact install commands (owner-run — never run by an agent against the box)

One-time migration from the single `gatetest-web.service` onto the blue/green
template, from a checkout at `/opt/gatetest` (or `GATETEST_APP_DIR`), as root:

```bash
cd /opt/gatetest
git pull
sudo scripts/deploy/install-pull-deploy.sh   # copies gatetest-web@.service too, idempotent
sudo systemctl daemon-reload

# Bootstrap: start the SAME build already running, on port 3000, under the
# new template unit, then stop the old single unit. This does not change
# what code is serving — it only changes which systemd unit owns it.
sudo systemctl start gatetest-web@3000.service
curl -s http://10.0.1.1:3000/api/platform-status   # confirm it answers before stopping the old unit
sudo systemctl stop gatetest-web.service
sudo systemctl disable gatetest-web.service        # the template units own it from here
echo 3000 | sudo tee /var/lib/gatetest/pull-deploy-active-port

# One-time proxy config change (Tallrig side, not this repo): whoever owns
# tallrig-bun-gateway's config needs to give this box a way to flip its
# upstream between 10.0.1.1:3000 and 10.0.1.1:3001 on command, and that
# command needs to be wired into scripts/deploy/switch-proxy.sh (or
# PULL_DEPLOY_PROXY_SWITCH_CMD) before the next step. Until then, deploys
# will abort safely at the switch step — see above.
```

**Verify** (after a real deploy has gone through blue/green at least once):

```bash
# Confirms which port is live and that pull-deploy's own bookkeeping agrees.
cat /var/lib/gatetest/pull-deploy-active-port
curl -s http://10.0.1.1:"$(cat /var/lib/gatetest/pull-deploy-active-port)"/api/platform-status | jq .commit

# Confirms the public path (through the real proxy) matches the same commit.
curl -s https://gatetest.io/api/platform-status | jq .commit

# Confirms the OTHER port is not still holding an instance open.
systemctl list-units 'gatetest-web@*' --no-legend

journalctl -u gatetest-pull-deploy -n 50 --no-pager   # the [blue-green] log lines from the last deploy
```

A box with only one port free (or that has not wired up the proxy-switch
command yet) should skip the migration above and instead add one line to
`gatetest-pull-deploy.service`'s `[Service]` block —
`Environment=PULL_DEPLOY_INPLACE=1` — then `sudo systemctl daemon-reload`.
`pull-deploy.sh` reads that and keeps restarting the single `gatetest-web`
unit in place exactly as it always has (brief 502s, no health check, no
switch step) until the box is ready to migrate.

## Recommended hardening: run as non-root

**Today's default is `User=root`**, because `/opt/gatetest` is root-owned and
`deploy-on-box.sh` needs root to `systemctl restart gatetest-web`. That
matches every deploy that has ever touched this checkout (the old SSH path
also ran as root on the box) — it is not a regression, but it is not the
end state either, especially on a box that hosts other products.

**Before enabling this timer on a shared box**, consider migrating to a
dedicated non-root `gatetest` user:

1. `chown -R gatetest:gatetest /opt/gatetest` (create the user first if it
   does not exist: `useradd --system --home /opt/gatetest gatetest`).
2. Grant exactly the one privileged operation the deploy needs — the restart —
   via a narrow sudoers rule, not a shell:
   ```
   # /etc/sudoers.d/gatetest-pull-deploy
   gatetest ALL=(root) NOPASSWD: /usr/bin/systemctl restart gatetest-web
   ```
   `deploy-on-box.sh`'s restart step would need to call
   `sudo systemctl restart gatetest-web` instead of `systemctl restart
   gatetest-web` for this to work — that script is out of scope for this
   change (see the PR that shipped pull-deploy: it touches only the files
   listed there) and is a **follow-up**, not something this installer does
   silently.
3. Change `User=root` to `User=gatetest` in
   `scripts/deploy/systemd/gatetest-pull-deploy.service` and re-run
   `install-pull-deploy.sh`.

The installer never performs any of these three steps itself — ownership
changes and sudoers rules are exactly the kind of privileged, once-per-box
decision that should be made deliberately by whoever has root, not embedded in
a script that runs unattended every 5 minutes.

## Seeing the last result

**Status file** — one line of JSON, `at` / `before` / `after` / `result`
(`up-to-date` | `deployed` | `failed`) / `reason`:

```bash
cat /var/lib/gatetest/pull-deploy-status.json
```

**Logs** — everything `pull-deploy.sh` and (when it runs)
`deploy-on-box.sh` printed:

```bash
journalctl -u gatetest-pull-deploy -n 100 --no-pager
```

**Is the timer actually scheduled:**

```bash
systemctl list-timers gatetest-pull-deploy.timer
```

## How recovery differs

`pull-deploy.sh` **never sets `DEPLOY_RECOVER`**. If the box is stuck on the
wrong branch or has hand edits — the scenario `DEPLOY_RECOVER=1` fixes (see
[PR #611](https://github.com/crclabs-hq/GateTest/pull/611)) — the pull timer's
own guards refuse the same way `deploy-on-box.sh` always has: loudly, without
touching anything. Recovery stays a **deliberate human act**, run manually:

```bash
cd /opt/gatetest
DEPLOY_RECOVER=1 bash scripts/deploy/deploy-on-box.sh
```

This is unchanged by pull-deploy — it is documented here only so recovery is
not confused with something the timer does on its own.

## Rollback

Disable the timer; production stops deploying itself and holds at whatever
commit it last reached (it does **not** revert):

```bash
sudo systemctl disable --now gatetest-pull-deploy.timer
```

Re-enable with `sudo systemctl enable --now gatetest-pull-deploy.timer`, or
re-run `install-pull-deploy.sh`.

## Why `deploy-box.yml` no longer turns red on every push

`.github/workflows/deploy-box.yml`'s `deploy` job (the SSH path) now only runs
on a manual `workflow_dispatch` — kept for the day SSH-over-mesh exists, not
for every push, since a push can no longer reach the box that way. A push
instead triggers `poll-pull-deploy`, which polls `/api/platform-status` (the
`commit` field — **not** `/api/status`, which is the operator-readiness probe
and carries no commit stamp at all) for up to 15 minutes via
`scripts/ops/verify-deploy.js`, and goes red only if the pull timer has not
picked up the pushed commit in that window.
