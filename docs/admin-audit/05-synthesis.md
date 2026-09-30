# 05 — Synthesis: the owner console (one design)

**Mock:** `mock-final.html` covers Overview, Scan (Findings with lifecycle, Not checked, Trace, Fix PRs, Raw), Customer, Secrets and Cmd-K. Geist is embedded, it makes zero requests, and every view has a URL. **W2** means it needs backend data first (§7). Browser-checked at 1440 and 390 in both themes: no overflow, and no hue 0–65° or 330–360° on about 1,700 elements.

## 0. Basis

**Base: Designer C**, the owner and customer judges' pick. Its numbers reconcile, its failure copy names what is unknown, and entity pages with Related chips are the hardest thing to retrofit. The first wave follows A's ordering (the engineering judge's pick).

**Grafts.**
- **A:** ranked Next actions (verb and key), rail signals, verified-empty, the "lower bound" callout, compact default, hatched queue wait.
- **B:** admin.css theme contract, SVG mark sprite, definition footers, prose verdict with last week, Not-checked by reason, "partial", "not live until first event", "= main", real row focus, aria tabs, drawer with scrim, hue test.
- **Judges:** masked PII with audited reveal, full secret redaction, "New fix PR" as the blocker primary, labelled density, URLs everywhere.

**Rule zero.** The headline takes the worst gate-path state. The gate path is the worker, queue, git-host deliveries, engine and deployed build.
1. Gate-path read failed: "Cannot confirm the gate".
2. Gate-path cannot tell: "◌ Cannot tell whether the gate is running — {reason}".
3. Worker stalled or deliveries failing: "■ Gate is not running".
4. Blockers open: "Gate running · N merges blocked".
5. Everything ok: "● Gate held". This is the only pass mark allowed in a headline.

Any other not-ok panel adds "Partial verdict: N panels are not ok". All three mocks broke this.

**Refinement of C:** ok panels say "Read 12s ago", not "OK", so read state never shares a word with subject health (marks carry that).

## 1. Information architecture

Replaces 9 sidebar links and 9 URL-less in-page tabs.

| Group | Routes |
|---|---|
| Overview | `/admin` (the default; today the default is Repo Scan) |
| Gate | `/admin/scans`, `/admin/findings`, `/admin/watchdog` |
| Customers | `/admin/customers`, `/admin/repos`, `/admin/revenue`, `/admin/feedback` |
| Platform | `/admin/health`, `/admin/deploys`, `/admin/keys`, `/admin/integrations`, `/admin/secrets` |
| Governance | `/admin/audit`, `/admin/compliance`, `/admin/rules` |
| Pinned | `/admin/launch` |

**Rail signals:** worst mark plus count, ▍ for a failed read, nothing when well; from the same `/api/admin/overview` payload as Next actions (60 s cache), so rail and page cannot disagree.

**URL rules:**
- A list and its entities share one root (`/admin/keys`, `/admin/keys/:prefix`).
- Tabs are path segments (`/admin/scans/:id/{findings|not-checked|trace|fix-prs|raw}`).
- Filters and palette prefill go in the query string (`?f=sev:blocker`, `?k=4f1e9c2`).
- Repo URLs carry the host: `/admin/repos/:host/:owner/:name`.

**Entity pages** share one `EntityHeader` (crumb, mono id and copy, verdict chip, meta, Related chips, tabs, timeline): Scan (Findings · Not checked · Trace W2 · Fix PRs · Raw), Customer (Timeline · Scans · Repos · Keys · Billing · Feedback · Audit), Key (step-up revoke and rotate), Secret (expanded row), Deploy (checks). Finding, Rule, Fix PR, Repo, Watch and Incident are W2.

**Removed:** tab strip, stats bar and second query, LiveScanTerminal, "Quick (41 modules)", ☢ "Fix Everything" (forensic becomes a `kind`), trace/triage skeletons, duplicate `<main>` and feed, bare "Run Tick Now" (now a job with an outcome), "vapron-ai".

**Mapping:**

| Today | New home |
|---|---|
| Overview, stats bar, BuildStatusBar | `/admin` |
| Recent Scans; Repo, Server and Forensic scans | `/admin/scans?kind=`, a New scan sheet, `/admin/scans/:id` |
| Pipeline trace | `/admin/scans?live=1`; Scan › Trace (W2) |
| Triage, fleet, Learning | `/admin/findings`, `/admin/rules` (W2); fleet goes to Overview |
| Watchdog, Health, Customers, Keys, Secrets, Feedback | same-name routes |
| Platforms, siblings, git-host accounts, estate events | `/admin/integrations` |
| Compliance and audit CSV; HN launch | `/admin/compliance`, `/admin/audit`; `/admin/launch` |

## 2. Design system

**Tokens:** re-values the `--gt-admin-*` contract (light in bare `:root`; dark under `prefers-color-scheme` guarded by `:root:not([data-theme="light"])`; dark again under `[data-theme="dark"]`). ThemeToggle keeps system/light/dark (`gatetest-admin-theme`), labelled White/Black. success, warning and danger are deleted. The rail is `bg` in both themes; only token values differ.

| Token (legacy alias) | White | Black |
|---|---|---|
| bg (bg, sidebar-bg) | #FFFFFF | #000000 |
| surface | #FFFFFF | #0B0B0C |
| surface-2 (bg-alt) | #F6F7F8 | #141518 |
| line / line-strong (border / border-strong) | #E4E7EB / #C5CBD2 | #26282D / #3B3F46 |
| ink-1 (fg, danger) | #0B0F14 | #F2F3F5 |
| ink-2 (fg-secondary, warning) | #3F4752 | #AAB0B9 |
| ink-3 (muted) | #687280 | #7A818B |
| ink-off (decoration) | #A3AAB3 | #50555D |
| accent (success) | #0F766E | #2DD4BF |
| accent-soft / accent-fg | rgba(15,118,110,.10) / #FFF | rgba(45,212,191,.12) / #00201C |

**Contrast on bg (white / black):** ink-1 19.2 / 18.9, ink-2 9.4 / 8.9, ink-3 4.9 / 5.3 (at least 4.5 on surface-2 too), accent 5.5 / 11.3.

**Colour use.** Accent only on pass marks, focus rings and the current-nav and focused-row bars. Links are underlined ink, primary buttons ink-1. Money and destructive verbs take step-up plus a typed reason, never a colour.

**Type.** Geist 400/500/600; Geist Mono (tabular, right-aligned) for ids, SHAs, paths, money and counts; self-hosted via `next/font/local`. Scale 12/13/14/16/20/24 on 16/18/20/24/28/32; tables 13, titles 20, only the verdict at 24. Labels 12 px sentence case; only the 11 px kind tags are uppercase. Ids truncate in the middle, with `title` and copy on `C`.

**Spacing and density.** 4 px grid; gutter 24 (16 at ≤900 px); panel padding 16; radii 8/6/4. `data-density`: compact 28 px rows (owner default) or comfortable 40 px on the same DOM, via a labelled "Compact | Comfortable" toggle (persisted, also `D`).

**Marks:** one SVG sprite (12×12, `currentColor`), one optical size; always beside a word, `aria-hidden`.

| Mark | Shape | Ink | Rule |
|---|---|---|---|
| ■ Blocker | square, rx 1 | ink-1 | label weight 600; 2 px ink row bar |
| ◆ High | diamond | ink-1 | — |
| ◐ Medium | ring, left half filled | ink-1 | — |
| ○ Low | ring | ink-3 | muted label |
| ● Pass | disc | accent | the only accented mark |
| ◌ Not run / unknown | dashed ring | ink-3 | muted label |
| ▍ Read failed | 3×11 bar | ink-1 | lists and signals only |

One set for findings, scans, payments, watches, secrets and integrations; in #847, missing Required = ■, missing Important = ◆, pending apply = ◐.

**Three read states (`<Panel>`):**

| State | Chrome | Copy |
|---|---|---|
| ok | "Read 12s ago" | A zero shows only after an ok read. An empty list reads "None. Verified: GET … → 200, 0 rows" plus the snippet that fills it. |
| failed | 2 px ink left rule, "▍ Failed" | "Failed — {what we could not read}", the consequence ("No number is shown because none was read"), method, endpoint, status, request id, since/attempts, Retry, request log. |
| cannot tell | dashed border, "◌ Cannot tell" | What cannot be decided, and why. "Either … or … — this panel cannot decide." The one action that decides it. |

**Panel rules:** strip cells carry own state (hatched = cannot tell, ruled = failed); last-known values state provenance; "Still loading (12 s)" after 400 ms, Failed at 10 s; "Healthy", "No issues found", "✓", "intact" only after an ok read of a check that ran; disputable numbers get a definition footer.

**Tables:** sticky header and first column; `tabindex=0` rows (J/K real focus, Enter opens/expands, C copies, accent bar on focus); actions on hover/focus; footer with "Showing x of y", CSV/JSON, definitions; never a silent LIMIT.

**Charts, no hue:** blocked solid, passed outlined, not run/no data hatched with dashed edge; comparisons dashed; deploys as dashed verticals with mono SHA; silence hatched, never zero; `role=img` with a numeric `aria-label`.

**Motion and a11y:** 120 ms palette/dialogs, 160 ms drawer, 0 tables; reduced-motion disables all; no spinners. 2 px accent focus ring; screen change focuses the `h1`, tab change keeps tab focus. Tabs with `aria-controls` and arrows; drawer with scrim, trap, Esc; dialogs trap and return focus; palette is a combobox with `aria-activedescendant`; per-theme `color-scheme`; targets ≥ 24 px; skip link.

## 3. Shared components (`website/app/admin/_ui/`)

| Component | Replaces or does |
|---|---|
| `adminFetch`, `useAdminFetch` | raw fetches that ignore `res.ok`: 503 "not configured" or `{checked:false}` → cannot tell; 5xx, network or 10 s timeout → failed, with endpoint, status, request id |
| `Panel`, `FailedState`, `CannotTellState`, `VerifiedEmpty`, `ReadStamp` | the three states |
| `Mark`, `MarkSprite`, `StatusLabel` | 11 status-pill copies and the emoji |
| `RelativeTime`, `CopyId`, `Stat`/`StatStrip` | 9 formatters, 6 copy buttons, 2 Stats |
| `verdictFromPanels()`, `VerdictHeadline` | rule zero, unit-tested |
| `NextActions` | server-built `actions[]` from the panels' own reads, ranked gate path first, then ■ ▍ ◆ ◐ ◌ ○; keys 1–8 |
| `Rail`, `Topbar`, `Drawer`, `ThemeToggle`, `DensityToggle` | AdminShell and AdminPanel navigation |
| `AdminGuard` | wave 0's `requireAdmin`; a client-side 401 goes to sign-in, never to an empty panel |
| `StepUpDialog`, `ReasonDialog`, `Modal` | `confirm()`, via #847's Modal and `runWithStepUp` |
| `DataTable`, `FilterChips`, `Tabs` | ad-hoc tables, with URL-bound state |
| `EntityHeader`, `RelatedChips`, `Timeline` | new; timeline kinds PAY / SCAN / GATE / PR / KEY / FB / AUD |
| `Snippet` | two duplicate renderers; redacts secret matches in full |
| `MaskedValue` | email and IP masking; reveal needs a reason and is audited |
| `Bars`, `Spark`, `DeployTick`, `CommandPalette`, `useHotkeys`, `KeyboardMap` | new |

## 4. 01-measure defects: fix and PR

| Area | Defect → fix | PR |
|---|---|---|
| Shell | URL-less tabs and the Repo Scan default → routes; no mobile → drawer; no tab roles → `Tabs` | 4 |
| | ~108 banned-hue lines and hard-coded greys → tokens plus a ratchet down to 0; ThemeToggle roles → radiogroup | 1–12 |
| | "stale" after 24 h → stale only when SHA ≠ main | 6 |
| Overview | AI key reads "present" → match by catalogue id; idle worker reads "Healthy" → cannot tell; missing tables read as zeros → cannot tell; "Not ready" → reasons; cards → links; second query → deleted; SUM(tier_price) → "Billed (scans)", completed scans only | 3 |
| Recent scans | "No scans" on error → Failed; all-time badge → in-range count; no paging or detail → list and page | 5, 8, 9 |
| Repo scan | PASSED, "done", lost PR URLs, "Quick (41)" → wave 0; fake terminal → real `/api/scan/status` | 0, 8 |
| Server/Forensic | 429 as "no fixes", unlabelled input, unreachable AI branch, "SSH credentials not found", ☢ → Failed, label, pass tier, honest empty, `Mark`; self-heal → wave 0; duplicate snippet → `Snippet` | 5, 0, 9 |
| Watchdog | tick 401 and "checked undefined"; "✓ No issues" on failure; "No watches" on DB failure; dropped stats; N+1 → bearer, Failed, all stats, paging | 7 |
| Pipeline trace | dies at 55 s → reconnect with "Reconnecting (n)"; green dot with DB unset → cannot tell; scroll jump → removed. Duplicate nav/`<main>` → shell; duplicate feed → `?live=1` | 5, 4, 8 |
| Triage | "table missing" hidden, errors shown as empty → Panel; copied skeleton → shell | 5, 4 |
| Health | id mismatch → catalogue ids; green button → "Not run yet"; div onClick → buttons; wrong `/api/db/init` advice → POST; own env list → env-catalogue; two "Ready" definitions → shared `ready()` | 6 |
| Customers | "No customers" on error → Panel; silent LIMIT 100, no detail page, no payments link, no refund/credit/email, two revenue sources → paged list, customer page, "Open in payments ↗", credit via step-up, one definition | 5, 10 |
| Keys | "Loading…" forever and getDb outside try → Panel, try; revoke with `confirm()` and no status check, no step-up, no customer link → dialog, step-up, link. Rotate, expiry, usage → W2 | 5, 10 |
| Platforms | "none" on failure, unhandled add/remove, missing health counted healthy, placeholder, wrong help, dark widget → Failed, handled, cannot tell, removed, `/admin/secrets`, tokens | 5 |
| Accounts, HN auth | 401 everywhere, one-click delete, auth bypass → wave 0 | 0 |
| Estate events | `ok:true, []` on read failure → Failed; `job.failed` → ◆; JSONL store → W2 (DB) | 5 |
| Compliance | "intact" when the check throws → cannot tell; 0/0 with DB unset → banner; "Vercel" → "the box's reverse proxy"; asserted controls → "Cannot tell — no evidence"; unlinked CSV → Audit page | 11 |
| Feedback | scan_id hidden → linked. Filters and reply → W2 (needs outbound mail) | 5 |
| HN launch | poll restarts on "Mark replied" → keyed on draft id; orange page → tokens | 5, 1 |
| Learning | "Modules tracked 0" on failure; errors in the success box; "red" copy → Panel, Failed block, corrected copy | 5 |
| Secrets | would_drop_keys; out_of_sync shown as failure; hash chain; verify rows → #847. Own marks → `Mark` | 0, 12 |
| Cross-cutting | auth copied into ~12 routes → wave 0; duplicated primitives and no `res.ok` → `_ui`; four scan tools → one list; no search → palette; no MRR, incidents or margin → W2 | 0, 2, 8, 12 |

## 5. Wave 0 (in flight; land, do not redo)

- **fix/admin-auth-and-heal-guard** (0deecc8b, 9389f31b): one `requireAdmin`; hn-launch and seo/submit no longer pass on cookie presence; github-profiles gated; Accounts shows refusals; SSH heal guard; public scan gating.
- **fix/admin-repo-scan-honest** (9116115a): `res.ok` checks, errors reported as errors, the real module count, and all PR URLs kept.
- **#847 secrets panel**, on the merged store (#849).
- **Corpus fix** (`wip/fix/corpus-apollo-regression`, `chore/corpus-ratchet-0929`): keeps main green.

## 6. First wave, ranked

**Every PR:** files under 500 lines; a Playwright journey `website/e2e/admin-*.spec.ts` at 1440×900 and 390×844 in White and Black (screenshot pairs, computed-colour walk); routes added to `tests/heavy/admin-signed-in-smoke.test.js`.

| # | PR | Files | Removes | Deps |
|---|---|---|---|---|
| 1 | Tokens, Geist, hue ratchet | `admin.css`, `admin/layout.tsx`, `public/fonts/geist*.woff2`, `ThemeToggle.tsx`, `tests/admin-hue-ratchet.test.js` | amber/red tokens, dark sidebar, role mix | — |
| 2 | Primitives | `lib/admin-fetch.ts`, `_ui/{Panel,Mark,MarkSprite,RelativeTime,CopyId,Stat}` | duplicate primitives | 1 |
| 3 | Overview honest, rule zero, Next actions | `OverviewDashboard` split into Verdict, NextActions and Readiness; `lib/admin-overview.ts`; `api/admin/overview` | 7 Overview defects, stats bar | 2 |
| 4 | Rail, routes, drawer, signals | `AdminShell`; delete `AdminPanel`; tabs lifted into `app/admin/{scans,customers,keys,integrations,watchdog,launch}`; `?tab=` redirects | URL-less tabs, second nav, duplicate `<main>` | 3 |
| 5 | False-OK sweep | Scans, Customers, Keys (+route), Platforms, Siblings, tallrig, learning, FleetIntelligence, LiveScanFeed, feedback, ServerScan, NuclearScan, hn-launch | about 14 false-OK sites | 2 |
| 6 | Health and deploy truth | `health/page.tsx`, `api/admin/health`, `health-composite.js`, `admin-build-status.ts` | Health defects, 24 h stale | 2, 3 |
| 7 | Watchdog honesty | `WatchdogTab`/`Panel`/`Briefing`, tick caller, paged `api/admin/repos` | 6 false states, N+1 | 2, 4 |
| 8 | Scans list | `admin/scans`, `api/admin/scans`, New scan sheet; delete `LiveScanTerminal` | 4 launchers, fake terminal | 4, 5, wave 0 |
| 9 | Scan page: Findings, Not checked | `admin/scans/[id]/[tab]`, `_ui/Snippet`, `api/admin/scans/[id]`, `scans.commit_sha` migration | duplicate renderer, lost PR URLs | 8 |
| 10 | Customer page v1, key actions | `admin/customers/[id]/[tab]`, `api/admin/customers/[id]`, `EntityHeader`, `Timeline`, `MaskedValue`, `StepUpDialog` | Customer and Key defects, `confirm()` | 2, 4, wave 0 |
| 11 | Compliance honest, Audit page | `compliance/page.tsx`, `compliance-status.ts`, `admin/audit` over `api/admin/audit-log` | Compliance defects, unlinked CSV | 2, 4 |
| 12 | Cmd-K, keyboard, ratchet at 0 | `CommandPalette`, `useHotkeys`, `KeyboardMap`, bounded `api/admin/search`, secrets marks | "cannot find anything"; empty allowlist | 4, 9 |

**Proofs** (journey assertions):

1. No hue 0–65° or 330–360° on any `/admin` route in either theme outside a shrinking named allowlist; a source test blocks new `red|orange|amber|yellow|rose` classes.
2. 200 → ok; 503-not-configured and `{checked:false}` → cannot tell; 500, network, timeout → failed; a fixture page renders all three states in both themes.
3. 500 → Failed with endpoint; DB unset → cannot tell, no zero; no worker activity → "Cannot tell whether the gate is running", no ●; AI key unset → Next action links `/admin/secrets/AI_API_KEY`.
4. Every URL 200 with `aria-current`; back and refresh keep the view; drawer at 390 with scrim and focus trap; rail signals equal Overview counts.
5. Per endpoint: 500 → Failed, DB unset → cannot tell, true zero → "Verified 200, 0 rows"; the stream survives 60 s and shows "Reconnecting (n)".
6. Failing git-host check → ■ row; "Not run yet" before a run; deployed = main never stale; readiness line "= main · 0 behind".
7. 401 → Failed with reason; a failed scan never reads "No issues found"; an overdue watch reads ◌ Stale.
8. Stats 500 → Failed with code; `?kind=site&status=failed` survives reload; a failed scan never reads PASSED.
9. Not-checked count = 122 − `modules_run.length`; each row has the runner's reason or "reason not recorded — cannot tell"; the lower-bound callout shows when a timed-out module carries blocker rules; secret snippets show no value characters.
10. Lanes: scans, gate blocks, fix PRs, keys (`last_used_at`, `total_calls`), feedback, audit; payment history is cannot tell (no event store) with "Open in payments ↗". Payments API down → live Billing Failed, scans still list. A reveal writes an audit row. Credit or revoke without step-up → 403.
11. Thrown chain verify → cannot tell, never "intact"; actor filter round-trips via URL; CSV downloads.
12. Pasted 7–40 hex SHA → that commit's scans and deploy; email → customer, masked; search 503 → Failed, commands still work; `?` lists keys; G S opens Scans; allowlist empty.

## 7. Wave 2 (deferred, and why)

Main lacks the data, so a UI now would show invented or empty numbers.

- **Per-finding fingerprint and lifecycle** (finding pages, auto-reopen, apply-to-all, "came back"): `scan_fingerprint` is per-codebase and excludes paths by contract; needs a store keyed on rule, path extension, pattern hash, normalised snippet.
- **Payment-event store**, for MRR, failed payments, the PAY lane and `/admin/revenue`.
- **Precision per rule, kill line, triage reasons.** These need verdict events; `finding_dismissals` is only a start.
- **Margin.** `ai_cost_usd` exists; compute seconds do not.
- **Key usage per day, IP, rotate and expiry.** `api_keys` has only `total_calls` and `last_used_at`.
- **Waterfall trace.** Needs per-stage timings.
- **Also:** incidents, deploy objects, watch drift, Mark expected, leak-scan sightings, estate events off JSONL, feedback reply, saved views.
