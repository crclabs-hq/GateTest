/**
 * Server Scan API — scan a live URL for SSL, headers, DNS, and performance.
 *
 * POST /api/scan/server
 * Body: { url: string }
 *
 * Returns scan results with module-by-module breakdown.
 * No GitHub needed — just a URL.
 */

import { NextRequest, NextResponse } from "next/server";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveAndValidateUrl } = require("@/app/lib/ssrf-guard") as {
  resolveAndValidateUrl: (input: string) => Promise<{ ok: true; url: URL } | { ok: false; reason: string }>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};
const _hostScanLimiter = createLimiter(PRESETS.webScan);

import https from "https";
import http from "http";
import dns from "dns";
import tls from "tls";

export const maxDuration = 30;

interface ModResult {
  name: string;
  label: string;
  status: "passed" | "failed" | "warning";
  checks: number;
  issues: number;
  details: string[];
}

async function fetchHeaders(url: string): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.request(url, { method: "HEAD", timeout: 10000 }, (res) => {
      resolve(res.headers as Record<string, string>);
    });
    req.on("error", () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function timedGet(url: string): Promise<{ status: number; headers: Record<string, string>; ttfb: number }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.request(url, {
      method: "GET",
      timeout: 15000,
      headers: { "User-Agent": "GateTest/1.0 ServerScanner" },
    }, (res) => {
      const ttfb = Date.now() - start;
      res.resume();
      res.on("end", () => resolve({
        status: res.statusCode || 0,
        headers: res.headers as Record<string, string>,
        ttfb,
      }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

async function checkSSL(hostname: string, port: number): Promise<ModResult> {
  const mod: ModResult = { name: "ssl", label: "SSL / TLS", status: "passed", checks: 0, issues: 0, details: [] };

  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port, servername: hostname, timeout: 10000 }, () => {
      const cert = socket.getPeerCertificate();

      mod.checks++;
      if (!cert?.subject) {
        mod.issues++; mod.details.push("error: No SSL certificate"); mod.status = "failed";
        socket.end(); resolve(mod); return;
      }

      mod.checks++;
      const expiry = new Date(cert.valid_to);
      const days = Math.floor((expiry.getTime() - Date.now()) / 86400000);
      if (days < 0) { mod.issues++; mod.details.push(`error: Certificate EXPIRED ${Math.abs(days)} days ago`); mod.status = "failed"; }
      else if (days < 14) { mod.issues++; mod.details.push(`warning: Expires in ${days} days`); if (mod.status !== "failed") mod.status = "warning"; }
      else { mod.details.push(`pass: Valid for ${days} days (expires ${expiry.toISOString().split("T")[0]})`); }

      mod.checks++;
      const proto = socket.getProtocol();
      if (proto === "TLSv1" || proto === "TLSv1.1") { mod.issues++; mod.details.push(`error: Deprecated ${proto}`); mod.status = "failed"; }
      else { mod.details.push(`pass: ${proto}`); }

      mod.checks++;
      const issuer = cert.issuer?.O || cert.issuer?.CN || "Unknown";
      mod.details.push(`info: Issued by ${issuer}`);

      socket.end(); resolve(mod);
    });
    socket.on("error", (e) => { mod.checks++; mod.issues++; mod.details.push(`error: ${e.message}`); mod.status = "failed"; resolve(mod); });
    socket.setTimeout(10000, () => { mod.checks++; mod.issues++; mod.details.push("error: Timeout"); mod.status = "failed"; socket.destroy(); resolve(mod); });
  });
}

async function checkHeaders(url: string): Promise<ModResult> {
  const mod: ModResult = { name: "headers", label: "Security Headers", status: "passed", checks: 0, issues: 0, details: [] };
  const h = await fetchHeaders(url);
  if (!h) { mod.issues++; mod.checks++; mod.details.push("error: Could not fetch"); mod.status = "failed"; return mod; }

  const checks: [string, string, string][] = [
    ["strict-transport-security", "HSTS", "error"],
    ["x-content-type-options", "X-Content-Type-Options", "warning"],
    ["x-frame-options", "X-Frame-Options", "warning"],
    ["content-security-policy", "CSP", "warning"],
    ["referrer-policy", "Referrer-Policy", "info"],
    ["permissions-policy", "Permissions-Policy", "info"],
  ];

  for (const [key, label, sev] of checks) {
    mod.checks++;
    if (!h[key]) {
      if (sev !== "info") mod.issues++;
      mod.details.push(`${sev}: Missing ${label}`);
      if (sev === "error") mod.status = "failed";
      else if (sev === "warning" && mod.status !== "failed") mod.status = "warning";
    } else {
      mod.details.push(`pass: ${label} present`);
    }
  }

  mod.checks++;
  if (h["x-powered-by"]) { mod.issues++; mod.details.push(`warning: X-Powered-By leaks: ${h["x-powered-by"]}`); }
  if (h["server"] && /\d+\.\d+/.test(h["server"])) { mod.issues++; mod.details.push(`warning: Server header leaks version: ${h["server"]}`); }

  return mod;
}

async function checkDNS(hostname: string): Promise<ModResult> {
  const mod: ModResult = { name: "dns", label: "DNS & Email", status: "passed", checks: 0, issues: 0, details: [] };

  mod.checks++;
  try {
    const addrs = await new Promise<string[]>((res, rej) => dns.resolve4(hostname, (e, a) => e ? rej(e) : res(a)));
    mod.details.push(`pass: ${addrs.length} A record(s)`);
  } catch { mod.details.push("warning: No A records"); mod.issues++; }

  mod.checks++;
  try {
    await new Promise<string[]>((res, rej) => dns.resolve6(hostname, (e, a) => e ? rej(e) : res(a)));
    mod.details.push("pass: IPv6 available");
  } catch { mod.details.push("info: No IPv6"); }

  mod.checks++;
  try {
    const txt = await new Promise<string[][]>((res, rej) => dns.resolveTxt(hostname, (e, r) => e ? rej(e) : res(r)));
    const flat = txt.map(r => r.join("")).join("\n");
    if (flat.includes("v=spf1")) mod.details.push("pass: SPF record found");
    else { mod.issues++; mod.details.push("warning: No SPF — email spoofing risk"); }
  } catch { mod.details.push("info: No TXT records"); }

  mod.checks++;
  try {
    await new Promise<string[][]>((res, rej) => dns.resolveTxt(`_dmarc.${hostname}`, (e, r) => e ? rej(e) : res(r)));
    mod.details.push("pass: DMARC configured");
  } catch { mod.issues++; mod.details.push("warning: No DMARC — email auth missing"); }

  return mod;
}

async function checkPerformance(url: string): Promise<ModResult> {
  const mod: ModResult = { name: "performance", label: "Performance", status: "passed", checks: 0, issues: 0, details: [] };

  mod.checks++;
  try {
    const { status, headers, ttfb } = await timedGet(url);
    mod.details.push(`info: TTFB ${ttfb}ms`);
    mod.checks++;
    if (ttfb > 2000) { mod.issues++; mod.details.push("error: TTFB > 2s"); mod.status = "failed"; }
    else if (ttfb > 800) { mod.issues++; mod.details.push("warning: TTFB > 800ms"); if (mod.status !== "failed") mod.status = "warning"; }
    else { mod.details.push("pass: TTFB under 800ms"); }

    mod.checks++;
    const enc = headers["content-encoding"];
    if (enc?.includes("gzip") || enc?.includes("br")) mod.details.push(`pass: Compression (${enc})`);
    else { mod.issues++; mod.details.push("warning: No compression"); }

    mod.checks++;
    if (status >= 200 && status < 300) mod.details.push(`pass: HTTP ${status}`);
    else { mod.issues++; mod.details.push(`error: HTTP ${status}`); mod.status = "failed"; }
  } catch (e) {
    mod.issues++; mod.details.push(`error: ${e instanceof Error ? e.message : "Failed"}`); mod.status = "failed";
  }

  return mod;
}

// auth-public — probes a caller-supplied PUBLIC host and returns findings about
// that host only: no stored data, no AI spend. Reached credential-free by
// /api/admin/triage's server-to-server callScan. SSRF-guarded to public IPs and
// web ports, rate limited (_hostScanLimiter, PRESETS.webScan). Audited
// 2026-09-29: cheap and intentionally public.
export async function POST(req: NextRequest) {
  let body: { url?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  let url = (body.url || "").trim();
  if (!url) return NextResponse.json({ error: "URL required" }, { status: 400 });
  if (!url.startsWith("http")) url = `https://${url}`;

  let parsed: URL;
  try { parsed = new URL(url); } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  // SSRF: the hostname must resolve to a PUBLIC address before we open a
  // socket to it — this route accepted any host:port and used tls.connect /
  // http.request against it, an unauthenticated internal port scanner
  // (2026-08-18 audit). Web ports only.
  const validated = await resolveAndValidateUrl(url);
  if (!validated.ok) {
    return NextResponse.json({ error: "That host cannot be scanned: it does not resolve to a public internet address" }, { status: 400 });
  }
  const explicitPort = parsed.port ? Number(parsed.port) : 0;
  if (explicitPort && ![80, 443, 8080, 8443].includes(explicitPort)) {
    return NextResponse.json({ error: "Only web ports (80, 443, 8080, 8443) can be scanned" }, { status: 400 });
  }
  const rl = await _hostScanLimiter.guard(req);
  if (!rl.allowed) {
    return NextResponse.json(rl.body || { error: "Too many scans — try again in a minute" }, { status: rl.status || 429, headers: rl.headers });
  }

  const start = Date.now();
  const isHttps = parsed.protocol === "https:";

  const results = await Promise.allSettled([
    isHttps ? checkSSL(parsed.hostname, Number(parsed.port) || 443) : Promise.resolve({ name: "ssl", label: "SSL", status: "failed" as const, checks: 1, issues: 1, details: ["error: Not using HTTPS"] }),
    checkHeaders(url),
    checkDNS(parsed.hostname),
    checkPerformance(url),
  ]);

  const modules: ModResult[] = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return { name: ["ssl", "headers", "dns", "performance"][i], label: "", status: "failed" as const, checks: 1, issues: 1, details: [`error: ${r.reason?.message || "Failed"}`] };
  });

  const totalIssues = modules.reduce((s, m) => s + m.issues, 0);
  const totalChecks = modules.reduce((s, m) => s + m.checks, 0);

  return NextResponse.json({
    status: totalIssues === 0 ? "complete" : "complete",
    url,
    hostname: parsed.hostname,
    modules,
    totalModules: modules.length,
    completedModules: modules.length,
    totalIssues,
    totalChecks,
    totalFixed: 0,
    duration: Date.now() - start,
    scanType: "server",
  });
}
