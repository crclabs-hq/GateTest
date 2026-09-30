"use client";

import { useState, useEffect, useRef } from "react";
import { TIERS } from "@/app/lib/checkout-tiers";
import {
  classifyScanResponse,
  readJsonBody,
  gateLine,
  scanResultForCaller,
  tierScopeLine,
  type ScanOutcomeKind,
} from "@/app/lib/scan-outcome";

interface LogEntry {
  time: number;
  type: "module-fail" | "issue" | "info" | "complete" | "error";
  module?: string;
  message: string;
}

interface LiveScanTerminalProps {
  repoUrl: string;
  tier: string;
  sessionId?: string;
  onComplete: (result: Record<string, unknown>) => void;
  onError: (error: string) => void;
}

// /api/scan/run answers once, with every module's result, when the scan
// finishes — it does not stream progress. So while the request is in flight
// this terminal says it is WAITING and shows elapsed time; it never prints
// timed text dressed up as engine progress (admin audit 2026-09-29: it used
// to print "<module> — running on the engine" on a timer, for a module list
// that was not even the tier's). The result is classified by
// lib/scan-outcome.ts, so a failed request can never print "GATE: PASSED".
export default function LiveScanTerminal({ repoUrl, tier, sessionId, onComplete, onError }: LiveScanTerminalProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(true);
  const [outcome, setOutcome] = useState<ScanOutcomeKind | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const terminalRef = useRef<HTMLDivElement>(null);
  const hasStarted = useRef(false);

  const addLog = (entry: Omit<LogEntry, "time">) => {
    setLogs((prev) => [...prev, { ...entry, time: Date.now() }]);
  };

  useEffect(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;

    addLog({ type: "info", message: `GATETEST — Scanning ${repoUrl.replace("https://github.com/", "")}` });
    addLog({ type: "info", message: tierScopeLine(tier, TIERS) });
    addLog({ type: "info", message: "Waiting for the engine — it reports every module together when the scan finishes (no live per-module feed)." });

    fetch("/api/scan/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl, tier, ...(sessionId ? { sessionId } : {}) }),
    })
      .then(async (res) => {
        const body = await readJsonBody(res);
        const result = classifyScanResponse(res.ok, res.status, body);
        const data = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
        const mods = Array.isArray(data.modules) ? (data.modules as Array<Record<string, unknown>>) : [];

        for (const mod of mods) {
          const details = (mod.details as string[]) || [];
          const issues = (mod.issues as number) || 0;
          if (mod.status !== "failed" || issues === 0) continue;
          addLog({ type: "module-fail", module: mod.name as string, message: `${mod.name} — ${issues} issue${issues > 1 ? "s" : ""} found` });
          for (const d of details.slice(0, 5)) addLog({ type: "issue", module: mod.name as string, message: d });
          if (details.length > 5) addLog({ type: "info", message: `  ...${details.length - 5} more` });
        }

        addLog({ type: result.kind === "failed" ? "error" : "complete", message: `\n${gateLine(result, data.duration)}` });
        setOutcome(result.kind);
        setRunning(false);
        onComplete(scanResultForCaller(body, result));
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : "the scan request failed";
        addLog({ type: "error", message: `\nGATE: FAILED — ${msg}` });
        setOutcome("failed");
        setRunning(false);
        onError(msg);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoUrl, tier, onComplete, onError]);

  // Elapsed time while waiting — a clock, not a progress estimate.
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Auto-scroll
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs]);

  const getColor = (type: LogEntry["type"]) => {
    switch (type) {
      case "module-fail": return "text-danger";
      case "issue": return "text-white/70";
      case "complete": return outcome === "issues" ? "text-white font-bold" : "text-emerald-400 font-bold";
      case "error": return "text-danger font-bold";
      default: return "text-white/50";
    }
  };

  const getPrefix = (type: LogEntry["type"]) => {
    switch (type) {
      case "module-fail": return "  ✗ ";
      case "issue": return "    → ";
      case "error": return "  ✗ ";
      default: return "  ";
    }
  };

  const statusWord = running ? "WAITING" : outcome === "failed" ? "FAILED" : outcome === "issues" ? "ISSUES" : "PASSED";
  const statusClass = running
    ? "text-emerald-400 animate-pulse"
    : outcome === "failed" ? "text-danger" : outcome === "issues" ? "text-white" : "text-emerald-400";
  const barClass = running
    ? "w-full bg-emerald-400/40 animate-pulse"
    : outcome === "failed" ? "w-full bg-danger" : "w-full bg-emerald-400";

  return (
    <div className="rounded-xl border border-white/10 overflow-hidden bg-[#0a0a12] shadow-2xl">
      {/* Terminal header */}
      <div className="px-4 py-3 flex items-center gap-2 border-b border-white/6 bg-white/[0.02]">
        <div className="w-3 h-3 rounded-full bg-white/15" />
        <div className="w-3 h-3 rounded-full bg-white/15" />
        <div className="w-3 h-3 rounded-full bg-white/15" />
        <span className="ml-3 text-xs text-white/30 font-mono">
          gatetest --suite {tier} {repoUrl.replace("https://github.com/", "")}
        </span>
        <span className={`ml-auto text-xs font-medium tracking-wider ${statusClass}`} role="status">
          {statusWord}
        </span>
      </div>

      {/* Activity bar — pulses while waiting (no progress estimate exists), solid when answered */}
      <div className="h-0.5 bg-white/5">
        <div className={`h-full transition-all duration-500 ${barClass}`} />
      </div>

      {/* Terminal output */}
      <div
        ref={terminalRef}
        className="p-5 font-mono text-xs leading-relaxed max-h-[500px] overflow-y-auto"
      >
        {logs.map((log, i) => (
          <div key={i} className={`${getColor(log.type)} whitespace-pre-wrap`}>
            {getPrefix(log.type)}{log.message}
          </div>
        ))}
        {running && (
          <div className="text-white/30 mt-1">
            {"  "}waiting for results · {elapsed}s <span className="animate-pulse">▍</span>
          </div>
        )}
      </div>
    </div>
  );
}
