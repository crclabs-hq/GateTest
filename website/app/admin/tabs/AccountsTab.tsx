"use client";

import { useState, useEffect, useCallback } from "react";
import type { GitHubProfile } from "@/app/lib/admin-github-profiles";

// The "GitHub Accounts" tab — multiple GitHub PATs; GateTest picks the token
// whose orgs list matches the repo owner when the admin triggers a scan.

// Same-origin fetches: the browser attaches the HttpOnly gt_admin session
// cookie itself and the route checks it with requireAdminRoute. (This tab
// used to read a cookie JavaScript cannot see and send it as a password
// header, so every call was refused and the list read "none".)

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; profiles: GitHubProfile[] }
  | { kind: "error"; message: string };

/** Turn a refused / failed answer into one honest sentence. */
async function describeFailure(res: Response, action: string): Promise<string> {
  let code = "";
  try {
    const d = (await res.json()) as { error?: unknown };
    if (typeof d.error === "string") code = d.error;
  } catch {
    // error-ok — a non-JSON body still gets the status-based sentence
  }
  if (res.status === 401) return `Could not ${action}: your admin session has expired. Sign in again.`;
  if (res.status === 403) return `Could not ${action}: the request did not come from this site. Reload the page and try again.`;
  if (res.status === 503) return `Could not ${action}: the account store is not reachable (database unavailable).`;
  return `Could not ${action}: the server answered ${res.status}${code ? ` (${code})` : ""}.`;
}

const API = "/api/admin/github-profiles";
const FETCH_OPTS = { credentials: "same-origin", cache: "no-store" } as const;

export function AccountsTab() {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [ghLabel, setGhLabel] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [ghOrgs, setGhOrgs] = useState("");
  const [ghProfileError, setGhProfileError] = useState("");
  const [ghProfileAdding, setGhProfileAdding] = useState(false);
  // Remove is confirm-by-typing: the label must be typed exactly.
  const [removing, setRemoving] = useState<GitHubProfile | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [removeBusy, setRemoveBusy] = useState(false);

  const loadGhProfiles = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      const res = await fetch(API, FETCH_OPTS);
      if (!res.ok) {
        setLoad({ kind: "error", message: await describeFailure(res, "load GitHub accounts") });
        return;
      }
      const d = (await res.json()) as { profiles?: unknown };
      if (!Array.isArray(d.profiles)) {
        setLoad({ kind: "error", message: "Could not load GitHub accounts: the server answer had no account list." });
        return;
      }
      setLoad({ kind: "ok", profiles: d.profiles as GitHubProfile[] });
    } catch (e) {
      setLoad({ kind: "error", message: `Could not load GitHub accounts: ${e instanceof Error ? e.message : "network error"}.` });
    }
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
      const res = await fetch(API, {
        ...FETCH_OPTS,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: ghLabel, token: ghToken, orgs }),
      });
      if (!res.ok) { setGhProfileError(await describeFailure(res, "add the account")); return; }
      setGhLabel(""); setGhToken(""); setGhOrgs("");
      loadGhProfiles();
    } catch (e) {
      setGhProfileError(`Could not add the account: ${e instanceof Error ? e.message : "network error"}.`);
    } finally { setGhProfileAdding(false); }
  };

  const startRemove = (p: GitHubProfile) => {
    setRemoving(p);
    setConfirmText("");
    setRemoveError("");
  };

  const cancelRemove = () => {
    setRemoving(null);
    setConfirmText("");
    setRemoveError("");
  };

  const confirmRemove = async () => {
    if (!removing || confirmText !== removing.label) return;
    setRemoveBusy(true);
    setRemoveError("");
    try {
      const res = await fetch(`${API}?id=${encodeURIComponent(String(removing.id))}`, { ...FETCH_OPTS, method: "DELETE" });
      if (!res.ok) { setRemoveError(await describeFailure(res, "remove the account")); return; }
      cancelRemove();
      loadGhProfiles();
    } catch (e) {
      setRemoveError(`Could not remove the account: ${e instanceof Error ? e.message : "network error"}.`);
    } finally { setRemoveBusy(false); }
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
          {ghProfileError && (
            <p role="alert" className="text-xs font-medium text-gray-900 border-l-2 border-gray-900 pl-2">{ghProfileError}</p>
          )}
        </div>
      </div>

      <div className="rounded-xl bg-white border border-gray-200 shadow-sm overflow-hidden">
        {load.kind === "loading" ? (
          <div className="p-8 text-center text-gray-400">Loading…</div>
        ) : load.kind === "error" ? (
          <div role="alert" className="p-6 text-sm text-gray-900 border-l-4 border-gray-900 bg-gray-50">
            <p className="font-semibold">GitHub accounts could not be loaded — this is not the same as having none.</p>
            <p className="mt-1 text-gray-700">{load.message}</p>
            <button
              onClick={loadGhProfiles}
              className="mt-3 px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-lg hover:bg-white transition-colors"
            >
              Try again
            </button>
          </div>
        ) : load.profiles.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            No GitHub accounts connected yet. Add one above, or set{" "}
            <code className="bg-gray-100 px-1 rounded">GATETEST_GITHUB_TOKEN</code> in Tallrig → Platform secrets as a fallback.
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
              {load.profiles.map((p) => (
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
                    {removing?.id === p.id ? (
                      <div className="flex flex-col items-end gap-1.5">
                        <label className="text-xs text-gray-600">
                          Type <code className="bg-gray-100 px-1 rounded">{p.label}</code> to remove
                          <input
                            type="text"
                            value={confirmText}
                            onChange={(e) => setConfirmText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") confirmRemove();
                              if (e.key === "Escape") cancelRemove();
                            }}
                            autoFocus
                            aria-label={`Type ${p.label} to confirm removal`}
                            className="ml-2 w-40 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-gray-500"
                          />
                        </label>
                        <div className="flex gap-2">
                          <button
                            onClick={cancelRemove}
                            className="text-xs text-gray-500 hover:text-gray-900 transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={confirmRemove}
                            disabled={removeBusy || confirmText !== p.label}
                            className="px-2 py-1 text-xs font-medium bg-gray-900 text-white rounded hover:bg-gray-700 disabled:opacity-40 transition-colors"
                          >
                            {removeBusy ? "Removing…" : "Remove permanently"}
                          </button>
                        </div>
                        {removeError && <p role="alert" className="text-xs font-medium text-gray-900">{removeError}</p>}
                      </div>
                    ) : (
                      <button
                        onClick={() => startRemove(p)}
                        className="text-xs text-gray-500 underline hover:text-gray-900 transition-colors"
                      >
                        Remove
                      </button>
                    )}
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
