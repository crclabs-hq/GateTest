/**
 * Cross-product platform health aggregator.
 *
 * GET /api/admin/platform-siblings
 *
 * Fetches the public /api/platform-status endpoint on each of the three
 * sibling products (the platform — Tallrig today —, Gluecron, GateTest) and returns a unified
 * health report. Server-side fetch with a 3s per-product timeout, graceful
 * degradation (unreachable products become status: "unreachable" rather
 * than failing the whole response), and an in-memory 30s cache so this
 * endpoint doesn't hammer the siblings if the admin panel re-mounts.
 *
 * URLs are configurable via env vars and come from the shared registry in
 * app/lib/platform-siblings.js — the same one the PUBLIC /api/platform-status
 * map is built from, so the two can no longer disagree about where a sibling
 * lives. (They did: this file was corrected to api.vapron.ai in 2026-07 while
 * the public map kept advertising the 404ing vapron.ai path.) Env var names
 * and current defaults are documented in that module, next to the
 * measurements that justify them.
 *
 * Admin-gated: mirrors the same two-method auth as /api/admin/health.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import {
  getAdminConfig,
  getAdminUser,
  SESSION_COOKIE_NAME,
} from "@/app/lib/admin-session";
import { ADMIN_COOKIE_NAME } from "@/app/lib/admin-auth";
import { SIBLING_REGISTRY, resolveSiblingUrl } from "@/app/lib/platform-siblings";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

const TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 30_000;

// The platform id is env-driven (PLATFORM_ID, "tallrig" today — was "vapron"),
// so the type is the registry's string id, not a literal union.
type SiblingId = string;

interface SiblingResult {
  id: SiblingId;
  name: string;
  url: string;
  // "needs_key" is distinct from "down" on purpose: a sibling whose status API
  // is key-gated answers 401 to our anonymous poll. Reporting that as DOWN is
  // claiming an observation we never made — the product is very likely fine,
  // we just aren't allowed to look. A panel that cries DOWN at a healthy
  // platform on every refresh is a panel Craig learns to ignore.
  status: "up" | "down" | "unreachable" | "needs_key";
  healthy: boolean;
  latency_ms: number | null;
  version: string | null;
  commit: string | null;
  last_updated: string | null;
  error: string | null;
  checked_at: string;
}

interface AggregateReport {
  siblings: SiblingResult[];
  generated_at: string;
  cached: boolean;
}

// Single source of truth, shared with the public /api/platform-status map.
const SIBLINGS = SIBLING_REGISTRY as ReadonlyArray<{
  id: SiblingId;
  name: string;
  envVar: string;
  defaultUrl: string | null;
  requiresAuth: boolean;
}>;

// In-memory cache — fine on a per-instance basis, and on Vercel each
// function instance handles ~hundreds of requests before cycling. A
// stale-for-30s read is the intended behaviour here.
let cache: { expires: number; report: AggregateReport } | null = null;

async function fetchSibling(
  id: SiblingId,
  name: string,
  url: string,
  requiresAuth = false,
): Promise<SiblingResult> {
  const checked_at = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    const latency_ms = Date.now() - started;

    if (!res.ok) {
      // A key-gated sibling refusing an anonymous poll tells us nothing about
      // its health, so don't pretend otherwise. It answered — that alone rules
      // out "unreachable" — but healthy stays false because we did not observe
      // health, and the error says what would let us.
      const keyGated =
        requiresAuth && (res.status === 401 || res.status === 403);
      return {
        id,
        name,
        url,
        status: keyGated ? "needs_key" : "down",
        healthy: false,
        latency_ms,
        version: null,
        commit: null,
        last_updated: null,
        error: keyGated
          ? `HTTP ${res.status} — status API is key-gated; health not observed`
          : `HTTP ${res.status}`,
        checked_at,
      };
    }

    const body = (await res.json()) as {
      product?: string;
      version?: string;
      commit?: string;
      healthy?: boolean;
      overall?: string;
      timestamp?: string;
    };

    // Siblings do not all speak the same dialect. GateTest and Gluecron emit
    // `healthy: boolean`; Vapron's /api/health/status emits `overall: "ok" |
    // "degraded" | …` and no `healthy` field at all. Reading only `healthy`
    // meant `undefined !== false` → true, so a Vapron reporting *degraded*
    // rendered as a green UP pill. Prefer the explicit boolean, fall back to
    // `overall`, and only assume health when the body offers neither.
    const healthy =
      typeof body.healthy === "boolean"
        ? body.healthy
        : typeof body.overall === "string"
          ? body.overall === "ok"
          : true;
    return {
      id,
      name,
      url,
      status: healthy ? "up" : "down",
      healthy,
      latency_ms,
      version: body.version ?? null,
      commit: body.commit ?? null,
      last_updated: body.timestamp ?? null,
      error: null,
      checked_at,
    };
  } catch (err) {
    const latency_ms = Date.now() - started;
    const aborted = (err as Error).name === "AbortError";
    return {
      id,
      name,
      url,
      status: "unreachable",
      healthy: false,
      latency_ms: aborted ? null : latency_ms,
      version: null,
      commit: null,
      last_updated: null,
      error: aborted ? `timeout after ${TIMEOUT_MS}ms` : (err as Error).message || "network error",
      checked_at,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function isAuthenticatedAdmin(): Promise<boolean> {
  const store = await cookies();

  const adminStatus = getAdminConfig();
  if (adminStatus.ok && adminStatus.config) {
    const sessionCookie = store.get(SESSION_COOKIE_NAME)?.value;
    if (getAdminUser(sessionCookie, adminStatus.config)) return true;
  }

  const adminPassword = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (adminPassword) {
    const passwordCookie = store.get(ADMIN_COOKIE_NAME)?.value || "";
    const expected = crypto
      .createHmac("sha256", adminPassword)
      .update("gatetest-admin-v1")
      .digest("hex");
    if (
      passwordCookie &&
      passwordCookie.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(passwordCookie), Buffer.from(expected))
    ) {
      return true;
    }
  }

  return false;
}

export async function GET() {
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  if (cache && cache.expires > now) {
    return NextResponse.json({ ...cache.report, cached: true });
  }

  const results = await Promise.all(
    SIBLINGS.map((s) =>
      fetchSibling(s.id, s.name, resolveSiblingUrl(s), s.requiresAuth),
    ),
  );

  const report: AggregateReport = {
    siblings: results,
    generated_at: new Date().toISOString(),
    cached: false,
  };

  cache = { expires: now + CACHE_TTL_MS, report };
  return NextResponse.json(report);
}
