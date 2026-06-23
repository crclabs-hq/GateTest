"use client";

import { useState, useEffect } from "react";

interface FleetSignature {
  module_name: string;
  occurrences: number;
  affected_repos: number;
  total_issues: number;
  last_seen?: string;
}

interface FleetData {
  signatures: FleetSignature[];
  scansAnalyzed: number;
  generatedAt: string;
  note?: string;
  error?: string;
}

function fmtLastSeen(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function fmtModule(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}

export function FleetIntelligencePanel() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<FleetData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/fleet-intelligence", { credentials: "same-origin" });
        if (cancelled) return;
        if (res.status === 401) { setError("Not authenticated."); return; }
        const json = await res.json() as FleetData;
        if (json.error) { setError(json.error); return; }
        setData(json);
      } catch {
        if (!cancelled) setError("Fleet data unavailable.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-4 sm:p-5 mb-6">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Fleet Intelligence</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Top vulnerability signatures across all customer scans · last 30 days
          </p>
        </div>
        {data && !loading && (
          <div className="text-[10px] text-gray-400 text-right shrink-0 ml-4">
            <div className="font-semibold text-gray-600">{data.scansAnalyzed} scans</div>
            <div>analyzed</div>
          </div>
        )}
      </header>

      {loading ? (
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="flex-1 min-w-[130px] h-[72px] bg-white/70 rounded-lg border border-indigo-100 animate-pulse"
            />
          ))}
        </div>
      ) : error ? (
        <p className="text-xs text-gray-400 italic">{error}</p>
      ) : !data || data.signatures.length === 0 ? (
        <p className="text-xs text-gray-400 italic">
          No fleet data yet — appears once customers have completed scans in the last 30 days.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {data.signatures.map((sig, i) => {
            const maxOcc = data.signatures[0].occurrences;
            const barPct = Math.round((sig.occurrences / maxOcc) * 100);
            return (
              <article
                key={sig.module_name}
                className="flex-1 min-w-[130px] bg-white rounded-lg border border-indigo-100 shadow-sm p-3"
              >
                <div className="flex items-start justify-between gap-1 mb-1.5">
                  <span className="text-[11px] font-bold text-gray-800 leading-snug break-words">
                    {fmtModule(sig.module_name)}
                  </span>
                  <span className="shrink-0 text-[10px] text-gray-400 font-mono mt-0.5">#{i + 1}</span>
                </div>
                <div className="w-full h-1 bg-indigo-100 rounded-full mb-2">
                  <div
                    className="h-1 bg-red-400 rounded-full transition-all"
                    style={{ width: `${barPct}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] text-gray-500">
                  <span>
                    <span className="font-semibold text-gray-800">{sig.occurrences}</span> scans
                  </span>
                  <span>
                    <span className="font-semibold text-gray-800">{sig.affected_repos}</span> repos
                  </span>
                </div>
                {sig.last_seen && (
                  <div className="text-[10px] text-gray-400 mt-1">
                    last seen {fmtLastSeen(sig.last_seen)}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
