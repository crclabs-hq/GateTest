"use client";

import type { DbData } from "./types";

// The "Recent Scans" tab — read-only table over /api/admin/stats data
// (loaded once by the parent shell and shared with the stats bar).
export function ScansTab({ dbData, dbLoading }: { dbData: DbData | null; dbLoading: boolean }) {
  return (
    <div className="rounded-xl bg-white border border-gray-200 shadow-sm overflow-hidden">
      {dbLoading ? (
        <div className="p-8 text-center text-gray-400">Loading...</div>
      ) : !dbData?.scans?.length ? (
        <div className="p-8 text-center text-gray-400">No scans recorded yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Repo</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Tier</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Score</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Customer</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Date</th>
              </tr>
            </thead>
            <tbody>
              {dbData.scans.map((scan) => (
                <tr key={scan.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-gray-700 max-w-[200px] truncate">
                    {scan.repo_url?.replace("https://github.com/", "") || "-"}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{scan.tier}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${
                      scan.status === "completed" ? "bg-emerald-100 text-emerald-700" :
                      scan.status === "failed" ? "bg-red-100 text-red-700" :
                      "bg-amber-100 text-amber-700"
                    }`}>
                      {scan.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-700 font-medium">{scan.score ?? "-"}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{scan.customer_email || "-"}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {scan.created_at ? new Date(scan.created_at).toLocaleDateString() : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
