/**
 * Admin authentication endpoint.
 *
 *   POST /api/admin/auth   → { password } → 200 + Set-Cookie  | 401 | 429
 *   DELETE /api/admin/auth → clears admin cookie (logout)
 *
 * Password is compared in constant time against the `GATETEST_ADMIN_PASSWORD`
 * environment variable. On success we set an httpOnly, SameSite=Lax cookie
 * derived from the password via HMAC — see app/lib/admin-auth.ts.
 *
 * Brute-force protection (Manifest #20):
 *   - Per-IP lockout backed by Neon. After 5 failures in a 15-minute
 *     rolling window, the IP is locked for 30 minutes (returns 429).
 *   - Successful login clears the IP's failure counter.
 *   - Every attempt is recorded to admin_auth_audit for /admin/health
 *     visibility.
 *   - Graceful degradation: if DATABASE_URL is unset / DB query throws,
 *     the route falls back to the legacy jitter-only behaviour rather
 *     than locking everyone out.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  verifyAdminPassword,
  buildAdminCookieHeader,
  buildAdminClearCookieHeader,
} from "@/app/lib/admin-auth";
import {
  clientIp,
  checkLockout,
  recordFailure,
  recordSuccess,
  recordLockedRejection,
  LOCKOUT_MS,
} from "@/app/lib/admin-lockout";

export async function POST(req: NextRequest) {
  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const password = (body.password || "").toString();

  if (!password) {
    return NextResponse.json({ error: "Password required" }, { status: 400 });
  }

  if (!process.env.GATETEST_ADMIN_PASSWORD) {
    // Fail loudly so a misconfigured deployment cannot silently allow access.
    return NextResponse.json(
      { error: "Admin access is not configured on this server" },
      { status: 503 },
    );
  }

  const ip = clientIp(req.headers);
  const userAgent = req.headers.get("user-agent");

  // Pre-flight lockout check. If the IP is already locked, return 429
  // without even comparing the password (cheaper than the constant-time
  // HMAC + adds no signal to the attacker beyond "still locked").
  const lockoutState = await checkLockout(ip);
  if (lockoutState.locked) {
    await recordLockedRejection(ip, userAgent);
    const retryAfterSec = lockoutState.lockedUntil
      ? Math.max(1, Math.ceil((lockoutState.lockedUntil.getTime() - Date.now()) / 1000))
      : Math.ceil(LOCKOUT_MS / 1000);
    return NextResponse.json(
      {
        error: "Too many failed attempts. Try again later.",
        retryAfterSeconds: retryAfterSec,
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSec) },
      },
    );
  }

  if (!verifyAdminPassword(password)) {
    // Random jitter to blunt timing side-channels (kept from the prior
    // implementation — runs in parallel with the lockout DB write).
    const jitter = 1500 + Math.floor(Math.random() * 1000);
    await Promise.all([
      new Promise((r) => setTimeout(r, jitter)),
      recordFailure(ip, userAgent),
    ]);
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  // Success — clear failure counter, write audit row.
  await recordSuccess(ip, userAgent);

  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", buildAdminCookieHeader());
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", buildAdminClearCookieHeader());
  return response;
}
