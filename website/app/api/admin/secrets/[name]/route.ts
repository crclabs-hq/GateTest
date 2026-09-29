/**
 * PUT    /api/admin/secrets/[name]  { value }  — store (encrypt) one secret
 * DELETE /api/admin/secrets/[name]            — remove one secret
 *
 * Both: admin + same-origin + step-up (gt_admin_fresh), no-store, audited.
 * After the write the unit env file is re-rendered; `apply` in the answer says
 * whether that file was written (the box's path unit then restarts the web
 * instances). PUT also runs a proof-on-save liveness probe AFTER the response
 * (next/server `after`), so a slow vendor never delays or fails the save.
 */

import { NextRequest, after } from "next/server";
import {
  actorOf, auditQuietly, errorResponse, requireAdmin, nameParam, noStoreJson, openStore, paths, storeUnavailable,
} from "@/app/lib/secrets/http";
import { applyNow, verifyOne, PROOF_ON_SAVE_TIMEOUT_MS } from "@/app/lib/secrets/panel";
import { checkName } from "@/app/lib/secrets/reserved";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ name: string }> };

export async function PUT(req: NextRequest, ctx: Ctx) {
  const refused = requireAdmin(req, { mutating: true, fresh: true });
  if (refused) return refused;
  const name = await nameParam(ctx);
  const store = openStore();
  if (!store) return storeUnavailable();
  const who = actorOf(req);
  let body: { value?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const value = typeof body.value === "string" ? body.value : "";
  let result: { fingerprint: string; warnings: string[] };
  try {
    result = await store.set(name, value, who);
  } catch (err) {
    const code = (err as { code?: string }).code || "error";
    await auditQuietly(store, { ...who, action: "set", name: checkName(name).ok ? name : null, outcome: code });
    return errorResponse(err);
  }
  const apply = await applyNow({ store, unitEnvFile: paths().unitEnvFile, allowRemoving: [], ctx: who });
  after(async () => {
    await verifyOne({ store, name, runtimeEnv: process.env, timeoutMs: PROOF_ON_SAVE_TIMEOUT_MS });
  });
  return noStoreJson({
    ok: true,
    fingerprint: result.fingerprint,
    apply,
    ...(result.warnings.length ? { warnings: result.warnings } : {}),
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const refused = requireAdmin(req, { mutating: true, fresh: true });
  if (refused) return refused;
  const name = await nameParam(ctx);
  const store = openStore();
  if (!store) return storeUnavailable();
  const who = actorOf(req);
  let removed: boolean;
  try {
    removed = (await store.remove(name, who)).removed;
  } catch (err) {
    const code = (err as { code?: string }).code || "error";
    await auditQuietly(store, { ...who, action: "delete", name: checkName(name).ok ? name : null, outcome: code });
    return errorResponse(err);
  }
  const apply = await applyNow({ store, unitEnvFile: paths().unitEnvFile, allowRemoving: [name], ctx: who });
  return noStoreJson({ ok: true, removed, apply });
}
