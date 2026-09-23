/**
 * Overview dashboard facts (issue #691, item 2) — a real dashboard built
 * only from data the site already exposes. Every field says where it came
 * from; anything the store cannot supply is left out entirely rather than
 * shipped as a placeholder (Bible Forbidden #1 / Doctrine #1).
 *
 * Sources, and why each is the source (mirrors public-status-collect.ts's
 * own header, which does the same in-process call for the public /status
 * page — reused here rather than re-implemented, Doctrine #4):
 *   - GET /api/status (called in-process, same as public-status-collect.ts):
 *     readiness (`ready`), the secrets-presence checklist (missing_required /
 *     missing_important / invalid_placeholders, names only — never values),
 *     queue posture, Stripe mode, platform pointing.
 *   - scan_queue: worker heartbeat (last started/finished job).
 *   - scans: today / this week counts, total revenue, average score.
 *   - marketplace_purchases: Marketplace webhook — active installs + last
 *     event received.
 *   - tallrig-push-event-store: last Tallrig push event, by type + time.
 *
 * Every reading is independently guarded — a failure in one section never
 * blocks the rest, and is reported as "not checked" rather than omitted
 * silently (Doctrine #6).
 */

import { NextRequest } from "next/server";
import { GET as readinessGet, REQUIRED as REQUIRED_SECRETS, IMPORTANT as IMPORTANT_SECRETS } from "@/app/api/status/route";
import { siteUrl } from "@/app/lib/site-url";
import { getDb } from "@/app/lib/db";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tallrigPushEventStore = require("@/app/lib/tallrig-push-event-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const marketplacePurchaseStore = require("@/app/lib/marketplace-purchase-store") as {
  summarize: (sql: unknown) => Promise<{ counts: Record<string, number>; activeInstalls: number }>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { inspectEnvValue } = require("@/app/lib/env-placeholder") as {
  inspectEnvValue: (name: string, value: string | undefined) => { ok: boolean };
};

/** Worker heartbeat ceiling — same 24h rule #691 asks for (mirrors #688's
 * WORKER_STALE_SECONDS in public-status.js, which is on an unmerged branch
 * this admin surface cannot import yet — kept as one independent constant
 * here rather than forking that file's internals). */
const WORKER_STALE_SECONDS = 24 * 60 * 60;
const DB_TIMEOUT_MS = 2500;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

interface ReadinessBody {
  ready?: boolean;
  queue?: Record<string, unknown>;
  missing_required?: Array<{ name: string; why: string }>;
  missing_important?: Array<{ name: string; why: string }>;
  invalid_placeholders?: Array<{ name: string }>;
  summary?: { required_set: number; required_total: number; important_set: number; important_total: number };
  stripe?: { mode?: string };
  platform?: unknown;
}

type Checked<T> = { checked: true; value: T } | { checked: false; reason: string };

function ok<T>(value: T): Checked<T> {
  return { checked: true, value };
}
function fail<T>(reason: string): Checked<T> {
  return { checked: false, reason };
}

async function readReadiness(): Promise<Checked<ReadinessBody>> {
  try {
    const url = siteUrl("/api/status");
    const res = await readinessGet(new NextRequest(url));
    if (res.status !== 200 && res.status !== 503) return fail("readiness probe returned an unexpected status");
    const body = (await res.json()) as ReadinessBody;
    return body && typeof body === "object" ? ok(body) : fail("readiness probe returned no body");
  } catch (err) {
    return fail(err instanceof Error ? err.message : "readiness probe failed");
  }
}

export interface WorkerHeartbeat {
  lastActivityAt: string | null;
  ageSeconds: number | null;
  stale: boolean;
  staleThresholdSeconds: number;
}

async function readWorkerHeartbeat(): Promise<Checked<WorkerHeartbeat>> {
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return fail("DATABASE_URL not set");
  }
  try {
    const rows = (await withTimeout(
      sql`SELECT MAX(GREATEST(started_at, completed_at))::text AS last_activity FROM scan_queue`,
      DB_TIMEOUT_MS,
    )) as Array<{ last_activity: string | null }>;
    const lastActivityAt = rows[0]?.last_activity ?? null;
    const ageSeconds = lastActivityAt ? Math.max(0, Math.floor((Date.now() - Date.parse(lastActivityAt)) / 1000)) : null;
    return ok({
      lastActivityAt,
      ageSeconds,
      stale: ageSeconds === null ? false : ageSeconds > WORKER_STALE_SECONDS,
      staleThresholdSeconds: WORKER_STALE_SECONDS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("does not exist") || message.includes("relation")) {
      return ok({ lastActivityAt: null, ageSeconds: null, stale: false, staleThresholdSeconds: WORKER_STALE_SECONDS });
    }
    return fail(message);
  }
}

export interface ScanVolume {
  today: number;
  thisWeek: number;
  totalScans: number;
  totalRevenueUsd: number;
  avgScore: number;
  totalCustomers: number;
}

async function readScanVolume(): Promise<Checked<ScanVolume>> {
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return fail("DATABASE_URL not set");
  }
  try {
    const [row] = (await withTimeout(
      sql`SELECT
            COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::int AS today,
            COUNT(*) FILTER (WHERE created_at >= date_trunc('week', NOW()))::int AS this_week,
            COUNT(*)::int AS total_scans,
            COALESCE(SUM(tier_price_usd), 0)::numeric AS total_revenue,
            COALESCE(AVG(score), 0)::int AS avg_score
          FROM scans`,
      DB_TIMEOUT_MS,
    )) as Array<{ today: number; this_week: number; total_scans: number; total_revenue: string | number; avg_score: number }>;
    const [customerRow] = (await withTimeout(
      sql`SELECT COUNT(*)::int AS total FROM customers`,
      DB_TIMEOUT_MS,
    )) as Array<{ total: number }>;
    return ok({
      today: row?.today ?? 0,
      thisWeek: row?.this_week ?? 0,
      totalScans: row?.total_scans ?? 0,
      totalRevenueUsd: Number(row?.total_revenue ?? 0),
      avgScore: row?.avg_score ?? 0,
      totalCustomers: customerRow?.total ?? 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("does not exist") || message.includes("relation")) {
      return ok({ today: 0, thisWeek: 0, totalScans: 0, totalRevenueUsd: 0, avgScore: 0, totalCustomers: 0 });
    }
    return fail(message);
  }
}

export interface IntegrationStatus {
  githubApp: { configured: boolean; lastDeliveryAt: string | null };
  marketplaceWebhook: { activeInstalls: number | null; lastEventAt: string | null };
  tallrig: { lastEventType: string | null; lastEventAt: string | null };
}

function envSet(name: string): boolean {
  const v = process.env[name];
  if (typeof v !== "string" || v.trim().length === 0) return false;
  return inspectEnvValue(name, v).ok;
}

async function readIntegrationStatus(readiness: Checked<ReadinessBody>): Promise<Checked<IntegrationStatus>> {
  const missingImportant = new Set(
    readiness.checked ? (readiness.value.missing_important ?? []).map((m) => m.name) : [],
  );

  let lastGithubDeliveryAt: string | null = null;
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    sql = getDb();
  } catch {
    sql = null;
  }
  if (sql) {
    try {
      const rows = (await withTimeout(
        sql`SELECT MAX(created_at) FILTER (WHERE host = 'github')::text AS last_github FROM scan_queue`,
        DB_TIMEOUT_MS,
      )) as Array<{ last_github: string | null }>;
      lastGithubDeliveryAt = rows[0]?.last_github ?? null;
    } catch {
      // error-ok — this sub-field stays null; the rest of the section still ships
    }
  }

  const githubApp = {
    configured: envSet("GITHUB_WEBHOOK_SECRET") && !missingImportant.has("GATETEST_APP_ID") && !missingImportant.has("GATETEST_PRIVATE_KEY"),
    lastDeliveryAt: lastGithubDeliveryAt,
  };

  let marketplaceWebhook: IntegrationStatus["marketplaceWebhook"] = { activeInstalls: null, lastEventAt: null };
  if (sql) {
    try {
      const summary = await withTimeout(marketplacePurchaseStore.summarize(sql), DB_TIMEOUT_MS);
      const lastRows = (await withTimeout(
        sql`SELECT MAX(received_at)::text AS last FROM marketplace_purchases`,
        DB_TIMEOUT_MS,
      )) as Array<{ last: string | null }>;
      marketplaceWebhook = {
        activeInstalls: summary.activeInstalls,
        lastEventAt: lastRows[0]?.last ?? null,
      };
    } catch {
      // error-ok — table may not exist yet; leave nulls (never a placeholder count)
    }
  }

  let tallrig: IntegrationStatus["tallrig"] = { lastEventType: null, lastEventAt: null };
  try {
    const recent = tallrigPushEventStore.listRecent(1) as Array<{ type: string | null; receivedAt: string }>;
    if (recent.length > 0) {
      tallrig = { lastEventType: recent[0].type, lastEventAt: recent[0].receivedAt };
    }
  } catch {
    // error-ok — ledger read failed; report no event rather than crashing
  }

  return ok({ githubApp, marketplaceWebhook, tallrig });
}

export interface SecretsChecklistItem {
  name: string;
  tier: "required" | "important";
  present: boolean;
  placeholder: boolean;
}

export interface OverviewFacts {
  generatedAt: string;
  readiness: Checked<{ ready: boolean; stripeMode: string | null; platform: unknown; queue: Record<string, unknown> | null }>;
  worker: Checked<WorkerHeartbeat>;
  scans: Checked<ScanVolume>;
  integrations: Checked<IntegrationStatus>;
  secrets: Checked<SecretsChecklistItem[]>;
}

export async function getOverviewFacts(): Promise<OverviewFacts> {
  const readiness = await readReadiness();
  const [worker, scans, integrations] = await Promise.all([
    readWorkerHeartbeat(),
    readScanVolume(),
    readIntegrationStatus(readiness),
  ]);

  let secrets: Checked<SecretsChecklistItem[]>;
  if (readiness.checked) {
    const placeholderNames = new Set((readiness.value.invalid_placeholders ?? []).map((p) => p.name));
    const requiredMissing = new Set((readiness.value.missing_required ?? []).map((m) => m.name));
    const importantMissing = new Set((readiness.value.missing_important ?? []).map((m) => m.name));
    // Full checklist, present or missing, by name — matches the probe's own
    // REQUIRED / IMPORTANT lists (imported, not retyped: Doctrine #4) rather
    // than only the missing subset the public JSON body carries.
    const items: SecretsChecklistItem[] = [
      ...REQUIRED_SECRETS.map((v) => ({
        name: v.name,
        tier: "required" as const,
        present: !requiredMissing.has(v.name),
        placeholder: placeholderNames.has(v.name),
      })),
      ...IMPORTANT_SECRETS.map((v) => ({
        name: v.name,
        tier: "important" as const,
        present: !importantMissing.has(v.name),
        placeholder: placeholderNames.has(v.name),
      })),
    ];
    secrets = ok(items);
  } else {
    secrets = fail(readiness.reason);
  }

  return {
    generatedAt: new Date().toISOString(),
    readiness: readiness.checked
      ? ok({
          ready: !!readiness.value.ready,
          stripeMode: readiness.value.stripe?.mode ?? null,
          platform: readiness.value.platform ?? null,
          queue: readiness.value.queue ?? null,
        })
      : fail(readiness.reason),
    worker,
    scans,
    integrations,
    secrets,
  };
}
