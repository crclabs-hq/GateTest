/**
 * GET /api/admin/secrets/audit?limit=50 — the secrets audit trail, newest first.
 *
 * Admin-only, no-store, audited (action "audit_read"). Rows carry who, what,
 * which name, from where and the outcome — never a value (store.js/audit.js).
 * `chain` reports whether the hash chain over the whole trail still verifies.
 */

import { NextRequest } from "next/server";
import { actorOf, auditQuietly, requireAdmin, noStoreJson, openStore, storeUnavailable } from "@/app/lib/secrets/http";
import { verifyAuditChain } from "@/app/lib/secrets/audit";

type AuditRow = { at: string; actor: string; action: string; name: string | null; ip: string | null; outcome: string };

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const refused = requireAdmin(req);
  if (refused) return refused;
  const store = openStore();
  if (!store) return storeUnavailable();
  const limit = Number(new URL(req.url).searchParams.get("limit") || 50);
  try {
    const rows = await store.listAudit(limit);
    const chain = verifyAuditChain(await store.allAudit());
    await auditQuietly(store, { ...actorOf(req), action: "audit_read", outcome: "ok", detail: `limit=${rows.length}` });
    return noStoreJson({
      entries: rows.map((r: AuditRow) => ({ at: r.at, actor: r.actor, action: r.action, name: r.name, ip: r.ip, outcome: r.outcome })),
      chain,
    });
  } catch {
    return noStoreJson({ error: "store_unavailable", reason: "database_error" }, 503);
  }
}
