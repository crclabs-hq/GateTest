/**
 * Compliance status aggregator — reads the audit log and admin lockout
 * tables, derives the controls posture that auditors actually ask about
 * (SOC2 CC controls / HIPAA §164.312), and returns a single payload the
 * dashboard renders.
 *
 * No customer PII is returned. Counts only. The audit-log read filters
 * to the last 30 days for the activity rollups.
 *
 * Why this lives here (not in /api): we want the same shape callable
 * from a server component (the dashboard page) without an HTTP round
 * trip, AND from an API route for partners who consume it.
 */

import { getDb } from "./db";

export interface ControlStatus {
  id: string;
  framework: "SOC2" | "HIPAA" | "BOTH";
  name: string;
  status: "in_place" | "manual" | "todo";
  evidence: string;
}

// Three states for every number on the page (CLAUDE.md doctrine 1): a value,
// a finding, or NOT CHECKED with the reason. A zero that came from a failed
// query is not a zero — it carries a `…NotCheckedReason` beside it.
export interface ComplianceSnapshot {
  generatedAt: string;
  /** Set when nothing could be read at all (e.g. DATABASE_URL unset). */
  notCheckedReason: string | null;
  retention: {
    auditLogYears: number;
    scansDays: number;
  };
  encryption: {
    atRest: "managed_by_neon";
    inTransit: "tls_required";
  };
  controls: ControlStatus[];
  audit: {
    totalEvents: number;
    last30Days: number;
    last24Hours: number;
    distinctActorsLast30Days: number;
    /** The count queries failed — the four counts above are not real. */
    countsNotCheckedReason: string | null;
    // true = intact, false = broken, null = not verified: either the table is
    // empty (chainNotCheckedReason null) or the probe failed (reason set).
    chainOk: boolean | null;
    chainBrokenAt?: number;
    chainNotCheckedReason: string | null;
  };
  adminAuth: {
    lockedAccountsNow: number;
    failedAttemptsLast24Hours: number;
    notCheckedReason: string | null;
  };
  schemaPresent: {
    audit_log: boolean;
    admin_auth_attempts: boolean;
    customer_memory: boolean;
  };
  /** Tables whose existence probe itself failed, with the reason. */
  schemaNotChecked: Partial<Record<"audit_log" | "admin_auth_attempts" | "customer_memory", string>>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const CONTROLS: ControlStatus[] = [
  {
    id: "CC6.1",
    framework: "SOC2",
    name: "Logical access controls — API keys hashed at rest (SHA-256)",
    status: "in_place",
    evidence: "website/app/lib/api-key.ts:hashKey",
  },
  {
    id: "CC6.6",
    framework: "SOC2",
    name: "Account lockout on repeated auth failures (per-IP)",
    status: "in_place",
    evidence: "website/app/lib/admin-lockout.ts",
  },
  {
    id: "CC7.2",
    framework: "SOC2",
    name: "Append-only audit trail with cryptographic hash chain",
    status: "in_place",
    evidence: "website/app/lib/audit-log-store.js",
  },
  {
    id: "CC7.3",
    framework: "SOC2",
    name: "Audit trail retention (7 years)",
    status: "in_place",
    evidence: "DEFAULT_RETENTION_YEARS = 7 in audit-log-store.js",
  },
  {
    id: "164.312(a)(1)",
    framework: "HIPAA",
    name: "Access control — unique user identification",
    status: "in_place",
    evidence: "API key bound to customer_email; admin session HMAC + AES-256-GCM",
  },
  {
    id: "164.312(b)",
    framework: "HIPAA",
    name: "Audit controls — record access to ePHI-shaped data",
    status: "in_place",
    evidence: "audit-log table; recordEventSafe in scan + fix paths",
  },
  {
    id: "164.312(c)(1)",
    framework: "HIPAA",
    name: "Integrity controls — tamper-evident log via hash chain",
    status: "in_place",
    evidence: "verifyChain() in audit-log-store.js",
  },
  {
    id: "164.312(e)(1)",
    framework: "HIPAA",
    name: "Transmission security — TLS for all customer-bound traffic",
    status: "in_place",
    evidence: "Vercel edge enforces HTTPS; no plaintext endpoints",
  },
  {
    id: "CC6.7",
    framework: "SOC2",
    name: "Encryption at rest — Neon-managed AES-256",
    status: "in_place",
    evidence: "Neon Postgres default; DATABASE_URL sslmode=require",
  },
  {
    id: "DR-1",
    framework: "BOTH",
    name: "Disaster recovery — daily Neon point-in-time recovery (PITR)",
    status: "manual",
    evidence: "Neon PITR retains 7 days on default plan; verify in dashboard.",
  },
];

function listControls(): ControlStatus[] {
  return CONTROLS.slice();
}

interface CountRow {
  count: number | string;
}

// present: the answer; error: the probe failed, so `present` is NOT an answer.
async function tableExists(sql: ReturnType<typeof getDb>, name: string): Promise<{ present: boolean; error: string | null }> {
  try {
    const rows = (await sql`
      SELECT to_regclass(${`public.${name}`}) AS r
    `) as Array<{ r: string | null }>;
    return { present: Boolean(rows[0]?.r), error: null };
  } catch (err) {
    return { present: false, error: errMessage(err) };
  }
}

function num(v: number | string | undefined): number {
  if (v === undefined) return 0;
  return typeof v === "number" ? v : parseInt(v, 10) || 0;
}

/**
 * Build the full compliance snapshot. Designed to never throw — every
 * branch either returns real data or zero WITH a `…NotCheckedReason`, and
 * the dashboard renders "Not checked — <reason>" for the latter.
 */
export async function buildComplianceSnapshot(): Promise<ComplianceSnapshot> {
  const snapshot: ComplianceSnapshot = {
    generatedAt: new Date().toISOString(),
    notCheckedReason: null,
    retention: { auditLogYears: 7, scansDays: 90 },
    encryption: { atRest: "managed_by_neon", inTransit: "tls_required" },
    controls: listControls(),
    audit: {
      totalEvents: 0,
      last30Days: 0,
      last24Hours: 0,
      distinctActorsLast30Days: 0,
      countsNotCheckedReason: null,
      chainOk: null,
      chainNotCheckedReason: null,
    },
    adminAuth: { lockedAccountsNow: 0, failedAttemptsLast24Hours: 0, notCheckedReason: null },
    schemaPresent: { audit_log: false, admin_auth_attempts: false, customer_memory: false },
    schemaNotChecked: {},
  };

  // getDb() throws SYNCHRONOUSLY when DATABASE_URL is unset. A config gap is
  // not a route failure, but it is NOT an empty audit log either: return the
  // zeroed snapshot marked not-checked so the page cannot read as healthy.
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const reason = `database not reachable: ${errMessage(err)}`;
    snapshot.notCheckedReason = reason;
    snapshot.audit.countsNotCheckedReason = reason;
    snapshot.audit.chainNotCheckedReason = reason;
    snapshot.adminAuth.notCheckedReason = reason;
    return snapshot;
  }

  for (const name of ["audit_log", "admin_auth_attempts", "customer_memory"] as const) {
    const probe = await tableExists(sql, name);
    snapshot.schemaPresent[name] = probe.present;
    if (probe.error) snapshot.schemaNotChecked[name] = probe.error;
  }
  if (snapshot.schemaNotChecked.audit_log) {
    const reason = `audit_log existence probe failed: ${snapshot.schemaNotChecked.audit_log}`;
    snapshot.audit.countsNotCheckedReason = reason;
    snapshot.audit.chainNotCheckedReason = reason;
  }
  if (snapshot.schemaNotChecked.admin_auth_attempts) {
    snapshot.adminAuth.notCheckedReason = `admin_auth_attempts existence probe failed: ${snapshot.schemaNotChecked.admin_auth_attempts}`;
  }

  if (snapshot.schemaPresent.audit_log) {
    try {
      const t = (await sql`SELECT COUNT(*)::int AS count FROM audit_log`) as CountRow[];
      const t30 = (await sql`SELECT COUNT(*)::int AS count FROM audit_log WHERE created_at > NOW() - INTERVAL '30 days'`) as CountRow[];
      const t24 = (await sql`SELECT COUNT(*)::int AS count FROM audit_log WHERE created_at > NOW() - INTERVAL '24 hours'`) as CountRow[];
      const a30 = (await sql`SELECT COUNT(DISTINCT actor)::int AS count FROM audit_log WHERE created_at > NOW() - INTERVAL '30 days'`) as CountRow[];
      snapshot.audit.totalEvents = num(t[0]?.count);
      snapshot.audit.last30Days = num(t30[0]?.count);
      snapshot.audit.last24Hours = num(t24[0]?.count);
      snapshot.audit.distinctActorsLast30Days = num(a30[0]?.count);
      // Lightweight chain probe: only verify the most recent 200 rows so
      // the dashboard stays fast. Full verification is a periodic job.
      if (snapshot.audit.totalEvents > 0) {
        const probe = await verifyRecentChain(sql, 200);
        snapshot.audit.chainOk = probe.ok;
        snapshot.audit.chainNotCheckedReason = probe.notCheckedReason;
        if (probe.ok === false && probe.brokenAt !== undefined) {
          snapshot.audit.chainBrokenAt = probe.brokenAt;
        }
      }
    } catch (err) {
      // The counts are not real — say so beside them instead of showing 0.
      const reason = `audit_log query failed: ${errMessage(err)}`;
      snapshot.audit.countsNotCheckedReason = reason;
      if (snapshot.audit.chainOk === null) snapshot.audit.chainNotCheckedReason = reason;
    }
  }

  if (snapshot.schemaPresent.admin_auth_attempts) {
    try {
      const locked = (await sql`
        SELECT COUNT(*)::int AS count FROM admin_auth_attempts
        WHERE locked_until IS NOT NULL AND locked_until > NOW()
      `) as CountRow[];
      const fails = (await sql`
        SELECT COALESCE(SUM(failed_count), 0)::int AS count FROM admin_auth_attempts
        WHERE last_attempt_at > NOW() - INTERVAL '24 hours'
      `) as CountRow[];
      snapshot.adminAuth.lockedAccountsNow = num(locked[0]?.count);
      snapshot.adminAuth.failedAttemptsLast24Hours = num(fails[0]?.count);
    } catch (err) {
      snapshot.adminAuth.notCheckedReason = `admin_auth_attempts query failed: ${errMessage(err)}`;
    }
  }

  return snapshot;
}

interface ChainProbe {
  /** true intact, false broken, null NOT CHECKED (see notCheckedReason). */
  ok: boolean | null;
  brokenAt?: number;
  rowsChecked: number;
  notCheckedReason: string | null;
}

async function verifyRecentChain(
  sql: ReturnType<typeof getDb>,
  windowSize: number
): Promise<ChainProbe> {
  try {
    // Lazy require so this file stays TS-pure for static analysis
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const auditStore = require("./audit-log-store");
    const max = (await sql`SELECT MAX(id)::int AS m FROM audit_log`) as Array<{ m: number | null }>;
    const top = max[0]?.m ?? 0;
    // No rows to verify is "nothing checked", not "intact".
    if (!top) return { ok: null, rowsChecked: 0, notCheckedReason: "audit_log has no rows to verify" };
    const fromId = Math.max(1, top - windowSize + 1);
    const result = await auditStore.verifyChain(sql, { fromId, toId: top });
    return {
      ok: Boolean(result?.ok),
      brokenAt: result?.brokenAt,
      rowsChecked: top - fromId + 1,
      notCheckedReason: null,
    };
  } catch (err) {
    // A probe that threw verified nothing. It used to return ok:true here,
    // which rendered "✓ Hash chain intact" for a chain nobody had read.
    return { ok: null, rowsChecked: 0, notCheckedReason: `hash-chain probe failed: ${errMessage(err)}` };
  }
}
