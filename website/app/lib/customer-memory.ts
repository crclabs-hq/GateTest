/**
 * Customer Memory — central, persistent key/value store for Nuclear+ tier
 * customers. Per-customer, per-scope (e.g. "repo:owner/name"), JSON-safe values.
 *
 * Tier gate: only `scan_fix` and `nuclear` API keys can write. Read is allowed
 * for the same tiers. Lower tiers get 403.
 *
 * Schema is idempotent — first call ensures the table.
 */

import { getDb } from "./db";

// Tier allowlist + size caps — internal. Promote to exports when a caller
// outside this file actually needs them.
const MEMORY_TIERS = ["scan_fix", "nuclear"] as const;

const MAX_SCOPE_LEN = 200;
const MAX_KEY_LEN = 200;
const MAX_VALUE_BYTES = 64 * 1024;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS customer_memory (
    id              BIGSERIAL PRIMARY KEY,
    customer_email  TEXT NOT NULL,
    scope           TEXT NOT NULL,
    key             TEXT NOT NULL,
    value           JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_email, scope, key)
  );
  CREATE INDEX IF NOT EXISTS customer_memory_owner ON customer_memory (customer_email, scope);
  CREATE INDEX IF NOT EXISTS customer_memory_updated ON customer_memory (updated_at DESC);
`;

export async function ensureMemoryTable(): Promise<void> {
  const sql = getDb();
  await sql.unsafe(CREATE_TABLE_SQL);
}

interface ValidationError {
  ok: false;
  status: number;
  error: string;
}

interface ValidationSuccess<T> {
  ok: true;
  value: T;
}

type Validation<T> = ValidationSuccess<T> | ValidationError;

/** True if the tier is allowed to use Memory. */
export function tierAllowed(tier: string | null | undefined): boolean {
  if (!tier) return false;
  return (MEMORY_TIERS as readonly string[]).includes(tier);
}

/** Validate scope: ASCII, no nulls, length-bounded, no leading/trailing whitespace. */
export function validateScope(scope: unknown): Validation<string> {
  if (typeof scope !== "string") {
    return { ok: false, status: 400, error: "scope must be a string" };
  }
  if (scope.length === 0 || scope.length > MAX_SCOPE_LEN) {
    return { ok: false, status: 400, error: `scope length must be 1..${MAX_SCOPE_LEN}` };
  }
  if (scope.trim() !== scope) {
    return { ok: false, status: 400, error: "scope must not have leading/trailing whitespace" };
  }
  if (/[\x00-\x1f]/.test(scope)) {
    return { ok: false, status: 400, error: "scope must not contain control characters" };
  }
  return { ok: true, value: scope };
}

export function validateKey(key: unknown): Validation<string> {
  if (typeof key !== "string") {
    return { ok: false, status: 400, error: "key must be a string" };
  }
  if (key.length === 0 || key.length > MAX_KEY_LEN) {
    return { ok: false, status: 400, error: `key length must be 1..${MAX_KEY_LEN}` };
  }
  if (key.trim() !== key) {
    return { ok: false, status: 400, error: "key must not have leading/trailing whitespace" };
  }
  if (/[\x00-\x1f]/.test(key)) {
    return { ok: false, status: 400, error: "key must not contain control characters" };
  }
  return { ok: true, value: key };
}

/** Validate value: JSON-serialisable, under the size cap. */
export function validateValue(value: unknown): Validation<unknown> {
  let serialised: string;
  try {
    serialised = JSON.stringify(value);
  } catch {
    return { ok: false, status: 400, error: "value must be JSON-serialisable" };
  }
  if (serialised === undefined) {
    return { ok: false, status: 400, error: "value must be JSON-serialisable" };
  }
  const byteLen = Buffer.byteLength(serialised, "utf8");
  if (byteLen > MAX_VALUE_BYTES) {
    return { ok: false, status: 413, error: `value too large (${byteLen} bytes, max ${MAX_VALUE_BYTES})` };
  }
  return { ok: true, value };
}

interface MemoryRow {
  scope: string;
  key: string;
  value: unknown;
  updated_at: string;
}

export async function setValue(
  customerEmail: string,
  scope: string,
  key: string,
  value: unknown
): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO customer_memory (customer_email, scope, key, value, updated_at)
    VALUES (${customerEmail}, ${scope}, ${key}, ${JSON.stringify(value)}::jsonb, NOW())
    ON CONFLICT (customer_email, scope, key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

export async function getValue(
  customerEmail: string,
  scope: string,
  key: string
): Promise<MemoryRow | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT scope, key, value, updated_at
    FROM customer_memory
    WHERE customer_email = ${customerEmail} AND scope = ${scope} AND key = ${key}
    LIMIT 1
  `) as MemoryRow[];
  return rows[0] ?? null;
}

export async function listKeys(
  customerEmail: string,
  scope: string,
  limit = 100
): Promise<MemoryRow[]> {
  const sql = getDb();
  const capped = Math.min(Math.max(1, limit), 500);
  return (await sql`
    SELECT scope, key, value, updated_at
    FROM customer_memory
    WHERE customer_email = ${customerEmail} AND scope = ${scope}
    ORDER BY updated_at DESC
    LIMIT ${capped}
  `) as MemoryRow[];
}

export async function deleteValue(
  customerEmail: string,
  scope: string,
  key: string
): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    DELETE FROM customer_memory
    WHERE customer_email = ${customerEmail} AND scope = ${scope} AND key = ${key}
    RETURNING id
  `) as Array<{ id: number }>;
  return rows.length > 0;
}
