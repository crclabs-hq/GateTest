# Designer C — entity-first admin console

Lens: everything the owner cares about is an object with a stable URL. Lists exist to reach objects; the differentiators (finding lifecycle, what was not checked, precision per rule, fix-PR outcomes) live on object pages, reached by search from anywhere.

## A. Information architecture

### Rail (six groups + one pinned item; replaces 9 sidebar links + 9 URL-less tabs)

| Group | Views (stable URL) | Absorbs today |
|---|---|---|
| Overview | `/admin` | Overview, stats bar, fleet panel from Triage |
| Scans | `/admin/scans?kind=repo,site,forensic&status=&customer=&repo=&range=` · `/admin/scans/live` (same list, streaming filter) | Recent Scans, Repo/Server/Forensic scan tabs (become one **New scan** action), pipeline feed |
| Findings | `/admin/findings?view=unresolved,review,regressed,accepted,archived` · `/admin/rules` | Triage page, Learning |
| Watchdog | `/admin/watchdog` | Watchdog tab, briefing |
| Customers | `/admin/customers` · `/admin/repos` · `/admin/feedback` | Customers tab, Feedback |
| Platform | `/admin/platform/health` · `/admin/platform/deploys` · `/admin/platform/keys` · `/admin/platform/integrations` · `/admin/platform/secrets` | Health, API keys, Platforms, GitHub accounts, Tallrig events, Secrets branch |
| Governance | `/admin/audit` · `/admin/compliance` | Compliance, audit-log CSV (finally linked) |
| Launch (pinned) | `/admin/launch` | HN launch, SEO submit, readiness checklist |

Disappears: the in-page tab bar; the second `<main>`; the duplicated pipeline feed; "Run Tick Now" (becomes a job object with an outcome).

### Entity pages (header · related objects · tabs · timeline)

| Entity | URL | Header facts | Tabs |
|---|---|---|---|
| Customer | `/admin/customers/:id` | email, plan, MRR, Stripe id (deep link), since | Timeline · Scans · Repos · Keys · Billing · Feedback |
| Repo | `/admin/repos/:host/:owner/:name` | default branch, last gate verdict, watch, installation | Scans · Findings · Watch · Fix PRs |
| Scan | `/admin/scans/:id` | kind, tier, commit SHA, verdict, duration, price / compute / model spend → margin | Findings · **Not checked** · Trace · Fix PRs · Raw |
| Finding | `/admin/findings/:fingerprint` | rule, severity mark, first seen, suspect commit, status | Occurrences (per commit) · Verdicts · Related |
| Rule | `/admin/rules/:id` | module, precision (FP ÷ triaged), trend, kill-list flag | Findings · Fix-PR outcomes · Timing |
| Fix PR | `/admin/fix-prs/:id` | repo, PR number, outcome (merged / closed / reverted), time-to-merge | Fingerprints fixed · Came back? |
| Secret | `/admin/secrets/:name` | state, liveness, age since rotation, consuming units | Verify history · Audit · Leak-scan sightings |
| Deploy | `/admin/deploys/:sha` | SHA vs origin/main, units restarted, blue/green slot | Checks · Scans on this build · Incidents |
| Key | `/admin/keys/:prefix` | customer, scopes, last used (time + IP), calls/day | Activity · Rotate/Revoke (step-up) |
| Incident | `/admin/incidents/:id` | opened by (check id), duration | Timeline · Post-incident |

Every row and timeline entry links into one of these. Tabs are `?tab=`; finding rows anchor `#fp=`.

## B. Design system

**Two themes, one structure.** Both themes use the same surfaces in the same places: the rail is the page surface, not a dark slab, so white and black read as one console. Tokens carry identical names:

| Token | White | Black |
|---|---|---|
| `--bg` / `--surface` / `--surface-2` (sunken) | #FFFFFF / #FFFFFF / #F6F7F8 | #000000 / #0A0A0B / #121315 |
| `--line` / `--line-strong` | #E6E8EB / #C9CDD2 | #232529 / #363940 |
| `--ink-1` / `--ink-2` / `--ink-3` / `--ink-off` | #0B0F14 / #4B5563 / #8A929B / #B4BAC2 | #F2F3F5 / #A6ADB5 / #6F767E / #4B5158 |
| `--accent` / `--accent-soft` | #0F766E / rgba(15,118,110,.10) | #2DD4BF / rgba(45,212,191,.12) |
| `--focus` | 2px solid `--accent`, 2px offset | same |

No warning/danger tokens exist. Primary buttons are `--ink-1` on `--bg`; secondary are outlined `--line-strong`; destructive verbs use the same ink button behind step-up and a typed confirmation, never a colour.

**Type.** Geist 400/500/600 only. Scale 12 / 13 / 14 / 16 / 20 / 24, line-height 1.45 body, 1.2 headings. Geist Mono 12–13 for ids, SHAs, fingerprints, money and counts (`font-variant-numeric: tabular-nums`, right-aligned). Ids are middle-truncated with a copy affordance on hover and a full value in `title`.

**Spacing and density.** 4px base; page gutter 24 (16 at phone). `data-density="comfortable"` rows 40px, `compact` 28px; toggle is per user (`D`), persisted in localStorage.

**Mark set** (shape + weight + label; colour is never the only cue). Blocker ■ filled square, label weight 600 and a 2px `--ink-1` left rule on the row · High ◆ filled diamond · Medium ◐ half-filled circle · Low ○ hollow circle, `--ink-3` · Pass ● filled circle in `--accent` (the only accented mark) · Not run ◌ dashed outline. Panel-level status uses words: "OK", "Failed", "Cannot tell".

**Three states per data panel.** `ok` renders data; `failed` replaces the body with a 2px left-ruled block "Failed — {reason}" + Retry + the endpoint name; `cannot tell` uses a dashed panel border and "Cannot tell — {what was unreachable}". Enforced by one `<Panel state>` primitive and one `useAdminFetch` (checks `res.ok`, parses `{checked:false, reason}`). An empty *successful* list shows the CLI / Action snippet that fills it. Zero renders only after a successful query, as "0 (checked 12s ago)".

**Tables.** Sticky header and first column; sort arrow in header; hover reveals row actions; `J`/`K` focus, `Enter` opens the object, `C` copies id; relative time with absolute on hover; sparkline column where a trend exists.

**Charts without hue.** Primary series `--ink-1` solid; comparison `--ink-3` dashed; "not run" hatched pattern; blocked shown as solid, passed as outlined bars; deploy and commit ticks are dashed verticals labelled with a mono SHA. Tooltips are text, not colour.

**Motion.** Panels and palette 120 ms ease-out; tables 0 ms; `prefers-reduced-motion` disables all; no shimmer — a "Loading · 0.8 s" mono counter makes a hang visible.

## C. Per area — the upgrade and what it removes

- **Overview.** Headline is the gate verdict for the range ("Gate held: 14 merges blocked · 312 findings passed on new code · 9 modules not run"), every count new-code vs overall, every tile a filtered link. Single-box readiness strip (units, disk, queue depth, deployed SHA vs main). Removes: false "present" (key by catalogue id), worker "Healthy" without activity → *Cannot tell*, real-looking zeros on missing tables → *Failed*, "Not ready" now lists reasons, revenue relabelled "Billed (scans)" until Stripe is the source, second stats query deleted.
- **Scans & findings.** One list, kinds as filters, paging, URL state. Scan page: verdict from the real result (never "PASSED" on `!res.ok`), real progress from the queue rows, PR batching becomes explicit fix PR objects with every URL kept. **Not checked tab**: registry minus `modules_run`, each with a reason (tier, missing secret, language absent, timeout, disabled) and what it would have caught. Finding page carries lifecycle across commits and reopens on regression. Removes: fake terminal, "41 modules", lost PR urls, 429→"No fixes", duplicated snippet renderer (one component).
- **Watchdog.** Each watch is an object: uptime math, drift timeline with deploy ticks, "stale" when last success predates the schedule. Tick is a job with an outcome. Removes: 401 tick + "checked undefined", failed scan → "No issues", DB failure → "No watches", N+1 repos call (paged).
- **Pipeline trace** → Scan › Trace: waterfall webhook → queue → clone → modules → fix → check-run with duration, exit reason and cost per bar; range-select filters logs; stream reconnects with backoff and shows "Reconnecting (attempt 3)"; DB unset → dashed "Cannot tell", never a live dot.
- **Triage** → Findings › For review: keyboard verdicts (`S`), required reason for FP/accept, "apply to all matching fingerprints in org"; each verdict feeds rule precision. Fleet panel moves to Overview with honest "table missing". Removes the second skeleton copy.
- **Health & incidents.** Check ids come from one catalogue (fixes `github`/`gluecron`); a failed check opens an incident object with timeline; button state "Not run yet"; env list from env-catalogue; one "Ready" definition shared with Overview.
- **Customers & revenue.** Customer page timeline merges Stripe events, scans, gate blocks, fix PRs, feedback; MRR and failed payments from Stripe; margin per scan; refund/credit/email as Stripe deep links (admin never moves money). Removes: "No customers yet" on failure, silent LIMIT 100, two revenue sources.
- **Keys & integrations.** Key object: prefix, created by, scopes, last used, calls/day, "unused 30 days"; issue/rotate/revoke behind step-up. Integrations: per integration last webhook and failure rate; accounts route fixed to the session cookie; sibling counted healthy only with an explicit field; event store read failure → Failed. Removes "Loading…" forever, `confirm()`.
- **Secrets.** Keep the branch's honest states; add age-since-rotation, consuming units, leak-scan sightings; `out_of_sync` is pending, not failure.
- **Audit & compliance.** One unified audit (`actor · action · resource → link`), filters, CSV; chain verify throw → *Cannot tell*; controls carry evidence from gate decisions; HTTPS evidence names the real proxy.
- **Rules (learning/precision).** Precision per rule with trend, kill list below floor, fix-PR outcome per rule; refresh errors in a Failed block, never the success box.
- **Launch.** Pinned checklist; polling keyed by draft id; honest states.

## D. Global patterns

- **Cmd-K / `/`.** Search by id prefix, SHA, email, repo, fingerprint, rule id; results grouped by entity; verbs ("New scan", "Go to…", "Toggle theme", "Density"). Paste a SHA → the deploy and the scans on it.
- **Keyboard.** `G` then `O S F W C P A L`; `J K Enter C`; `S` verdict; `T` theme; `D` density; `?` map.
- **Saved views.** URL is the state; "Save view" stores name → URL per user, one shared default per list.
- **Deep links.** Every object, tab, filter and finding row; the topbar shows the path with copy.

## E. First wave (each ≤ 400 lines, independently shippable)

1. **Shell + tokens** — rail groups, two themes with identical structure, banned hues removed, density attr. Proof: both-theme screenshots; grep for red/amber hex returns 0; toggle persists across reload; `aria-current` on the active link.
2. **Panel primitive + `useAdminFetch`** — three states, `res.ok`, `{checked:false}` parsing. Proof: force 503 on `/api/admin/overview` → panel says "Failed", no zero anywhere; journey asserts text.
3. **`/admin/scans` list** — filters in URL, paging. Proof: reload keeps filters; stats 500 → "Failed", not "No scans".
4. **`/admin/scans/:id`** — header, Findings tab with marks, verdict from real result. Proof: a failed scan reads "Failed", marks by shape in both themes.
5. **Not-checked tab** — registry diff with reasons. Proof: count equals registry − `modules_run`; every row has a reason.
6. **Finding fingerprint + lifecycle** — per-finding fingerprint (rule + path-ext + pattern hash + normalised snippet), first/last seen, status transitions. Proof: rescan after a line move keeps the fingerprint; fixed then reappeared → "Regressed".
7. **Cmd-K + G-keys.** Proof: paste SHA → deploy; type email → customer; `G S` opens scans.
8. **`/admin/customers/:id`** — timeline from scans, keys, Stripe events. Proof: Stripe unreachable → Billing "Cannot tell", timeline still renders scans.
9. **Health ids + deploy object** — catalogue ids, `/admin/deploys/:sha`, stale = SHA ≠ main. Proof: git-host failure shows a row; deployed == main is never "stale".
10. **Rules + precision** — verdicts write precision. Proof: mark FP → rule precision drops on next load.
11. **Unified audit** — list, filters, CSV link, chain verify. Proof: verify throw → "Cannot tell".
12. **Key object + step-up** — last used, revoke with step-up. Proof: GET 503 → "Failed"; revoke without step-up refused.
