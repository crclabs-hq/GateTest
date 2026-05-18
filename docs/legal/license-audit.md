# License compatibility audit — pre-launch

Generated: 2026-05-17
Stated license: MIT
Auditor: read-only, automated (npm ls + filesystem walk + targeted LICENSE-file read)
Scope: `/package.json` (CLI) + `/website/package.json` (Next.js website)

---

## Summary

- **Stated license consistency:** PASS — `LICENSE`, `README.md` badge, `README.md` "License" section, root `package.json` `"license"` field all agree on **MIT**. `website/package.json` is `"private": true` (Next.js convention — not published, no license field needed).
- **Total unique deps audited:** 91 (root) + 520 (website) = **611 unique installed package versions**. By unique package NAME across both trees: 547.
- **Strictly incompatible licenses (GPL / AGPL):** **0**.
- **Borderline / weak-copyleft (LGPL / MPL):** 6 packages (4 MPL-2.0, 2 LGPL-3.0-or-later). All are transitive, all are used as-is (no modification, no redistribution of modified source), and the file-level copyleft of MPL/LGPL means GateTest's own MIT-licensed source remains MIT.
- **Source-available / non-OSI (FSL):** 2 packages (`@sentry/cli`, `@sentry/cli-linux-x64`). Build-only. FSL prohibits ONLY building a "Competing Use" — i.e. another error-tracking SaaS. GateTest is QA-gate not error-tracking, so we are inside the Permitted Purpose. Auto-converts to MIT after 2 years (2027).
- **Unverified / unclear:** **0** — every package had either a `license` field in `package.json` or a recognised SPDX identifier.
- **Recommended actions:** 4 (see end of report). All are low-priority hygiene items. **No launch blocker found.**

---

## Phase 1 — project license consistency

| Surface | License claim | Match? |
|---|---|---|
| `LICENSE` (root) | MIT, Copyright (c) 2026 GateTest | ✓ |
| `README.md` line 11 (badge) | `![License: MIT]` linking to `LICENSE` | ✓ |
| `README.md` line 213 | "The codebase ships under MIT" | ✓ |
| `README.md` line 250-252 ("## License") | "MIT — see LICENSE." | ✓ |
| Root `package.json` field `"license"` | `"MIT"` | ✓ |
| `website/package.json` | `"private": true`, no `license` field | OK (Next.js convention — website is not a publishable package) |
| `MARKETING.md` | No license claim anywhere | OK (no drift to police) |

**Verdict:** PASS. No drift between license file, README, package.json, or marketing copy.

---

## Phase 2 — dependency licenses

### Safe (MIT-compatible — no contamination concern)

**Root (91 unique installed):**

| License | Count |
|---|---|
| MIT | 81 |
| ISC | 7 |
| BSD-3-Clause | 2 |
| BSD-2-Clause | 1 |
| **Total** | **91 (100% permissive)** |

Notable root deps: `express@5.2.1` (MIT), `hono@4.12.18` (MIT), `zod@4.3.6` (MIT), `@modelcontextprotocol/sdk@1.29.0` (MIT — the only declared root dependency in `package.json`).

**Website (520 unique installed):**

| License | Count |
|---|---|
| MIT | 404 |
| Apache-2.0 | 62 |
| ISC | 16 |
| BSD-2-Clause | 13 |
| BSD-3-Clause | 6 |
| BlueOak-1.0.0 | 5 |
| Unlicense | 1 |
| CC0-1.0 | 1 |
| 0BSD | 1 |
| (MIT OR CC0-1.0) | 1 |
| **Subtotal — permissive** | **510 (98.1%)** |

All licenses in this group are explicitly compatible with MIT redistribution. BlueOak-1.0.0 is a modern OSI-approved permissive license (used by the npm/Node maintainer community). 0BSD is the most permissive license that exists (public-domain equivalent).

### Borderline — weak copyleft (LGPL / MPL)

**MPL-2.0 (Mozilla Public License) — 4 packages:**

  - `axe-core@4.11.4` — pulled in by `eslint-plugin-jsx-a11y` (devDep). **Build/lint-only.** Not in the customer bundle.
  - `lightningcss@1.32.0` — pulled in by `@tailwindcss/postcss` (devDep). **Build-only** CSS transformer.
  - `lightningcss-linux-x64-gnu@1.32.0` — same parent, native binary.
  - `lightningcss-linux-x64-musl@1.32.0` — same parent, native binary.

MPL-2.0 is file-level copyleft. Only modifications to the MPL-licensed FILE itself need to be MPL-licensed. Linking, importing, or bundling MPL files alongside MIT files does NOT contaminate the MIT code. We do not modify these packages.

**LGPL-3.0-or-later — 2 packages (native binaries):**

  - `@img/sharp-libvips-linux-x64@1.2.4` — pulled in by `next@16.2.4` → `sharp@0.34.5` (image optimisation for Next.js).
  - `@img/sharp-libvips-linuxmusl-x64@1.2.4` — same parent, musl libc variant.

These are pre-built libvips C-library binaries. LGPL allows dynamic linking from non-(L)GPL software without copyleft contamination. Static linking or modification would trigger the copyleft. We do neither — Next.js dynamically links libvips at runtime via Node's native module loader.

**Assessment of all 6:** SAFE. Standard industry pattern. No action required.

### Source-available — non-OSI (Functional Source License)

**FSL-1.1-MIT — 2 packages:**

  - `@sentry/cli@2.58.5` — Sentry's command-line sourcemap uploader. Pulled in by `@sentry/bundler-plugin-core` (devDep, build-only).
  - `@sentry/cli-linux-x64@2.58.5` — native binary for the same.

The Functional Source License v1.1 (FSL) permits internal use, education, research, and "professional services" but PROHIBITS using the software to build a "Competing Use" — i.e. a substitute for Sentry's error-tracking SaaS. GateTest is a QA gate, not an error-tracking SaaS, so we are firmly inside the Permitted Purpose. The FSL converts to MIT 2 years after each release date (this version auto-converts in 2027).

Sentry's main runtime package `@sentry/nextjs@10.52.0` (the one actually bundled into the website) is **MIT** (verified — all 17 `@sentry/*` runtime packages are MIT; only `@sentry/cli` and its native binary are FSL).

**Assessment:** SAFE. We use Sentry as our error monitor, not a target to clone. Within FSL Permitted Purpose. Build-only, not shipped.

### Incompatible (GPL / AGPL)

**None found.** Zero packages with GPL-2.0, GPL-3.0, AGPL-3.0, or any other strong-copyleft license in either tree.

### Edge cases (one-offs worth noting, none risky)

| License | Package | Parent | Why fine |
|---|---|---|---|
| `(MIT OR CC0-1.0)` | `type-fest@0.7.1` | `@sentry/nextjs` → `stacktrace-parser` | Dual-licensed; we pick MIT |
| `CC0-1.0` | `language-subtag-registry@0.3.23` | `eslint-plugin-jsx-a11y` (dev) | Public-domain dedication — fully compatible |
| `CC-BY-4.0` | `caniuse-lite@1.0.30001792` | `next` / `browserslist` | CC-BY applies to the BROWSER COMPATIBILITY DATA. We don't redistribute the data; we use it at build-time to inform CSS prefixing. Standard industry pattern — every Next.js / webpack site has this dep. |
| `Python-2.0` | `argparse@2.0.1` | `eslint` → `js-yaml` (dev) | Python Software Foundation license — permissive, GPL-compatible per the FSF. Build-only. |
| `Unlicense` | one package | varies | Public-domain dedication, fully compatible. |

### Unverified / unclear

**None.** Every one of the 611 installed package versions had a recognisable `license` field. No `UNDECLARED`, no `SEE LICENSE IN ...`, no `null`.

---

## Phase 3 — bundled vs server-only vs build-only

This matters most for the LGPL/MPL/FSL group, because GPL etc. care about redistribution.

| Package | License | Where used | Ships to customer? |
|---|---|---|---|
| `axe-core` | MPL-2.0 | eslint-plugin-jsx-a11y (lint) | **NO** — devDependency, build-only |
| `lightningcss` (3 variants) | MPL-2.0 | `@tailwindcss/postcss` (build) | **NO** — devDependency, build-only |
| `@img/sharp-libvips-*` | LGPL-3.0-or-later | `next` → `sharp` (image opt at build) | **NO direct ship** — runs on the SERVER at build/request time to optimise images; the binary stays on Vercel infra, only the optimised images reach the browser. LGPL's dynamic-linking allowance covers this. |
| `@sentry/cli*` | FSL-1.1-MIT | `@sentry/nextjs` bundler plugin (build) | **NO** — devDependency-adjacent, runs only when uploading sourcemaps to Sentry during build |
| `@sentry/nextjs` (and 16 sibling MIT pkgs) | MIT | Direct runtime import in `app/global-error.tsx` | YES — but it's MIT so this is fine |
| `@neondatabase/serverless` | MIT | Server-only (API routes: `app/api/heal/sentry-webhook`, `app/api/score`, `app/lib/db.ts`) | Server-only |
| `ssh2` | MIT | Server-only (`app/api/heal/ssh/route.ts`) | Server-only |
| `next`, `react`, `react-dom` | MIT | Universal | YES — MIT, fine |

**Verdict:** Every license that requires care (LGPL/MPL/FSL) is confined to either devDependencies or server-side / build-time tooling. Nothing copyleft or source-available reaches the browser bundle.

---

## Phase 4 — Service ToS (informational — not license risk, contractual risk)

GateTest calls external APIs **directly via `fetch`** (not via SDKs). No `@anthropic-ai/sdk` or `openai` package appears in either dependency tree.

| Service | Endpoint used | License risk | Contractual risk |
|---|---|---|---|
| Anthropic Claude | `https://api.anthropic.com/v1/messages` (verified in `app/api/scan/fix/route.ts`, `app/api/chat/route.ts`, `app/api/scan/server-fix/route.ts`) | None (no SDK to license) | **Re-read Anthropic Usage Policies pre-launch.** Public-facing AI features must follow Anthropic's content policies. Customers' code being analysed = downstream user data; review Anthropic's data-use terms for inputs > outputs. |
| Stripe | Stripe REST API | None | Standard Stripe ToS — already integrated, no new exposure |
| GitHub | GitHub REST + Webhooks | None | Standard GitHub ToS, plus future GitHub Marketplace ToS (Known Issue #29 — Craig action). |
| Sentry | Sentry ingest endpoint | None (`@sentry/nextjs` is MIT, `@sentry/cli` FSL covered above) | Standard Sentry ToS. |

No commercial-API SDK is bundled, so this section is **informational only** — there are no license obligations, only the usual ToS hygiene a public launch entails.

---

## Phase 5 — Playwright / Chromium

| Package | License | Notes |
|---|---|---|
| `@playwright/test@1.60.0` | Apache-2.0 | devDependency (test harness) |
| `playwright@1.60.0` | Apache-2.0 | transitive via @playwright/test |
| `playwright-core@1.60.0` | Apache-2.0 | transitive |

Playwright is also installed at the website level for chromium-driven scans (`src/modules/chaos.js`, `src/modules/runtime-errors.js` use it from the CLI / worker path — they're not shipped in the Vercel bundle per the CLAUDE.md "Headless browser path" note).

The Chromium binary itself is downloaded by Playwright on demand. Chromium ships under a mix of permissive licenses (BSD-3-Clause for the Chromium project umbrella, LGPL-2.1 / MPL-2.0 / etc. for some bundled libraries — all compatible with MIT redistribution since we do NOT redistribute the Chromium binary; Playwright pulls it on the customer's runner / our worker).

**Verdict:** Standard, safe. Same exposure as every Next.js site that uses Playwright tests.

---

## Phase 6 — fonts, images, icons

### Fonts

`website/app/globals.css:28-29`:

```
--font-mono: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
--font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Segoe UI', Roboto, sans-serif;
```

The site uses **system font stacks only**. No `next/font` imports detected. No `.woff` / `.woff2` / `.ttf` / `.otf` files in `website/public/`, `website/app/`, or root `public/`. No webfonts pulled from Google Fonts, Adobe Fonts, or any paid CDN. The browser uses whatever the OS provides for each named family. **Zero font license exposure.**

### Images

Inventory of `website/public/`:

| File | Notes | License status |
|---|---|---|
| `next.svg` | Next.js wordmark — Next.js scaffold default | MIT (Vercel/Next.js scaffold) |
| `vercel.svg` | Vercel wordmark — Next.js scaffold default | Used as scaffold; if Vercel branding appears anywhere customer-facing, **remove pre-launch** (it's not GateTest's mark) |
| `window.svg`, `globe.svg`, `file.svg` | Next.js scaffold icons (the gray `#666` icons) | MIT (Vercel/Next.js scaffold) — verify still referenced; if unused, remove pre-launch hygiene |
| `icon.svg`, `icon-180.png`, `icon-400.png` | GateTest's own (matching `viewBox="0 0 400 400"`) | Original work — MIT (covered by repo LICENSE) |
| `logo.svg`, `logo-512.png` | GateTest's own (`viewBox="0 0 512 512"`) | Original work — MIT |
| `logos.html`, `manifest.json` | Hand-authored | Original work — MIT |
| `favicon.ico` (in `app/`) | GateTest's own | Original work — MIT |

**No stock-photo files detected.** No JPGs, no royalty-image-bank assets. All raster/vector images are either Next.js scaffold defaults (Vercel/Next.js MIT-licensed) or GateTest's own SVG/PNG.

### Icons

No icon library is installed:

- `lucide-react` / `@heroicons/react` / `react-icons` / `@iconify/*` / `@tabler/icons` — **none present** in either dependency tree.
- All in-page icons are inline SVG hand-authored in components.

**Verdict:** No third-party icon-set license to track.

---

## Recommended actions

| # | Priority | Action |
|---|---|---|
| 1 | **OPTIONAL (low)** | Remove unused Next.js scaffold assets if not referenced anywhere customer-facing: `next.svg`, `vercel.svg`, `window.svg`, `globe.svg`, `file.svg`. They are MIT-licensed and harmless to keep, but the `vercel.svg` in particular reads as "we forgot to clean up the template." Hygiene only — not a launch blocker. |
| 2 | **INFORMATIONAL** | Re-read Anthropic Usage Policies before public launch and confirm GateTest's product (customers paste their repo URL → we send code snippets to Claude API for review/fix) is within Anthropic's published acceptable-use surface. This is a contractual hygiene step, not a license item. Boss Rule territory — Craig confirmation. |
| 3 | **OPTIONAL (low)** | Consider adding a `THIRD_PARTY_LICENSES.md` to the repo root that enumerates the 6 borderline packages (MPL/LGPL) and the 2 FSL packages, explaining for any future auditor (or customer security review) exactly why they're safe. Two-paragraph file, zero engineering risk. Useful for SOC2 / enterprise-procurement conversations. |
| 4 | **NONE** | No license-related code changes required. No package needs to be removed or replaced. The MIT license claim on the GateTest project is honest and defensible. |

---

## Top-line verdict

**GateTest can launch publicly under MIT with no license-compatibility risk.**

- Zero GPL, zero AGPL, zero copyleft contamination in either the CLI or the website.
- The six MPL-2.0 / LGPL-3.0-or-later packages are all transitive, all used as-is (not modified), and either confined to devDependencies (build-only) or invoked via the standard dynamic-linking pattern that LGPL/MPL explicitly permit alongside permissive code.
- The two FSL-1.1-MIT packages (`@sentry/cli` and its native binary) are build-time tooling only; the FSL's "Competing Use" prohibition would only fire if we built an error-tracking SaaS that competes with Sentry — we build a QA gate, which is unrelated.
- All runtime Sentry packages (the ones that DO reach the browser) are MIT.
- No fonts, no stock photos, no icon library — all visual assets are either Next.js scaffold defaults (MIT) or original GateTest work (MIT).
- No commercial-API SDK is installed; Claude API is called via direct `fetch`, which carries no license obligation (only the Anthropic ToS, which is a separate, contractual item for Craig to confirm).

The single most urgent finding: **none.** This is a clean tree.
