/**
 * HTTP glue shared by every /api/admin/secrets/** route and /api/admin/step-up.
 *
 * One gate for all of them, in this order:
 *   1. isAdminRequest()          — the admin password cookie (or the internal
 *      admin token); the GitHub-OAuth admin session the /admin pages also
 *      accept (getAdminLoginFromCookies) is honoured too, so a page that
 *      renders never answers 401 on its own API. Neither is enough to write:
 *   2. csrfOk() on every mutating request — the same-origin check the password
 *      routes use (app/lib/password-auth-http.ts), imported, not re-written
 *   3. a valid `gt_admin_fresh` cookie for set / delete / reveal / apply —
 *      minted ONLY by POST /api/admin/step-up after the password is typed
 * and every answer carries `cache-control: no-store`.
 *
 * The service logic lives in panel.js / store.js (plain CommonJS, tested in
 * node); this file only wires Next to it.
 */

import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/app/lib/admin-auth";
import { getAdminLoginFromCookies } from "@/app/lib/admin-session";
import { clientIp } from "@/app/lib/admin-lockout";
import { csrfOk } from "@/app/lib/password-auth-http";
import { getDb } from "@/app/lib/db";
import { createSecretsStore } from "./store";
import { createPgAdapter } from "./store-pg";
import { FRESH_COOKIE_NAME, freshKey, verifyFreshToken } from "./step-up";
import { unitEnvPath } from "./materialize";
import { appEnvPath, readAppEnv } from "./shadow";

const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;

type SecretsStore = ReturnType<typeof createSecretsStore>;

/** JSON answer with no-store — the only way these routes respond. */
export function noStoreJson(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE_HEADERS, ...headers } });
}

/**
 * Authenticate a request. Returns a response to send when refused, or null.
 * `mutating` adds the same-origin check; `fresh` adds the step-up check.
 */
export function requireAdmin(req: NextRequest, opts: { mutating?: boolean; fresh?: boolean } = {}): NextResponse | null {
  if (!isAdminRequest(req) && !getAdminLoginFromCookies(req.cookies)) return noStoreJson({ error: "unauthorized" }, 401);
  if (opts.mutating && !csrfOk(req)) return noStoreJson({ error: "cross_origin" }, 403);
  if (opts.fresh) {
    const verdict = verifyFreshToken(req.cookies.get(FRESH_COOKIE_NAME)?.value || "", freshKey(process.env), Date.now());
    if (!verdict.ok) return noStoreJson({ error: "step_up_required", reason: verdict.reason }, 403);
  }
  return null;
}

export function actorOf(req: NextRequest): { actor: string; ip: string } {
  const login = getAdminLoginFromCookies(req.cookies);
  return { actor: login && login !== "admin" ? `github:${login}` : "admin", ip: clientIp(req.headers) };
}

/** The store over Postgres, or null when DATABASE_URL is not configured. */
export function openStore(): SecretsStore | null {
  try {
    return createSecretsStore({ adapter: createPgAdapter(getDb()) });
  } catch {
    return null;
  }
}

export function paths(): { unitEnvFile: string; appEnvFile: string } {
  return { unitEnvFile: unitEnvPath(process.env), appEnvFile: appEnvPath(process.env) };
}

export function appEnvMap(): Map<string, string> | null {
  return readAppEnv(paths().appEnvFile);
}

/** Map a thrown error to the contract's status + code. Never echoes a value. */
export function errorResponse(err: unknown): NextResponse {
  const e = err as { name?: string; code?: string; status?: number; reason?: string };
  if (e && e.name === "SecretsError" && e.code && e.status) return noStoreJson({ error: e.code }, e.status);
  if (e && e.name === "StoreUnavailable") return noStoreJson({ error: "store_unavailable", reason: e.reason }, 503);
  if (e && e.name === "DecryptFailed") return noStoreJson({ error: "store_unavailable", reason: "decrypt_failed" }, 503);
  return noStoreJson({ error: "store_unavailable", reason: "database_error" }, 503);
}

export const storeUnavailable = (): NextResponse =>
  noStoreJson({ error: "store_unavailable", reason: "database_url_missing" }, 503);

/** Audit a call; a failed audit write never turns a read into a 500. */
export async function auditQuietly(store: SecretsStore | null, entry: {
  actor: string; action: string; name?: string | null; ip: string; outcome: string; detail?: string | null;
}): Promise<void> {
  if (!store) return;
  try {
    await store.audit(entry, []);
  } catch {
    // error-ok — the chain shows the gap; the response is unchanged
  }
}

/** Route params in Next 16 arrive as a Promise. */
export async function nameParam(ctx: { params: Promise<{ name: string }> }): Promise<string> {
  const p = await ctx.params;
  return decodeURIComponent(String(p.name || ""));
}
