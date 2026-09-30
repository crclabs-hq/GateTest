/**
 * Watches API — list, add, update, remove monitored domains/repos.
 *
 * GET    /api/watches                  → list all watches (admin)
 * POST   /api/watches                  → add a watch { target_type, target, interval_minutes?, auto_fix_enabled? }
 * PATCH  /api/watches?id=<id>          → update a watch
 * DELETE /api/watches?id=<id>          → remove a watch
 * POST   /api/watches/run?id=<id>      → trigger immediate scan + heal
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminRoute, adminLoginOf } from "@/app/lib/admin-guard";
import { getDb } from "../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const refused = requireAdminRoute(req);
  if (refused) return refused;

  try {
    const sql = getDb();
    const watches = await sql`
      SELECT id, owner_login, target_type, target, interval_minutes, enabled,
             last_checked_at, last_status, last_issue_count, auto_fix_enabled,
             created_at, updated_at
      FROM watches
      ORDER BY created_at DESC
      LIMIT 100
    `;
    return NextResponse.json({ watches });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "DB error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const refused = requireAdminRoute(req, { mutating: true });
  if (refused) return refused;
  const admin = { login: adminLoginOf(req) };

  let body: { target_type?: string; target?: string; interval_minutes?: number; auto_fix_enabled?: boolean };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const targetType = body.target_type === "repo" ? "repo" : "server";
  const target = (body.target || "").trim();
  const interval = Math.max(5, Math.min(1440, Number(body.interval_minutes) || 15));
  const autoFix = body.auto_fix_enabled !== false;

  if (!target) return NextResponse.json({ error: "target required" }, { status: 400 });
  if (targetType === "server" && !/^https?:\/\//i.test(target)) {
    return NextResponse.json({ error: "server target must be a full URL (http:// or https://)" }, { status: 400 });
  }
  if (targetType === "repo" && !/^[\w-]+\/[\w.-]+$/.test(target)) {
    return NextResponse.json({ error: "repo target must be owner/repo format" }, { status: 400 });
  }

  try {
    const sql = getDb();
    const inserted = await sql`
      INSERT INTO watches (owner_login, target_type, target, interval_minutes, auto_fix_enabled)
      VALUES (${admin.login}, ${targetType}, ${target}, ${interval}, ${autoFix})
      ON CONFLICT (owner_login, target_type, target)
      DO UPDATE SET interval_minutes = EXCLUDED.interval_minutes,
                    auto_fix_enabled = EXCLUDED.auto_fix_enabled,
                    enabled = TRUE,
                    updated_at = NOW()
      RETURNING id, target_type, target, interval_minutes, enabled, auto_fix_enabled
    `;
    return NextResponse.json({ watch: inserted[0] }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "DB error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const refused = requireAdminRoute(req, { mutating: true });
  if (refused) return refused;
  const admin = { login: adminLoginOf(req) };

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  try {
    const sql = getDb();
    await sql`DELETE FROM watches WHERE id = ${Number(id)} AND owner_login = ${admin.login}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "DB error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const refused = requireAdminRoute(req, { mutating: true });
  if (refused) return refused;
  const admin = { login: adminLoginOf(req) };

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  let body: { enabled?: boolean; interval_minutes?: number; auto_fix_enabled?: boolean };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const sql = getDb();
    if (typeof body.enabled === "boolean") {
      await sql`UPDATE watches SET enabled = ${body.enabled}, updated_at = NOW() WHERE id = ${Number(id)} AND owner_login = ${admin.login}`;
    }
    if (typeof body.interval_minutes === "number") {
      const iv = Math.max(5, Math.min(1440, body.interval_minutes));
      await sql`UPDATE watches SET interval_minutes = ${iv}, updated_at = NOW() WHERE id = ${Number(id)} AND owner_login = ${admin.login}`;
    }
    if (typeof body.auto_fix_enabled === "boolean") {
      await sql`UPDATE watches SET auto_fix_enabled = ${body.auto_fix_enabled}, updated_at = NOW() WHERE id = ${Number(id)} AND owner_login = ${admin.login}`;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "DB error" }, { status: 500 });
  }
}
