"use client";

import { useEffect, useState } from "react";
import CountUp from "./CountUp";

interface StatsPayload {
  scans_completed: number;
  repos_scanned: number;
  avg_score: number | null;
}

function fmt(n: number): string {
  if (n >= 1000) return `${Math.floor(n / 100) * 100}+`;
  return String(n);
}

export default function LiveStats() {
  const [stats, setStats] = useState<StatsPayload | null>(null);

  useEffect(() => {
    fetch("/api/stats/public")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: StatsPayload | null) => {
        if (d && d.scans_completed > 0) setStats(d);
      })
      .catch(() => {/* graceful degradation */});
  }, []);

  if (!stats) return null;

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 py-3 px-4 rounded-xl bg-white/5 border border-white/10 text-sm">
      <LiveStat value={fmt(stats.scans_completed)} label="scans completed" />
      {stats.repos_scanned > 0 && (
        <LiveStat value={fmt(stats.repos_scanned)} label="repos scanned" />
      )}
      {stats.avg_score !== null && (
        <LiveStat value={`${Math.round(stats.avg_score)}/100`} label="avg score" />
      )}
    </div>
  );
}

function LiveStat({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-extrabold tabular-nums text-white">
        <CountUp value={value} duration={1200} />
      </span>
      <span className="text-teal-300/70">{label}</span>
    </span>
  );
}
