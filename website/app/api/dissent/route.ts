/**
 * POST /api/dissent
 *
 * Phase 5.2.1 UI hook — records a customer's dissent signal so the
 * 5.2.2 FP scorer can downgrade noisy modules. Surfaces:
 *
 *   - FindingsPanel "thumbs-down" button → records FALSE_POSITIVE
 *   - /api/scan/fix rollback path → records FIX_REJECTED
 *   - GitHub PR-closed-without-merge webhook → records PR_CLOSED_UNMERGED
 *   - Future operator-driven path → records ROLLED_BACK / COMMENT_DOWNVOTE
 *
 * Body: {
 *   repoUrl: string         // cleartext; hashed before storage
 *   module: string          // module name from the scan
 *   patternHash?: string    // (module, ruleId, file-ext) hash from the brain
 *   kind: keyof DISSENT_KINDS  // accepts the lowercase enum value too
 *   reviewer?: string       // hashed before storage
 *   fixPrNumber?: number
 *   notes?: string
 * }
 *
 * Auth: bound by repo ownership — caller must be the repo's webhook
 * signer OR an admin OR a customer logged in for that repo. For now
 * the simple-and-safe posture is: admin OR matching customer-session.
 * Open dissent endpoints invite spam, so we never accept anonymous.
 *
 * Privacy: every persisted column is hashed by the storage helper.
 * Notes free-text is capped at 500 chars.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminRoute } from "@/app/lib/admin-guard";
import { getDb } from "@/app/lib/db";
 
const dissentStore = require("@/app/lib/dissent-store.js") as {
  DISSENT_KINDS: Record<string, string>;
  ensureDissentTable: (sql: unknown) => Promise<void>;
  recordDissent: (opts: {
    sql: unknown;
    repoUrl: string;
    module: string;
    patternHash?: string | null;
    kind: string;
    reviewer?: string | null;
    fixPrNumber?: number | null;
    notes?: string | null;
  }) => Promise<{ id: number | null }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normaliseKind(rawKind: unknown): string | null {
  if (typeof rawKind !== "string") return null;
  const lower = rawKind.toLowerCase();
  // Accept either the enum key (FALSE_POSITIVE) or the value (false_positive).
  const values = Object.values(dissentStore.DISSENT_KINDS);
  if (values.includes(lower)) return lower;
  const upper = rawKind.toUpperCase();
  if (dissentStore.DISSENT_KINDS[upper]) return dissentStore.DISSENT_KINDS[upper];
  return null;
}

interface DissentRequestBody {
  repoUrl?: unknown;
  module?: unknown;
  patternHash?: unknown;
  kind?: unknown;
  reviewer?: unknown;
  fixPrNumber?: unknown;
  notes?: unknown;
}

export async function POST(req: NextRequest) {
  const refused = requireAdminRoute(req, { mutating: true });
  if (refused) return refused;

  let input: DissentRequestBody;
  try {
    input = (await req.json()) as DissentRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  if (!input || typeof input.repoUrl !== "string" || !input.repoUrl.trim()) {
    return NextResponse.json({ ok: false, error: "repoUrl is required" }, { status: 400 });
  }
  if (typeof input.module !== "string" || !input.module.trim()) {
    return NextResponse.json({ ok: false, error: "module is required" }, { status: 400 });
  }
  const kind = normaliseKind(input.kind);
  if (!kind) {
    return NextResponse.json(
      {
        ok: false,
        error: `kind must be one of: ${Object.values(dissentStore.DISSENT_KINDS).join(", ")}`,
      },
      { status: 400 }
    );
  }

  let sql;
  try {
    sql = getDb();
  } catch {
    return NextResponse.json(
      { ok: false, error: "database not configured" },
      { status: 503 }
    );
  }

  // Idempotently ensure the table exists so first-run installs don't
  // 500. The cost is one IF NOT EXISTS check per request — negligible.
  try {
    await dissentStore.ensureDissentTable(sql);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `dissent table unavailable: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 503 }
    );
  }

  try {
    const result = await dissentStore.recordDissent({
      sql,
      repoUrl: input.repoUrl as string,
      module: input.module as string,
      patternHash: typeof input.patternHash === "string" ? input.patternHash : null,
      kind,
      reviewer: typeof input.reviewer === "string" ? input.reviewer : null,
      fixPrNumber: typeof input.fixPrNumber === "number" ? input.fixPrNumber : null,
      notes: typeof input.notes === "string" ? input.notes : null,
    });
    return NextResponse.json({ ok: true, id: result.id, kind });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `failed to record dissent: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 500 }
    );
  }
}
