/**
 * Finding-feedback store — records customer dismissals so the
 * confidence-calibrator trainer can re-weight rules over time.
 *
 * "Suppression becomes signal" — Wave 6 of the year-2030 flywheel.
 * When a customer suppresses a finding the trainer reads the
 * cumulative dismissal rate per rule and recommends downgrades
 * (error → warning, warning → info) when a rule is consistently
 * being treated as noise.
 *
 * Serverless-safe — every call is a single SQL query via the Neon
 * driver. No in-memory state.
 *
 * GRACEFUL DEGRADATION: when DATABASE_URL is unset or a query throws,
 * the helpers degrade to no-op (record) / empty (read). The route
 * MUST surface a friendly error when persistence fails.
 *
 * Schema (idempotent — ensureSchema() creates if missing):
 *   finding_dismissals(
 *     id          BIGSERIAL PRIMARY KEY,
 *     ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     scan_id     TEXT,            -- Stripe payment_intent id or queue id
 *     rule        TEXT NOT NULL,   -- e.g. "security:eval"
 *     file        TEXT,
 *     line        INTEGER,
 *     reason      TEXT,            -- 'false-positive' | 'intended' | 'wont-fix' | 'other'
 *     comment     TEXT,            -- free-text, optional, capped at 500 chars
 *     ip          TEXT             -- for rate limiting + abuse detection
 *   )
 */

import { getDb } from "./db";

const MAX_COMMENT_LEN = 500;
const MAX_RULE_LEN = 200;
const MAX_FILE_LEN = 300;
const MAX_REASON_LEN = 30;

const VALID_REASONS = new Set([
  "false-positive",
  "intended",
  "wont-fix",
  "test-only",
  "deprecated",
  "other",
]);

let _initPromise: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const sql = getDb();
      await sql`CREATE TABLE IF NOT EXISTS finding_dismissals (
        id        BIGSERIAL PRIMARY KEY,
        ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scan_id   TEXT,
        rule      TEXT NOT NULL,
        file      TEXT,
        line      INTEGER,
        reason    TEXT,
        comment   TEXT,
        ip        TEXT
      )`;
      await sql`CREATE INDEX IF NOT EXISTS finding_dismissals_rule_idx ON finding_dismissals(rule)`;
      await sql`CREATE INDEX IF NOT EXISTS finding_dismissals_ts_idx ON finding_dismissals(ts DESC)`;
    } catch (err) { // error-ok — log-and-continue is intentional; failure here must not block the caller
      // eslint-disable-next-line no-console
      console.warn("[finding-feedback] schema init failed:", (err as Error)?.message);
    }
  })();
  return _initPromise;
}

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

function clamp(s: unknown, max: number): string | null {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DismissalInput {
  scanId?: string | null;
  rule: string;
  file?: string | null;
  line?: number | null;
  reason?: string | null;
  comment?: string | null;
  ip?: string | null;
}

export interface RecordResult {
  ok: boolean;
  id?: string;
  reason?: string;
}

/**
 * Record one customer-supplied dismissal.
 *
 * @returns { ok: true, id } on persisted row.
 * @returns { ok: false, reason } on validation or DB failure.
 */
export async function recordDismissal(input: DismissalInput): Promise<RecordResult> {
  const rule = clamp(input.rule, MAX_RULE_LEN);
  if (!rule) return { ok: false, reason: "missing rule" };

  const scanId = clamp(input.scanId, 100);
  const file = clamp(input.file, MAX_FILE_LEN);
  const line = Number.isFinite(input.line) ? Math.max(0, Math.floor(input.line as number)) : null;
  const reasonRaw = clamp(input.reason, MAX_REASON_LEN);
  const reason = reasonRaw && VALID_REASONS.has(reasonRaw) ? reasonRaw : "other";
  const comment = clamp(input.comment, MAX_COMMENT_LEN);
  const ip = clamp(input.ip, 100);

  if (!process.env.DATABASE_URL) {
    // Degrade silently — return ok but report no id.
    return { ok: false, reason: "persistence unavailable (DATABASE_URL unset)" };
  }

  try {
    await ensureSchema();
    const sql = getDb();
    const rows = (await sql`
      INSERT INTO finding_dismissals (scan_id, rule, file, line, reason, comment, ip)
      VALUES (${scanId}, ${rule}, ${file}, ${line}, ${reason}, ${comment}, ${ip})
      RETURNING id
    `) as Array<{ id: string }>;
    return { ok: true, id: rows[0]?.id };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[finding-feedback] recordDismissal failed:", (err as Error)?.message);
    return { ok: false, reason: (err as Error)?.message || "persistence failed" };
  }
}

// ---------------------------------------------------------------------------
// Read-side — for the confidence-calibrator trainer
// ---------------------------------------------------------------------------

export interface RuleDismissalStat {
  rule: string;
  totalDismissals: number;
  uniqueScans: number;
  uniqueIps: number;
  reasonBreakdown: Record<string, number>;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
}

/**
 * Aggregate stats per rule. Used by the confidence-calibrator trainer
 * to decide which rules are being suppressed consistently.
 *
 * @param sinceDays look back this many days (default 90)
 * @param ruleLimit max rules to return (default 200)
 */
export async function statsByRule(sinceDays = 90, ruleLimit = 200): Promise<RuleDismissalStat[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    await ensureSchema();
    const sql = getDb();
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const cap = Math.max(1, Math.min(1000, Math.floor(ruleLimit)));
    const rows = (await sql`
      SELECT
        rule,
        COUNT(*)::int                AS total_dismissals,
        COUNT(DISTINCT scan_id)::int AS unique_scans,
        COUNT(DISTINCT ip)::int      AS unique_ips,
        MIN(ts)                      AS first_seen_at,
        MAX(ts)                      AS last_seen_at
      FROM finding_dismissals
      WHERE ts >= ${since}
      GROUP BY rule
      ORDER BY total_dismissals DESC
      LIMIT ${cap}
    `) as Array<{
      rule: string;
      total_dismissals: number;
      unique_scans: number;
      unique_ips: number;
      first_seen_at: string;
      last_seen_at: string;
    }>;

    // Second pass: pull reason breakdown per rule. One query per rule is
    // fine — the rule_limit cap bounds this. If this becomes hot, fold
    // into the first query with a CASE-aggregate.
    const out: RuleDismissalStat[] = [];
    for (const r of rows) {
      const breakdownRows = (await sql`
        SELECT reason, COUNT(*)::int AS n
        FROM finding_dismissals
        WHERE rule = ${r.rule} AND ts >= ${since}
        GROUP BY reason
      `) as Array<{ reason: string; n: number }>;
      const reasonBreakdown: Record<string, number> = {};
      for (const b of breakdownRows) reasonBreakdown[b.reason || "unknown"] = b.n;
      out.push({
        rule: r.rule,
        totalDismissals: r.total_dismissals,
        uniqueScans: r.unique_scans,
        uniqueIps: r.unique_ips,
        reasonBreakdown,
        firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at) : null,
        lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at) : null,
      });
    }
    return out;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[finding-feedback] statsByRule failed:", (err as Error)?.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// IP helpers (re-used from admin-lockout pattern)
// ---------------------------------------------------------------------------

export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  return "unknown";
}

export { VALID_REASONS };
