"use client";

import { useState } from "react";
import { NuclearFixSnippets } from "./NuclearFixSnippets";

// The "Forensic Scan" tab — full-stack domain diagnosis (DNS, ports, SSL,
// headers, performance, availability, redirects, email auth) with SSH
// auto-heal when credentials are available, config snippets otherwise.

interface NuclearFinding {
  category: string;
  severity: "error" | "warning" | "info" | "pass";
  title: string;
  detail: string;
}

export function NuclearScanTab() {
  const [url, setUrl] = useState("");
  const [scanning, setScanning] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [fixResult, setFixResult] = useState<Record<string, unknown> | null>(null);

  async function runNuclear() {
    if (!url) { setError("Enter a URL"); return; }
    setScanning(true); setResult(null); setError(""); setFixResult(null);
    try {
      const res = await fetch("/api/scan/nuclear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Scan failed"); return; }
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally { setScanning(false); }
  }

  async function fixEverything() {
    if (!result) return;
    setFixing(true);
    try {
      const issueFindings = (result.findings as NuclearFinding[] || [])
        .filter(f => f.severity === "error" || f.severity === "warning");

      // Try SSH auto-heal first (autonomous fix)
      const ip = result.resolvedIp as string || "";
      if (ip && issueFindings.length > 0) {
        try {
          const sshRes = await fetch("/api/heal/ssh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              host: ip,
              hostname: result.hostname,
              issues: issueFindings.map(f => ({
                category: f.category,
                title: f.title,
                detail: f.detail,
              })),
            }),
          });
          const sshData = await sshRes.json();
          if (sshRes.ok && sshData.status !== "failed") {
            setFixResult(sshData);
            return;
          }
          // SSH failed (no credentials etc.) — fall through to config snippets
        } catch {
          // SSH agent not available — fall through
        }
      }

      // Fallback: generate config snippets
      const res = await fetch("/api/scan/server-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostname: result.hostname,
          modules: issueFindings.reduce((acc, f) => {
            const cat = f.category.toLowerCase().replace(/[^a-z]/g, "");
            const existing = acc.find((m) => m.name === cat);
            if (existing) { existing.details.push(`${f.severity}: ${f.title} - ${f.detail}`); }
            else { acc.push({ name: cat, status: "failed", details: [`${f.severity}: ${f.title} - ${f.detail}`] }); }
            return acc;
          }, [] as Array<{ name: string; status: string; details: string[] }>),
        }),
      });
      const data = await res.json();
      setFixResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fix failed");
    } finally { setFixing(false); }
  }

  const findings = (result?.findings as NuclearFinding[]) || [];
  const summary = result?.summary as { errors: number; warnings: number; passes: number; total: number } | undefined;
  const diagnosis = (result?.diagnosis as string[]) || [];

  return (
    <>
      <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6 mb-6 border-l-4 border-l-red-500">
        <div className="flex items-start gap-3 mb-3">
          <span className="text-2xl">☢</span>
          <div>
            <h3 className="font-bold text-lg">Forensic Scan</h3>
            <p className="text-sm text-gray-500">Find <strong>anything</strong> and <strong>everything</strong> wrong with a domain. Full stack diagnosis — DNS, ports, SSL, headers, performance, availability, redirects, email auth. Root-cause pinpointed automatically.</p>
          </div>
        </div>
        <div className="flex gap-3">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runNuclear(); }}
            placeholder="https://vapron.ai"
            className="flex-1 px-4 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 text-sm"
          />
          <button
            onClick={runNuclear}
            disabled={scanning}
            className="btn-primary px-6 py-3 text-sm font-bold disabled:opacity-50"
            style={{ background: "#dc2626" }}
          >
            {scanning ? "Scanning..." : "☢ Forensic Scan"}
          </button>
        </div>
        {error && <p className="text-danger text-sm mt-3">{error}</p>}
      </div>

      {scanning && (
        <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-8 text-center">
          <div className="w-10 h-10 border-2 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="font-bold">Running full-stack diagnosis...</p>
          <p className="text-xs text-gray-500 mt-1">DNS · Ports · SSL · Headers · Performance · Redirects · Email</p>
        </div>
      )}

      {result && !scanning && (
        <>
          {/* Diagnosis */}
          <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6 mb-4 border-l-4 border-l-red-500">
            <h3 className="font-bold mb-3">Diagnosis</h3>
            {diagnosis.map((d, i) => (
              <p key={i} className={`text-sm mb-1 ${d.startsWith("ROOT CAUSE") ? "text-red-700 font-bold" : d.startsWith("FIX") ? "text-emerald-700 font-medium" : "text-gray-800"}`}>
                {d}
              </p>
            ))}
            <div className="mt-4 grid grid-cols-4 gap-2 text-center">
              <div className="p-3 bg-red-50 rounded-lg border border-red-200">
                <div className="text-2xl font-bold text-red-600">{summary?.errors ?? 0}</div>
                <div className="text-xs text-gray-500">Errors</div>
              </div>
              <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
                <div className="text-2xl font-bold text-amber-600">{summary?.warnings ?? 0}</div>
                <div className="text-xs text-gray-500">Warnings</div>
              </div>
              <div className="p-3 bg-emerald-50 rounded-lg border border-emerald-200">
                <div className="text-2xl font-bold text-emerald-600">{summary?.passes ?? 0}</div>
                <div className="text-xs text-gray-500">Passes</div>
              </div>
              <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
                <div className="text-2xl font-bold text-gray-700">{summary?.total ?? 0}</div>
                <div className="text-xs text-gray-500">Total Checks</div>
              </div>
            </div>
            {(summary?.errors ?? 0) + (summary?.warnings ?? 0) > 0 && (
              <div className="mt-5">
                <button
                  onClick={fixEverything}
                  disabled={fixing}
                  className="btn-primary w-full py-4 text-base font-bold disabled:opacity-50"
                  style={{ background: "#059669" }}
                >
                  {fixing ? "Generating fix plan..." : "⚡ Fix Everything Automatically"}
                </button>
                <p className="text-xs text-gray-400 text-center mt-2">
                  Generates ready-to-apply fixes for every issue found. Code fixes go to a PR; config fixes produce Vercel/Nginx/DNS snippets.
                </p>
              </div>
            )}
          </div>

          {/* Fixes */}
          {fixResult && (
            <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-5 mb-4">
              {/* SSH auto-heal result */}
              {(fixResult as Record<string, unknown>).actions ? (
                <>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xl">{(fixResult as Record<string, unknown>).status === "healed" ? "✅" : "⚡"}</span>
                    <h3 className="font-bold text-gray-900">
                      {(fixResult as Record<string, unknown>).status === "healed"
                        ? "Server Healed"
                        : (fixResult as Record<string, unknown>).status === "partial"
                          ? "Partially Healed"
                          : "Heal Attempted"}
                    </h3>
                  </div>
                  <p className="text-sm text-gray-500 mb-3">
                    {(fixResult as Record<string, unknown>).message as string}
                  </p>
                  <div className="space-y-2">
                    {((fixResult as Record<string, unknown>).actions as Array<{ issue: string; command: string; output: string; status: string }>).map((a, i) => (
                      <div key={i} className={`rounded-lg border p-3 text-xs ${
                        a.status === "fixed" ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"
                      }`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className={a.status === "fixed" ? "text-emerald-600" : "text-red-600"}>
                            {a.status === "fixed" ? "✓" : "✗"}
                          </span>
                          <span className="font-medium text-gray-800">{a.issue}</span>
                        </div>
                        <pre className="font-mono text-xs bg-gray-900 text-gray-300 p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap">{a.output || "(no output)"}</pre>
                      </div>
                    ))}
                  </div>
                </>
              ) : (fixResult as Record<string, unknown>).fixes && Object.keys((fixResult as Record<string, unknown>).fixes as Record<string, unknown>).length > 0 ? (
                <NuclearFixSnippets fixResult={fixResult as Record<string, unknown>} />
              ) : (
                <div>
                  <h3 className="font-bold mb-2 text-gray-900">⚡ Fix attempted</h3>
                  <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 mb-3">
                    <p className="text-sm text-amber-800 font-medium">SSH credentials not found</p>
                    <p className="text-xs text-amber-700 mt-1">
                      Set these env vars in Vercel, then <strong>trigger a new deployment</strong> — env vars only take effect after redeployment.
                    </p>
                  </div>
                  <ul className="text-xs font-mono bg-gray-50 border border-gray-200 rounded p-3 space-y-1.5 text-gray-700">
                    <li><span className="text-emerald-700 font-bold">GATETEST_SSH_HOST</span> — server IP (e.g. 45.76.171.37)</li>
                    <li><span className="text-gray-500 font-bold">GATETEST_SSH_USER</span> — username (default: root)</li>
                    <li><span className="text-emerald-700 font-bold">GATETEST_SSH_PASSWORD</span> — server password</li>
                  </ul>
                  <p className="text-xs text-gray-400 mt-2">
                    Or use <span className="font-mono">GATETEST_SSH_KEY</span> (PEM private key) instead of a password.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Findings by category */}
          {(() => {
            const byCategory = findings.reduce((acc: Record<string, NuclearFinding[]>, f) => {
              (acc[f.category] = acc[f.category] || []).push(f);
              return acc;
            }, {});
            return Object.entries(byCategory).map(([cat, items]) => (
              <div key={cat} className="rounded-xl bg-white border border-gray-200 shadow-sm p-4 mb-3">
                <h4 className="font-bold text-sm mb-2 text-gray-800">{cat}</h4>
                <div className="space-y-1">
                  {items.map((f, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className={`font-bold shrink-0 w-16 ${
                        f.severity === "error" ? "text-red-600" :
                        f.severity === "warning" ? "text-amber-600" :
                        f.severity === "pass" ? "text-emerald-600" :
                        "text-gray-400"
                      }`}>{f.severity.toUpperCase()}</span>
                      <span className="font-medium shrink-0 min-w-[140px] text-gray-700">{f.title}</span>
                      <span className="text-gray-400">{f.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            ));
          })()}
        </>
      )}
    </>
  );
}
