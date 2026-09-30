# GateTest admin audit — 02 benchmark (2026-09-30)

Benchmarked against Datadog (incl. Synthetics), Checkly, Playwright trace viewer, Snyk, Sentry,
SonarQube/SonarCloud, Lighthouse CI server, Stripe Dashboard/Workbench, Linear, Vercel, PostHog,
Semgrep. Sources are official docs (URLs inline); extracts, not screenshots.

## Per area — table stakes / where GateTest can lead

1. **Overview** — stakes: one global time range; filter chips that drive every widget, saved as
   named views (Datadog template variables); every tile deep-links to the filtered list; PDF export
   (Semgrep). Lead: the headline is the gate verdict ("gate held: N merges blocked, N findings
   passed on new code, N modules not run"); every count split new-code vs overall (Sonar Clean as
   You Code).
2. **Scans & findings** — stakes: issue tabs Unresolved / For review / Regressed / Archived /
   Escalating + saved shareable views (Sentry); Open / Accepted / False positive with history,
   accepted & FP excluded from ratings (Sonar); expiring ignores (Snyk); per-project scan history
   with snapshot compare (Snyk, LHCI); CSV + API export; deep link to one finding. Lead: finding
   fingerprint stable across line moves (SARIF partialFingerprints) → finding lifecycle (first
   seen / suspect commit / fixed / regressed); scan-to-base compare (added / removed / unchanged,
   module timing deltas); **"What was not checked" as a first-class tab on every scan**; accepted
   findings reopen automatically when the rule's count worsens (Sentry archive-until-escalating).
3. **Watchdog** — stakes: per-monitor page (Activity / Runs / Performance / Properties), uptime
   graph, per-location results (Datadog); public dashboards (Checkly); explicit uptime math
   (degraded/maintenance don't count). Lead: drift timeline per watched site/repo with deploy and
   commit ticks; "stale" = last success older than schedule (silent stop ≠ failing).
4. **Pipeline trace** — stakes: Playwright trace viewer (action list with durations, draggable
   timeline filtering network/console, before/after snapshots). Lead: one-scan waterfall
   (webhook → queue → clone → 122 modules → AI/fix → check-run) with duration, exit reason and
   cost per bar; range-select filters logs; linked from scan, fix PR and customer.
5. **Triage** — stakes: For-review queue, assignee, bulk status, keyboard (S status, G+letter,
   Cmd-K) (Linear); required reason for FP/accept. Lead: each verdict is training data for
   precision (§11); "apply to all matching fingerprints in this org".
6. **Health & incidents** — stakes: incident page Overview / Timeline / Post-incident, one-click
   postmortem draft (Datadog); status history per dependency. Lead: single-box readiness strip
   (systemd units, disk, queue depth, deployed SHA vs origin/main); every red→green transition is
   an automatic timeline entry.
7. **Customers & revenue** — stakes: Stripe MRR & subscriber roll-forward with churn definition;
   object inspector (JSON + request log + related events, Stripe Workbench); person timeline
   (PostHog). Lead: margin per scan (price vs compute seconds + model spend) per customer and
   plan; customer timeline merging Stripe events, scans, gate blocks, fix PRs and feedback.
8. **Keys & integrations** — stakes: partial key prefix, created by, last used (time + IP),
   scopes, expiry, rotate; activity log (Vercel). Lead: calls per key per day, "unused 30 days —
   safe to revoke"; per integration last webhook received + delivery failure rate.
9. **Secrets** — stakes: write-only sensitive values, redacted logs naming key + deployment only
   (Vercel); owner-only audit. Lead: age since rotation and consuming units per secret; "last seen
   in a leak scan" (the estate scanning itself — cf. the Resend key incident).
10. **Audit & compliance** — stakes: immutable log (actor, role, event, time), filter, export,
    SIEM-pollable API; audit side panel following the current page (PostHog). Lead: evidence
    pack per control generated from gate decisions ("every merge to main in Q3 passed or was
    overridden by X") → the SOC 2 evidence-feed product.
11. **Telemetry / learning** — stakes: time-to-resolve distributions, weekly trends (Snyk);
    high-confidence filter (Semgrep). Lead: precision per rule (FP ÷ triaged) by rule / language
    / repo with trend; kill list below a precision floor; fix-PR outcome per rule (merged /
    closed / reverted / time-to-merge / fingerprint came back).

## Information architecture
- Left rail of 6–7 groups instead of ~18 flat tabs: Overview · Scans (repo / server / nuclear /
  trace as filters of one list) · Findings & Triage · Watchdog · Customers & Revenue · Platform
  (keys, integrations, secrets, health) · Governance (audit, compliance, learning). Launch prep
  becomes a pinned checklist.
- Entity pages with stable URLs: customer, repo, scan, finding (by fingerprint), rule, fix PR —
  each with header, related entities, timeline (Sentry release page, Stripe inspector).
- Cmd-K palette searching entities by id or pasted SHA; G+letter navigation (Linear, PostHog).
- Saved views per user or shared default (Linear display options).
- Density toggle: compact ≈28px rows / comfortable ≈40px, per user (Datadog high density).
- Empty states show the exact CLI/Action snippet or the button that fills the view.

## Visual craft — light and dark, identical structure
- Status without red/orange/yellow: three of four cues (colour, shape, symbol, text) per Carbon.

  | Status | Mark | Label |
  |---|---|---|
  | Blocker | filled square, weight 600, optional 2px left row bar | Blocker |
  | High | filled diamond | High |
  | Medium | half-filled circle | Medium |
  | Low | hollow circle, muted ink | Low |
  | Pass | filled circle (the one accent) | Pass |
  | Not run | dashed-outline circle | Not run |

- Three ink levels (primary / secondary / disabled); dark mode keeps the same contrast steps.
- Type scale 12 / 13 / 14 / 16 / 20 / 24; 13px table body; tabular, right-aligned numbers; mono
  for SHAs, rule ids, fingerprints, middle-truncated with copy on hover.
- Tables: sticky header and first column, sort indicator, hover actions, J/K row focus,
  sparkline columns, relative time with absolute on hover.
- Charts: series by dash pattern and marker shape, not hue; deploy/commit ticks.

## Top 5 to build first (benchmark view)
1. Finding fingerprint + lifecycle. 2. "Not checked" coverage view. 3. Precision per rule from
triage. 4. Scan waterfall trace. 5. Cmd-K palette with entity pages.
