# Phase 2.4 + 3.7 — Third proof (Gluecron)

**Status:** real Claude API calls against a Craig-owned production-grade codebase.
**Date:** 2026-04-26 (re-scoped 2026-05-20 — MarcoReid removed from scope per Craig directive)
**Target:** `ccantynz-alt/Gluecron.com` (Gluecron — git-host platform).
**Model:** `claude-opus-4-7`

This is the third proof for Phase 2.4 / 3.7. Combined with the gatetest
self-proof and the Crontech proof, GateTest's full pipeline has now
been validated against **three real codebases**, two of which are
customer-facing production products (Crontech + Gluecron).

The customer-facing report (with specific file paths and vulnerability
evidence) is kept off-repo for the same reason as the Crontech proof —
publishing internal vuln details in a public docs commit is bad form.

## Run summary

| Target | Scan errors | Diagnoses | Chains | Headline keyword |
| --- | --- | --- | --- | --- |
| Gluecron.com | 649 | 9/9 | **3 chains** (1 critical, 2 high) | "Critical secrets and supply-chain vulnerabilities" |

---

## Gluecron.com — the chains Claude found

A 290-file TypeScript monorepo (a working git-host platform). Quick
scan: 26/39 modules pass, **649 errors, 520 warnings, 10s wall time.**

The Nuclear-tier Anthropic call (9 sampled findings, parallel
diagnoser+correlator + sequential exec-summary) ran in **~95 seconds
total**. Three real chains:

| # | Chain | Severity |
| --- | --- | --- |
| 1 | Hardcoded secret + undeclared `WORKFLOW_SECRETS_KEY` → secret rotation is impossible, hardcoded value becomes permanent | **CRITICAL** |
| 2 | Missing rate-limiter reliability + setInterval resource leak in same middleware → rate-limit silently stops enforcing under load | **HIGH** |
| 3 | `curl-piped-to-sh` deploy script + undeclared env vars → supply-chain compromise installs with missing secrets, silently misconfigured | **HIGH** |

Chain #1 is genuinely clever reasoning: a hardcoded secret is bad,
but a hardcoded secret plus a missing `.env.example` entry means
**you cannot rotate it without a code change**. The two findings
together describe an operational lock-in that neither describes
alone.

Chain #2 is a real systems observation: the rate-limit middleware
itself has a resource leak. Under load, the leak grows, the limiter
stops working — exactly when you need it most. A per-finding scanner
sees "leak" and "rate-limiter," not their interaction.

Chain #3 is a textbook supply-chain attack path: `curl … | sh` is
MITM-vulnerable, and if env vars aren't declared the install proceeds
in a misconfigured state — providing a foothold without obvious
failure.

### Executive headline (verbatim)

> *"Critical secrets and supply-chain vulnerabilities are exposed in
> production code today — immediate action required before the next
> deployment."*

---

## Cost

Total Anthropic spend on this target:

| Step | Calls | Wall time |
| --- | --- | --- |
| Gluecron parallel block | 10 (9 diag + 1 corr) | 82 s |
| Gluecron exec summary | 1 | 13 s |
| **Total** | **11 calls** | **~95 s** |
| **Estimated spend** | | **~$0.75 - $1.20** (Sonnet pricing at the time; equivalent under Opus 4.7 today scales by 5x) |

Combined with the Crontech proof's ~$1, the three-target proof cost
roughly $2-3 of Anthropic credit total. At the $399 Nuclear tier
price, that's a comfortable two-orders-of-magnitude margin.

---

## What this proves about Phase 2.4 and 3.7

| Phase 2.4 | Status |
| --- | --- |
| Self-proof (gatetest) | ✅ |
| Crontech | ✅ |
| Gluecron | ✅ |
| **Total: 3/3 proofs done** | ✅ |

| Phase 3.7 | Status |
| --- | --- |
| Self-proof (gatetest) | ✅ |
| Crontech | ✅ |
| Gluecron | ✅ |
| **Total: 3/3 proofs done** | ✅ |

This unlocks Phase 2.3 (wire `scan_fix` into checkout TIERS + add
$199 card to Pricing.tsx) per the loosened Boss Rule — preceding
sub-tasks (2.1 + 2.2 + 2.4) all shipped with proof artifacts and
tests green.

Phase 3.6 ($399 wiring) shipped under the same condition once
Phases 3.3 + 3.4 (mutation testing + chaos/fuzz) landed.

## Provenance and security

- Repo cloned depth-1 to `/tmp` (deleted at session end)
- No branches created, no PRs opened, no commits pushed against
  the target — the proof exercises GateTest *against* it
  without modifying it
- Full diagnoser+correlator+executive-summary report kept off-repo
  in session-ephemeral `/tmp/proof-gluecron-com-report.md`
- Summary metrics, chain titles, and headline sentences ARE
  committed here because they describe what GateTest can do, not
  what's specifically wrong with the target

## Reproduction

```bash
# Quick scan
git clone https://github.com/ccantynz-alt/Gluecron.com.git /tmp/gluecron
cd /tmp/gluecron && node /home/user/GateTest/bin/gatetest.js --suite quick

# Nuclear pipeline (with ANTHROPIC_API_KEY set)
node <script importing diagnoseFindings, correlateFindings,
       composeExecutiveSummary>
```
