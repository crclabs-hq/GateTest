/**
 * Customer Memory API — GET / POST / DELETE in one route.
 *
 *   GET    /api/memory?scope=<scope>&key=<key>   — fetch one value
 *   GET    /api/memory?scope=<scope>             — list keys in a scope
 *   POST   /api/memory                            — set { scope, key, value }
 *   DELETE /api/memory?scope=<scope>&key=<key>   — delete one value
 *
 * Auth: Authorization: Bearer gt_live_... (Scan+Fix or Nuclear tier only).
 *
 * Why one route file: Memory is a thin CRUD surface; the auth + tier guard
 * are identical for every verb so co-locating them keeps the policy in one
 * place. (See AGENTS.md — Next 16 App Router supports multiple HTTP-verb
 * exports from one route.ts.)
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey, checkRateLimit, recordApiCall } from "@/app/lib/api-key";
import {
  ensureMemoryTable,
  tierAllowed,
  validateScope,
  validateKey,
  validateValue,
  setValue,
  getValue,
  listKeys,
  deleteValue,
} from "@/app/lib/customer-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorise(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth.ok) return { fail: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  if (!tierAllowed(auth.key.tier_allowed)) {
    return {
      fail: NextResponse.json(
        { error: "Memory requires Scan+Fix or Nuclear tier" },
        { status: 403 }
      ),
    };
  }
  const rl = await checkRateLimit(auth.key);
  if (rl) return { fail: NextResponse.json({ error: rl.error }, { status: rl.status }) };
  if (!auth.key.customer_email) {
    return { fail: NextResponse.json({ error: "API key has no customer identity" }, { status: 403 }) };
  }
  return { auth };
}

export async function GET(req: NextRequest) {
  const a = await authorise(req);
  if ("fail" in a) return a.fail;
  const { searchParams } = new URL(req.url);
  const scopeRaw = searchParams.get("scope");
  const keyRaw = searchParams.get("key");

  const scope = validateScope(scopeRaw);
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });

  await ensureMemoryTable();
  recordApiCall({ apiKeyId: a.auth.key.id, statusCode: 200 }).catch(() => {});

  if (keyRaw === null) {
    const limitParam = Number(searchParams.get("limit") || "100");
    const rows = await listKeys(a.auth.key.customer_email!, scope.value, limitParam);
    return NextResponse.json({ scope: scope.value, items: rows });
  }
  const key = validateKey(keyRaw);
  if (!key.ok) return NextResponse.json({ error: key.error }, { status: key.status });

  const row = await getValue(a.auth.key.customer_email!, scope.value, key.value);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function POST(req: NextRequest) {
  const a = await authorise(req);
  if ("fail" in a) return a.fail;
  let body: { scope?: unknown; key?: unknown; value?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const scope = validateScope(body.scope);
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
  const key = validateKey(body.key);
  if (!key.ok) return NextResponse.json({ error: key.error }, { status: key.status });
  const value = validateValue(body.value);
  if (!value.ok) return NextResponse.json({ error: value.error }, { status: value.status });

  await ensureMemoryTable();
  recordApiCall({ apiKeyId: a.auth.key.id, statusCode: 200 }).catch(() => {});

  await setValue(a.auth.key.customer_email!, scope.value, key.value, value.value);
  return NextResponse.json({ ok: true, scope: scope.value, key: key.value });
}

export async function DELETE(req: NextRequest) {
  const a = await authorise(req);
  if ("fail" in a) return a.fail;
  const { searchParams } = new URL(req.url);
  const scope = validateScope(searchParams.get("scope"));
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
  const key = validateKey(searchParams.get("key"));
  if (!key.ok) return NextResponse.json({ error: key.error }, { status: key.status });

  await ensureMemoryTable();
  recordApiCall({ apiKeyId: a.auth.key.id, statusCode: 200 }).catch(() => {});

  const deleted = await deleteValue(a.auth.key.customer_email!, scope.value, key.value);
  if (!deleted) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
