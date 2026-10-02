# Work claims — the medic and Claude sessions never work on the same thing

Craig, 2026-10-01: *"all we need is to make sure we don't overlap running code
from different ends as in medic and anthropic subscription running both on
both platforms."* Then: *"build it with the gluecron leases."*

Two kinds of actor write to Craig's repositories:

| Actor | Runs on | Branches |
|---|---|---|
| **medic** — the autonomous site medic (jarvis-platform; Tallrig's own medic on box B) | its own API key, on a schedule | always `medic/…` |
| **session** — a Claude Code session on Craig's subscription | Craig's account | anything except `medic/…` |

Both follow the same rule on every platform (GitHub and Gluecron repos):

> **Before you start a change, take a lease on every file you will edit — and
> on red main if you are fixing red main. If any lease is held, do not start.**

## The lease store: Gluecron agent leases

Gluecron already has exclusive leases (`src/lib/agent-multiplayer.ts` in
`gluecron.com/ccantynz/Gluecron.com`): one active lease per exact
`(target_type, target_id)`, enforced by a partial UNIQUE index, so two actors
can never both win. An expired lease frees itself on the next acquire. They are
reached through Gluecron's MCP endpoint (`POST https://gluecron.com/mcp`,
JSON-RPC `tools/call` `gluecron_acquire_lease` / `gluecron_release_lease`,
Bearer token with `repo` scope).

### Target keys (one convention for every platform)

| target_type | target_id | Meaning |
|---|---|---|
| `repo-path` | `<host>:<owner>/<repo>:<path>` | this file is being changed |
| `repo-main-red` | `<host>:<owner>/<repo>` | this actor is fixing red main — nobody else chases it |

`<host>` is `github` or `gluecron`. Examples:
`github:crclabs-hq/GateTest:website/app/lib/sales-pause.js`,
`gluecron:ccantynz/tallrig:apps/api/src/domains/registrar.ts`,
`github:crclabs-hq/GateTest` (main-red).

Leases match on the exact string, so a change claims every file it edits.

### Rules

1. **All or nothing.** Acquire in sorted order; if any target is held, release
   what you took and back off. `scripts/work-claims.js` does this.
2. **Three answers, never a false "free".** `acquired` (go), `held` (do not
   start — someone else has it), `not_checked` (no token / no session / API
   down — do not start, say why). A medic that cannot reach Gluecron skips
   its sweep; it never assumes the coast is clear.
3. **Duration covers the PR's life** (default 3 hours). A lease cannot be
   renewed while active — if the work runs longer, release and re-acquire
   between steps. Release on merge or close.
4. **The medic yields.** If a session holds a file, the medic leaves it alone
   until the next sweep. Sessions are a person's live intent; the medic is
   background maintenance.
5. **One owner for red main.** Whoever holds `repo-main-red` fixes it; the
   other actor does not open a second fix PR.

## Commands

```bash
# before starting (exit 0 acquired · 3 held · 2 not checked)
node scripts/work-claims.js acquire --repo crclabs-hq/GateTest \
  --files website/app/lib/a.js,website/app/lib/b.js [--main-red] [--hours 3]

# after the PR merges or closes
node scripts/work-claims.js release --leases <id>,<id>
```

Env: `GLUECRON_API_TOKEN` (repo scope, never printed), `WORK_CLAIM_AGENT_SESSION`
(this actor's Gluecron agent-session id), optional `GLUECRON_BASE_URL`.

## The CI backstop

`.github/workflows/work-claims.yml` runs `scripts/pr-overlap-check.js` on every
pull request. It compares this PR's files with every other open PR:

- a **medic** PR that overlaps an open **session** PR **fails** (the medic yields);
- any other overlap **passes with a warning** naming the other PR;
- an unreadable GitHub API is reported as **not checked** and passes — the
  backstop must never block merges on an API blip (Forbidden #25).

It holds even if an actor forgets to take leases.

## One-time setup (Craig)

1. With a Gluecron token that has **admin** scope, create two agent sessions —
   `gluecron_create_agent_session` with name `medic` and name `claude-sessions`
   (one per actor; Tallrig's medic can share `medic` or get its own). Keep each
   session's **id**. The one-time token it also returns is not needed for leases.
2. Put the ids where each actor reads them:
   - medic (jarvis box, its env file): `WORK_CLAIM_AGENT_SESSION=<medic id>` and a
     `GLUECRON_API_TOKEN` with `repo` scope;
   - Claude sessions (cloud environment env vars): `WORK_CLAIM_AGENT_SESSION=<claude-sessions id>`
     and `GLUECRON_API_TOKEN`.
3. In jarvis-platform, make the medic use `medic/` branches and call
   `scripts/work-claims.js acquire` (or the same two MCP calls) before each fix,
   skipping anything `held` or `not_checked`.

Until step 1–2 are done, `work-claims.js` answers `not_checked` and the CI
backstop is the only protection.
