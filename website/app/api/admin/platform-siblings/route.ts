/**
 * Cross-product platform health aggregator.
 *
 * GET /api/admin/platform-siblings
 *
 * Fetches the public /api/platform-status endpoint on each of the three
 * sibling products (Vapron, Gluecron, GateTest) and returns a unified
 * health report. Server-side fetch with a 3s per-product timeout, graceful
 * degradation (unreachable products become status: "unreachable" rather
 * than failing the whole response), and an in-memory 30s cache so this
 * endpoint doesn't hammer the siblings if the admin panel re-mounts.
 *
 * URLs are configurable via env vars — defaults mirror the contract in
 * docs/PLATFORM_STATUS.md:
 *   - VAPRON_STATUS_URL  (default https://vapron.ai/api/platform-status)
 *   - GLUECRON_STATUS_URL  (default https://gluecron.com/api/platform-status)
 *   - GATETEST_STATUS_URL  (default https://gatetest.ai/api/platform-status)
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

export const dynamic = "force-dynamic";
export const maxDuration = 10;

const TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 30_000;

type SiblingId = "vapron" | "gluecron" | "gatetest";

interface SiblingResult {
  id: SiblingId;
  name: string;
  url: string;
  status: "up" | "down" | "unreachable";
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

const SIBLINGS: Array<{ id: SiblingId; name: string; envVar: string; defaultUrl: string }> = [
  {
    id: "vapron",
    name: "Vapron",
    envVar: "VAPRON_STATUS_URL",
    defaultUrl: "https://vapron.ai/api/platform-status",
  },
  {
    id: "gluecron",
    name: "Gluecron",
    envVar: "GLUECRON_STATUS_URL",
    defaultUrl: "https://gluecron.com/api/platform-status",
  },
  {
    id: "gatetest",
    name: "GateTest",
    envVar: "GATETEST_STATUS_URL",
    defaultUrl: "https://gatetest.ai/api/platform-status",
  },
];

// In-memory cache — fine on a per-instance basis, and on Vercel each
// function instance handles ~hundreds of requests before cycling. A
// stale-for-30s read is the intended behaviour here.
let cache: { expires: number; report: AggregateReport } | null = null;

async function fetchSibling(
  id: SiblingId,
  name: string,
  url: string,
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
      return {
        id,
        name,
        url,
        status: "down",
        healthy: false,
        latency_ms,
        version: null,
        commit: null,
        last_updated: null,
        error: `HTTP ${res.status}`,
        checked_at,
      };
    }

    const body = (await res.json()) as {
      product?: string;
      version?: string;
      commit?: string;
      healthy?: boolean;
      timestamp?: string;
    };

    const healthy = body.healthy !== false;
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
    SIBLINGS.map((s) => {
      const url = process.env[s.envVar] || s.defaultUrl;
      return fetchSibling(s.id, s.name, url);
    }),
  );

  const report: AggregateReport = {
    siblings: results,
    generated_at: new Date().toISOString(),
    cached: false,
  };

  cache = { expires: now + CACHE_TTL_MS, report };
  return NextResponse.json(report);
}
