# Designer A — the operator cockpit

Lens: the owner opens this many times a day to answer *is anything wrong?* and *what do I do next?* Dense, keyboard-first, every number a link, every panel honest. Structure is identical in both themes; only tokens change.

## (a) Information architecture

One left rail, six groups plus one pinned item. Every view and entity has a stable URL; the nine `useState` tabs in `AdminPanel` disappear.

| Rail | Views (URL) | What merges into it |
|---|---|---|
| **Overview** | `/admin` | stats bar (deleted), fleet panel from Triage |
| **Scans** | `/admin/scans` (one list; `?kind=repo\|site\|forensic&source=app\|action\|hosted\|watchdog&status=`), `/admin/scans/live`, `/admin/scans/new?kind=` | Recent Scans, Repo/Server/Forensic scan launchers, pipeline-trace live feed |
| | `/admin/scans/:id` tabs `findings \| not-checked \| trace \| fix-prs \| raw` | Pipeline trace (per scan), ModuleResults |
| **Findings** | `/admin/findings` (queues `for-review \| open \| regressed \| accepted \| fp \| archived`), `/admin/findings/:fingerprint`, `/admin/rules`, `/admin/rules/:ruleId`, `/admin/fix-prs`, `/admin/fix-prs/:id` | Triage page, Learning (as Rules) |
| **Watchdog** | `/admin/watchdog`, `/admin/watchdog/:watchId` (Activity / Runs / Drift / Settings) | WatchdogTab/Panel/Briefing |
| **Customers** | `/admin/customers`, `/admin/customers/:id`, `/admin/repos/:owner/:name`, `/admin/revenue` | CustomersTab, Stripe revenue, per-key usage |
| **Platform** | `/admin/health`, `/admin/incidents/:id`, `/admin/deploys`, `/admin/deploys/:sha`, `/admin/keys`, `/admin/keys/:id`, `/admin/integrations` (git hosts, estate siblings, Tallrig events, Stripe webhooks, MCP), `/admin/secrets`, `/admin/secrets/:name` | Health, Platforms, PlatformSiblings, GitHub accounts, Tallrig events, KeysTab, secrets branch |
| **Governance** | `/admin/audit`, `/admin/compliance`, `/admin/precision`, `/admin/feedback` | Compliance, Learning trend, Feedback |
| **Launch** (pinned) | `/admin/launch` | HN launch page, becomes a checklist with the thread poll as one item |

Gone: the second in-page nav, the duplicated stats bar, "Fix Everything", the fake terminal, "Quick (41 modules)". Forensic is a scan `kind` with the same detail page. Entity headers share one shape: title · mono id with copy · status mark · related-entity chips (customer, repo, scan, fix PR, deploy) · actions.

## (b) Design system

**Tokens (both themes, same names).** `--bg`, `--surface`, `--surface-2` (wells), `--line`, `--line-strong`; ink `--ink-1/2/3` (primary, secondary, disabled — contrast steps 15:1 / 7:1 / 3:1 kept in both themes); `--accent`, `--accent-soft`, `--accent-fg`; `--focus` (2px accent ring, 2px offset); `--bar` (2px left rule for blocker rows, ink-1). White: bg `#fff`, surface-2 `#f5f6f7`, line `#e5e7ea`, ink `#0b0f14 / #525a63 / #9aa1a9`, accent `#0f766e`. Black: bg `#000`, surface `#0a0a0a`, surface-2 `#131313`, line `#242424`, ink `#f2f2f2 / #a3a8ad / #5d6167`, accent `#2dd4bf`. Nothing else is coloured; `--gt-admin-success/warning/danger` are deleted. Primary buttons are ink-1; secondary outlined; destructive is primary plus typed confirmation, never a hue.

**Type.** Geist 400/500/600; Geist Mono for SHAs, ids, fingerprints and table numbers (tabular, right-aligned). Scale 12/13/14/16/20/24, line heights 16/18/20/24/28/32; table body 13; page title 20; one 24 per screen (the verdict).

**Spacing and density.** 4-pt grid. `data-density` on the shell: compact rows 28px (cell 4×8) or comfortable 40px (10×12); persisted per user; same DOM.

**Mark set** (CSS shapes, always labelled): blocker ■ + label weight 600 + row `--bar`; high ◆; medium ◐ (half-fill by gradient); low ○ ink-3; pass ● accent; not run ◌ dashed outline. Status for scans and services reuse the same six.

**Tables.** Sticky header and first column, sort caret, hover-revealed actions, `J/K` row focus with visible ring, `Enter` opens, `.` opens the row menu, relative time with absolute in `title`, mono middle-truncation with copy on hover.

**Charts without hue.** Single ink stroke; series by dash (solid/dashed/dotted) and marker (●/■/◆); 8% ink area fill; deploy and commit ticks as vertical rules with SHA on hover; the current point in accent.

**Three states per data panel** — enforced by one `<Panel state>` primitive and a `fetchJson` that checks `res.ok`:
- *ok*: content. A true zero renders "None yet" plus the CLI/Action snippet that fills it, only after an ok response.
- *failed*: solid 2px ink bar, "FAILED" 600, cause (`HTTP 502 /api/admin/overview`), since-time, Retry. Never empty.
- *cannot tell*: dashed outline, "CANNOT TELL", reason (`DATABASE_URL unset`, `no heartbeat 3h`, `table missing`). Counts as not-ok in the verdict.

**Motion.** 120ms ease-out for tab and panel changes; live rows insert without scroll jump; `prefers-reduced-motion` disables all; no spinners, an "updated 12s ago" stamp instead.

## (c) Per area

**Overview.** Headline is the gate verdict as a strip: merges blocked · findings passed on new code · modules not run · failed scans · cannot-tell panels. Right column "Next actions" is derived from failures and ranked by mark, each a link with a shortcut. Readiness strip for the box (units, disk, queue depth, deployed SHA vs `origin/main`, mail sender last send). Fixes: AI key matched on the renamed status key; worker with no heartbeat is cannot-tell, not Healthy; missing tables are cannot-tell, not zeros; "Not ready" lists reasons; every tile links; the second stats query goes; "Revenue" becomes Stripe money on `/admin/revenue`, the SUM(tier_price) becomes "billed scans".

**Scans and findings.** One paged, filtered list (kind, source, status, customer, repo); stats 500 is a failed panel, never "No scans recorded yet". Scan page tabs: Findings (marks, new-code vs overall, status with history, fingerprint link); **Not checked** — the 122 modules as ran / skipped (reason) / timed out / not applicable, with what would change the answer; Trace — waterfall webhook → queue → clone → modules → fix → check-run with duration, exit reason, cost; Fix PRs — all PR urls, not the last one. Failed scan reads "FAILED" from `res.ok`; fix errors read failed. Finding page: lifecycle rail across commits (first seen, suspect, fixed, regressed) and accepted/FP with reason; accepted reopens when the rule's count worsens.

**Watchdog.** Per-watch page with runs and a drift timeline with deploy ticks; "stale" (last success older than schedule) is cannot-tell, distinct from failing. Tick sends the bearer and a 401 reads FAILED; failed repo scans never read "No issues found"; DB failure is FAILED, not "No watches yet"; briefing shows all stats; repos paged, not N+1.

**Pipeline trace.** Becomes the scan Trace tab plus `/admin/scans/live`. The stream reconnects with backoff and shows its true state; DB unset is cannot-tell, not green; no `scrollIntoView`; duplicate `<main>` and nav removed.

**Triage.** The Findings queues with `S` status, `A` assign, bulk select, required reason for FP/accept, "apply to all matching fingerprints in this org"; each verdict writes a precision event. Fleet "table missing" is cannot-tell.

**Health and incidents.** One check list keyed by API id (the `gluecron` row renders); three states per row; neutral button until run; rows are buttons; env list from the catalogue; "Ready" is the Overview strip's function. Incident page Overview / Timeline / Post-incident; every not-ok → ok transition is an automatic timeline entry.

**Customers and revenue.** Customer page: header (plan, MRR, Stripe id linked), stat row (scans 30d, gate blocks, fix PRs merged, margin per scan), keys with last use, repos with precision, and a timeline merging Stripe events, scans, gate blocks, fix PRs, feedback, filterable by chip. Actions: refund, credit, email, with typed confirmation. Revenue: MRR and roll-forward, failed payments, per-scan margin; no `LIMIT 100` without a pager; stats failure is failed, never "No customers yet".

**Keys and integrations.** Key rows: prefix, created by, last used (time + IP), scopes, expiry, calls/day sparkline, "unused 30 days" low mark; rotate and revoke behind step-up; GET 503 reads FAILED, not "Loading…". Integrations: git hosts (401 fixed, auth via the admin session), estate siblings (missing health field = cannot-tell, placeholder removed), Tallrig events (`job.failed` marked high; read failure is FAILED), Stripe webhooks (last received, failure rate), MCP.

**Secrets.** Keep the branch's honest states; add age since rotation, consuming units, last seen in a leak scan; `out_of_sync` is a pending mark, not a failure; verify rows use the mark set; hash-chain result shown.

**Audit and compliance.** One immutable audit view (actor, role, event, time) with filter, CSV/API export, and a side panel that follows the current entity page. Compliance: controls carry evidence links or read cannot-tell; a thrown chain check reads FAILED, never "intact"; DB unset shows a banner; Vercel copy removed.

**Precision (learning).** Precision per rule (FP ÷ triaged) by rule / language / repo with trend and a kill line; fix-PR outcome per rule; status/trend failures are failed panels, not "Modules tracked 0"; refresh errors are not styled as success.

**Launch prep.** A pinned checklist (owner, state mark, link); the HN poll is one item and no longer restarts on "Mark replied".

## (d) Global patterns

**Cmd-K** — search customers, repos, scans, findings, rules, keys, secrets, deploys by name, id, email or pasted SHA (7–40 hex resolves to scan, deploy or finding); commands ("New scan", "Toggle theme", "Density"); recents first.
**Keyboard map** (`?`): `g o/s/f/w/c/p/a` go to group; `j/k` rows; `enter` open; `.` row menu; `[ ]` tabs; `/` filter; `n` new scan; `s` status; `\` theme; `d` density; `esc` close.
**Saved views** — filter state lives in the URL; "Save view" names it; shared default per list.
**Deep links** — every count, tile and mark is an `<a>` to the filtered list; every entity page has a copy-link action.

## (e) First wave — small, ordered, independently shippable

Each proof runs in both themes with a browser check at 1440 and 390 and a journey test.

1. **Tokens + fonts** — delete success/warning/danger; add ink levels, surfaces, lines, accent, focus; Geist. Proof: a test walks computed colours across `/admin/**` and finds no hue outside grey and the accent; screenshots identical in structure.
2. **`<Panel>` + `fetchJson`** — three-state primitive; migrate Overview cards. Proof: mock 500 on `/api/admin/overview` → every card reads FAILED with cause; DB unset → CANNOT TELL; no zeros.
3. **Mark set + one status pill** — replace the 11 pills and the emoji. Proof: six marks render by shape at 13px, labelled, in both themes; not-run is dashed.
4. **URL routes for the nine tabs** — `/admin/scans`, `/admin/customers`, `/admin/keys`, `/admin/integrations`; rail groups; default is Overview. Proof: back and refresh keep the view; in-page tab state is gone.
5. **Overview verdict strip + next actions** — with the AI-key name fix, worker cannot-tell, reasons for "Not ready". Proof: with the key unset the strip says so and the action links to `/admin/secrets/:name`.
6. **Scans list** — paging, filters, marks, honest failed state, rows link to `/admin/scans/:id`. Proof: stats 500 reads FAILED; a failed scan reads FAILED, not PASSED.
7. **Scan page: Findings + Not checked** — from existing module results. Proof: a scan with a timed-out module shows it under Not checked with the reason; counts in the tab titles.
8. **Health** — id keyed rows, three states, neutral button, shared Ready function. Proof: a failing git-host check renders a marked row.
9. **Watchdog honesty** — bearer on tick, failed states, per-watch URL. Proof: a 401 reads FAILED; a failed repo scan never reads "No issues found".
10. **Cmd-K + keyboard map** — entity search and G-navigation. Proof: paste a SHA → scan page opens; `?` lists the map; focus rings visible in both themes.
11. **Customer page + timeline** — scans and Stripe events merged, Stripe link, honest lanes. Proof: Stripe fetch failure renders CANNOT TELL on the payments lane only; the scans lane still lists.
12. **Density + table craft** — compact/comfortable, sticky header, tabular numbers, J/K. Proof: rows measure 28/40 px; choice persists after reload.
