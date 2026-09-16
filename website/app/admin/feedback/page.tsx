"use client";

/**
 * /admin/feedback — the triage view for the two customer feedback loops.
 * Reads GET /api/admin/feedback (admin-gated): up / down per surface over
 * 7 and 30 days, then the last 200 events with their escalation state.
 * Linked from every issue the escalation opens.
 */

import { useEffect, useState } from "react";

interface Row {
  id: string;
  ts: string;
  scan_id: string | null;
  surface: string;
  tier: string | null;
  rating: "up" | "down";
  rule: string | null;
  text: string | null;
  page: string | null;
  escalated: boolean;
  issue_number: number | null;
  escalation_ref: string | null;
}

interface Count { surface: string; up: number; down: number }

interface Payload {
  ok: boolean;
  rows?: Row[];
  counts?: { d7: Count[]; d30: Count[] };
  generatedAt?: string;
  error?: string;
}

function CountsTable({ title, counts }: { title: string; counts: Count[] }) {
  const up = counts.reduce((n, c) => n + c.up, 0);
  const down = counts.reduce((n, c) => n + c.down, 0);
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-gray-900 mb-2">
        {title} <span className="text-gray-500 font-normal">— {up} up · {down} down</span>
      </h2>
      {counts.length === 0 ? (
        <p className="text-xs text-gray-500">No feedback in this window.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 font-medium">Surface</th>
              <th className="py-1 font-medium text-right">Up</th>
              <th className="py-1 font-medium text-right">Down</th>
            </tr>
          </thead>
          <tbody>
            {counts.map((c) => (
              <tr key={c.surface} className="border-t border-gray-100">
                <td className="py-1 font-mono">{c.surface}</td>
                <td className="py-1 text-right tabular-nums text-emerald-700">{c.up}</td>
                <td className="py-1 text-right tabular-nums text-rose-700">{c.down}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function AdminFeedbackPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/feedback", { cache: "no-store" });
        const json = (await res.json()) as Payload;
        if (cancelled) return;
        if (res.status === 401) setError("Not signed in as admin. Sign in at /admin first.");
        else if (!res.ok || !json.ok) setError(json.error || `HTTP ${res.status}`);
        else setData(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Network error");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <main className="min-h-screen bg-gray-50 px-6 py-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Customer feedback</h1>
            <p className="text-xs text-gray-500">
              Scan-result ratings and finding-wrong reports. Down ratings with text and finding-wrong
              clicks open issues on the repository automatically.
            </p>
          </div>
          <a href="/admin" className="text-xs text-indigo-700 hover:underline">Back to admin</a>
        </div>

        {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>}
        {!error && !data && <p className="text-sm text-gray-500">Loading…</p>}

        {data?.counts && (
          <div className="grid gap-4 sm:grid-cols-2">
            <CountsTable title="Last 7 days" counts={data.counts.d7} />
            <CountsTable title="Last 30 days" counts={data.counts.d30} />
          </div>
        )}

        {data?.rows && (
          <div className="rounded-xl border border-gray-200 bg-white overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 bg-gray-50">
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Surface</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 font-medium">Rating</th>
                  <th className="px-3 py-2 font-medium">Rule</th>
                  <th className="px-3 py-2 font-medium">Text</th>
                  <th className="px-3 py-2 font-medium">Page</th>
                  <th className="px-3 py-2 font-medium">Escalation</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-500">No feedback recorded yet.</td></tr>
                )}
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">{new Date(r.ts).toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono">{r.surface}</td>
                    <td className="px-3 py-2 font-mono text-gray-600">{r.tier || "—"}</td>
                    <td className={`px-3 py-2 font-semibold ${r.rating === "up" ? "text-emerald-700" : "text-rose-700"}`}>{r.rating}</td>
                    <td className="px-3 py-2 font-mono text-gray-600">{r.rule || "—"}</td>
                    <td className="px-3 py-2 max-w-md break-words text-gray-800">{r.text || "—"}</td>
                    <td className="px-3 py-2 font-mono text-gray-600">{r.page || "—"}</td>
                    <td className="px-3 py-2">
                      {r.escalation_ref ? (
                        <a href={r.escalation_ref} target="_blank" rel="noopener noreferrer" className="text-indigo-700 hover:underline">
                          #{r.issue_number ?? "issue"}
                        </a>
                      ) : r.rating === "down" ? (
                        <span className="text-gray-400">not escalated</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.generatedAt && <p className="text-[11px] text-gray-400">Generated {new Date(data.generatedAt).toLocaleString()}</p>}
      </div>
    </main>
  );
}
