import type { Metadata } from "next";
import Link from "next/link";
import { contentMetadata, breadcrumbSchema, jsonLd } from "../lib/seo/schema";
import incidentsData from "../data/incidents.json";
import { Hero, Section, Card } from "../components/v2";
import { getPublicStatus, PUBLIC_STATUS_TTL_SECONDS } from "../lib/public-status-collect";
import type { ComponentState, OverallState, PublicStatus } from "../lib/public-status-collect";
import { NonceScript } from "@/app/lib/seo/NonceScript";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { recentIncidents, INCIDENT_WINDOW_DAYS } = require("../lib/public-status") as {
  recentIncidents: (data: unknown, now?: number) => Incident[];
  INCIDENT_WINDOW_DAYS: number;
};

// Every state on this page is derived from a probe that already runs —
// /api/status, the build stamp, the scan queue, a reachability check of the
// hosted MCP endpoint — through the pure mapper in app/lib/public-status.js.
// Nothing here is typed by hand; the incident list is the one human-written
// record, and tests/public-status.test.js validates its shape.

export const metadata: Metadata = contentMetadata({
  title: "GateTest Status",
  description:
    "Live health of every GateTest surface — website, hosted scans, scan worker, GitHub App webhooks, API, hosted MCP endpoint and payments — with the running build and the last 14 days of incidents. Derived from the probes that already run; nothing typed by hand.",
  path: "/status",
  keywords: ["gatetest status", "gatetest uptime", "is gatetest down"],
});

// Live data — never prerender a status page.
export const dynamic = "force-dynamic";

type Incident = {
  date: string;
  title: string;
  components: string[];
  impact: "none" | "minor" | "major";
  resolved: boolean;
  summary: string;
};

// Semantic colours are the status vocabulary — deliberately NOT the accent,
// so "operational" reads as a state, not as a brand highlight.
const STATE_STYLE: Record<ComponentState, { pill: string; dot: string; label: string }> = {
  operational: { pill: "bg-success/10 text-success border-success/30", dot: "bg-success", label: "Operational" },
  degraded: { pill: "bg-warning/10 text-warning border-warning/30", dot: "bg-warning", label: "Degraded" },
  down: { pill: "bg-danger/10 text-danger border-danger/30", dot: "bg-danger", label: "Down" },
  unknown: { pill: "bg-surface-light text-muted border-border", dot: "bg-muted", label: "Not verified" },
};

const OVERALL_STYLE: Record<OverallState, { band: string; dot: string }> = {
  operational: { band: "border-success/40 bg-success/10 text-success", dot: "bg-success" },
  partial: { band: "border-warning/40 bg-warning/10 text-warning", dot: "bg-warning" },
  major: { band: "border-danger/40 bg-danger/10 text-danger", dot: "bg-danger" },
  unknown: { band: "border-border bg-surface-light text-muted", dot: "bg-muted" },
};

const IMPACT_LABEL: Record<Incident["impact"], string> = {
  none: "No customer impact",
  minor: "Minor impact",
  major: "Major impact",
};

function StatePill({ state }: { state: ComponentState }) {
  const s = STATE_STYLE[state] ?? STATE_STYLE.unknown;
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium whitespace-nowrap ${s.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden="true" />
      {s.label}
    </span>
  );
}

function secondsSince(iso: string, now: number): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.round((now - t) / 1000));
}

function formatWhen(iso: string | null): string {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  return new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// The data step, kept out of the component body: it reads the clock once, so
// "checked N s ago" and the incident window agree on what "now" is.
async function loadStatusView(): Promise<{ status: PublicStatus; checkedAgo: number; incidents: Incident[] }> {
  const status = await getPublicStatus();
  const now = Date.now();
  return {
    status,
    checkedAgo: secondsSince(status.checkedAt, now),
    incidents: recentIncidents(incidentsData, now),
  };
}

export default async function StatusPage() {
  const { status, checkedAgo, incidents } = await loadStatusView();
  const overall = OVERALL_STYLE[status.overall] ?? OVERALL_STYLE.unknown;
  const unverified = status.components.filter((c) => c.state === "unknown").length;

  return (
    <main>
      <NonceScript
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(breadcrumbSchema([{ name: "GateTest", path: "/" }, { name: "Status" }])),
        }}
      />

      <Section wrap={false}>
        <div className="v2-wrap">
          <Hero
            kicker="Live"
            title="GateTest status"
            lede={
              <>
                Whether each surface is up right now, and what happened recently. Every state on this page
                is read from a probe that already runs against production — nothing is typed by hand, and a
                surface we cannot verify says so instead of showing green.
              </>
            }
            actions={
              <a href="/api/status/public" className="v2-btn">JSON &rarr;</a>
            }
          />
        </div>
      </Section>

      <Section>
        {/* Overall banner */}
        <div
          role="status"
          aria-live="polite"
          className={`flex flex-col gap-2 rounded-xl border px-5 py-4 sm:flex-row sm:items-center sm:justify-between ${overall.band}`}
        >
          <p className="flex items-center gap-3 text-base font-semibold">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${overall.dot}`} aria-hidden="true" />
            {status.headline}
          </p>
          <p className="text-xs font-mono text-foreground-secondary tabular-nums">
            checked {checkedAgo}s ago · refreshes every {PUBLIC_STATUS_TTL_SECONDS}s
          </p>
        </div>

        {/* Components */}
        <section className="mt-10" aria-labelledby="components-heading">
          <h2 id="components-heading" className="text-xs font-mono uppercase tracking-[0.13em] text-accent mb-4">
            Components
          </h2>
          <ul className="divide-y divide-border rounded-xl border border-border bg-[var(--surface-solid)]">
            {status.components.map((c) => (
              <li key={c.name} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="min-w-0">
                  <h3 className="font-medium text-foreground">{c.name}</h3>
                  <p className="mt-1 text-sm text-foreground-secondary leading-relaxed">{c.detail}</p>
                </div>
                <div className="shrink-0 sm:pt-0.5">
                  <StatePill state={c.state} />
                </div>
              </li>
            ))}
          </ul>
          {unverified > 0 && (
            <p className="mt-3 text-xs text-muted max-w-[66ch] leading-relaxed">
              &ldquo;Not verified&rdquo; means the probe behind that row could not complete within its time
              budget just now — it is neither a pass nor a failure, and it is never shown as green.
            </p>
          )}
        </section>

        {/* Build */}
        <section className="mt-10" aria-labelledby="build-heading">
          <h2 id="build-heading" className="text-xs font-mono uppercase tracking-[0.13em] text-accent mb-4">
            Running build
          </h2>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card as="div">
              <dt className="text-xs text-[var(--v2-muted)]">Version</dt>
              <dd className="mt-1 v2-mono text-sm text-[var(--v2-fg)] tabular-nums">v{status.version}</dd>
            </Card>
            <Card as="div">
              <dt className="text-xs text-[var(--v2-muted)]">Commit</dt>
              <dd className="mt-1 v2-mono text-sm text-[var(--v2-fg)]">{status.commit}</dd>
            </Card>
            <Card as="div">
              <dt className="text-xs text-[var(--v2-muted)]">Built</dt>
              <dd className="mt-1 v2-mono text-sm text-[var(--v2-fg)] tabular-nums">{formatWhen(status.builtAt)}</dd>
            </Card>
          </dl>
        </section>

        {/* Incidents */}
        <section className="mt-10" aria-labelledby="incidents-heading">
          <h2 id="incidents-heading" className="text-xs font-mono uppercase tracking-[0.13em] text-accent mb-4">
            Incidents — last {INCIDENT_WINDOW_DAYS} days
          </h2>
          {incidents.length === 0 ? (
            <p className="text-sm text-foreground-secondary">No incidents in the last {INCIDENT_WINDOW_DAYS} days.</p>
          ) : (
            <ol className="space-y-4">
              {incidents.map((inc) => (
                <Card key={`${inc.date}-${inc.title}`} as="li">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
                    <h3 className="font-medium text-[var(--v2-fg)]">{inc.title}</h3>
                    <time dateTime={inc.date} className="v2-mono text-xs text-[var(--v2-muted)] tabular-nums">
                      {inc.date.slice(0, 10)}
                    </time>
                  </div>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--v2-muted)]">
                    <span>{IMPACT_LABEL[inc.impact] ?? "Impact unknown"}</span>
                    <span>{inc.resolved ? "Resolved" : "Ongoing"}</span>
                    {inc.components.length > 0 && <span>Affected: {inc.components.join(", ")}</span>}
                  </p>
                  <p className="mt-3 text-sm text-[var(--v2-muted)] leading-relaxed">{inc.summary}</p>
                </Card>
              ))}
            </ol>
          )}
        </section>

        <section className="mt-12 text-sm text-muted max-w-[66ch] leading-relaxed space-y-3">
          <p>
            How this page is produced: the configuration readiness probe, the build stamp, the scan queue
            and a reachability check of the hosted MCP endpoint are read every {PUBLIC_STATUS_TTL_SECONDS}{" "}
            seconds and mapped to four states. The mapping is a pure function with its own tests, including
            one that feeds it hostile input and asserts no internal name reaches this page.
          </p>
          <p>
            Something wrong that this page does not show?{" "}
            <Link href="/trust" className="text-[var(--v2-accent)] hover:underline">
              Trust &amp; security &rarr;
            </Link>{" "}
            <Link href="/changelog" className="text-[var(--v2-accent)] hover:underline">
              What shipped recently &rarr;
            </Link>
          </p>
        </section>
      </Section>
    </main>
  );
}
