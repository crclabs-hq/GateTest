# Reliability baselines

This directory holds **captured baselines** for url-* cases — the
last known-good output of a probe against a real URL, used by the
drift detector to flag regressions.

## Lifecycle

1. New URL case added to the corpus with `category: url-known-good`
   and `expected: {}` (no bounds asserted yet).
2. First probe runs against the live URL and captures the output as
   `baselines/<case-name>.json`.
3. Craig reviews the baseline. If accepted, the manifest's `expected`
   block is updated to lock in the bounds (e.g., "no more than 2
   warnings", "must include the HSTS rule").
4. Subsequent runs compare against this baseline. A drift PR is
   opened when findings diverge.

## Format

```json
{
  "name": "case-name",
  "capturedAt": "ISO timestamp",
  "capturedBy": "where the scan ran (sandbox / production / craig-laptop)",
  "status": 200,
  "durationMs": 1234,
  "findings": [
    { "module": "webHeaders", "severity": "error", "rule": "missing-hsts", "message": "..." }
  ]
}
```

## Honesty note

Baselines captured in this codebase's CI sandbox may not reflect the
real target — the sandbox network proxy can intercept outbound
requests and return its own response (e.g. 403 on `.co.nz` domains).
Always check `capturedBy` before treating a baseline as authoritative.
Real baselines must be captured from an environment with unrestricted
outbound network access.
