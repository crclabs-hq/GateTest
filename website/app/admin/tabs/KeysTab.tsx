"use client";

import { useState, useEffect, useCallback } from "react";

// The "API Keys" tab — issue and revoke keys for external platforms calling
// POST /api/v1/scan.

interface ApiKeyRow {
  id: string;
  key_prefix: string;
  name: string;
  customer_email: string | null;
  tier_allowed: string;
  rate_limit_per_hour: number;
  active: boolean;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  total_calls: number;
}

interface NewKeyResult {
  id: string;
  name: string;
  prefix: string;
  tier_allowed: string;
  rate_limit_per_hour: number;
  plaintext_key: string;
}

export function KeysTab() {
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[] | null>(null);
  const [keyName, setKeyName] = useState("");
  const [keyCustomer, setKeyCustomer] = useState("");
  const [keyTier, setKeyTier] = useState<"quick" | "full">("quick");
  const [keyRate, setKeyRate] = useState(60);
  const [newKey, setNewKey] = useState<NewKeyResult | null>(null);
  const [keyError, setKeyError] = useState("");

  const loadKeys = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/keys");
      if (res.ok) {
        const data = await res.json();
        setApiKeys(data.keys || []);
      }
    } catch {
      // db not ready — surface as empty
      setApiKeys([]);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  async function createKey() {
    setKeyError("");
    setNewKey(null);
    if (!keyName.trim()) {
      setKeyError("Name required");
      return;
    }
    try {
      const res = await fetch("/api/admin/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: keyName.trim(),
          customer_email: keyCustomer.trim() || undefined,
          tier_allowed: keyTier,
          rate_limit_per_hour: keyRate,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setKeyError(data.error || "Failed to create key");
        return;
      }
      setNewKey(data);
      setKeyName("");
      setKeyCustomer("");
      loadKeys();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Failed to create key");
    }
  }

  async function revokeKey(id: string) {
    if (!confirm(`Revoke key ${id}? This cannot be undone.`)) return;
    try {
      await fetch(`/api/admin/keys?revoke=${encodeURIComponent(id)}`, {
        method: "POST",
      });
      loadKeys();
    } catch {
      /* ignore — loadKeys will reflect reality */
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6">
        <h2 className="text-lg font-bold mb-1">Issue an API key</h2>
        <p className="text-xs text-gray-500 mb-4">
          For external platforms calling <code className="font-mono">POST /api/v1/scan</code>.
          The plaintext key is shown ONCE after creation — copy it immediately.
        </p>
        <div className="grid sm:grid-cols-[1fr,1fr,auto,auto,auto] gap-3">
          <input
            type="text"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="Key name (e.g. Platform A prod)"
            className="px-4 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 text-sm"
          />
          <input
            type="email"
            value={keyCustomer}
            onChange={(e) => setKeyCustomer(e.target.value)}
            placeholder="customer@example.com (optional)"
            className="px-4 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 text-sm"
          />
          <select
            value={keyTier}
            onChange={(e) => setKeyTier(e.target.value as "quick" | "full")}
            className="px-4 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 text-sm"
          >
            <option value="quick">quick</option>
            <option value="full">full</option>
          </select>
          <input
            type="number"
            value={keyRate}
            onChange={(e) => setKeyRate(Math.max(1, Number(e.target.value) || 60))}
            placeholder="60"
            className="px-4 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 text-sm w-24"
          />
          <button onClick={createKey} className="btn-primary px-6 py-3 text-sm">
            Create Key
          </button>
        </div>
        {keyError && <p className="text-danger text-sm mt-3">{keyError}</p>}

        {newKey && (
          <div className="mt-4 p-4 border-l-4 border-l-emerald-500 bg-emerald-50 rounded">
            <p className="text-sm font-bold text-emerald-700 mb-1">
              Key created — copy it now, it will not be shown again.
            </p>
            <p className="text-xs text-emerald-700 mb-2">
              <strong>{newKey.name}</strong> · tier {newKey.tier_allowed} ·{" "}
              {newKey.rate_limit_per_hour}/hr
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-xs bg-white border border-gray-200 rounded px-3 py-2 break-all text-gray-800">
                {newKey.plaintext_key}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(newKey.plaintext_key);
                }}
                className="btn-secondary px-3 py-2 text-xs"
              >
                Copy
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-xl bg-white border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-400">Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Prefix</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Tier</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Rate/hr</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Calls</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-400">Last used</th>
                <th className="text-right px-4 py-3 font-medium text-gray-400">Action</th>
              </tr>
            </thead>
            <tbody>
              {apiKeys === null ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-gray-400">Loading...</td>
                </tr>
              ) : apiKeys.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-gray-400">
                    No keys issued yet. Create one above.
                  </td>
                </tr>
              ) : (
                apiKeys.map((k) => (
                  <tr key={k.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-gray-900 font-medium">{k.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">{k.key_prefix}…</td>
                    <td className="px-4 py-3 text-gray-700">{k.tier_allowed}</td>
                    <td className="px-4 py-3 text-gray-700">{k.rate_limit_per_hour}</td>
                    <td className="px-4 py-3 text-gray-700">{k.total_calls}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${
                        k.active ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"
                      }`}>
                        {k.active ? "active" : "revoked"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">
                      {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {k.active && (
                        <button
                          onClick={() => revokeKey(k.id)}
                          className="text-xs text-danger hover:underline"
                        >
                          revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-4 text-xs text-gray-500">
        Docs: <a href="/docs/api" className="text-accent hover:underline">/docs/api</a> ·
        Endpoint: <code className="font-mono">POST /api/v1/scan</code>
      </div>
    </div>
  );
}
