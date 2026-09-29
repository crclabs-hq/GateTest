/**
 * POST /api/admin/step-up  { password } → 200 { ok, freshUntil } | 401 bad_password | 429 throttled
 *
 * The ONLY place a `gt_admin_fresh` cookie is minted (app/lib/secrets/step-up.js).
 * Requires an existing admin session AND the admin password typed again, so a
 * machine-held admin token can never step up. Same-origin checked, no-store,
 * audited. Throttled in Postgres: 5 attempts per 15 minutes per client IP;
 * with no database there is no throttle, so the route fails closed (503).
 */

import { NextRequest } from "next/server";
import { verifyAdminPassword } from "@/app/lib/admin-auth";
import { actorOf, auditQuietly, requireAdmin, noStoreJson, openStore, storeUnavailable } from "@/app/lib/secrets/http";
import {
  STEP_UP_MAX_ATTEMPTS, STEP_UP_WINDOW_MS, buildFreshCookieHeader, freshKey, mintFreshToken, throttleKey,
} from "@/app/lib/secrets/step-up";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const refused = requireAdmin(req, { mutating: true });
  if (refused) return refused;
  const store = openStore();
  if (!store) return storeUnavailable();
  const who = actorOf(req);
  const key = throttleKey(who.ip);
  const now = Date.now();
  let attempts: number;
  try {
    attempts = await store.stepUpAttempts(key, new Date(now - STEP_UP_WINDOW_MS).toISOString());
  } catch {
    return noStoreJson({ error: "store_unavailable", reason: "database_error" }, 503);
  }
  if (attempts >= STEP_UP_MAX_ATTEMPTS) {
    await auditQuietly(store, { ...who, action: "step_up", outcome: "throttled" });
    return noStoreJson({ error: "throttled" }, 429, { "Retry-After": String(Math.ceil(STEP_UP_WINDOW_MS / 1000)) });
  }
  let password = "";
  try {
    const body = (await req.json()) as { password?: unknown };
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    password = "";
  }
  try {
    await store.recordStepUpAttempt(key, new Date(now).toISOString());
  } catch {
    return noStoreJson({ error: "store_unavailable", reason: "database_error" }, 503);
  }
  const signingKey = freshKey(process.env);
  if (!signingKey || !password || !verifyAdminPassword(password)) {
    await auditQuietly(store, { ...who, action: "step_up", outcome: "bad_password" });
    return noStoreJson({ error: "bad_password" }, 401);
  }
  const { token, freshUntil } = mintFreshToken(signingKey, now);
  await auditQuietly(store, { ...who, action: "step_up", outcome: "ok" });
  return noStoreJson({ ok: true, freshUntil }, 200, {
    "Set-Cookie": buildFreshCookieHeader(token, process.env.NODE_ENV === "production"),
  });
}
