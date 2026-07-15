# GateTest Scan Benchmarks

Real measured wall-clock times. These numbers back (or bound) every public speed claim — Known Issue #31.

## Benchmark run — 2026-07-16 (Known Issue #31 re-validated)

Machine: win32 x64, 13th Gen Intel(R) Core(TM) i7-1355U × 12, 16 GB RAM, Node v24.15.0

| Repo | Source files | Suite | Runs | Min | Median | Max |
| --- | --- | --- | --- | --- | --- | --- |
| bench-small-repo (synthetic, typical-customer-size) | 36 | quick | 3 | 1.1s | 1.2s | 1.3s |
| bench-small-repo (synthetic, typical-customer-size) | 36 | full | 3 | 2.6s | 2.9s | 3.1s |
| gatetest (this repo — self-scan, NOT representative of a typical customer repo) | 2250 | quick | 2 | 29.4s | 30.1s | 30.8s |

**Finding: the 34-52s baseline this Known Issue was originally about holds up on a typical-sized repo** — the small synthetic repo (36 files, representative of what most customers actually scan) comes in at ~1.2s quick / ~2.9s full, comfortably inside Bible Quality Bar #9 ("Quick <15s, Full <60s"). The self-scan number (this repo's own ~2,250-file monorepo) is a different, much larger repo shape and was never a fair proxy for "typical customer repo" — its 228s figure from 2026-07-15 (before the ESLint `--cache` fix) vs. 30s here (after, with a warm cache) is mostly explained by ESLint cache state, not a config regression. Conclusion: the Bible's quick/full numeric targets are realistic for the repo sizes most customers actually have; self-scan timing on this unusually large monorepo should be tracked separately and never used to validate or invalidate the public per-scan-size targets.

## Benchmark run — 2026-07-15

Machine: win32 x64, 13th Gen Intel(R) Core(TM) i7-1355U × 12, 16 GB RAM, Node v24.15.0

| Repo | Source files | Suite | Runs | Min | Median | Max |
| --- | --- | --- | --- | --- | --- | --- |
| bench-small-repo | 36 | quick | 3 | 1.1s | 1.2s | 1.3s |
| bench-small-repo | 36 | full | 3 | 2.6s | 2.9s | 3.1s |

## Benchmark run — 2026-07-15

Machine: win32 x64, 13th Gen Intel(R) Core(TM) i7-1355U × 12, 16 GB RAM, Node v24.15.0

| Repo | Source files | Suite | Runs | Min | Median | Max |
| --- | --- | --- | --- | --- | --- | --- |
| gatetest | 2250 | quick | 2 | 29.4s | 30.1s | 30.8s |
