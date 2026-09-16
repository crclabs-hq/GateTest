# scripts/ops

Operator scripts that ask the LIVE world a question — production, the
registries, the box — instead of inferring the answer from a green test
suite. Each is safe to run unattended: GETs, POSTs we expect to be rejected,
or installs into a temp dir. None needs a secret.

| Script | Asks | Workflow |
|---|---|---|
| `readiness-probe.js` | Is gatetest.io serving the product right now? | `readiness-probe.yml` (every 30 min) |
| `smoke-published.js` | Does every PUBLISHED artifact install and run for a stranger? | `post-publish-smoke.yml` (every 6 h + after each publish) |
| `mail-test.js` | Does the platform mail transport deliver from the box? | run by hand on the box |
| `fire-test-webhook.js` | Does the webhook path accept a signed event? | run by hand |
| `vapron-link-check.js`, `run-vapron-repair.js` | Platform link / repair checks (pre-rename filenames) | run by hand |
| `close-retired-code-scanning-categories.sh` | KI #105 — delete stale Code Scanning categories | run by hand with `gh` |

## Post-publish smoke — `smoke-published.js`

**Why it exists.** On 2026-09-15 the npm CLI 1.61.0 could not be run with bare
`npx @gatetest/cli` (the package shipped no bin named after itself) and the
published `@gatetest/mcp-server` 1.1.3 crashed on start with `Cannot find
module './site-url'` from the cli it depends on. CI was green the whole time:
every test ran from a checkout or a locally packed tarball, and nothing ever
installed from the registry. This script does only that — a fresh temp dir,
an empty npm cache, and the commands a README tells a stranger to type.

```bash
node scripts/ops/smoke-published.js               # table; exit 1 only on a FAIL row
node scripts/ops/smoke-published.js --json        # the same rows as JSON (what CI uploads)
node scripts/ops/smoke-published.js --only npm,mcp  # a subset: npm | mcp | vscode | action | ghcr
node scripts/ops/smoke-published.js --keep        # leave the temp dir behind for inspection
```

**What it covers** (one row per line of the table, `channel | version | result | detail`):

| id | Channel | How |
|---|---|---|
| `npm-cli` | `@gatetest/cli@latest` | `npm init -y`, `npm install @gatetest/cli@latest`, `npx -p @gatetest/cli gatetest --version` |
| `npm-cli-bare` | bare `npx @gatetest/cli --version` | needs the `cli` bin that ships in 1.61.1 |
| `npm-cli-scan` | the installed CLI on a project | `gatetest --suite quick --project <fixture>` over a tiny package.json + one JS file; exit 0/1 is the product working, exit 2 / any other exit / a stack trace on stderr is a FAIL |
| `mcp-server` | `@gatetest/mcp-server@latest` | `npx -y …`, JSON-RPC `initialize` over stdio; a valid result with `serverInfo` is PASS, a crash before replying is FAIL with the stderr excerpt |
| `vscode-extension` | VS Code Marketplace `GateTestHQ.gatetest` | gallery `extensionquery`; PASS when flags include `validated` and `public`; reports the latest version |
| `github-action-marketplace` | github.com/marketplace/actions/gatetest-quality-gate | the page answers 200 |
| `ghcr-image` | `ghcr.io/crclabs-hq/gatetest:latest` | anonymous registry token, then the `latest` manifest |

**Three states, on purpose.** `PASS`, `FAIL`, `KNOWN GAP`, plus `NOT CHECKED`
for a row whose prerequisite already failed (the scan row when the install
failed). A channel that ships with 1.61.1 — bare npx and the ghcr image — is
a `KNOWN GAP` while `npm view @gatetest/cli version` is older than 1.61.1 and
becomes a `FAIL` by itself the day 1.61.1 is published; the threshold is
`BARE_NPX_SINCE` in `smoke-published-lib.js`. A channel that already works is
always a `PASS`; an unreadable npm version is never an excuse for a gap. Only
`FAIL` rows set the exit code (1). Exit 2 means the smoke itself could not
run, and the workflow surfaces that instead of uploading a JSON that says
nothing.

**Timeouts everywhere.** Every subprocess has a wall clock (install 5 min,
each npx run 2 min, the fixture scan 4 min, the MCP handshake 3 min) and every
HTTP call 30 s; on Windows the whole process tree is killed. It never hangs.

**In CI.** `.github/workflows/post-publish-smoke.yml` runs it every 6 hours,
after every completed "Publish to npm" / "Publish VS Code extension" run, and
on dispatch; uploads `smoke-published.json`; and on a FAIL opens or refreshes
ONE issue titled `Published artifact is broken: <channel ids>`. No secrets
beyond `GITHUB_TOKEN`.

**Tests.** `tests/smoke-published.test.js` pins the pure parts with control
pairs (gap vs failure across the 1.61.1 threshold, crash detection, JSON-RPC
framing, the table, the exit code, and the workflow's shape — including that
it chains off the publish workflows by their current `name:`).
`tests/heavy/smoke-published.test.js` runs the real script against the
network and asserts it finishes, exits 0 or 1, and its exit code matches its
own rows.
