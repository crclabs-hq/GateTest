"use client";

import type { DbData } from "./types";

// The "Customers" tab — read-only table over /api/admin/stats data.
export function CustomersTab({ dbData, dbLoading }: { dbData: DbData | null; dbLoading: boolean }) {
  return (
    <div className="rounded-xl bg-white border border-gray-200 shadow-sm overflow-hidden">
      {dbLoading ? (
        <div className="p-8 text-center text-gray-400">Loading...</div>
      ) : !dbData?.customers?.length ? (
        <div className="p-8 text-center text-gray-400">No customers yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-400">Email</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">GitHub</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Scans</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Spent</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Joined</th>
              </tr>
            </thead>
            <tbody>
              {dbData.customers.map((c) => (
                <tr key={c.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 text-xs text-gray-700">{c.email}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{c.github_login || "-"}</td>
                  <td className="px-4 py-3 text-gray-700">{c.total_scans}</td>
                  <td className="px-4 py-3 text-gray-700">${Number(c.total_spent_usd || 0).toFixed(0)}</td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {c.created_at ? new Date(c.created_at).toLocaleDateString() : "-"}
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
