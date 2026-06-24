"use client";

import { useEffect, useState } from "react";

interface ControlStatus {
  id: string;
  framework: "SOC2" | "HIPAA" | "BOTH";
  name: string;
  status: "in_place" | "manual" | "todo";
  evidence: string;
}

interface Snapshot {
  generatedAt: string;
  retention: { auditLogYears: number; scansDays: number };
  encryption: { atRest: string; inTransit: string };
  controls: ControlStatus[];
  audit: {
    totalEvents: number;
    last30Days: number;
    last24Hours: number;
    distinctActorsLast30Days: number;
    chainOk: boolean | null;
    chainBrokenAt?: number;
  };
  adminAuth: { lockedAccountsNow: number; failedAttemptsLast24Hours: number };
  schemaPresent: { audit_log: boolean; admin_auth_attempts: boolean; customer_memory: boolean };
}

const STATUS_COLOUR: Record<ControlStatus["status"], string> = {
  in_place: "bg-emerald-100 text-emerald-800 border-emerald-200",
  manual: "bg-amber-100 text-amber-800 border-amber-200",
  todo: "bg-red-100 text-red-800 border-red-200",
};

const FRAMEWORK_COLOUR: Record<ControlStatus["framework"], string> = {
  SOC2: "bg-blue-100 text-blue-800",
  HIPAA: "bg-purple-100 text-purple-800",
  BOTH: "bg-indigo-100 text-indigo-800",
};

export default function CompliancePage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const run = async () => {
      try {
        const res = await fetch("/api/admin/compliance", { credentials: "same-origin" });
        if (res.status === 401) {
          setError("Not authenticated — log in via /admin first.");
          return;
        }
        const json = await res.json();
        if (!res.ok || json.error) {
          setError(json.error || `HTTP ${res.status}`);
          return;
        }
        setData(json as Snapshot);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    run();
  }, []);

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900">
      <nav className="border-b border-gray-200 bg-white px-4 sm:px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-600 flex items-center justify-center shadow-sm">
              <span className="text-white font-bold text-base font-mono">C</span>
            </div>
            <span className="text-lg font-semibold tracking-tight text-gray-900">Compliance</span>
          </div>
          <a href="/admin" className="text-sm text-gray-500 hover:text-gray-900 transition-colors">Back to admin &rarr;</a>
        </div>
      </nav>

      <section className="px-4 sm:px-6 py-6 max-w-5xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900">Always-audit-ready</h1>
          <p className="text-sm text-gray-600 mt-1 leading-relaxed">
            SOC2 + HIPAA controls inventory, hash-chained audit log activity, and admin lockout state. Read-only.
          </p>
        </header>

        {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

        {!data && !error && <div className="text-sm text-gray-500">Loading…</div>}

        {data && (
          <>
            <article className="rounded-xl border border-gray-200 bg-white shadow-sm p-5">
              <header className="flex items-center justify-between mb-3">
                <span className="text-xs uppercase tracking-wider font-bold text-gray-700">Controls inventory</span>
                <span className="text-xs text-gray-400">snapshot {new Date(data.generatedAt).toUTCString()}</span>
              </header>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-gray-500 border-b border-gray-200">
                      <th className="py-2 pr-3">ID</th>
                      <th className="py-2 pr-3">Framework</th>
                      <th className="py-2 pr-3">Control</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.controls.map((c) => (
                      <tr key={c.id} className="border-b border-gray-100">
                        <td className="py-2 pr-3 font-mono text-xs text-gray-700">{c.id}</td>
                        <td className="py-2 pr-3"><span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${FRAMEWORK_COLOUR[c.framework]}`}>{c.framework}</span></td>
                        <td className="py-2 pr-3 text-gray-800">{c.name}</td>
                        <td className="py-2 pr-3"><span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${STATUS_COLOUR[c.status]}`}>{c.status.replace("_", " ")}</span></td>
                        <td className="py-2 pr-3 text-xs text-gray-500 font-mono break-all">{c.evidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="rounded-xl border border-gray-200 bg-white shadow-sm p-5">
              <header className="mb-3"><span className="text-xs uppercase tracking-wider font-bold text-gray-700">Audit log activity</span></header>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Total events" value={data.audit.totalEvents.toLocaleString()} />
                <Stat label="Last 30 days" value={data.audit.last30Days.toLocaleString()} />
                <Stat label="Last 24 hours" value={data.audit.last24Hours.toLocaleString()} />
                <Stat label="Distinct actors / 30d" value={data.audit.distinctActorsLast30Days.toLocaleString()} />
              </div>
              <div className="mt-4 text-xs">
                {data.audit.chainOk === null && <span className="text-gray-500">Hash chain: not yet verified (table empty or unreachable)</span>}
                {data.audit.chainOk === true && <span className="text-emerald-700 font-semibold">✓ Hash chain intact across the recent 200-row probe window</span>}
                {data.audit.chainOk === false && (
                  <span className="text-red-700 font-semibold">✗ Hash chain broken at id {data.audit.chainBrokenAt} — tampering or migration error. Investigate.</span>
                )}
              </div>
            </article>

            <article className="rounded-xl border border-gray-200 bg-white shadow-sm p-5">
              <header className="mb-3"><span className="text-xs uppercase tracking-wider font-bold text-gray-700">Admin auth posture</span></header>
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Locked accounts now" value={data.adminAuth.lockedAccountsNow.toLocaleString()} />
                <Stat label="Failed attempts / 24h" value={data.adminAuth.failedAttemptsLast24Hours.toLocaleString()} />
              </div>
            </article>

            <article className="rounded-xl border border-gray-200 bg-white shadow-sm p-5">
              <header className="mb-3"><span className="text-xs uppercase tracking-wider font-bold text-gray-700">Data retention &amp; encryption</span></header>
              <ul className="text-sm text-gray-700 leading-relaxed list-disc pl-5 space-y-1">
                <li>Audit log retention: <strong>{data.retention.auditLogYears} years</strong> (SOC2 standard)</li>
                <li>Scan data retention: <strong>{data.retention.scansDays} days</strong> (purge job runs nightly)</li>
                <li>Encryption at rest: <strong>{data.encryption.atRest.replace(/_/g, " ")}</strong></li>
                <li>Encryption in transit: <strong>{data.encryption.inTransit.replace(/_/g, " ")}</strong></li>
              </ul>
            </article>

            <article className="rounded-xl border border-gray-200 bg-white shadow-sm p-5">
              <header className="mb-3"><span className="text-xs uppercase tracking-wider font-bold text-gray-700">Schema presence</span></header>
              <ul className="text-sm space-y-1">
                <SchemaLine name="audit_log" present={data.schemaPresent.audit_log} />
                <SchemaLine name="admin_auth_attempts" present={data.schemaPresent.admin_auth_attempts} />
                <SchemaLine name="customer_memory" present={data.schemaPresent.customer_memory} />
              </ul>
            </article>
          </>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">{label}</div>
      <div className="mt-1 text-lg font-bold text-gray-900">{value}</div>
    </div>
  );
}

function SchemaLine({ name, present }: { name: string; present: boolean }) {
  return (
    <li className="flex items-center gap-2 font-mono text-xs">
      <span className={present ? "text-emerald-700" : "text-gray-400"}>{present ? "✓" : "○"}</span>
      <span className={present ? "text-gray-900" : "text-gray-500"}>{name}</span>
      <span className="text-gray-400">{present ? "present" : "not yet initialised"}</span>
    </li>
  );
}
