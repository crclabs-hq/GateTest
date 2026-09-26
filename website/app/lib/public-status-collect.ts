/**
 * Public status — the COLLECTOR. Gathers the readings the internal probes
 * already produce and hands them to the pure mapper in public-status.js.
 * Shared by GET /api/status/public and the /status page so the two can never
 * disagree (one definition, imported — Doctrine #4).
 *
 * Sources, and why each is the source:
 *   - /api/status (its GET handler, called in-process — NOT re-implemented,
 *     so the REQUIRED / IMPORTANT lists have one home): config readiness,
 *     Stripe mode, and the scan_queue counts it already races against 2s.
 *   - build-info.json: version / commit / builtAt, the same stamp
 *     /api/platform-status serves.
 *   - scan_queue: the worker's last start/finish and the last GitHub delivery
 *     that reached the queue. Bounded by a 2s timeout like the readiness read.
 *   - GET /api/mcp over the public origin: the path an MCP client takes.
 *   - process.env presence (never values) for the webhook-verification
 *     secrets, through the same placeholder detector /api/status uses.
 *
 * Caching: unstable_cache with a 30s revalidate — Next's data cache, the
 * same mechanism ISR uses (filesystem-backed in the standalone server), not
 * process memory. `checkedAt` therefore tells the truth about when the
 * readings were taken.
 *
 * Every reading is independently guarded: a failure becomes `{ error: true }`
 * (no message — the mapper never reads one) and the rest still collect.
 */

import { unstable_cache } from "next/cache";
import { NextRequest } from "next/server";
import buildInfo from "@/app/data/build-info.json";
import { GET as readinessGet } from "@/app/api/status/route";
import { siteUrl } from "@/app/lib/site-url";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { summarisePublicStatus } = require("@/app/lib/public-status") as {
  summarisePublicStatus: (readings: Record<string, unknown>) => PublicStatus;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { inspectEnvValue } = require("@/app/lib/env-placeholder") as {
  inspectEnvValue: (name: string, value: string | undefined) => { ok: boolean };
};

export type ComponentState = "operational" | "degraded" | "down" | "unknown";
export type OverallState = "operational" | "partial" | "major" | "unknown";
export interface PublicComponent {
  name: string;
  state: ComponentState;
  detail: string;
  checkedAt: string;
}
export interface PublicStatus {
  overall: OverallState;
  headline: string;
  components: PublicComponent[];
  version: string;
  commit: string;
  builtAt: string | null;
  checkedAt: string;
}

export const PUBLIC_STATUS_TTL_SECONDS = 30;
const DB_TIMEOUT_MS = 2000;
const MCP_TIMEOUT_MS = 2500;

type Reading<T> = T | { error: true };
const failed: { error: true } = { error: true };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

/** A variable is set when it is non-empty AND not documentation filler. */
function envSet(name: string): boolean {
  const v = process.env[name];
  if (typeof v !== "string" || v.trim().length === 0) return false;
  return inspectEnvValue(name, v).ok;
}

interface ReadinessBody {
  ready?: boolean;
  queue?: Record<string, unknown>;
  missing_required?: Array<{ name: string }>;
  missing_important?: Array<{ name: string }>;
  invalid_placeholders?: Array<{ name: string }>;
  stripe?: { mode?: string };
}

/**
 * Call the readiness route in-process. One definition of "configured".
 *
 * /api/status now gates its operator-detail body (GT-02) behind an admin
 * session or `Authorization: Bearer $CRON_SECRET` — the same check
 * scan/worker/tick uses. This call is server-to-server (never reaches a
 * browser), so it carries that bearer from the server's own env when set;
 * without it, the readiness route still answers, just with the minimal
 * `{ ok, healthy, version, commit, checked_at }` body, and the derived
 * component states below fall back to "unknown" rather than fabricating a
 * detail they were not given.
 */
async function readReadiness(): Promise<Reading<ReadinessBody>> {
  try {
    const gate = process.env.GATETEST_STATUS_TOKEN;
    const url = siteUrl("/api/status") + (gate ? `?token=${encodeURIComponent(gate)}` : "");
    const cronSecret = process.env.CRON_SECRET;
    const headers = cronSecret ? { authorization: `Bearer ${cronSecret}` } : undefined;
    const res = await readinessGet(new NextRequest(url, { headers }));
    // 503 is a VALID answer here — it means "not ready", which is a reading.
    if (res.status !== 200 && res.status !== 503) return failed;
    const body = (await res.json()) as ReadinessBody;
    return body && typeof body === "object" ? body : failed;
  } catch {
    return failed;
  }
}

interface QueueSignals {
  lastActivityAt: string | null;
  lastGithubDeliveryAt: string | null;
}

/** Worker heartbeat + last GitHub delivery, both from scan_queue. */
async function readQueueSignals(): Promise<Reading<QueueSignals>> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/app/lib/db") as { getDb: () => unknown };
    const sql = getDb() as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
    const rows = (await withTimeout(
      sql`SELECT
            MAX(GREATEST(started_at, completed_at))::text                AS last_activity,
            MAX(created_at) FILTER (WHERE host = 'github')::text         AS last_github
          FROM scan_queue`,
      DB_TIMEOUT_MS,
    )) as Array<{ last_activity: string | null; last_github: string | null }>;
    const row = Array.isArray(rows) ? rows[0] : null;
    return {
      lastActivityAt: row?.last_activity ?? null,
      lastGithubDeliveryAt: row?.last_github ?? null,
    };
  } catch {
    return failed;
  }
}

/** GET /api/mcp over the public origin — the route a client actually takes. */
async function readMcp(): Promise<Reading<{ reachable: boolean; status: number }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  try {
    const res = await fetch(siteUrl("/api/mcp"), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    let ok = false;
    try {
      const body = (await res.json()) as { ok?: unknown };
      ok = body?.ok === true;
    } catch {
      ok = false;
    }
    // The transport is POST-only: a 405 WITH the JSON body is the healthy answer.
    return { reachable: (res.status === 405 || res.status === 200) && ok, status: res.status };
  } catch {
    return failed;
  } finally {
    clearTimeout(timer);
  }
}

const namesOf = (list: unknown): Set<string> =>
  new Set(Array.isArray(list) ? list.map((m) => (m && typeof m === "object" && "name" in m ? String((m as { name: unknown }).name) : String(m))) : []);

async function collectPublicStatus(): Promise<PublicStatus> {
  const [readiness, signals, mcp] = await Promise.all([readReadiness(), readQueueSignals(), readMcp()]);

  const readinessOk = !("error" in readiness);
  const missingImportant = readinessOk ? namesOf(readiness.missing_important) : new Set<string>();
  const placeholders = readinessOk ? namesOf(readiness.invalid_placeholders) : new Set<string>();
  const notReal = (name: string) => missingImportant.has(name) || placeholders.has(name);

  const queue = readinessOk && readiness.queue && typeof readiness.queue === "object" ? readiness.queue : failed;

  const worker = "error" in signals ? failed : { lastActivityAt: signals.lastActivityAt };

  // Webhooks are "configured" when the App can authenticate AND the delivery
  // signature can be verified. Names are consulted, never values.
  const webhooks = readinessOk
    ? {
        configured: envSet("GITHUB_WEBHOOK_SECRET") && !notReal("GATETEST_APP_ID") && !notReal("GATETEST_PRIVATE_KEY"),
        lastDeliveryAt: "error" in signals ? null : signals.lastGithubDeliveryAt,
      }
    : failed;

  const payments = readinessOk
    ? {
        mode: readiness.stripe?.mode ?? "unknown",
        webhookConfigured: !notReal("STRIPE_WEBHOOK_SECRET") && envSet("STRIPE_WEBHOOK_SECRET"),
        production: process.env.NODE_ENV === "production",
      }
    : failed;

  return summarisePublicStatus({
    build: {
      version: process.env.APP_VERSION ?? buildInfo.version,
      commit: process.env.GIT_COMMIT ?? buildInfo.commit,
      builtAt: buildInfo.builtAt ?? null,
    },
    readiness: readinessOk ? readiness : failed,
    queue,
    worker,
    webhooks,
    mcp,
    payments,
  });
}

/**
 * The cached summary — 30s TTL shared by the route and the page. A throw
 * inside the collector (it should be impossible; every reading is guarded)
 * still resolves to an all-unknown summary rather than propagating.
 */
export const getPublicStatus = unstable_cache(
  async (): Promise<PublicStatus> => {
    try {
      return await collectPublicStatus();
    } catch {
      return summarisePublicStatus({});
    }
  },
  ["public-status-v1"],
  { revalidate: PUBLIC_STATUS_TTL_SECONDS },
);
