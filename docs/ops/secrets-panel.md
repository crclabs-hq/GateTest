# Admin secrets panel (`/admin/secrets`)

Owner directive 2026-09-30: "we need our own infra secrets panel in admin — copy
Tallrig's setup." This is that panel, with the holes found in Tallrig's version
closed rather than copied.

## What it is

- A list of every variable the site's env catalogue knows
  (`website/app/lib/env-catalogue.js` — the same lists `/api/status` answers
  from), plus any custom name you add. For each: tier, why it matters, whether
  it is set / missing / filler, where the running value comes from, whether a
  different value is shadowing the stored one, an 8-hex fingerprint, and
  whether the vendor last accepted it (alive / dead / cannot tell).
- Set, delete and reveal a value; re-apply the whole set; check one credential
  against its vendor; read the audit trail.
- Values are stored in Postgres (`platform_secrets`) encrypted with AES-256-GCM
  under a dedicated master key, and rendered to one file,
  `/var/lib/gatetest/unit-env/platform.env`, which the web unit loads last.
  A path unit sees the file change and runs the existing blue/green restart.
  The web process never restarts itself and never needs sudo.

## How a value reaches the running site

1. You save it in the panel (step-up password required).
2. The web app encrypts it, stores it, and rewrites `platform.env`: temp file in
   the same directory, mode 0600, fsync, read back and compared key by key,
   previous file kept as `platform.env.bak`, rename, fsync of the directory.
3. `gatetest-secrets-apply.path` sees the change and starts
   `gatetest-secrets-apply.service`, which takes pull-deploy's lock and runs
   `scripts/deploy/blue-green-restart.sh` — a new instance starts with the new
   environment, is health-checked, the proxy switches, the old one stops.

## Precedence — which value wins

- `gatetest-web@.service` loads `/opt/gatetest/website/.env.local` first and
  `platform.env` LAST. systemd reads EnvironmentFile= lines in order and a later
  assignment wins (`systemd.exec(5)`), and EnvironmentFile= overrides
  Environment=. So a stored value beats a leftover `.env.local` line.
- `next start` then fills only names NOT already in `process.env` (Next 16
  docs, "Environment Variable Load Order": `process.env` first, then the .env
  files, stopping at the first hit). Next never overrides systemd.
- The panel still flags `shadowed` when the running process has a different
  value than the store — the restart has not happened or failed, or the
  instance was started by a unit without the `platform.env` line. It names the
  winner: `app-env-file` (the `.env.local` line) or `process-env` (anything
  else).

## Install (owner, on the box, once)

Every value below is typed by you on the box. Nothing goes through a chat.

1. Master key — generated straight into the env file, never shown, never in
   shell history as a value:

   ```bash
   sudo -i
   cd /opt/gatetest/website
   printf 'GATETEST_SECRETS_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" >> .env.local
   chmod 600 .env.local
   ```

   Keep an offline copy (password manager). Losing it loses every value stored
   in the panel. To see it once for that copy:
   `grep '^GATETEST_SECRETS_MASTER_KEY=' /opt/gatetest/website/.env.local`.
   It must not equal `SESSION_SECRET` or `GATETEST_ADMIN_PASSWORD`; the panel
   refuses to start the store if it does, if it is not exactly 32 bytes, or if
   it equals any value in `website/.env.example`.

2. Units and directory (after this PR is on the box — pull-deploy brings it):

   ```bash
   sudo bash /opt/gatetest/scripts/deploy/install-secrets.sh
   ```

   Creates `/var/lib/gatetest/unit-env` (owner = the web unit's `User=`, 0700),
   installs `gatetest-secrets-apply.path` + `.service` and the updated
   `gatetest-web@.service`, enables the path unit, and tells you whether the
   master key line is present (by name only).

3. The helper units now hide that directory (`InaccessiblePaths=`). Reinstall
   them so the rule is live:

   ```bash
   sudo bash /opt/gatetest/scripts/deploy/install-pull-deploy.sh
   cd /opt/gatetest && sudo cp scripts/deploy/systemd/gatetest-tick.service \
     scripts/deploy/systemd/gatetest-watches.service \
     scripts/deploy/systemd/gatetest-empire-smoke.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```

4. Restart onto the new template and the key (zero downtime):

   ```bash
   sudo bash /opt/gatetest/scripts/deploy/secrets-apply.sh
   ```

5. Open `https://gatetest.io/admin/secrets`. The header should say the store is
   ready.

## Migration — move the existing `.env.local` values into the store

```bash
cd /opt/gatetest
sudo node scripts/ops/secrets-import-env.js           # dry run: names, fingerprints, what would happen
sudo APPLY=1 node scripts/ops/secrets-import-env.js   # store them and write platform.env
```

Only catalogue names are imported; reserved names, filler values and values
already stored are skipped; a stored value that differs is kept unless you add
`OVERWRITE=1`. It prints names and fingerprints only and writes one audit row
per key. The `.env.local` lines stay — the store wins over them (above). Remove
them later by hand if you want the store to be the only copy; the reserved
names below must stay in `.env.local`.

## Reserved names (never stored in the panel)

`GATETEST_SECRETS_MASTER_KEY`, `GATETEST_SECRETS_MASTER_KEY_NEXT`,
`GATETEST_ADMIN_PASSWORD`, `ADMIN_PASSWORD`, `GATETEST_ADMIN_USERNAMES`,
`SESSION_SECRET`, `DATABASE_URL`, the panel's own path overrides, and the
variables that change how Node runs (`NODE_OPTIONS`, `NODE_ENV`,
`NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `PATH`, `HOME`, `PORT`,
`HOSTNAME`, `LD_PRELOAD`, `LD_LIBRARY_PATH`). List and reasons:
`website/app/lib/secrets/reserved.js`.

## Rotating the master key

1. Add the new key as `GATETEST_SECRETS_MASTER_KEY_NEXT` in `.env.local`
   (same `printf … "$(openssl rand -base64 32)"` form), then
   `sudo bash scripts/deploy/secrets-apply.sh`. New writes now use NEXT; old
   rows still read with the key they name.
2. `sudo node scripts/ops/secrets-rekey.js` (dry run), then
   `sudo APPLY=1 node scripts/ops/secrets-rekey.js`. Batched, re-runnable,
   never overwrites a row edited meanwhile, audited per key. Re-run until it
   reports 0 rows to move.
3. In `.env.local`, replace the `GATETEST_SECRETS_MASTER_KEY` value with the
   NEXT value and delete the NEXT line. Restart with `secrets-apply.sh`.
   Rows keep working: each row names its key by a one-way id, not by slot.

## Step-up

Set, delete, reveal and apply need a `gt_admin_fresh` cookie minted only by
`POST /api/admin/step-up` after the admin password is typed again (15 minutes,
HttpOnly, SameSite=Strict, path `/api/admin`). It is signed with a derivation
of the password that differs from the admin cookie and the internal
`X-Admin-Token`, so no machine-held token can mint it. Five attempts per 15
minutes per IP, counted in Postgres.

## API

All under `/api/admin/`, admin-only, same-origin checked when mutating,
`cache-control: no-store`, audited. Error bodies are `{ "error": "<code>" }`.

| Call | Step-up | Answer |
|---|---|---|
| `GET secrets` | no | `{ storeReady, storeError?, keyVersion, unitEnvPath, applyState, items[] }` |
| `PUT secrets/[name]` `{value}` | yes | `{ ok, fingerprint, apply, warnings? }` |
| `DELETE secrets/[name]` | yes | `{ ok, removed, apply }` |
| `POST secrets/[name]/reveal` | yes | `{ value }` |
| `POST secrets/[name]/verify` | no | `{ liveness, checkedAt }` |
| `POST secrets/apply` `{allowRemoving?}` | yes | `{ applied, reason?, path, count, dropped? }` |
| `GET secrets/audit?limit=50` | no | `{ entries[], chain }` |
| `POST step-up` `{password}` | — | `{ ok, freshUntil }` / 401 `bad_password` / 429 `throttled` |

## What is deliberately not done

- No KMS or HSM. The master key sits in `.env.local` on the same box; root on
  the box reads everything, exactly as today.
- The web unit still runs as root, so directory ownership alone cannot keep
  other root processes out. Helper units hide the directory with
  `InaccessiblePaths=`; the real fix is the non-root migration in
  `docs/deploy/PULL-DEPLOY.md`.
- A value may not contain a line break. Paste a PEM with its newlines written
  as `\n` (the GitHub App key loader accepts that form).
- Liveness is probed for Stripe, Resend, the GitHub App and the AI provider
  key only; everything else answers "cannot tell". The list never calls a
  vendor — only `verify` and the proof-on-save after a PUT do. A verify result
  is saved only for names stored in the panel.
- The audit chain proves the trail was not edited row by row; someone with
  write access to the whole table could rebuild the whole chain. There is no
  external anchor.
- The fingerprint is the first 8 hex of an unsalted SHA-256 — fine for
  high-entropy credentials, not a secret for low-entropy values.
- `.env.local` lines are never removed automatically.
