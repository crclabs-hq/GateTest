# GateTest — GitHub Marketplace Listing (canonical)

> **This is the single source of truth for the Marketplace listing.**
> Three other drafts previously existed (`docs/GITHUB-MARKETPLACE-LISTING.md`,
> `docs/marketplace-listing.md`, `docs/marketplace/listing-draft.md`) with
> conflicting module counts (67/90/91/110/120), conflicting distribution
> models (GitHub App vs. GitHub Action), and conflicting pricing strategies
> (Marketplace-billed plans vs. free-only). None of them matched what was
> actually submitted and rejected on 2026-05-14 (which described "90 modules"
> and "Claude Opus 4.7" — text that doesn't appear in any tracked doc). All
> three have been deleted; this file replaces them.
>
> **Rejection root cause (confirmed):** GitHub requires an app to already have
> ≥100 installations AND be a verified publisher before it will let a listing
> attach a paid pricing plan. The submitted listing described paid "Cloud AI"
> functionality fulfilled through an external Stripe checkout on gatetest.ai —
> paid functionality with no real Marketplace plan behind it, on an app with
> ~0 installs. That mismatch, on an app nowhere near the install threshold, is
> why it was rejected.
>
> **Fix:** resubmit as a genuinely **free** listing. No paid Marketplace plan
> attached — sidesteps the install/verified-publisher gate entirely, and it's
> honest: installing the App for free already runs a real, ongoing quick-scan
> gate (below) with zero payment required. Paid deeper scans are described as
> what they are — available on gatetest.ai, not something bought through this
> install.
>
> **Module count:** verify with `node bin/gatetest.js --list | grep -cE '^  [a-zA-Z]'`
> before every submission — this repo has a documented history of the module
> count drifting stale in exactly this kind of static, manually-pasted copy
> (see `docs/legal/public-copy-redline.md`). Verified 120 as of 2026-07-19.
>
> **Craig action:** go to `github.com/apps/gatetesthq` (or `.../edit`) →
> Marketplace tab → replace the existing content with everything below →
> confirm pricing plan is **Free only** (delete any other draft plan if one
> exists from the rejected submission) → Submit for review.

---

## Short description (≤160 chars — Marketplace search card)

```
120-module code quality gate for GitHub. Free continuous scanning on every push. Deeper AI-powered scans and auto-fix PRs available on gatetest.ai.
```

---

## Full description (Markdown — Marketplace listing page)

```markdown
## One gate, 120 modules, installed in 30 seconds

GateTest scans every push to your repo and posts a pass/fail commit status —
free, forever, no card required. It checks syntax, lint rules, and hardcoded
secrets on every single push automatically once installed.

For teams that want the full 120-module pass — security, reliability,
infrastructure, accessibility, performance, and Claude-powered code review
with automatic fix pull requests — deeper scans are available as a separate
purchase on [gatetest.ai](https://gatetest.ai). This app install is not where
that payment happens; it's free the moment you add it to a repo.

### What the free tier checks on every push
- Syntax errors
- Lint violations
- Hardcoded secrets (API keys, tokens, credentials)
- Core code-quality issues

### What the full 120-module scan adds (gatetest.ai, separate purchase)
- Security: SSRF, ReDoS, TLS bypass, cookie misconfig, SQL migration safety
- Reliability: N+1 queries, race conditions, resource leaks, async footguns
- Infrastructure: Dockerfile, Kubernetes, Terraform/IaC, CI-workflow hardening
- AI-generated-code specific checks: fake-fix detection, prompt-injection
  surfaces, money-as-float bugs
- Claude-powered code review that reasons about the change, not just pattern
  matches
- Auto-fix pull requests on the paid fix tiers — review the diff, merge

### How it works
1. **Install** — add GateTest to the repos you want covered.
2. **Push** — every push triggers the free quick gate automatically.
3. **See results** — a commit status and PR comment show what was found.
4. **Go deeper (optional)** — run a full 120-module scan, or subscribe to
   continuous full-depth scanning, at [gatetest.ai](https://gatetest.ai).

### Privacy
Code is scanned to produce a result; see the privacy policy for exactly what
is retained and for how long: https://gatetest.ai/legal/privacy
```

---

## Category

**Primary:** Code quality
**Secondary:** Security

---

## Pricing model

Select **Free** in the Marketplace pricing editor. Do not attach a second
plan — GateTest is not eligible for a paid Marketplace plan yet (requires
≥100 installs + verified publisher status; revisit once installs clear that
threshold, see `docs/ROADMAP.md`). Paid tiers are sold separately on
gatetest.ai and must not be described as purchasable through this listing.

### Free plan — configuration reference
- **Plan name:** Free
- **Type:** Free
- **Description:** Continuous quick-scan gate on every push — syntax, lint, and hardcoded-secret detection. No card required.
- **Bullet points:**
  - Runs automatically on every push
  - Syntax + lint + hardcoded-secret detection
  - Commit status on every PR
  - No credit card required
  - Deeper scans and auto-fix available separately at gatetest.ai

---

## Installation URL
```
https://gatetest.ai/github/setup
```

## Privacy Policy URL
```
https://gatetest.ai/legal/privacy
```

## Terms of Service URL
```
https://gatetest.ai/legal/terms
```

## Support URL
```
mailto:hello@gatetest.ai
```

---

## Logo / screenshots

A logo and at least one screenshot were already uploaded for the rejected
2026-05-14 submission — confirm they're still present and still accurate
(no visible "90 modules" or model-version text in any screenshot) before
resubmitting rather than starting over.

---

## App configuration reference

(Confirm these match the live GitHub App settings before submitting.)

| Setting | Value |
|---------|-------|
| **Setup URL** | `https://gatetest.ai/github/setup` |
| **Webhook URL** | `https://gatetest.ai/api/webhook` |
| **Callback URL** | `https://gatetest.ai/api/github/callback` |
| **Webhook events** | `push`, `pull_request` |
| **Contents permission** | Read |
| **Pull requests permission** | Read & write |
| **Commit statuses permission** | Read & write |
| **Issues permission** | Read & write |
| **Metadata permission** | Read |

---

## What to expect after resubmission

- GitHub reviews Marketplace listings manually; typical turnaround 1–3 weeks.
- They check: the app works as described, legal pages are live, install flow
  works end-to-end. All three are already true today (verified 2026-07-19).
- **Before resubmitting:** confirm `hello@gatetest.ai` forwarding actually
  works (the 2026-05-14 rejection sat unread for over two months because of
  this) — GitHub's only way to reach you about this listing is email.
