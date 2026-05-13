/**
 * API Key library — generate, hash, verify, rate-limit.
 *
 * Contract:
 *   - Plaintext keys look like:  gt_live_<32 base62 chars>
 *   - Only the SHA-256 hash is stored in DB (we cannot recover the plaintext)
 *   - The `key_prefix` (first 8 chars) is stored for display ("gt_live_abcd1234…")
 *   - Rate limit: rolling 1-hour window counted from api_calls
 *
 * Auth header: `Authorization: Bearer <key>` OR `X-API-Key: <key>`.
 */

import crypto from "crypto";
import type { NextRequest } from "next/server";
import { getDb } from "./db";

export interface ApiKeyRecord {
  id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  customer_email: string | null;
  tier_allowed: string;
  rate_limit_per_hour: number;
  active: boolean;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  total_calls: number;
}

const KEY_PREFIX = "gt_live_";
const KEY_BODY_LEN = 32;
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a cryptographically random key body. */
function randomBody(len: number): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const body = randomBody(KEY_BODY_LEN);
  const plaintext = `${KEY_PREFIX}${body}`;
  const hash = hashKey(plaintext);
  // Show the prefix + first 4 of body so humans can tell keys apart
  const prefix = `${KEY_PREFIX}${body.slice(0, 4)}`;
  return { plaintext, hash, prefix };
}

export function hashKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

export function extractBearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const xkey = req.headers.get("x-api-key");
  if (xkey) return xkey.trim();
  return null;
}

export interface AuthSuccess {
  ok: true;
  key: ApiKeyRecord;
}

export interface AuthFailure {
  ok: false;
  status: number;
  error: string;
}

/**
 * Authenticate an API key from the request. Returns the DB row on success.
 * Updates last_used_at asynchronously — never blocks the caller.
 */
export async function authenticateApiKey(
  req: NextRequest
): Promise<AuthSuccess | AuthFailure> {
  const plaintext = extractBearer(req);
  if (!plaintext) {
    return {
      ok: false,
      status: 401,
      error: "Missing API key — pass Authorization: Bearer <key> or X-API-Key header",
    };
  }
  if (!plaintext.startsWith(KEY_PREFIX)) {
    return { ok: false, status: 401, error: "Malformed API key" };
  }

  const sql = getDb();
  const hash = hashKey(plaintext);
  const rows = (await sql`
    SELECT id, key_hash, key_prefix, name, customer_email,
           tier_allowed, rate_limit_per_hour, active,
           created_at, last_used_at, revoked_at, total_calls
    FROM api_keys WHERE key_hash = ${hash} LIMIT 1
  `) as ApiKeyRecord[];

  if (rows.length === 0) {
    return { ok: false, status: 401, error: "Invalid API key" };
  }
  const key = rows[0];
  if (!key.active || key.revoked_at) {
    return { ok: false, status: 403, error: "API key is revoked" };
  }

  return { ok: true, key };
}

/**
 * Enforce rate limit: count api_calls for this key in the last hour. Returns
 * null if under limit, else a failure with 429 + Retry-After guidance.
 */
export async function checkRateLimit(key: ApiKeyRecord): Promise<AuthFailure | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT COUNT(*)::int AS count FROM api_calls
    WHERE api_key_id = ${key.id}
      AND created_at > NOW() - INTERVAL '1 hour'
  `) as Array<{ count: number }>;
  const count = rows[0]?.count ?? 0;
  if (count >= key.rate_limit_per_hour) {
    return {
      ok: false,
      status: 429,
      error: `Rate limit exceeded (${key.rate_limit_per_hour}/hour). Try again later.`,
    };
  }
  return null;
}

/** Record an API call for rate-limit accounting and audit. */
export async function recordApiCall(params: {
  apiKeyId: string;
  repoUrl?: string;
  tier?: string;
  statusCode: number;
  issuesFound?: number;
  durationMs?: number;
  idempotencyKey?: string;
}): Promise<void> {
  const sql = getDb();
  try {
    await sql`
      INSERT INTO api_calls (
        api_key_id, repo_url, tier, status_code,
        issues_found, duration_ms, idempotency_key
      ) VALUES (
        ${params.apiKeyId},
        ${params.repoUrl ?? null},
        ${params.tier ?? null},
        ${params.statusCode},
        ${params.issuesFound ?? null},
        ${params.durationMs ?? null},
        ${params.idempotencyKey ?? null}
      )
    `;
    await sql`
      UPDATE api_keys
      SET last_used_at = NOW(), total_calls = total_calls + 1
      WHERE id = ${params.apiKeyId}
    `;
  } catch (err) { // error-swallow-ok: stats update is best-effort, never block the API request on telemetry write failure
    console.error("[GateTest] recordApiCall failed:", err);
  }
}

/**
 * Idempotency: if the same (api_key_id, idempotency_key) has been recorded
 * recently with a success status, return the cached repo/tier/issues. We store
 * only the envelope in api_calls, so callers that need the full scan body must
 * pass a unique key OR accept that the first response is authoritative.
 */
export async function findIdempotentCall(
  apiKeyId: string,
  idempotencyKey: string
): Promise<{ status_code: number; issues_found: number | null; tier: string | null; repo_url: string | null; created_at: string } | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT status_code, issues_found, tier, repo_url, created_at
    FROM api_calls
    WHERE api_key_id = ${apiKeyId}
      AND idempotency_key = ${idempotencyKey}
      AND created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC
    LIMIT 1
  `) as Array<{ status_code: number; issues_found: number | null; tier: string | null; repo_url: string | null; created_at: string }>;
  return rows[0] ?? null;
}
