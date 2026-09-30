# GateTest owner console — Designer B spec (calm editorial clarity)

Principle: few things per screen, each unmistakable. Every number carries its own definition. A failure is never quiet. Structure is identical in white and black; craft lives in layout, hierarchy, type, density and interaction.

## A. Information architecture

One left rail, seven groups, no second tab strip. Every view and entity has a stable URL; every filter lives in the query string so any screen can be pasted into a chat.

| Group | Contents | Absorbs today |
|---|---|---|
| **Overview** `/admin` | Gate verdict headline, readiness, worker, revenue, integrations, deploy strip | OverviewDashboard, stats bar, BuildStatusBar |
| **Scans** `/admin/scans` | One list; chips `kind=repo\|site\|forensic`, `status`, `customer`, `repo`; "Run a scan" sheet; live toggle | Repo Scan, Server Scan, Forensic, Recent Scans, pipeline-trace live feed |
| **Findings** `/admin/findings` | Queues Unresolved / For review / Regressed / Accepted / False positive; rules index | Triage page |
| **Watchdog** `/admin/watchdog` | Watches list, per-watch page, briefing | WatchdogTab/Panel/Briefing |
| **Customers** `/admin/customers`, **Revenue** `/admin/revenue` | Customer pages, MRR roll-forward, failed payments | CustomersTab, second revenue query |
| **Platform** | Health `/admin/health`, Incidents, Deploys `/admin/deploys`, Keys `/admin/keys`, Integrations `/admin/integrations`, Secrets `/admin/secrets` | Health, KeysTab, Platforms, GitHub accounts, Tallrig events, secrets branch |
| **Governance** | Audit `/admin/audit`, Compliance `/admin/compliance`, Precision `/admin/precision`, Feedback `/admin/feedback` | Compliance, Learning (renamed), FleetIntelligence, Feedback |
| **Launch** `/admin/launch` (pinned) | Checklist with owner-only items marked | HN launch |

Entity pages: `/admin/customers/:id` · `/admin/repos/:host/:owner/:repo` · `/admin/scans/:id` (tabs `#findings #not-checked #trace #fix-prs #raw`) · `/admin/findings/:fingerprint` · `/admin/rules/:ruleId` · `/admin/fix-prs/:id` · `/admin/secrets/:name` · `/admin/deploys/:sha` · `/admin/keys/:id` · `/admin/watchdog/:id` · `/admin/incidents/:id`. Each has header, related entities, timeline.

Disappears: AdminPanel's URL-less `useState("scan")` tabs; the duplicate pipeline-trace/triage skeletons; the fake terminal; the ☢ button; the "vapron-ai" placeholder; the second stats query.

## B. Design system

**Tokens** (one set, `--gt-*`; the amber/red `warning`/`danger` tokens are deleted, not restyled):

| Token | White | Black |
|---|---|---|
| `bg` | #ffffff | #0a0b0b |
| `surface` / `surface-2` | #ffffff / #f6f7f7 | #111313 / #171a19 |
| `ink-1` / `ink-2` / `ink-3` | #0b0f0e / #5b6663 / #98a29f | #f2f4f3 / #a3adaa / #66706d |
| `line` / `line-strong` | #e6e9e8 / #c6cdcb | #232827 / #384040 |
| `accent` / `accent-soft` | #0f766e / rgba(15,118,110,.10) | #2dd4bf / rgba(45,212,191,.14) |
| `focus` | 2px `accent` ring, 2px offset | same |

Contrast steps are identical: ink-1 ≈ 16:1, ink-2 ≈ 7:1, ink-3 ≈ 4.5:1 in both. Primary buttons are ink-1 on bg; secondary are line-strong outline; destructive is ink-1 outline that fills on hover. Accent appears only on pass marks, links, focus and the current-nav bar.

**Type**: Geist 400/500/600; scale 12 (meta, uppercase labels at .04em) / 13 (table body) / 14 (body) / 16 (panel titles) / 20 (page titles) / 24 (headline numbers). Geist Mono for SHAs, ids, fingerprints, money and counts (`font-variant-numeric: tabular-nums`, right-aligned). Mono ids middle-truncate (`a1b2…9f8e`) with copy on hover and full value in `title`.

**Spacing**: 4px base; panel padding 16; page gutter 24 (16 at phone). Density: comfortable 40px rows, compact 28px; a per-user toggle (`D`) sets `data-density` on the root; only row height, cell padding and font size 13→12 change.

**Mark set** (shape + weight + label, never hue): blocker ■ filled square, label weight 600, optional 2px ink row bar · high ◆ filled diamond · medium ◐ half-filled circle · low ○ hollow circle ink-3 · pass ● accent circle · not run ◌ dashed circle. Same six marks classify scans, payments, watches and integrations ("failed" = ■, "degraded" = ◐, "ok" = ●, "never ran" = ◌).

**Tables**: sticky header, sticky first column, sort caret, hover-revealed row actions, `J/K` focus, `Enter` opens, relative time with absolute on hover, sparkline column, footer row with the definition of each number.

**Charts without hue**: bars ink-2, current period ink-1; series by dash pattern (solid / dashed / dotted) and marker (circle / square / diamond); deploy and commit ticks as dashed verticals with a mono label; coverage as an ink bar with a dashed remainder.

**Panel states** — every data panel is `<Panel state="ok|failed|unknown">`. *failed*: 2px ink top rule, ■ "Failed", the HTTP/DB reason in prose, a retry link. *unknown* ("Cannot tell"): dashed border, ◌, the reason and the fix (`table missing — run migration 014`). An empty result in *ok* shows the exact CLI/Action snippet that fills it. Zero is rendered only when the query succeeded and returned zero.

**Motion**: 120ms ease on hover and panel state; 200ms slide for the mobile rail and the Cmd-K sheet; no spinners longer than 400ms — after that a panel shows "Still loading (12 s)".

## C. Per area

**Overview** — headline is the gate verdict in prose: "This week the gate blocked 12 merges, passed 3 findings on new code, and did not run 4 modules", each number a link. Panels: Readiness (reasons listed, not "Not ready"), Worker (stale when last success older than schedule), Revenue (paid, from payment events, never SUM(tier_price)), Scans, Integrations, Deploy strip (deployed SHA = main → "current", never "stale" by age). Removes: AI-key name mismatch, worker "Healthy" with no activity, zeros for missing tables, no links, duplicate stats query, revenue-from-tier-price, 24h stale bug.

**Scans & findings** — one list, paged, filtered by URL; a failed stats query is a failed panel, not "No scans yet". Run-a-scan sheet checks `res.ok` on every step, shows real module progress from the engine event stream, opens one fix PR only when asked, keeps every PR URL. Scan page tabs: Findings (mark, rule id, file:line, first seen, status New/Recurring/Regressed), **What was not checked** (modules not run grouped by reason — tier, timeout, no matching files, module error — with what each would have caught and how to enable), Trace, Fix PRs, Raw. Finding page: lifecycle across commits (first seen → present → fixed in PR → regressed), sibling repos with the same pattern hash. Removes: "PASSED" on failure, "done" on fix error, fake terminal, "Quick (41)", 429 as "no fixes", unlabeled input, duplicated snippet renderer, unreachable AI diagnosis branch.

**Watchdog** — per-watch page (Activity / Runs / Properties); uptime math excludes maintenance; *stale* = last success older than interval. Tick button sends the bearer or is disabled with the reason; a failed repo scan reads ■ Failed; DB failure reads Cannot tell. Repos endpoint paged. Removes six false states.

**Pipeline trace** — becomes the scan page Trace tab: waterfall webhook → queue → clone → modules → AI → check-run with duration, exit reason, cost; range-select filters the log. Stream reconnects with backoff and says "Reconnecting (attempt 3)"; DB unset shows ◌ not a live dot. Deletes the duplicate `<main>`.

**Triage → Findings** — queue with `S` status, required reason for accept/FP, bulk, "apply to all matching fingerprints in this org"; each verdict feeds Precision. Fleet note renders as Cannot tell when the table is missing.

**Health & incidents** — id contract (`gluecron`) fixed so the git-host row exists; button ink and neutral before a run; rows are buttons; advice matches routes; env list from `env-catalogue`; one `ready` definition shared with Overview. Incident page: Overview / Timeline / Post-incident; every ■→● transition is a timeline entry.

**Customers & revenue** — customer page with timeline mixing payment events, scans, gate blocks, fix PRs, keys, feedback; Open-in-payments link; credit/refund/email actions with step-up; MRR roll-forward with churn defined; margin per scan (price − compute − AI spend). Removes: 43-line table, silent LIMIT 100, "No customers yet" on failure.

**Keys & integrations** — prefix, created by, last used (time + IP), calls/day sparkline, "unused 30 days"; rotate and expiry; issue behind step-up; revoke via dialog, never `confirm()`; 503 is a failed panel. Integrations: one page for git hosts, marketplace, site-scan worker, siblings — last webhook received, delivery failure rate, honest add/remove errors; accounts route fixed (401 today).

**Secrets** — keep #847 shape; add age since rotation, consuming units, "last seen in a leak scan"; out_of_sync as ◐ pending, would_drop_keys with a recovery path; audit hash-chain result shown.

**Audit & compliance** — `/admin/audit` over the existing CSV endpoint: actor, event, time, filter, export, side panel that follows the current page. Compliance: controls computed from evidence, thrown chain check = Failed, DB unset = Cannot tell, HTTPS evidence names the proxy on the box.

**Learning → Precision** — precision per rule (FP ÷ triaged) by rule / language / repo with trend and a kill list below the floor; fix-PR outcome per rule; status failures render failed, refresh errors never in the success box; copy says what the marks mean.

**Launch prep** — pinned checklist, owner-only items marked, poll effect keyed on id so "Mark replied" never re-drafts; no orange page.

## D. Global patterns

**Cmd-K**: search by scan id, SHA, fingerprint, rule id, email, repo, key prefix, secret name; results grouped by entity; Enter opens; `>` prefix runs commands (run scan, toggle theme, density). **Keyboard**: `G` then `O/S/F/W/C/H/K` groups; `J/K` rows; `Enter` open; `/` filter; `S` status; `T` theme; `D` density; `?` map. **Saved views**: state = URL; "Save view" names it (per-user, shared default optional); views listed under the group. **Deep links**: every panel title, number and mark links to the filtered list that explains it; every entity has a copyable permalink.

## E. First wave (each PR small, independent, both themes)

1. **Tokens, marks, panel** — `--gt-*` set, Geist, `<Mark>`, `<Panel state>`. Proof: journey test computes styles on every admin route and fails if any colour has hue 0–60°; screenshot pair at 1440/390 in both themes.
2. **Rail + routes** — seven groups, AdminPanel tabs → `/admin/scans?kind=`. Proof: each URL 200s, `aria-current` set, drawer at 390, old URLs redirect.
3. **Overview verdict** — headline + three-state panels + deploy strip. Proof: with DB unset every panel reads Cannot tell and no zero renders; with worker idle 2 h it reads ■ Stale.
4. **Scans list** — paged, URL filters, failed panel on stats error. Proof: stats 500 shows ■ Failed with HTTP code; `?kind=site` filters.
5. **Scan page + Not checked** — tabs, findings with marks, modules not run with reasons. Proof: a scan with 118/122 modules shows four rows with reasons; verdict never "PASSED" when `ok=false`.
6. **Finding by fingerprint** — lifecycle across commits. Proof: a finding fixed then regressed shows both events with SHAs.
7. **Customer page** — timeline, payments link, paid revenue. Proof: revenue equals paid events, not tier sum; failed payment renders ■.
8. **Health rows honest** — id contract, ready definition shared, env-catalogue. Proof: git-host failure shows a ■ row; button neutral before run.
9. **Watchdog honesty** — bearer, failed states, stale rule. Proof: 401 renders ■ with reason; failed scan never "No issues found".
10. **Keys** — three states, dialog revoke, step-up issue. Proof: 503 renders ■; revoke needs dialog confirm.
11. **Cmd-K + entity search** — palette and `/api/admin/search`. Proof: pasting a SHA opens the scan; keyboard map works.
12. **Audit page** — over existing export. Proof: filter by actor, CSV download, side panel on a customer page.
