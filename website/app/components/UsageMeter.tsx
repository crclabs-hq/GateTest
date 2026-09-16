"use client";

/**
 * <UsageMeter> — the customer's usage report, rendered.
 *
 * Takes the GET /api/v1/usage body (also served to the signed-in dashboard
 * by /api/dashboard/usage) and shows, for the window: totals, BYOK versus
 * metered spend side by side, a per-day list, a per-surface table and the
 * most recent runs. Every number is one the ledger produced — money was
 * summed as integer micro-dollars there and converted once at the edge;
 * this component formats, it never adds.
 *
 * Empty state: an account with no events in the window reads "No usage
 * recorded yet" — never a grid of $0.00 tiles that looks like a bill.
 * Consumers must NOT render this component for a failed or unavailable
 * read; that is a "not checked" state and it is theirs to show.
 */

export interface UsageSummary {
  window: { from: string; to: string };
  events: number;
  scans: number;
  fixes: number;
  modulesRun: number;
  findingsTotal: number;
  findingsBlocking: number;
  aiCalls: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  usdEstimated: number;
  usdGatetestPaid: number;
  usdByok: number;
  byokEvents: number;
}

export interface UsageDay {
  day: string;
  events: number;
  aiCalls: number;
  tokensIn: number;
  tokensOut: number;
  usdEstimated: number;
  findingsTotal: number;
}

export interface UsageSurface {
  events: number;
  modulesRun: number;
  findingsTotal: number;
  findingsBlocking: number;
  aiCalls: number;
  tokensIn: number;
  tokensOut: number;
  usdEstimated: number;
  usdByok: number;
  byokEvents: number;
}

export interface UsageEvent {
  id: number | null;
  occurredAt: string | null;
  surface: string;
  repo: string | null;
  suite: string | null;
  tier: string | null;
  scanId: string | null;
  modulesRun: number;
  findingsTotal: number;
  findingsBlocking: number;
  aiCalls: number;
  tokensIn: number;
  tokensOut: number;
  usdEstimated: number;
  keyOwner: "byok" | "gatetest";
  modelTier: string | null;
}

export interface UsageReport {
  summary: UsageSummary;
  series: UsageDay[];
  bySurface: Record<string, UsageSurface>;
  recent: UsageEvent[];
  nextCursor: number | null;
}

// ---------------------------------------------------------------------------
// Formatting — presentation only. USD arrives already converted from the
// ledger's integer micro-dollars; it is re-expressed as an integer here so
// the string is exact and a sub-cent estimate is not rounded to "$0.00".
// ---------------------------------------------------------------------------

export function formatUsd(usd: number | null | undefined): string {
  const n = Number(usd);
  const micros = Number.isFinite(n) && n > 0 ? Math.round(n * 1e6) : 0;
  if (micros === 0) return "$0.00";
  const dollars = Math.floor(micros / 1e6);
  const rest = micros % 1e6;
  const dollarStr = dollars.toLocaleString("en-US");
  if (rest % 10000 === 0) return `$${dollarStr}.${String(rest / 10000).padStart(2, "0")}`;
  return `$${dollarStr}.${String(Math.round(rest / 100)).padStart(4, "0")}`;
}

export function formatInt(n: number | null | undefined): string {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "—";
}

function dayOf(iso: string | null | undefined): string {
  return typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "—";
}

function whenOf(iso: string | null | undefined): string {
  if (typeof iso !== "string") return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso.slice(0, 16);
  return t.toISOString().slice(0, 16).replace("T", " ");
}

const SURFACE_LABEL: Record<string, string> = {
  web: "Website scan",
  "hosted-fix": "Hosted fix",
  push: "Push scan (GitHub App / Gluecron)",
  api: "REST API",
  mcp: "MCP",
  cli: "CLI",
  vscode: "Editor",
  action: "GitHub Action",
};

function surfaceLabel(name: string): string {
  return SURFACE_LABEL[name] || name;
}

// BYOK and metered are the two states of "who paid for the model call".
// Semantic, not accent: a label, not a brand highlight.
const KEY_PILL: Record<UsageEvent["keyOwner"], { pill: string; label: string }> = {
  byok: { pill: "bg-success/10 text-success border-success/30", label: "BYOK" },
  gatetest: { pill: "bg-surface-light text-muted border-border", label: "Metered" },
};

function KeyPill({ owner }: { owner: UsageEvent["keyOwner"] }) {
  const s = KEY_PILL[owner] || KEY_PILL.gatetest;
  return (
    <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border ${s.pill}`}>
      {s.label}
    </span>
  );
}

function Tile({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="card p-4 text-center">
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-xs text-muted">{label}</p>
      {sub && <p className="text-[11px] text-muted mt-0.5">{sub}</p>}
    </div>
  );
}

const TH = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted";
const TD = "px-3 py-2 text-sm";
const NUM = "text-right tabular-nums";

export default function UsageMeter({ report }: { report: UsageReport }) {
  const s = report.summary;
  const windowLabel = `${dayOf(s.window?.from)} → ${dayOf(s.window?.to)} (UTC)`;
  const events = Number(s.events) || 0;

  if (events === 0) {
    return (
      <div className="card p-12 text-center">
        <p className="text-lg font-bold mb-2">No usage recorded yet</p>
        <p className="text-muted text-sm max-w-md mx-auto">
          Nothing ran under this account between {windowLabel}. Scans and fixes you run on any
          surface — website, CLI, GitHub Action, MCP, editor — appear here once they finish,
          whether they used your own model API key (BYOK) or a GateTest key.
        </p>
      </div>
    );
  }

  const byok = Number(s.byokEvents) || 0;
  const metered = events - byok;
  const surfaces = Object.entries(report.bySurface || {}).sort((a, b) => (b[1].events || 0) - (a[1].events || 0));
  const activeDays = (report.series || []).filter((d) => (Number(d.events) || 0) > 0);
  const quietDays = (report.series || []).length - activeDays.length;
  const maxDayMicros = Math.max(1, ...activeDays.map((d) => Math.round((Number(d.usdEstimated) || 0) * 1e6)));
  const recent = report.recent || [];

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted">
        Window <span className="font-mono text-foreground">{windowLabel}</span> · {formatInt(events)} run
        {events === 1 ? "" : "s"} recorded
      </p>

      {/* Totals */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Tile value={formatInt(s.scans)} label="Scans" sub={`${formatInt(s.modulesRun)} modules run`} />
        <Tile value={formatInt(s.fixes)} label="Fixes" sub={`${formatInt(s.aiCalls)} AI calls`} />
        <Tile value={formatInt(s.findingsTotal)} label="Findings" sub={`${formatInt(s.findingsBlocking)} blocking`} />
        <Tile
          value={formatInt(s.tokensTotal)}
          label="AI tokens"
          sub={`${formatInt(s.tokensIn)} in · ${formatInt(s.tokensOut)} out`}
        />
      </div>

      {/* BYOK vs metered — the split the customer asked for */}
      <section className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
          <h2 className="text-base font-bold">Estimated cost</h2>
          <p className="text-2xl font-bold tabular-nums">{formatUsd(s.usdEstimated)}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-xl border border-success/30 bg-success/5 p-4">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-sm font-semibold">BYOK — your own model API key</span>
              <KeyPill owner="byok" />
            </div>
            <p className="text-xl font-bold tabular-nums">{formatUsd(s.usdByok)}</p>
            <p className="text-xs text-muted">
              {formatInt(byok)} run{byok === 1 ? "" : "s"} · billed by your model provider, recorded here so you can see it
            </p>
          </div>
          <div className="rounded-xl border border-border bg-[var(--background-alt)] p-4">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-sm font-semibold">Metered — GateTest key</span>
              <KeyPill owner="gatetest" />
            </div>
            <p className="text-xl font-bold tabular-nums">{formatUsd(s.usdGatetestPaid)}</p>
            <p className="text-xs text-muted">
              {formatInt(metered)} run{metered === 1 ? "" : "s"} · AI usage on a key GateTest provided
            </p>
          </div>
        </div>
        <p className="text-[11px] text-muted mt-3">
          Estimates are derived from the token counts each run recorded. This page is a meter, not an invoice.
        </p>
      </section>

      {/* Per day */}
      {activeDays.length > 0 && (
        <section>
          <h2 className="text-base font-bold mb-3">
            By day{" "}
            <span className="text-sm font-normal text-muted">
              · {activeDays.length} active day{activeDays.length === 1 ? "" : "s"}
              {quietDays > 0 ? `, ${quietDays} quiet` : ""}
            </span>
          </h2>
          <div className="card overflow-hidden">
            <ul className="divide-y divide-border">
              {[...activeDays].reverse().map((d) => {
                const micros = Math.round((Number(d.usdEstimated) || 0) * 1e6);
                const pct = Math.max(2, Math.round((micros / maxDayMicros) * 100));
                return (
                  <li key={d.day} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                      <span className="font-mono w-24">{d.day}</span>
                      <span className="text-muted">
                        {formatInt(d.events)} run{d.events === 1 ? "" : "s"}
                      </span>
                      <span className="text-muted">{formatInt(d.findingsTotal)} findings</span>
                      <span className="text-muted">{formatInt(d.tokensIn + d.tokensOut)} tokens</span>
                      <span className={`ml-auto font-semibold ${NUM}`}>{formatUsd(d.usdEstimated)}</span>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-[var(--background-alt)] overflow-hidden" aria-hidden="true">
                      <div className="h-full rounded-full bg-accent/70" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}

      {/* Per surface */}
      {surfaces.length > 0 && (
        <section>
          <h2 className="text-base font-bold mb-3">By surface</h2>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead className="border-b border-border">
                <tr>
                  <th className={TH}>Surface</th>
                  <th className={`${TH} text-right`}>Runs</th>
                  <th className={`${TH} text-right`}>Findings</th>
                  <th className={`${TH} text-right`}>AI calls</th>
                  <th className={`${TH} text-right`}>Tokens</th>
                  <th className={`${TH} text-right`}>Cost</th>
                  <th className={`${TH} text-right`}>BYOK runs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {surfaces.map(([name, v]) => (
                  <tr key={name}>
                    <td className={TD}>
                      <span className="font-medium">{surfaceLabel(name)}</span>
                      <span className="ml-2 font-mono text-xs text-muted">{name}</span>
                    </td>
                    <td className={`${TD} ${NUM}`}>{formatInt(v.events)}</td>
                    <td className={`${TD} ${NUM}`}>{formatInt(v.findingsTotal)}</td>
                    <td className={`${TD} ${NUM}`}>{formatInt(v.aiCalls)}</td>
                    <td className={`${TD} ${NUM}`}>{formatInt(v.tokensIn + v.tokensOut)}</td>
                    <td className={`${TD} ${NUM} font-semibold`}>{formatUsd(v.usdEstimated)}</td>
                    <td className={`${TD} ${NUM}`}>{formatInt(v.byokEvents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Recent runs */}
      {recent.length > 0 && (
        <section>
          <h2 className="text-base font-bold mb-3">
            Recent runs{" "}
            <span className="text-sm font-normal text-muted">
              · newest first, {recent.length} shown{report.nextCursor != null ? ", more in the window" : ""}
            </span>
          </h2>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead className="border-b border-border">
                <tr>
                  <th className={TH}>When (UTC)</th>
                  <th className={TH}>Surface</th>
                  <th className={TH}>Repo</th>
                  <th className={TH}>Suite</th>
                  <th className={`${TH} text-right`}>Findings</th>
                  <th className={`${TH} text-right`}>AI calls</th>
                  <th className={`${TH} text-right`}>Tokens</th>
                  <th className={`${TH} text-right`}>Cost</th>
                  <th className={TH}>Key</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recent.map((e, i) => (
                  <tr key={e.id ?? `${e.occurredAt}-${i}`}>
                    <td className={`${TD} font-mono text-xs`}>{whenOf(e.occurredAt)}</td>
                    <td className={TD}>{surfaceLabel(e.surface)}</td>
                    <td className={`${TD} font-mono text-xs`}>{e.repo || "—"}</td>
                    <td className={TD}>{e.suite || e.tier || "—"}</td>
                    <td className={`${TD} ${NUM}`}>{formatInt(e.findingsTotal)}</td>
                    <td className={`${TD} ${NUM}`}>{formatInt(e.aiCalls)}</td>
                    <td className={`${TD} ${NUM}`}>{formatInt(e.tokensIn + e.tokensOut)}</td>
                    <td className={`${TD} ${NUM} font-semibold`}>{formatUsd(e.usdEstimated)}</td>
                    <td className={TD}>
                      <KeyPill owner={e.keyOwner} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
