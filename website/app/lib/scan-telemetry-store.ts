/**
 * Scan-telemetry store — central sink for anonymized per-scan finding signal.
 *
 * Client machines (CLI/MCP) flush batches of anonymized records here via
 * POST /api/telemetry/scan; the website records its own scans directly. Each
 * record is which modules ran + integer error/warning counts + gate status —
 * NEVER code, file paths, finding text, or repo identity (enforced both at the
 * recorder, src/core/scan-telemetry.js, and again at the route as defense in
 * depth).
 *
 * This is the aggregate signal the flywheel tunes on: fire-rate per module
 * across the whole customer base, so we can see which checks are noisy and
 * calibrate confidence. Pairs with finding_dismissals (finding-feedback-store)
 * — that captures WHICH findings customers reject; this captures HOW OFTEN
 * modules fire in the first place.
 *
 * GRACEFUL DEGRADATION: when DATABASE_URL is unset or a query throws, every
 * function returns a soft failure and logs — never blocks the caller. This is
 * how it behaves today while gatetest.ai is stale (endpoint reachable, DB may
 * not be) — records simply aren't persisted yet, and the client keeps buffering.
 */

import { getDb } from "./db";
// Pure PII-rejection sanitizer, shared with the unit tests (plain JS so it's
// require()-able from node --test without compiling TS).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sanitizeRecord } = require("./scan-telemetry-sanitize") as {
  sanitizeRecord: (raw: unknown) => SanitizeResult;
};

const MAX_RECORDS_PER_BATCH = 500;

let _initPromise: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const sql = getDb();
      await sql`CREATE TABLE IF NOT EXISTS scan_findings (
        id           BIGSERIAL PRIMARY KEY,
        ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source       TEXT,
        suite        TEXT,
        gate_status  TEXT,
        duration_ms  INTEGER,
        module_count INTEGER,
        total_errors INTEGER,
        total_warnings INTEGER,
        modules      JSONB
      )`;
      await sql`CREATE INDEX IF NOT EXISTS scan_findings_ts_idx ON scan_findings(ts DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS scan_findings_source_idx ON scan_findings(source)`;
    } catch (err) { // error-ok — log-and-continue; never block the caller
      // eslint-disable-next-line no-console
      console.warn("[scan-telemetry] schema init failed:", (err as Error)?.message);
    }
  })();
  return _initPromise;
}

// ---------------------------------------------------------------------------
// Validation / sanitisation — delegated to the shared pure sanitizer
// (scan-telemetry-sanitize.js), unit-tested directly.
// ---------------------------------------------------------------------------

export interface SanitizedScanRecord {
  source: string;
  suite: string;
  gateStatus: string;
  durationMs: number;
  moduleCount: number;
  totalErrors: number;
  totalWarnings: number;
  modules: Array<{ name: string; errors: number; warnings: number; soft: number; status: string }>;
}

export type SanitizeResult =
  | { ok: true; record: SanitizedScanRecord }
  | { ok: false; reason: string };

// sanitizeRecord is imported from ./scan-telemetry-sanitize (top of file) —
// the pure PII-rejection guard, unit-tested at tests/scan-telemetry-store.test.js.

export interface IngestResult {
  ok: boolean;
  accepted: number;
  rejected: number;
  reason?: string;
}

/**
 * Persist a batch of already-sanitized records. Degrades softly when the DB
 * is unavailable (returns ok:false, never throws).
 */
export async function recordScanBatch(rawRecords: unknown[]): Promise<IngestResult> {
  if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
    return { ok: false, accepted: 0, rejected: 0, reason: "empty-batch" };
  }
  if (rawRecords.length > MAX_RECORDS_PER_BATCH) {
    return { ok: false, accepted: 0, rejected: rawRecords.length, reason: "batch-too-large" };
  }

  const clean: SanitizedScanRecord[] = [];
  let rejected = 0;
  for (const raw of rawRecords) {
    const res = sanitizeRecord(raw);
    if (res.ok) clean.push(res.record);
    else rejected += 1;
  }

  if (clean.length === 0) return { ok: false, accepted: 0, rejected, reason: "all-rejected" };

  if (!process.env.DATABASE_URL) {
    // Endpoint reachable, DB not configured yet (pre-Vapron). Accept-shaped
    // so the client can drop its buffer? No — report soft failure so the
    // client KEEPS buffering until persistence is real.
    return { ok: false, accepted: 0, rejected, reason: "persistence-unavailable" };
  }

  try {
    await ensureSchema();
    const sql = getDb();
    for (const r of clean) {
      await sql`
        INSERT INTO scan_findings
          (source, suite, gate_status, duration_ms, module_count, total_errors, total_warnings, modules)
        VALUES
          (${r.source}, ${r.suite}, ${r.gateStatus}, ${r.durationMs}, ${r.moduleCount},
           ${r.totalErrors}, ${r.totalWarnings}, ${JSON.stringify(r.modules)})
      `;
    }
    return { ok: true, accepted: clean.length, rejected };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[scan-telemetry] recordScanBatch failed:", (err as Error)?.message);
    return { ok: false, accepted: 0, rejected, reason: (err as Error)?.message || "persistence-failed" };
  }
}
