"use client";

import { useState, useEffect, useCallback } from "react";
import type { GitHubProfile } from "@/app/lib/admin-github-profiles";

// The "GitHub Accounts" tab — multiple GitHub PATs; GateTest picks the token
// whose orgs list matches the repo owner when the admin triggers a scan.

// The admin password travels as an HMAC cookie; the profile routes verify it
// via the x-admin-password header. Read it at call time (not render time) so
// this stays SSR-safe without an eslint suppression.
function adminPwd(): string {
  return (document.cookie.match(/gatetest_admin=([^;]+)/) || [])[1] || "";
}

export function AccountsTab() {
  const [ghProfiles, setGhProfiles] = useState<GitHubProfile[]>([]);
  const [ghProfilesLoading, setGhProfilesLoading] = useState(false);
  const [ghLabel, setGhLabel] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [ghOrgs, setGhOrgs] = useState("");
  const [ghProfileError, setGhProfileError] = useState("");
  const [ghProfileAdding, setGhProfileAdding] = useState(false);

  const loadGhProfiles = useCallback(async () => {
    setGhProfilesLoading(true);
    try {
      const res = await fetch("/api/admin/github-profiles", {
        headers: { "x-admin-password": adminPwd() },
      });
      if (res.ok) { const d = await res.json(); setGhProfiles(d.profiles || []); }
    } finally { setGhProfilesLoading(false); }
  }, []);

  useEffect(() => {
    loadGhProfiles();
  }, [loadGhProfiles]);

  const addGhProfile = async () => {
    setGhProfileError("");
    if (!ghLabel.trim()) { setGhProfileError("Label is required"); return; }
    if (!ghToken.trim()) { setGhProfileError("Token is required"); return; }
    setGhProfileAdding(true);
    try {
      const orgs = ghOrgs.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await fetch("/api/admin/github-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPwd() },
        body: JSON.stringify({ label: ghLabel, token: ghToken, orgs }),
      });
      const d = await res.json();
      if (!res.ok) { setGhProfileError(d.error || "Error"); return; }
      setGhLabel(""); setGhToken(""); setGhOrgs("");
      loadGhProfiles();
    } finally { setGhProfileAdding(false); }
  };

  const removeGhProfile = async (id: number) => {
    const res = await fetch(`/api/admin/github-profiles?id=${id}`, {
      method: "DELETE",
      headers: { "x-admin-password": adminPwd() },
    });
    if (res.ok) loadGhProfiles();
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-1">Connected GitHub Accounts</h3>
        <p className="text-sm text-gray-500 mb-4">
          Add multiple GitHub Personal Access Tokens (PATs). When the admin triggers a scan, GateTest
          picks the token whose <strong>orgs</strong> list matches the repo owner — so you can scan
          private repos across different GitHub accounts or organisations without juggling env vars.
        </p>
        <div className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <input
              type="text"
              value={ghLabel}
              onChange={(e) => setGhLabel(e.target.value)}
              placeholder="Label  (e.g. crclabs-hq personal)"
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <input
              type="text"
              value={ghOrgs}
              onChange={(e) => setGhOrgs(e.target.value)}
              placeholder="Orgs / users  (comma-separated, e.g. crclabs-hq, ccantynz-alt)"
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={ghToken}
              onChange={(e) => setGhToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addGhProfile()}
              placeholder="GitHub Personal Access Token  (ghp_...)"
              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono"
            />
            <button
              onClick={addGhProfile}
              disabled={ghProfileAdding || !ghLabel.trim() || !ghToken.trim()}
              className="px-4 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 transition-colors"
            >
              {ghProfileAdding ? "Adding…" : "Add"}
            </button>
          </div>
          {ghProfileError && <p className="text-xs text-red-600">{ghProfileError}</p>}
        </div>
      </div>

      <div className="rounded-xl bg-white border border-gray-200 shadow-sm overflow-hidden">
        {ghProfilesLoading ? (
          <div className="p-8 text-center text-gray-400">Loading…</div>
        ) : ghProfiles.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            No GitHub accounts connected yet. Add one above, or set{" "}
            <code className="bg-gray-100 px-1 rounded">GATETEST_GITHUB_TOKEN</code> in Vercel env vars as a fallback.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-400">Label</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">GitHub Login</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Token</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Orgs</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Added</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {ghProfiles.map((p) => (
                <tr key={p.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 font-medium text-gray-900 text-xs">{p.label}</td>
                  <td className="px-4 py-3 font-mono text-xs text-emerald-700">
                    {p.github_login ? `@${p.github_login}` : <span className="text-gray-400">unverified</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.token_hint}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {p.orgs.length > 0 ? p.orgs.join(", ") : <span className="text-gray-400">all (fallback)</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {p.added_at ? new Date(p.added_at).toLocaleDateString() : "-"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => removeGhProfile(p.id)}
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
          <strong>How token selection works:</strong> When a scan is triggered for{" "}
          <code className="bg-blue-100 px-1 rounded">github.com/owner/repo</code>, GateTest checks the
          stored profiles for one whose <em>orgs</em> list contains <code className="bg-blue-100 px-1 rounded">owner</code>{" "}
          (case-insensitive). If no org match is found it tries the login name, then falls back to the
          first stored profile, then the <code className="bg-blue-100 px-1 rounded">GATETEST_GITHUB_TOKEN</code>{" "}
          env var. Tokens require <strong>repo</strong> + <strong>workflow</strong> scopes for full
          functionality.
        </p>
      </div>
    </div>
  );
}
