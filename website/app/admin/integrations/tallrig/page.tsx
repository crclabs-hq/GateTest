"use client";

/**
 * /admin/integrations/tallrig — the last 50 signed push events Tallrig has
 * sent to POST /api/integrations/tallrig/events (issue #672): deploy.started,
 * deploy.finished (sha + shaSource), job.failed, secret.rotated. Reads
 * GET /api/admin/integrations/tallrig (admin-gated). Signed-out users never
 * see this page's data — the API 401s and the page shows a sign-in prompt,
 * same pattern as /admin/feedback.
 */

import { useEffect, useState } from "react";

interface TallrigEvent {
  dedupeKey: string;
  type: string | null;
  keyId: string | null;
  sha: string | null;
  shaSource: string | null;
  name: string | null;
  receivedAt: string;
}

interface Payload {
  ok: boolean;
  events?: TallrigEvent[];
  generatedAt?: string;
  error?: string;
}

export default function AdminTallrigIntegrationPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/integrations/tallrig", { cache: "no-store" });
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
            <h1 className="text-lg font-semibold text-gray-900">Tallrig push events</h1>
            <p className="text-xs text-gray-500">
              Signed push events from the Tallrig tenant — deploy.started, deploy.finished, job.failed,
              secret.rotated. Delivered to POST /api/integrations/tallrig/events.
            </p>
          </div>
          <a href="/admin" className="text-xs text-indigo-700 hover:underline">Back to admin</a>
        </div>

        {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>}
        {!error && !data && <p className="text-sm text-gray-500">Loading…</p>}

        {data?.events && (
          <div className="rounded-xl border border-gray-200 bg-white overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 bg-gray-50">
                  <th className="px-3 py-2 font-medium">Received</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Key id</th>
                  <th className="px-3 py-2 font-medium">Sha</th>
                  <th className="px-3 py-2 font-medium">Sha source</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                </tr>
              </thead>
              <tbody>
                {data.events.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500">No push events recorded yet.</td></tr>
                )}
                {data.events.map((e) => (
                  <tr key={e.dedupeKey} className="border-t border-gray-100 align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">{new Date(e.receivedAt).toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono">{e.type ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-gray-600">{e.keyId ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-gray-600">{e.sha ? e.sha.slice(0, 7) : "—"}</td>
                    <td className="px-3 py-2 font-mono text-gray-600">{e.shaSource ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-gray-600">{e.name ?? "—"}</td>
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
