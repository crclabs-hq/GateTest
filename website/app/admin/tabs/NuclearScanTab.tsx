"use client";
import { PLATFORM_SITE_URL } from "@/app/lib/platform-config";

import { useState } from "react";
import { NuclearFixSnippets } from "./NuclearFixSnippets";

// The "Forensic Scan" tab — full-stack domain diagnosis (DNS, ports, SSL,
// headers, performance, availability, redirects, email auth), then "Fix
// Everything": config snippets for any domain, and SSH heal ONLY when the
// scanned hostname is one our server serves. /api/heal/ssh always connects to
// our own box (GATETEST_SSH_HOST), so running it after scanning someone
// else's domain used to run playbooks on our production server and could
// report the server as healed. The tab now asks the route first (dryRun) and says
// why when SSH heal is off.

interface NuclearFinding {
  category: string;
  severity: "error" | "warning" | "info" | "pass";
  title: string;
  detail: string;
}

type HealGate =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; hostname: string }
  | { kind: "off"; reason: string };

interface HealAction { issue: string; label?: string; command: string; output: string; status: string }

const HEAL_HEADINGS: Record<string, string> = {
  completed: "Heal commands ran",
  partial: "Some heal commands failed",
  failed: "Heal commands failed",
  no_playbook: "No heal playbook matched",
};

/** Ask /api/heal/ssh (dry run — nothing connects) whether SSH heal is on for this hostname. */
async function checkHealGate(hostname: string): Promise<HealGate> {
  try {
    const res = await fetch("/api/heal/ssh", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname, dryRun: true }),
    });
    const d = (await res.json().catch(() => ({}))) as {
      allowed?: boolean; ready?: boolean; missing?: string[]; error?: string;
    };
    if (res.ok && d.allowed) {
      if (d.ready) return { kind: "available", hostname };
      return { kind: "off", reason: `SSH heal is allowed for ${hostname} but not configured on the server: set ${(d.missing || []).join(" and ")}.` };
    }
    if (d.error === "target_not_configured") {
      return { kind: "off", reason: "SSH heal is off: GATETEST_SSH_HOSTNAMES is not set, so no scanned domain is known to be served by our server." };
    }
    if (d.error === "target_mismatch") {
      return { kind: "off", reason: `SSH heal is off for ${hostname}: it is not one of the hostnames our server serves (GATETEST_SSH_HOSTNAMES). Nothing runs on any server.` };
    }
    if (res.status === 401) return { kind: "off", reason: "Could not check SSH heal: your admin session has expired. Sign in again." };
    return { kind: "off", reason: `Could not check SSH heal (the server answered ${res.status}${d.error ? `, ${d.error}` : ""}).` };
  } catch (e) {
    return { kind: "off", reason: `Could not check SSH heal: ${e instanceof Error ? e.message : "network error"}.` };
  }
}

export function NuclearScanTab() {
  const [url, setUrl] = useState("");
  const [scanning, setScanning] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [fixResult, setFixResult] = useState<Record<string, unknown> | null>(null);
  const [healGate, setHealGate] = useState<HealGate>({ kind: "idle" });
  const [healNote, setHealNote] = useState("");

  async function runNuclear() {
    if (!url) { setError("Enter a URL"); return; }
    setScanning(true); setResult(null); setError(""); setFixResult(null); setHealGate({ kind: "idle" }); setHealNote("");
    try {
      const res = await fetch("/api/scan/nuclear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Scan failed"); return; }
      setResult(data);
      const hostname = typeof data.hostname === "string" ? data.hostname : "";
      if (hostname) {
        setHealGate({ kind: "checking" });
        // Not awaited: the findings render now; the gate line fills in after.
        checkHealGate(hostname).then(setHealGate);
      } else {
        setHealGate({ kind: "off", reason: "The scan returned no hostname, so SSH heal cannot be matched to a server." });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally { setScanning(false); }
  }

  async function fixEverything() {
    if (!result) return;
    setFixing(true);
    setHealNote("");
    try {
      const issueFindings = (result.findings as NuclearFinding[] || [])
        .filter(f => f.severity === "error" || f.severity === "warning");

      // SSH heal only when the route has said this hostname is ours.
      if (healGate.kind === "available" && issueFindings.length > 0) {
        try {
          const sshRes = await fetch("/api/heal/ssh", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              hostname: healGate.hostname,
              issues: issueFindings.map(f => ({
                category: f.category,
                title: f.title,
                detail: f.detail,
              })),
            }),
          });
          const sshData = await sshRes.json().catch(() => ({}));
          if (sshRes.ok && Array.isArray(sshData.actions) && sshData.actions.length > 0) {
            setFixResult(sshData);
            return;
          }
          setHealNote(
            sshData.reason || sshData.message ||
            `SSH heal did not run (the server answered ${sshRes.status}${sshData.error ? `, ${sshData.error}` : ""}).`,
          );
        } catch (e) {
          setHealNote(`SSH heal did not run: ${e instanceof Error ? e.message : "network error"}.`);
        }
      }

      // Config snippets — for any domain; nothing runs on a server.
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
  const healActions = (fixResult?.actions as HealAction[] | undefined) || null;

  return (
    <>
      <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6 mb-6 border-l-4 border-l-gray-900">
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
            placeholder={PLATFORM_SITE_URL}
            className="flex-1 px-4 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 text-sm"
          />
          <button
            onClick={runNuclear}
            disabled={scanning}
            className="btn-primary px-6 py-3 text-sm font-bold disabled:opacity-50"
            style={{ background: "#111827" }}
          >
            {scanning ? "Scanning..." : "☢ Forensic Scan"}
          </button>
        </div>
        {error && <p role="alert" className="text-gray-900 font-medium text-sm mt-3">{error}</p>}
      </div>

      {scanning && (
        <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-8 text-center">
          <div className="w-10 h-10 border-2 border-gray-900 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="font-bold">Running full-stack diagnosis...</p>
          <p className="text-xs text-gray-500 mt-1">DNS · Ports · SSL · Headers · Performance · Redirects · Email</p>
        </div>
      )}

      {result && !scanning && (
        <>
          {/* Diagnosis */}
          <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6 mb-4 border-l-4 border-l-gray-900">
            <h3 className="font-bold mb-3">Diagnosis</h3>
            {diagnosis.map((d, i) => (
              <p key={i} className={`text-sm mb-1 ${d.startsWith("ROOT CAUSE") ? "text-gray-900 font-bold" : d.startsWith("FIX") ? "text-emerald-700 font-medium" : "text-gray-800"}`}>
                {d}
              </p>
            ))}
            <div className="mt-4 grid grid-cols-4 gap-2 text-center">
              <div className="p-3 bg-gray-100 rounded-lg border border-gray-300">
                <div className="text-2xl font-bold text-gray-900">{summary?.errors ?? 0}</div>
                <div className="text-xs text-gray-500">Errors</div>
              </div>
              <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
                <div className="text-2xl font-bold text-gray-700">{summary?.warnings ?? 0}</div>
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
                  disabled={fixing || healGate.kind === "checking"}
                  className="btn-primary w-full py-4 text-base font-bold disabled:opacity-50"
                  style={{ background: "#059669" }}
                >
                  {fixing ? "Generating fix plan..." : "⚡ Fix Everything Automatically"}
                </button>
                <p className="text-xs text-gray-400 text-center mt-2">
                  Generates ready-to-apply fixes for every issue found. Code fixes go to a PR; config fixes produce Vercel/Nginx/DNS snippets.
                </p>
                <p className="text-xs text-gray-600 text-center mt-1" data-testid="heal-gate">
                  {healGate.kind === "checking" && "Checking whether SSH heal is available for this domain…"}
                  {healGate.kind === "available" && `SSH heal is available for ${healGate.hostname}: Fix Everything runs read-only diagnostics and restarts the app's own services on our server, then shows exactly what ran.`}
                  {healGate.kind === "off" && `${healGate.reason} Fix Everything generates config snippets only.`}
                </p>
              </div>
            )}
          </div>

          {/* Fixes */}
          {fixResult && (
            <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-5 mb-4">
              {healActions ? (
                <>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xl">{fixResult.status === "completed" ? "✓" : "⚡"}</span>
                    <h3 className="font-bold text-gray-900">
                      {HEAL_HEADINGS[String(fixResult.status)] || "Heal attempted"}
                    </h3>
                  </div>
                  <p className="text-sm text-gray-500 mb-3">
                    {fixResult.message as string}
                  </p>
                  <div className="space-y-2">
                    {healActions.map((a, i) => (
                      <div key={i} className={`rounded-lg border p-3 text-xs ${
                        a.status === "ran" ? "border-emerald-200 bg-emerald-50" : "border-gray-300 bg-gray-50"
                      }`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className={a.status === "ran" ? "text-emerald-600" : "text-gray-900 font-bold"}>
                            {a.status === "ran" ? "ran" : "failed"}
                          </span>
                          <span className="font-medium text-gray-800">{a.issue}{a.label ? ` — ${a.label}` : ""}</span>
                        </div>
                        <pre className="font-mono text-xs bg-gray-900 text-gray-300 p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap">{a.output || "(no output)"}</pre>
                      </div>
                    ))}
                  </div>
                </>
              ) : fixResult.fixes && Object.keys(fixResult.fixes as Record<string, unknown>).length > 0 ? (
                <>
                  {healNote && <p className="text-xs text-gray-600 mb-3">{healNote} Config snippets instead:</p>}
                  <NuclearFixSnippets fixResult={fixResult} />
                </>
              ) : (
                <div>
                  <h3 className="font-bold mb-2 text-gray-900">No config snippets for these findings</h3>
                  <p className="text-sm text-gray-600">
                    The snippet generator had nothing to offer for these findings, and nothing was run on any server.
                  </p>
                  {(healNote || healGate.kind === "off") && (
                    <p className="text-xs text-gray-500 mt-2">
                      {healNote || (healGate.kind === "off" ? healGate.reason : "")}
                    </p>
                  )}
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
                        f.severity === "error" ? "text-gray-900" :
                        f.severity === "warning" ? "text-gray-600" :
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
