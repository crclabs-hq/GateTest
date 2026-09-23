/**
 * Admin API Keys — create, list, revoke.
 *
 * Admin-only: requires valid admin session cookie.
 *
 * GET  /api/admin/keys              — list keys (without plaintext, obviously)
 * POST /api/admin/keys              — create a new key, returns plaintext ONCE
 *        body: { name, customer_email?, tier_allowed?, rate_limit_per_hour? }
 * POST /api/admin/keys?revoke=<id>  — revoke a key by id
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import {
  getAdminConfig,
  getAdminUser,
  SESSION_COOKIE_NAME,
} from "@/app/lib/admin-session";
import { ADMIN_COOKIE_NAME } from "@/app/lib/admin-auth";
import { getDb } from "@/app/lib/db";
import { generateApiKey } from "@/app/lib/api-key";

export const dynamic = "force-dynamic";

function checkPwCookie(v: string | undefined): boolean {
  const pw = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (!pw || !v) return false;
  const exp = crypto.createHmac("sha256", pw).update("gatetest-admin-v1").digest("hex");
  const a = Buffer.from(v), b = Buffer.from(exp);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

async function requireAdmin(): Promise<string | NextResponse> {
  const store = await cookies();

  // Auth: GitHub OAuth OR password cookie
  const status = getAdminConfig();
  if (status.ok && status.config) {
    const login = getAdminUser(store.get(SESSION_COOKIE_NAME)?.value, status.config);
    if (login) return login;
  }
  if (checkPwCookie(store.get(ADMIN_COOKIE_NAME)?.value)) return "admin";

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET() {
  const admin = await requireAdmin();
  if (typeof admin !== "string") return admin;

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return NextResponse.json({ error: "database not configured" }, { status: 503 });
  }
  try {
    const rows = (await sql`
      SELECT id, key_prefix, name, customer_email, tier_allowed,
             rate_limit_per_hour, active, created_at, last_used_at,
             revoked_at, total_calls
      FROM api_keys
      ORDER BY created_at DESC
      LIMIT 200
    `) as Array<Record<string, unknown>>;
    return NextResponse.json({ keys: rows });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (typeof admin !== "string") return admin;

  const url = new URL(req.url);
  const revokeId = url.searchParams.get("revoke");
  const sql = getDb();

  // ── Revoke path ───────────────────────
  if (revokeId) {
    try {
      await sql`
        UPDATE api_keys
        SET active = FALSE, revoked_at = NOW()
        WHERE id = ${revokeId}
      `;
      return NextResponse.json({ ok: true, revoked: revokeId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // ── Create path ───────────────────────
  let body: {
    name?: string;
    customer_email?: string;
    tier_allowed?: string;
    rate_limit_per_hour?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = (body.name || "").trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const tierAllowed = body.tier_allowed === "full" ? "full" : "quick";
  const rateLimit = Math.max(
    1,
    Math.min(10000, Number(body.rate_limit_per_hour) || 60)
  );
  const customerEmail = body.customer_email?.trim() || null;

  const { plaintext, hash, prefix } = generateApiKey();
  const id = `key_${crypto.randomBytes(12).toString("hex")}`;

  try {
    await sql`
      INSERT INTO api_keys (
        id, key_hash, key_prefix, name, customer_email,
        tier_allowed, rate_limit_per_hour, active
      ) VALUES (
        ${id}, ${hash}, ${prefix}, ${name}, ${customerEmail},
        ${tierAllowed}, ${rateLimit}, TRUE
      )
    `;
    return NextResponse.json({
      ok: true,
      id,
      name,
      prefix,
      tier_allowed: tierAllowed,
      rate_limit_per_hour: rateLimit,
      customer_email: customerEmail,
      plaintext_key: plaintext,
      warning:
        "Save this key now. It will not be shown again — only the hash is stored.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
