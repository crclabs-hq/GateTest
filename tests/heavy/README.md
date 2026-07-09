# tests/heavy/

Slow tests that spawn subprocesses, invoke the CLI, run git commands, or take
more than a few seconds. These run in a separate non-blocking CI job and are
not part of the fast gate.

## Convention

A test belongs here if it does any of the following:
- Spawns a child process (`execSync`, `spawnSync`, `spawn`, `exec`)
- Shells out to git, node, or the GateTest CLI
- Writes to a temp directory and runs a real scan
- Takes longer than ~5 seconds in typical CI

Tests that only import modules and run assertions in-process stay in `tests/`.

## Running locally

```bash
# Fast suite only (< 2 min, what CI gates on)
npm test

# Heavy suite only
npm run test:heavy

# Both
npm run test:all
```

## CI behaviour

`heavy-tests` runs in parallel from t=0 alongside `typecheck`. It is
**not** in the required-checks list — a failure marks the check red and
posts a step summary but never blocks a merge. The blocking gate is the
`test` job (fast suite) + `pre-merge-sweep`.
