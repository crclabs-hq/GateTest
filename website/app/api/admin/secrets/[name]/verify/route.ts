/**
 * POST /api/admin/secrets/[name]/verify — ask the vendor whether a credential works.
 *
 * Admin + same-origin, no-store, audited. No step-up: it reveals nothing and
 * writes only the cached liveness result. Probes the STORED value when the
 * name is stored, otherwise the value the running process has. Answers
 * alive | dead | cannot-tell within 5 s and never throws (app/lib/secrets/liveness.js).
 */

import { NextRequest } from "next/server";
import { actorOf, auditQuietly, requireAdmin, nameParam, noStoreJson, openStore } from "@/app/lib/secrets/http";
import { unavailableStore, verifyOne } from "@/app/lib/secrets/panel";
import { checkName } from "@/app/lib/secrets/reserved";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ name: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const refused = requireAdmin(req, { mutating: true });
  if (refused) return refused;
  const name = await nameParam(ctx);
  const shape = checkName(name);
  if (!shape.ok && shape.error === "invalid_name") return noStoreJson({ error: "invalid_name" }, 400);
  const store = openStore();
  const result = await verifyOne({
    store: store || unavailableStore("database_url_missing"),
    name,
    runtimeEnv: process.env,
  });
  await auditQuietly(store, { ...actorOf(req), action: "verify", name, outcome: result.liveness });
  return noStoreJson({ liveness: result.liveness, checkedAt: result.checkedAt });
}
