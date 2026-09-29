/**
 * POST /api/admin/secrets/apply  { allowRemoving?: string[] } — re-render the unit env file.
 *
 * Admin + same-origin + step-up, no-store, audited. Writes the file only;
 * the box's gatetest-secrets-apply.path sees the change and runs the
 * blue/green restart. Refuses (applied:false, reason "would_drop_keys",
 * dropped:[names]) when the file holds a key the store no longer has, unless
 * that name is listed in `allowRemoving`.
 */

import { NextRequest } from "next/server";
import { actorOf, requireAdmin, noStoreJson, openStore, paths, storeUnavailable } from "@/app/lib/secrets/http";
import { applyNow } from "@/app/lib/secrets/panel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const refused = requireAdmin(req, { mutating: true, fresh: true });
  if (refused) return refused;
  const store = openStore();
  if (!store) return storeUnavailable();
  let allowRemoving: string[] = [];
  try {
    const body = (await req.json()) as { allowRemoving?: unknown };
    if (Array.isArray(body.allowRemoving)) allowRemoving = body.allowRemoving.filter((n): n is string => typeof n === "string");
  } catch {
    allowRemoving = [];
  }
  const result = await applyNow({ store, unitEnvFile: paths().unitEnvFile, allowRemoving, ctx: actorOf(req) });
  return noStoreJson(result);
}
