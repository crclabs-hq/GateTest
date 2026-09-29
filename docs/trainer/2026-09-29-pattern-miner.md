# Flywheel Pattern Miner — Nightly Report

_Generated 2026-09-29T09:31:56.729Z_

Inputs: 204 session-fix(es), 0 fix-attempt(s), 0 MCP event(s).

## Recommendations

- **investigate-module** — `website`: 24 session-fixes recorded — high-touch module, candidate for refactor or rule split
- **investigate-module** — `deploy`: 9 session-fixes recorded — high-touch module, candidate for refactor or rule split
- **investigate-module** — `cli`: 8 session-fixes recorded — high-touch module, candidate for refactor or rule split
- **candidate-recipe**: 4 commits with this signature — convert to deterministic recipe
- **candidate-recipe**: 3 commits with this signature — convert to deterministic recipe
- **candidate-recipe**: 3 commits with this signature — convert to deterministic recipe

## Top modules by fix-count

| Module | Fixes |
| --- | --- |
| `website` | 24 |
| `deploy` | 9 |
| `cli` | 8 |
| `web-scan` | 7 |
| `secrets` | 7 |
| `(unattributed)` | 6 |
| `free-scan` | 6 |
| `crawler` | 5 |
| `fake-fix-detector` | 5 |
| `prompt-safety` | 5 |

## Top rule keys by attempt count

_None._

## Recurring subjects (recipe candidates)

| Pattern (head) | Hits |
| --- | --- |
| `fix(website): changelog page casts the gener` | 4 |
| `fix(cli): one pre-scan line honours both` | 3 |
| `fix(gitignore): env contract files stay in sco` | 3 |

## Under-tested modules (regression-test gaps)

_All modules are at ≥1 test added per fix on average._

## Flywheel maturity (Claude vs deterministic share)

_No fix attempts yet. The flywheel hasn't had a chance to mature._

## MCP tool usage (discoverability signal)

_No MCP tool calls recorded yet._

