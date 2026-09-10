# GitHub Marketplace Listing — Submission Guide

## Overview

This guide walks Craig through submitting GateTest to the GitHub Marketplace as a **FREE** GitHub App listing.
Complete every step in order. The listing will be reviewed by GitHub staff (typically 3–7 business days).

> **Canonical copy lives in [`listing.md`](listing.md), not here.** This file is the click-through procedure; `listing.md` is the exact text to paste. The 2026-05-14 submission was rejected for describing PAID functionality on an app below GitHub's ≥100-install threshold — so the listing is **Free-only** (no paid Marketplace plan attached; paid tiers are sold separately on gatetest.io and must never be described as purchasable through this install). Any field below that still reads "paid," quotes a module count other than 121 (the number is generated from the engine registry — see Step 6), or says "enter payment details" is stale — defer to `listing.md`.

---

## Prerequisites (confirm before starting)

- [ ] GitHub App **gatetest-hq** (App ID 3766251) is already created under the `crclabs-hq` organisation account
- [ ] The app is installed on at least one repository (required to publish)
- [ ] You are signed in to GitHub as the account that owns the app
- [ ] A 1544×500 px banner image is ready (PNG or JPEG — none is committed; compose one from the logo at `website/public/logo-512.png`)
- [ ] The logo/icon is ready — use `website/public/logo-512.png` (512×512 PNG) or `website/public/icon-400.png` (400×400 PNG); both exceed GitHub's 200×200 minimum
- [ ] At least 5 screenshots are captured (see `screenshots.md` for what to capture)
- [ ] No payment plan is attached — the listing is **Free-only**; paid tiers are bought on gatetest.io (see Step 6)

---

## Step 1 — Open the GitHub App settings

1. Go to **https://github.com/organizations/crclabs-hq/settings/apps** (the app is owned by the `crclabs-hq` org, not a personal account).
2. Click **gatetest-hq**.
3. In the left sidebar, click **Marketplace listing**.
   - If you don't see this option, the app must first be installed on at least one repo. Install it on `crclabs-hq/gatetest` via the "Install App" tab.

---

## Step 2 — Fill in the basic listing details

On the **Marketplace listing** page:

| Field | Value |
|-------|-------|
| **Listing name** | GateTest |
| **Short description** | (use the verified copy in `listing.md` → "Short description": 121-module code quality gate for GitHub. Free continuous scanning on every push. Deeper AI-powered scans and auto-fix PRs available on gatetest.io.) |
| **Categories** | Code quality (primary) · Security (secondary) — per `listing.md` |
| **Primary language** | (leave blank — GateTest is language-agnostic) |

Paste the **Full description** from `listing.md` into the long description field. GitHub Marketplace renders standard Markdown.

---

## Step 3 — Upload visual assets

| Asset | Spec | File to use |
|-------|------|-------------|
| App logo / icon | 200×200 px minimum, PNG | `website/public/logo-512.png` (512×512) or `website/public/icon-400.png` (400×400) |
| Banner image | 1544×500 px, PNG/JPEG | Not committed — compose from `website/public/logo-512.png` |
| Screenshots (×5) | 1280×800 px, PNG | See [`screenshots.md`](screenshots.md) |

Upload images in the **Screenshots and video** section. Drag and drop screenshots in the order described in `screenshots.md`. Captions are optional but recommended — use the caption suggestions in that file.

---

## Step 4 — Configure app permissions and webhook events

Confirm the App's **Permissions & events** and URLs match the generated table under [`listing.md` → "App configuration reference"](listing.md#app-configuration-reference). That table is rendered from `src/core/github-app-permissions.js` (the single source of truth — `tests/marketplace-sync.test.js` fails the suite if any surface drifts from it), so this guide deliberately does not repeat the permission list or the webhook-event list by hand; edit the source file, never a copy.

---

## Step 5 — Set the setup URL and post-installation flow

In the **Optional features** section of the App settings (not the Marketplace listing), confirm:

- **Setup URL (after installation):** `https://gatetest.io/github/setup`
  - This is where GitHub redirects users immediately after they install the app.
  - The page at this URL (gatetest.io/github/setup) explains the free install — it must NOT prompt for payment. The free App install runs the quick gate with no card; paid deeper scans live separately on gatetest.io.
- **Redirect on update:** `https://gatetest.io/github/setup`

---

## Step 6 — Configure pricing plans

In the Marketplace listing editor, scroll to **Pricing and setup**. GitHub offers two billing models:

### The chosen approach — Free plan only, Stripe on gatetest.io (see `listing.md`)

**Submit with a single Free plan.** The 2026-05-14 submission was rejected for
describing paid functionality without meeting GitHub's ≥100-install threshold for
paid plans — `listing.md` (the canonical, verified listing copy) is written around
a Free-only plan for exactly that reason. Do not re-add paid Marketplace plans
without re-reading `listing.md`'s header note.

| Plan name | Unit | Price | Description (shown to buyer) |
|-----------|------|-------|-------------------------------|
| Free | — | $0/month | Continuous quality gate on every push and PR. Deeper scans and auto-fix PRs available at gatetest.io. |

Payment stays on Stripe via gatetest.io: the **Setup URL**
(`https://gatetest.io/github/setup`) drives users to the site, where the real
tiers live — Quick $29 / Full $99 / Scan + Fix $199 / Forensic $399 (one-time)
plus Continuous $49/mo and MCP $29/mo. Marketplace copy must never hand-type a
module count: the engine total (**121** today) is generated from the module
registry and `tests/module-count-sync.test.js` fails any three-digit claim that
drifts from it. The website's `full` suite runs 88 of those modules —
mutation + chaos need the GitHub Action's CI runner.

### Later — GitHub-native billing (only after ≥100 installs)

GitHub Marketplace supports flat monthly/yearly plans and per-unit plans (unit
label "scan" for one-time-style purchases). Revisit only once the Free listing
crosses GitHub's paid-plan eligibility threshold, and with Craig's sign-off
(pricing = Boss Rule #3).

---

## Step 7 — Accept the Marketplace Developer Agreement

On the listing page, GitHub will prompt you to accept the **GitHub Marketplace Developer Agreement**. Read it, then click **Accept**.

This agreement covers revenue sharing (GitHub takes 0% as of 2024 for new listings). Verify the current terms before accepting.

---

## Step 8 — Submit for review

1. Scroll to the bottom of the Marketplace listing page.
2. Click **Submit for review**.
3. GitHub will email you within 3–7 business days with approval or feedback.

### Common rejection reasons and fixes:
| Rejection reason | Fix |
|-----------------|-----|
| "App must be installable" | Install the app on at least one repo first |
| "Description too short" | Full description must be 40+ words |
| "Missing screenshots" | Upload at least 1 screenshot (5 recommended) |
| "Webhook URL unreachable" | Ensure `https://gatetest.io/api/webhook` returns 200 on a GET request (add a health-check handler if needed) |
| "Setup URL not responding" | Ensure `https://gatetest.io/github/setup` loads without auth errors |
| "Pricing plans incomplete" | Each paid plan needs a description and unit price |

---

## Step 9 — After approval

Once approved:

1. The listing goes live at `https://github.com/marketplace/gatetest-hq` (or similar slug). The composite Action is already live separately at `https://github.com/marketplace/actions/gatetest-quality-gate`.
2. GitHub sends you a confirmation email with the live URL.
3. Update `CLAUDE.md` Known Issue #29 to DONE.
4. Add the Marketplace badge to `website/app/page.tsx` and `README.md`:
   ```
   [![GitHub Marketplace](https://img.shields.io/badge/Marketplace-GateTest-blue?logo=github)](https://github.com/marketplace/gatetest-hq)
   ```
5. Announce in any mailing list / social channels.

---

## Useful links

- GitHub Marketplace docs: https://docs.github.com/en/apps/publishing-apps-to-github-marketplace
- GitHub App settings: https://github.com/settings/apps
- Marketplace developer agreement: https://docs.github.com/en/site-policy/github-terms/github-marketplace-developer-agreement
- Support: partners@github.com
