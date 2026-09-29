/**
 * Composite readiness — GET /api/health/deep (issue #809)
 *
 * The neighbours answer a different question each:
 *   - /api/health          bare liveness for the container HEALTHCHECK — a
 *                          constant body, by design; it must never touch a
 *                          dependency or the orchestrator restarts a healthy
 *                          web process when the database blips.
 *   - /api/v1/health       the locked partner liveness shape.
 *   - /api/status          operator readiness: variable names (gated).
 *   - /api/status/public   the customer status page in machine form.
 * None of them could go red through a dead database, a silent queue or a
 * rejected AI key (the AlecRae page of 2026-09-28: a monitor read green
 * through all three). This one can: five sub-checks — db, queue, ai, mail,
 * runtime — each with a status, its latency and a reason; overall
 * `ok` / `status`; HTTP 503 when a REQUIRED check is down, 200 otherwise.
 * The verdict rules live in app/lib/health-composite.js (pure, tested);
 * this file only gathers the readings.
 *
 * What it never does: a live paid AI call (the `ai` reading is the last
 * successful call the usage ledger recorded); an e-mail send (the mail
 * provider is asked a read-only question); a hang (every probe runs under
 * its own ceiling, in parallel, so the answer arrives in about 2.5 s
 * worst case). Unauthenticated, so the body carries sub-check NAMES only:
 * no env var name, hostname, URL, provider or error text — every reason
 * passes the same leak guard /status uses.
 *
 * Cached 30 s (Next's data cache, the same mechanism /api/status/public
 * uses) so a monitor polling every few seconds does not multiply the
 * database reads.
 */

import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getDb } from "@/app/lib/db";

const composite = require("@/app/lib/health-composite") as {
  AI_RECENT_HOURS: number;
  HEALTH_TTL_SECONDS: number;
  runChecks: (
    probes: Record<string, () => Promise<Reading>>,
    opts: { timeouts: Record<string, number>; onTimeout: Record<string, string>; onError: Record<string, string> },
  ) => Promise<Record<string, { status: string; latencyMs: number; reason: string }>>;
  composeHealth: (results: Record<string, unknown>) => Verdict;
  httpStatusOf: (verdict: Verdict) => number;
};
const { inspectEnvValue } = require("@/app/lib/env-placeholder") as {
  inspectEnvValue: (name: string, value: string) => { ok: boolean };
};
const { getQueueStats } = require("@/app/lib/scan-queue-store") as {
  getQueueStats: (sql: unknown) => Promise<QueueStats>;
};
const publicStatus = require("@/app/lib/public-status") as {
  formatAge: (ms: number) => string;
  _mappers: {
    mapHostedScans: (queue: QueueStats) => Mapped;
    mapScanWorker: (worker: { lastActivityAt: string | null }, queue: QueueStats, now: number) => Mapped;
  };
};
const { mailProvider, mailConfigured, PLATFORM_PROVIDER } = require("@/app/lib/mail-transport") as {
  mailProvider: () => string;
  mailConfigured: () => boolean;
  PLATFORM_PROVIDER: string;
};
const { platformEnv, platformStatusUrl, platformMailUrl } = require("@/app/lib/platform-config") as {
  platformEnv: (name: string) => string | undefined;
  platformStatusUrl: () => string;
  platformMailUrl: () => string;
};
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Reading = { status: string; reason: string };
type Mapped = { state: string; detail: string };
type Verdict = { ok: boolean; status: string; checks: Record<string, unknown> };
interface QueueStats { queued: number; running: number; done: number; dead: number; oldest_queued_age_s: number | null }
type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

const DB_TIMEOUT_MS = 2000;
const HTTP_TIMEOUT_MS = 2500;

/** A variable is set when it is non-empty AND not documentation filler (the /api/status rule). */
function envSet(name: string): boolean {
  const v = process.env[name];
  if (typeof v !== "string" || v.trim().length === 0) return false;
  return inspectEnvValue(name, v).ok;
}

function missingRelation(err: unknown): boolean {
  return /does not exist/i.test(err instanceof Error ? err.message : String(err));
}

/** Read-only GET with a hard ceiling. Resolves `{ status, json }`; a network failure is status 0. */
async function probeHttp(url: string, headers?: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", headers: { accept: "application/json", ...headers }, signal: controller.signal, cache: "no-store" });
    let json: Record<string, unknown> | null = null;
    try {
      const body: unknown = await res.json();
      json = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
}

// ── Probes — each resolves { status, reason }; throws and timeouts are mapped by runChecks ──

/** db (required): one round trip. Not configured is down — nothing persists without it. */
async function probeDb(): Promise<Reading> {
  if (!envSet("DATABASE_URL")) return { status: "down", reason: "database not configured" };
  try {
    await (getDb() as unknown as Sql)`SELECT 1 AS one`;
    return { status: "ok", reason: "connected" };
  } catch {
    return { status: "down", reason: "connection failed" };
  }
}

/**
 * queue (required): the scan_queue posture through the SAME mappers the
 * status page uses (stale-queue and stale-worker ceilings have one home).
 * The worse of "hosted scans" and "scan worker" is the verdict.
 */
async function probeQueue(): Promise<Reading> {
  if (!envSet("DATABASE_URL")) return { status: "down", reason: "database not configured" };
  const sql = getDb() as unknown as Sql;
  let stats: QueueStats;
  let lastActivityAt: string | null = null;
  try {
    stats = await getQueueStats(sql);
    const rows = (await sql`SELECT MAX(GREATEST(started_at, completed_at))::text AS last_activity FROM scan_queue`) as Array<{ last_activity: string | null }>;
    lastActivityAt = Array.isArray(rows) && rows[0] ? rows[0].last_activity : null;
  } catch (err) {
    if (missingRelation(err)) return { status: "unknown", reason: "no scan queue on this deployment yet" };
    return { status: "down", reason: "queue table unreadable" };
  }
  const rank: Record<string, number> = { operational: 0, unknown: 1, degraded: 2, down: 3 };
  const toStatus: Record<string, string> = { operational: "ok", unknown: "unknown", degraded: "degraded", down: "down" };
  const scans = publicStatus._mappers.mapHostedScans(stats);
  const worker = publicStatus._mappers.mapScanWorker({ lastActivityAt }, stats, Date.now());
  const worst = (rank[worker.state] ?? 1) >= (rank[scans.state] ?? 1) ? worker : scans;
  return { status: toStatus[worst.state] ?? "unknown", reason: worst.detail };
}

/**
 * ai (required): the key must be configured (a missing one takes the review
 * and fix paths down), and the proof it works is the last successful AI call
 * the usage ledger recorded — never a live call, which would cost money on
 * every poll. No call inside the window is "unknown": a quiet day and a
 * rejected key look the same from here, and saying so is the honest answer.
 */
async function probeAi(): Promise<Reading> {
  if (!envSet("ANTHROPIC_API_KEY")) return { status: "down", reason: "AI provider key not configured" };
  if (!envSet("DATABASE_URL")) return { status: "unknown", reason: "no call ledger without a database" };
  let last: string | null = null;
  try {
    const rows = (await (getDb() as unknown as Sql)`SELECT MAX(occurred_at)::text AS last FROM usage_events WHERE ai_calls > 0`) as Array<{ last: string | null }>;
    last = Array.isArray(rows) && rows[0] ? rows[0].last : null;
  } catch (err) {
    if (missingRelation(err)) return { status: "unknown", reason: "no AI call recorded yet" };
    return { status: "unknown", reason: "call ledger unreadable" };
  }
  const t = last ? Date.parse(last) : NaN;
  if (!Number.isFinite(t)) return { status: "unknown", reason: "no AI call recorded yet" };
  const age = Date.now() - t;
  const hours = composite.AI_RECENT_HOURS;
  if (age <= hours * 3_600_000) return { status: "ok", reason: `last successful AI call ${publicStatus.formatAge(age)}` };
  return { status: "unknown", reason: `no successful AI call in the last ${hours} h (last ${publicStatus.formatAge(age)}); a quiet period and a rejected key look the same from here` };
}

/**
 * mail (optional): the configured provider is asked a read-only question —
 * the platform provider's send endpoint must answer (any non-5xx means it
 * exists and is reachable; the key is not exercised), the other provider's
 * key is checked against a list endpoint that sends nothing.
 */
async function probeMail(): Promise<Reading> {
  if (!mailConfigured()) return { status: "not-configured", reason: "no mail provider configured" };
  if (mailProvider() === PLATFORM_PROVIDER) {
    const r = await probeHttp(platformMailUrl());
    if (r.status === 0) return { status: "down", reason: "mail provider unreachable" };
    if (r.status >= 500) return { status: "down", reason: "mail provider not answering" };
    return { status: "ok", reason: "mail provider endpoint reachable; send not exercised" };
  }
  const r = await probeHttp("https://api.resend.com/domains", { authorization: `Bearer ${process.env.RESEND_API_KEY}` });
  if (r.status === 0) return { status: "down", reason: "mail provider unreachable" };
  if (r.status === 200) return { status: "ok", reason: "mail provider accepted the key" };
  if (r.status === 401 || r.status === 403) return { status: "down", reason: "mail provider rejected the key" };
  if (r.status === 429) return { status: "degraded", reason: "mail provider rate-limited the check" };
  if (r.status >= 500) return { status: "down", reason: "mail provider not answering" };
  return { status: "degraded", reason: "mail provider answered unexpectedly" };
}

/**
 * runtime (optional): the browser worker tier. Configured means the three
 * dispatch settings dispatchRuntimeScan needs are all set; reachable means
 * the platform's public status document answers and reports itself healthy.
 */
async function probeRuntime(): Promise<Reading> {
  const configured = Boolean(platformEnv("BASE_URL") && platformEnv("API_TOKEN") && platformEnv("DISPATCH_SECRET"));
  if (!configured) return { status: "not-configured", reason: "runtime worker not configured on this deployment" };
  const r = await probeHttp(platformStatusUrl());
  if (r.status === 0) return { status: "down", reason: "runtime worker platform unreachable" };
  if (r.status !== 200) return { status: "down", reason: "runtime worker platform status not answering" };
  const overall = typeof r.json?.overall === "string" ? r.json.overall.toLowerCase() : "";
  if (overall === "ok" || overall === "operational" || overall === "healthy") return { status: "ok", reason: "runtime worker platform reports healthy" };
  if (/^[a-z-]{1,24}$/.test(overall)) return { status: "degraded", reason: `runtime worker platform reports ${overall}` };
  return { status: "unknown", reason: "runtime worker platform status unreadable" };
}

const getCheckResults = unstable_cache(
  async () =>
    composite.runChecks(
      { db: probeDb, queue: probeQueue, ai: probeAi, mail: probeMail, runtime: probeRuntime },
      {
        timeouts: { db: DB_TIMEOUT_MS, queue: DB_TIMEOUT_MS, ai: DB_TIMEOUT_MS, mail: HTTP_TIMEOUT_MS, runtime: HTTP_TIMEOUT_MS },
        // A database that does not answer in time IS down for readiness; a
        // ledger or a remote status document that does not is unverified.
        onTimeout: { db: "down", queue: "down", ai: "unknown", mail: "down", runtime: "down" },
        onError: { db: "down", queue: "down", ai: "unknown", mail: "down", runtime: "down" },
      },
    ),
  ["health-deep-v1"],
  { revalidate: composite.HEALTH_TTL_SECONDS },
);

const TTL = composite.HEALTH_TTL_SECONDS;
const HEADERS = {
  "cache-control": `public, max-age=${TTL}, s-maxage=${TTL}`,
  "access-control-allow-origin": "*",
};

// auth-public — a readiness verdict a customer's monitor polls: sub-check
// names, statuses, latencies and templated reasons only. No env var name,
// hostname, provider or error text can appear in it (redactIfLeaky).
export async function GET(): Promise<NextResponse> {
  let results: Record<string, unknown> = {};
  try {
    results = await getCheckResults();
  } catch {
    // Every probe is guarded, so this is the cache layer failing: the
    // composer reports each check as unknown rather than answering 500.
  }
  const verdict = composite.composeHealth(results);
  return NextResponse.json(verdict, { status: composite.httpStatusOf(verdict), headers: HEADERS });
}
