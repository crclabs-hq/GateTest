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
> functionality fulfilled through an external Stripe checkout on gatetest.io —
> paid functionality with no real Marketplace plan behind it, on an app with
> ~0 installs. That mismatch, on an app nowhere near the install threshold, is
> why it was rejected.
>
> **Fix:** resubmit as a genuinely **free** listing. No paid Marketplace plan
> attached — sidesteps the install/verified-publisher gate entirely, and it's
> honest: installing the App for free already runs a real, ongoing quick-scan
> gate (below) with zero payment required. Paid deeper scans are described as
> what they are — available on gatetest.io, not something bought through this
> install.
>
> **Module count:** no longer verified by hand. `tests/module-count-sync.test.js`
> fails the suite if any three-digit "N modules" claim in this file disagrees
> with the live registry, and `scripts/marketplace-preflight.js` re-checks the
> fenced copy against a real `node bin/gatetest.js --list` before submission.
> This repo has a documented history of the count going stale in exactly this
> kind of static, manually-pasted copy (see `docs/legal/public-copy-redline.md`),
> which is why it is now a failing test rather than a reminder.
>
> **Craig action:** the LIVE app is **`gatetest-hq`** (app_id `3766251`,
> Client ID `Iv23lisxbZrS1IJ8c1hk`), owned by the **`crclabs-hq`** org — its
> private key is the one on the production box (`GATETEST_APP_ID=3766251`) and
> a real webhook completed end to end through it on 2026-09-10. Manage it at
> `github.com/organizations/crclabs-hq/settings/apps/gatetest-hq`. The
> `Gate-Test` org owns the STALE duplicate (`gatetesthq`, app_id `3322634`):
> retire that one (make private, uninstall, delete) — never edit it as if it
> were live. (This note said the opposite from 2026-08-04 to 2026-09-10;
> following it would have deleted production.) Marketplace tab → replace the
> existing content with everything below → confirm pricing plan is **Free
> only** (delete any other draft plan left from the rejected submission) →
> Submit for review. Run `node scripts/marketplace-preflight.js` first; it
> exits non-zero on anything a reviewer would see.

---

## Short description (≤160 chars — Marketplace search card)

```
121-module code quality gate for GitHub. Free continuous scanning on every push. Deeper AI-powered scans and auto-fix PRs available on gatetest.io.
```

---

## Full description (Markdown — Marketplace listing page)

```markdown
## One gate, 121 modules, installed in 30 seconds

GateTest scans every push to your repo and posts a pass/fail commit status —
free, forever, no card required. It checks syntax, lint rules, and hardcoded
secrets on every single push automatically once installed.

For teams that want the full 121-module pass — security, reliability,
infrastructure, accessibility, performance, and Claude-powered code review
with automatic fix pull requests — deeper scans are available as a separate
purchase on [gatetest.io](https://gatetest.io). This app install is not where
that payment happens; it's free the moment you add it to a repo.

### What the free tier checks on every push
- Syntax errors
- Lint violations
- Hardcoded secrets (API keys, tokens, credentials)
- Core code-quality issues

### What the full 121-module scan adds (gatetest.io, separate purchase)
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
4. **Go deeper (optional)** — run a full 121-module scan, or subscribe to
   continuous full-depth scanning, at [gatetest.io](https://gatetest.io).

### Privacy
Code is scanned to produce a result; see the privacy policy for exactly what
is retained and for how long: https://gatetest.io/legal/privacy
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
gatetest.io and must not be described as purchasable through this listing.

### Free plan — configuration reference
- **Plan name:** Free
- **Type:** Free
- **Description:** Continuous quick-scan gate on every push — syntax, lint, and hardcoded-secret detection. No card required.
- **Bullet points:**
  - Runs automatically on every push
  - Syntax + lint + hardcoded-secret detection
  - Commit status on every PR
  - No credit card required
  - Deeper scans and auto-fix available separately at gatetest.io

---

## Installation URL
```
https://gatetest.io/github/setup
```

## Privacy Policy URL
```
https://gatetest.io/legal/privacy
```

## Terms of Service URL
```
https://gatetest.io/legal/terms
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
| **Setup URL** | `https://gatetest.io/github/setup` |
| **Webhook URL** | `https://gatetest.io/api/webhook` |
| **Callback URL** | `https://gatetest.io/api/github/callback` |
| **Webhook events** | `push`, `pull_request`, `workflow_run`, `issue_comment` |
| **Contents permission** | Read & write |
| **Pull requests permission** | Read & write |
| **Commit statuses permission** | Read & write |
| **Issues permission** | Read & write |
| **Metadata permission** | Read |

> **These rows are generated, not typed.** The source of truth is
> `src/core/github-app-permissions.js`, and `tests/marketplace-sync.test.js`
> fails the suite if this table, the install page, or the preflight script
> drifts from it — or if the bridge starts calling an endpoint needing a scope
> none of them declare. Edit the source file, not this table.
>
> **Corrected 2026-08-05 — `Contents` was wrong on every customer-facing surface.**
> It read `Read` here and on the install page. The App-installed path in
> `/api/scan/fix` resolves an installation token and then calls
> `POST /repos/{o}/{r}/git/refs` and `POST .../git/commits` to push the auto-fix
> branch, so GitHub asks the installing user for **write** access to code. Our
> copy promised less than the install prompt requests — a disclosure mismatch,
> which is precisely what a reviewer auditing permission scope looks for.
>
> **`Issues: write` is required — settled, do not drop it.** An earlier note here
> speculated that `Pull requests: write` might cover it. It does not:
> `postPrComment` posts to `POST /repos/{o}/{r}/issues/{n}/comments` and
> `updatePrComment` patches `/issues/comments/{id}`. Without `issues: write`
> the PR comment this listing promises fails silently. It is not over-broad
> scope; it is the scope the shipped code calls.
>
> **`workflow_run` is required** — `website/app/lib/github-events.js` branches on
> it (completed + failure → CI-fix kick). If the live App does not subscribe,
> CI-fix silently never fires on the App path.
>
> **`issue_comment` is required** — the same handler implements suppression in
> place: a repo owner/member/collaborator replies `@gatetest ignore <rule>`
> under the GateTest PR comment and the rule is committed to
> `.gatetestignore` on the PR branch. Without the subscription the command
> silently does nothing.
>
> **Still needs a human:** the LIVE App config at
> `github.com/organizations/crclabs-hq/settings/apps/gatetest-hq` (app_id
> `3766251`) cannot be edited from this repo. Confirm all five scopes and all
> four events match the table above before submitting.
> `node scripts/marketplace-preflight.js` reads the live grants, events,
> description and homepage when `gh` is authenticated — on 2026-09-10 it found
> `Contents` at Read, `Commit statuses` absent, `workflow_run` +
> `issue_comment` unsubscribed, an unused `checks:write`, and a description
> still quoting a long-stale count (102), "Nuclear" and "Pay per scan".

---

## What to expect after resubmission

- GitHub reviews Marketplace listings manually; typical turnaround 1–3 weeks.
- They check: the app works as described, legal pages are live, install flow
  works end-to-end. All three are already true today (verified 2026-07-19).
- **Before resubmitting:** confirm `hello@gatetest.ai` forwarding actually
  works (the 2026-05-14 rejection sat unread for over two months because of
  this) — GitHub's only way to reach you about this listing is email.
