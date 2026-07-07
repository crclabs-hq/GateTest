"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { StatCard, AdminTabs, type TabDef } from "./ui";
import type { DbData } from "./tabs/types";
import { RepoScanTab } from "./tabs/RepoScanTab";
import { ServerScanTab } from "./tabs/ServerScanTab";
import { NuclearScanTab } from "./tabs/NuclearScanTab";
import { WatchdogTab } from "./tabs/WatchdogTab";
import { ScansTab } from "./tabs/ScansTab";
import { CustomersTab } from "./tabs/CustomersTab";
import { KeysTab } from "./tabs/KeysTab";
import { PlatformsTab } from "./tabs/PlatformsTab";
import { AccountsTab } from "./tabs/AccountsTab";

// The admin console shell — header, stats bar, tab navigation. Each tab's
// state and behaviour lives in its own component under ./tabs/ (split out of
// the former 2,556-line god component). This file owns only what every tab
// shares: the /api/admin/stats data (stats bar + Scans + Customers) and the
// active-tab switch.

const ADMIN_TABS: TabDef[] = [
  { id: "scan", label: "Repo Scan" },
  { id: "server", label: "Server Scan" },
  { id: "nuclear", label: "Forensic Scan", danger: true },
  { id: "watchdog", label: "Watchdog" },
  { id: "scans", label: "Recent Scans" },
  { id: "customers", label: "Customers" },
  { id: "keys", label: "API Keys" },
  { id: "platforms", label: "Platforms" },
  { id: "accounts", label: "GitHub Accounts" },
];
type AdminTabId = "scan" | "server" | "nuclear" | "watchdog" | "scans" | "customers" | "keys" | "platforms" | "accounts";

interface AdminPanelProps {
  adminLogin: string;
}

export default function AdminPanel({ adminLogin }: AdminPanelProps) {
  const [dbData, setDbData] = useState<DbData | null>(null);
  const [dbLoading, setDbLoading] = useState(true);
  const [dbError, setDbError] = useState("");
  const [activeTab, setActiveTab] = useState<AdminTabId>("scan");

  const loadDbData = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/stats");
      if (res.ok) {
        const data = await res.json();
        setDbData(data);
      }
    } catch {
      // DB not available yet — that's fine
    } finally {
      setDbLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDbData();
  }, [loadDbData]);

  async function initDb() {
    setDbError("");
    try {
      const res = await fetch("/api/db/init", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        loadDbData();
      } else {
        setDbError(data.error || "DB init failed");
      }
    } catch (err) {
      setDbError(err instanceof Error ? err.message : "DB init failed");
    }
  }

  const stats = dbData?.stats;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">

        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-600 flex items-center justify-center shadow-sm">
              <span className="text-white font-bold text-base font-[var(--font-mono)]">G</span>
            </div>
            <div>
              <h1 className="text-lg font-semibold text-gray-900">GateTest Admin</h1>
              <p className="text-xs text-gray-500">
                Signed in as <span className="font-mono text-emerald-600 font-medium">{adminLogin}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="/admin/triage"
              className="text-xs px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 transition-colors font-medium"
            >
              Triage
            </a>
            <a
              href="/admin/pipeline-trace"
              className="text-xs px-3 py-2 rounded-lg bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100 transition-colors font-medium"
            >
              Pipeline
            </a>
            <a
              href="/admin/health"
              className="text-xs px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors font-medium"
            >
              Self-Test
            </a>
            <Link href="/" className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
              &larr; Site
            </Link>
          </div>
        </div>
      </div>

      <div className="relative max-w-6xl mx-auto px-6 py-6">
        {/* Stats bar */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <StatCard label="Total Scans" value={stats.total_scans} />
            <StatCard label="Customers" value={stats.total_customers} />
            <StatCard label="Revenue" value={`$${Number(stats.total_revenue || 0).toFixed(0)}`} tone="accent" />
            <StatCard label="Avg Score" value={stats.avg_score || 0} />
          </div>
        )}

        {/* Tab navigation — accessible (role=tab, aria-selected, arrow-key nav) */}
        <AdminTabs tabs={ADMIN_TABS} active={activeTab} onChange={(id) => setActiveTab(id as AdminTabId)} />

        {/* DB init notice */}
        {dbData?.note && (
          <div className="rounded-xl bg-white border border-yellow-200 shadow-sm p-4 mb-6 border-l-4 border-l-yellow-400">
            <p className="text-sm text-gray-600">{dbData.note}</p>
            <button onClick={initDb} className="btn-primary px-4 py-2 text-xs mt-2">
              Initialize Database
            </button>
            {dbError && <p className="text-danger text-sm mt-2">{dbError}</p>}
          </div>
        )}

        {activeTab === "scan" && <RepoScanTab onScanRecorded={loadDbData} />}
        {activeTab === "server" && <ServerScanTab />}
        {activeTab === "nuclear" && <NuclearScanTab />}
        {activeTab === "watchdog" && <WatchdogTab />}
        {activeTab === "scans" && <ScansTab dbData={dbData} dbLoading={dbLoading} />}
        {activeTab === "customers" && <CustomersTab dbData={dbData} dbLoading={dbLoading} />}
        {activeTab === "keys" && <KeysTab />}
        {activeTab === "platforms" && <PlatformsTab />}
        {activeTab === "accounts" && <AccountsTab />}
      </div>
    </div>
  );
}
