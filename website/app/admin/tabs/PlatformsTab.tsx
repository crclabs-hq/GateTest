"use client";

import { useState, useEffect, useCallback } from "react";

// The "Platforms" tab — orgs registered here get full admin access: the
// GateTest gate runs in strict mode with no advisory-mode messaging.

interface PlatformRow {
  id: number;
  github_org: string;
  display_url: string | null;
  added_at: string;
}

export function PlatformsTab() {
  const [platforms, setPlatforms] = useState<PlatformRow[]>([]);
  const [platformUrl, setPlatformUrl] = useState("");
  const [platformError, setPlatformError] = useState("");
  const [platformsLoading, setPlatformsLoading] = useState(false);

  const loadPlatforms = useCallback(async () => {
    setPlatformsLoading(true);
    try {
      const res = await fetch("/api/admin/platforms");
      if (res.ok) { const d = await res.json(); setPlatforms(d.platforms || []); }
    } finally { setPlatformsLoading(false); }
  }, []);

  useEffect(() => {
    loadPlatforms();
  }, [loadPlatforms]);

  const addPlatform = async () => {
    setPlatformError("");
    const res = await fetch("/api/admin/platforms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: platformUrl }),
    });
    const d = await res.json();
    if (!res.ok) { setPlatformError(d.error || "Error"); return; }
    setPlatformUrl("");
    loadPlatforms();
  };

  const removePlatform = async (org: string) => {
    const res = await fetch(`/api/admin/platforms?org=${encodeURIComponent(org)}`, { method: "DELETE" });
    if (res.ok) loadPlatforms();
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-1">Platform Registry</h3>
        <p className="text-sm text-gray-500 mb-4">
          Platforms registered here get <strong>full admin access</strong> — the GateTest gate runs
          in strict mode (errors turn the check red) but with no advisory-mode messaging on GitHub.
          Paste any GitHub URL or org name.
        </p>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={platformUrl}
            onChange={(e) => setPlatformUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPlatform()}
            placeholder="https://github.com/vapron-ai  or  vapron-ai"
            className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <button
            onClick={addPlatform}
            disabled={!platformUrl.trim()}
            className="px-4 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 transition-colors"
          >
            Add
          </button>
        </div>
        {platformError && (
          <p className="text-xs text-red-600 mt-1">{platformError}</p>
        )}
      </div>

      <div className="rounded-xl bg-white border border-gray-200 shadow-sm overflow-hidden">
        {platformsLoading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : platforms.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            No admin platforms registered yet. Add one above.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-400">GitHub Org</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Source URL</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Added</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {platforms.map((p) => (
                <tr key={p.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-emerald-700">
                    {p.github_org}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {p.display_url || "-"}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {p.added_at ? new Date(p.added_at).toLocaleDateString() : "-"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => removePlatform(p.github_org)}
                      className="text-xs text-red-500 hover:text-red-700 transition-colors"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-xl bg-blue-50 border border-blue-200 p-4">
        <p className="text-xs text-blue-700">
          <strong>How it works:</strong> When GateTest&apos;s GitHub App processes a push or PR from a
          registered org, it automatically uses strict mode — findings show as ✅ or ❌ in the
          PR checks tab, with no &ldquo;advisory mode&rdquo; label. Works for all repos under that org.
          You can also set <code className="bg-blue-100 px-1 rounded">GATETEST_ADMIN_ORGS</code> as
          a Vercel env var for a code-level fallback.
        </p>
      </div>
    </div>
  );
}
