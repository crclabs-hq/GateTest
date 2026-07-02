# GateTest Arena

Live training + proof environment for [GateTest](https://gatetest.ai).

## What this repo does

Every 2 hours, a workflow injects a known bug into `src/math.js`, opens a PR, and lets CI fail. The `ai-ci-fixer` workflow then runs against the failure and opens a follow-up PR with the fix already written. If the fix's CI is green, `auto-merge-fix.yml` merges it.

**The whole loop is public.** Every cycle — bug injection, fix attempt, merge outcome — is visible at [gatetest.ai/testing](https://gatetest.ai/testing).

## Why

1. **Proof for customers.** "Auto-fix while you sleep" is a strong claim. The arena is the receipts.
2. **Training data for the flywheel.** Every (bug, fix, outcome) tuple feeds the trainer pipeline.
3. **Continuous regression test on the fixer itself.** If the loop breaks, we see it within 2 hours.

## Setup (one-time, ~5 min)

1. Create a fresh GitHub repo: `crclabs-hq/gatetest-arena` (or wherever).
2. Copy every file in this `arena-scaffold/` directory into the new repo's root.
3. Set repo secrets:
   - `ANTHROPIC_API_KEY` — the ai-ci-fixer's Claude key.
   - `ARENA_BOT_PAT` *(optional)* — a fine-grained PAT with `contents: write` + `pull-requests: write` if you want commits authored by a non-actions identity (cleaner branding on the proof page).
4. Push. The first inject-bug cron fires on the next `:17 past`.

## Files

| File | Purpose |
| --- | --- |
| `src/math.js` | The target code the injector mutates. Intentionally tiny + stable. |
| `tests/math.test.js` | Tests that fail when the injector applies a pattern. |
| `bug-patterns/patterns.json` | 10 curated bug patterns. Add more freely. |
| `scripts/inject-bug.js` | Picks a pattern, applies it, opens a PR. |
| `.github/workflows/ci.yml` | Runs the tests on every push + PR. |
| `.github/workflows/inject-bug.yml` | Every 2 hours, runs the injector. |
| `.github/workflows/ai-ci-fixer.yml` | Same as main GateTest repo — opens fix PRs on CI failure. |
| `.github/workflows/auto-merge-fix.yml` | Merges the fixer's PR once green. |

## What "broken" looks like

If the fixer fails to open a PR within ~5 minutes of a CI failure, or if the fix PR's CI doesn't go green, the arena page shows it. Cycles aren't curated; the page renders whatever happened. **An honest red cycle is worth more than a fake green one.**

## Adding more bug patterns

Edit `bug-patterns/patterns.json`. Each pattern needs:

```json
{
  "id":       "unique-kebab-id",
  "category": "math-operator | error-handling | boundary | boolean-logic | completeness",
  "summary":  "human-readable one-liner",
  "find":     "exact source text in src/math.js",
  "replace":  "what to substitute"
}
```

`find` must match the current state of `src/math.js` literally (whitespace included). If it doesn't, the injector skips with `SKIP: find-text-missing` and waits for the next cycle.
