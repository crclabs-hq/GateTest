/**
 * POST /api/admin/secrets/[name]/reveal — return one stored value.
 *
 * Admin + same-origin + step-up, no-store. The audit row (action "reveal") is
 * written BEFORE the value is returned; if it cannot be written the value is
 * not returned (503). The value appears in this response body only — never in
 * a log line, an audit row, or an error.
 */

import { NextRequest } from "next/server";
import {
  actorOf, auditQuietly, errorResponse, requireAdmin, nameParam, noStoreJson, openStore, storeUnavailable,
} from "@/app/lib/secrets/http";
import { checkName } from "@/app/lib/secrets/reserved";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ name: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const refused = requireAdmin(req, { mutating: true, fresh: true });
  if (refused) return refused;
  const name = await nameParam(ctx);
  const store = openStore();
  if (!store) return storeUnavailable();
  const who = actorOf(req);
  try {
    const value = await store.reveal(name, who);
    return noStoreJson({ value });
  } catch (err) {
    const e = err as { name?: string; code?: string };
    if (e.name !== "SecretsError" || e.code !== "not_found") {
      await auditQuietly(store, { ...who, action: "reveal", name: checkName(name).ok ? name : null, outcome: e.code || "error" });
    }
    return errorResponse(err);
  }
}
