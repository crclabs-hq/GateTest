/**
 * GET /api/admin/secrets — the secrets panel listing.
 *
 * Admin-only, no-store, audited. Every catalogue name (app/lib/env-catalogue.js)
 * is listed even when missing; names stored in the panel but unknown to the
 * catalogue are appended as tier "custom". Values never appear — only state,
 * source, shadowing, an 8-hex fingerprint and the cached liveness result.
 * This route never calls a vendor; only POST …/[name]/verify does.
 */

import { NextRequest } from "next/server";
import { actorOf, appEnvMap, auditQuietly, requireAdmin, noStoreJson, openStore, paths } from "@/app/lib/secrets/http";
import { buildListing, unavailableStore } from "@/app/lib/secrets/panel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const refused = requireAdmin(req);
  if (refused) return refused;
  const store = openStore();
  const body = await buildListing({
    store: store || unavailableStore("database_url_missing"),
    runtimeEnv: process.env as Record<string, string | undefined>,
    appEnv: appEnvMap(),
    unitEnvFile: paths().unitEnvFile,
  });
  await auditQuietly(store, { ...actorOf(req), action: "list", outcome: "ok", detail: `items=${body.items.length}` });
  return noStoreJson(body);
}
