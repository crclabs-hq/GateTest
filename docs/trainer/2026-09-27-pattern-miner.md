# Flywheel Pattern Miner — Nightly Report

_Generated 2026-09-27T08:59:48.048Z_

Inputs: 220 session-fix(es), 0 fix-attempt(s), 0 MCP event(s).

## Recommendations

- **investigate-module** — `website`: 27 session-fixes recorded — high-touch module, candidate for refactor or rule split
- **investigate-module** — `deploy`: 11 session-fixes recorded — high-touch module, candidate for refactor or rule split
- **investigate-module** — `cli`: 8 session-fixes recorded — high-touch module, candidate for refactor or rule split
- **candidate-recipe**: 4 commits with this signature — convert to deterministic recipe
- **candidate-recipe**: 3 commits with this signature — convert to deterministic recipe
- **candidate-recipe**: 3 commits with this signature — convert to deterministic recipe
- **regression-test-gap** — `wp-plugin`: 6 fixes / 0 tests added (0/fix) — lock down the pattern with a regression test

## Top modules by fix-count

| Module | Fixes |
| --- | --- |
| `website` | 27 |
| `deploy` | 11 |
| `cli` | 8 |
| `secrets` | 7 |
| `(unattributed)` | 6 |
| `free-scan` | 6 |
| `wp-plugin` | 6 |
| `fake-fix-detector` | 5 |
| `prompt-safety` | 5 |
| `web-scan` | 5 |

## Top rule keys by attempt count

_None._

## Recurring subjects (recipe candidates)

| Pattern (head) | Hits |
| --- | --- |
| `fix(website): changelog page casts the gener` | 4 |
| `fix(cli): one pre-scan line honours both` | 3 |
| `fix(gitignore): env contract files stay in sco` | 3 |

## Under-tested modules (regression-test gaps)

| Module | Fixes | Tests added | Tests/fix |
| --- | --- | --- | --- |
| `wp-plugin` | 6 | 0 | 0 |

## Flywheel maturity (Claude vs deterministic share)

_No fix attempts yet. The flywheel hasn't had a chance to mature._

## MCP tool usage (discoverability signal)

_No MCP tool calls recorded yet._

