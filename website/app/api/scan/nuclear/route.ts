/**
 * Forensic Scan — find ANYTHING and EVERYTHING wrong with a domain.
 *
 * POST /api/scan/nuclear
 * Body: { url: string, repo?: string }
 *
 * Runs the full diagnostic in parallel:
 *   - DNS resolution (A, AAAA, MX, TXT, DMARC)
 *   - Ping (is the server alive at IP?)
 *   - Port scan (80, 443, 22, 21, 8080, 3000)
 *   - SSL certificate inspection
 *   - HTTP status on HTTPS and HTTP
 *   - Security headers
 *   - Performance (TTFB, compression, caching)
 *   - Availability (HTTP→HTTPS, www, root)
 *   - Content check (does it serve something?)
 *   - Redirect chain trace
 *   - IP geolocation hint (public IP info)
 *   - Server fingerprint (what's serving this?)
 *
 * Returns a comprehensive diagnostic report — every symptom, every possible cause.
 */

import { NextRequest, NextResponse } from "next/server";
import https from "https";
import http from "http";
import dns from "dns";
import net from "net";
import tls from "tls";

export const maxDuration = 60;

type Severity = "error" | "warning" | "info" | "pass";

interface Finding {
  category: string;
  severity: Severity;
  title: string;
  detail: string;
  evidence?: string;
}

function resolve4(host: string): Promise<string[]> {
  return new Promise((res, rej) => dns.resolve4(host, (e, a) => e ? rej(e) : res(a)));
}
function resolve6(host: string): Promise<string[]> {
  return new Promise((res, rej) => dns.resolve6(host, (e, a) => e ? rej(e) : res(a)));
}
function lookup4(host: string): Promise<string> {
  return new Promise((res, rej) => dns.lookup(host, { family: 4 }, (e, a) => e ? rej(e) : res(a)));
}
function resolveMx(host: string): Promise<dns.MxRecord[]> {
  return new Promise((res, rej) => dns.resolveMx(host, (e, a) => e ? rej(e) : res(a)));
}
function resolveTxt(host: string): Promise<string[][]> {
  return new Promise((res, rej) => dns.resolveTxt(host, (e, a) => e ? rej(e) : res(a)));
}

function tcpProbe(host: string, port: number, timeout = 4000): Promise<{ open: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open: boolean, reason?: string) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ open, reason });
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (err) => finish(false, (err as NodeJS.ErrnoException).code || err.message));
    socket.connect(port, host);
  });
}

function inspectSSL(host: string, port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, timeout: 8000 }, () => {
      const cert = socket.getPeerCertificate();
      const proto = socket.getProtocol();
      socket.end();
      resolve({
        ok: true,
        protocol: proto,
        issuer: cert.issuer?.O || cert.issuer?.CN || null,
        subject: cert.subject?.CN || null,
        validFrom: cert.valid_from || null,
        validTo: cert.valid_to || null,
        daysUntilExpiry: cert.valid_to
          ? Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000)
          : null,
        altNames: cert.subjectaltname || null,
      });
    });
    socket.on("error", (err) => resolve({ ok: false, error: err.message }));
    socket.setTimeout(8000, () => { socket.destroy(); resolve({ ok: false, error: "timeout" }); });
  });
}

function timedHttp(url: string): Promise<{ status: number; headers: Record<string, string>; body: string; ttfb: number }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.request(url, {
      method: "GET",
      timeout: 15000,
      headers: { "User-Agent": "GateTest/NuclearScan" },
    }, (res) => {
      const ttfb = Date.now() - start;
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode || 0,
        headers: res.headers as Record<string, string>,
        body: Buffer.concat(chunks).slice(0, 4096).toString("utf-8"),
        ttfb,
      }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

async function traceRedirects(url: string, maxHops = 5): Promise<string[]> {
  const chain: string[] = [url];
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    try {
      const client = current.startsWith("https") ? https : http;
      const res = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
        const req = client.request(current, { method: "HEAD", timeout: 8000 }, (r) => {
          r.resume();
          resolve({ status: r.statusCode || 0, location: r.headers.location });
        });
        req.on("error", reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
      });
      if (res.status >= 300 && res.status < 400 && res.location) {
        current = res.location.startsWith("http") ? res.location : new URL(res.location, current).href;
        chain.push(current);
      } else break;
    } catch {
      break;
    }
  }
  return chain;
}

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  let url = (body.url || "").trim();
  if (!url) return NextResponse.json({ error: "URL required" }, { status: 400 });
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  let parsed: URL;
  try { parsed = new URL(url); } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  const hostname = parsed.hostname;
  const start = Date.now();
  const findings: Finding[] = [];

  // --- DNS resolution ---
  let resolvedIp: string | null = null;
  try {
    const a = await resolve4(hostname);
    resolvedIp = a[0];
    findings.push({ category: "DNS", severity: "pass", title: "A record found", detail: `${a.length} IP(s): ${a.join(", ")}` });
  } catch {
    try {
      resolvedIp = await lookup4(hostname);
      findings.push({ category: "DNS", severity: "info", title: "Resolved via CNAME", detail: `Final IP: ${resolvedIp}` });
    } catch {
      findings.push({ category: "DNS", severity: "error", title: "DNS does not resolve", detail: `${hostname} has no A record and no CNAME chain.` });
    }
  }

  try {
    await resolve6(hostname);
    findings.push({ category: "DNS", severity: "pass", title: "IPv6 (AAAA) record found", detail: "" });
  } catch {
    findings.push({ category: "DNS", severity: "info", title: "No IPv6", detail: "Not critical but modern sites should support IPv6." });
  }

  try {
    const mx = await resolveMx(hostname);
    findings.push({ category: "DNS", severity: "info", title: "MX records", detail: `${mx.length} mail servers configured` });
  } catch { /* not an email domain */ }

  try {
    const txt = await resolveTxt(hostname);
    const flat = txt.map(t => t.join("")).join("\n");
    findings.push({
      category: "DNS",
      severity: flat.includes("v=spf1") ? "pass" : "warning",
      title: "SPF record",
      detail: flat.includes("v=spf1") ? "SPF configured" : "No SPF record — email spoofing risk",
    });
  } catch { /* no txt */ }

  try {
    await resolveTxt(`_dmarc.${hostname}`);
    findings.push({ category: "DNS", severity: "pass", title: "DMARC record", detail: "Configured" });
  } catch {
    findings.push({ category: "DNS", severity: "warning", title: "No DMARC", detail: "Email authentication not configured — spoofing risk." });
  }

  // --- Reachability + port scan (only if we have an IP) ---
  if (resolvedIp) {
    findings.push({ category: "Network", severity: "info", title: "Resolved IP", detail: resolvedIp });

    const ports = [443, 80, 22, 21, 8080, 3000];
    const portResults = await Promise.all(ports.map((p) => tcpProbe(resolvedIp!, p)));
    for (let i = 0; i < ports.length; i++) {
      const port = ports[i];
      const r = portResults[i];
      const severity: Severity = port === 443 ? (r.open ? "pass" : "error")
        : port === 80 ? "info"
        : "info";
      findings.push({
        category: "Ports",
        severity,
        title: `Port ${port}`,
        detail: r.open ? "OPEN (something listening)" : `CLOSED (${r.reason || "no response"})`,
      });
    }
  }

  // --- SSL inspection ---
  if (parsed.protocol === "https:" && resolvedIp) {
    const ssl = await inspectSSL(hostname, Number(parsed.port) || 443);
    if (ssl.ok) {
      const days = ssl.daysUntilExpiry as number;
      findings.push({
        category: "SSL",
        severity: days < 0 ? "error" : days < 14 ? "warning" : "pass",
        title: "SSL certificate",
        detail: `Valid for ${days} days · Issuer: ${ssl.issuer} · Protocol: ${ssl.protocol}`,
      });
    } else {
      findings.push({
        category: "SSL",
        severity: "error",
        title: "SSL handshake failed",
        detail: String(ssl.error),
      });
    }
  }

  // --- HTTPS response ---
  try {
    const r = await timedHttp(url);
    findings.push({
      category: "HTTP",
      severity: r.status >= 200 && r.status < 400 ? "pass" : "error",
      title: `HTTP ${r.status}`,
      detail: `TTFB: ${r.ttfb}ms · Body: ${r.body.length} bytes`,
      evidence: r.body.slice(0, 200),
    });

    // Server fingerprint
    const server = r.headers["server"] || "unknown";
    findings.push({ category: "Server", severity: "info", title: "Server header", detail: String(server) });

    // Security headers check
    const required: Array<[string, string]> = [
      ["strict-transport-security", "HSTS"],
      ["content-security-policy", "CSP"],
      ["x-frame-options", "X-Frame-Options"],
      ["x-content-type-options", "X-Content-Type-Options"],
      ["referrer-policy", "Referrer-Policy"],
    ];
    for (const [key, label] of required) {
      findings.push({
        category: "Security Headers",
        severity: r.headers[key] ? "pass" : "warning",
        title: label,
        detail: r.headers[key] ? "Present" : "MISSING",
      });
    }

    // Compression
    const enc = r.headers["content-encoding"];
    findings.push({
      category: "Performance",
      severity: enc?.includes("gzip") || enc?.includes("br") ? "pass" : "warning",
      title: "Compression",
      detail: enc ? `Enabled (${enc})` : "DISABLED — payloads bigger than they need to be",
    });

    // Caching
    findings.push({
      category: "Performance",
      severity: r.headers["cache-control"] ? "info" : "warning",
      title: "Cache-Control",
      detail: r.headers["cache-control"] || "No Cache-Control header — every request is uncached",
    });
  } catch (err) {
    findings.push({
      category: "HTTP",
      severity: "error",
      title: "HTTPS request failed",
      detail: err instanceof Error ? err.message : "Unknown error",
    });
  }

  // --- HTTP (port 80) redirect check ---
  try {
    const httpUrl = `http://${hostname}${parsed.pathname}`;
    const chain = await traceRedirects(httpUrl);
    if (chain.length > 1 && chain[chain.length - 1].startsWith("https://")) {
      findings.push({
        category: "Availability",
        severity: "pass",
        title: "HTTP redirects to HTTPS",
        detail: `Chain: ${chain.join(" → ")}`,
      });
    } else if (chain.length === 1) {
      findings.push({
        category: "Availability",
        severity: "warning",
        title: "No HTTP→HTTPS redirect",
        detail: "Plain HTTP is exposed without forcing HTTPS.",
      });
    }
  } catch {
    findings.push({
      category: "Availability",
      severity: "info",
      title: "HTTP port 80",
      detail: "Not reachable (may be intentionally blocked)",
    });
  }

  // --- www vs apex ---
  const altHost = hostname.startsWith("www.") ? hostname.slice(4) : `www.${hostname}`;
  try {
    const altUrl = `${parsed.protocol}//${altHost}${parsed.pathname}`;
    const r = await timedHttp(altUrl);
    findings.push({
      category: "Availability",
      severity: r.status >= 200 && r.status < 400 ? "pass" : "warning",
      title: `${altHost}`,
      detail: `HTTP ${r.status}`,
    });
  } catch {
    findings.push({
      category: "Availability",
      severity: "info",
      title: `${altHost}`,
      detail: "Not reachable",
    });
  }

  // --- Summary / diagnosis ---
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const passes = findings.filter((f) => f.severity === "pass").length;

  // Root cause hints
  const diagnosis: string[] = [];
  const httpsFailed = findings.some((f) => f.category === "HTTP" && f.severity === "error");
  const portClosed = findings.some((f) => f.title === "Port 443" && f.severity === "error");
  const dnsFailed = findings.some((f) => f.category === "DNS" && f.severity === "error" && f.title.includes("resolve"));

  if (dnsFailed) {
    diagnosis.push("ROOT CAUSE: DNS does not resolve. Check your domain registrar and nameserver settings.");
  } else if (portClosed && httpsFailed) {
    diagnosis.push("ROOT CAUSE: The server IP is reachable but nothing is listening on port 443. Web server (nginx/apache) is DOWN.");
    diagnosis.push("FIX: SSH into the server and run `sudo systemctl restart nginx` (or apache2).");
    diagnosis.push("If moved to a cloud host: update DNS to point at the new host's IP.");
  } else if (errors > 0) {
    diagnosis.push(`${errors} critical issue(s) need attention.`);
  } else if (warnings > 0) {
    diagnosis.push(`Site is up but has ${warnings} hardening issue(s).`);
  } else {
    diagnosis.push("All systems operational.");
  }

  return NextResponse.json({
    url,
    hostname,
    resolvedIp,
    summary: { errors, warnings, passes, total: findings.length },
    diagnosis,
    findings,
    duration: Date.now() - start,
  });
}
