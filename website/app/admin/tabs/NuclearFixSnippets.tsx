"use client";

import { useState } from "react";
import type { ServerFix } from "./ServerScanTab";

// Ready-to-paste config snippets for the Forensic tab's "Fix Everything"
// fallback path (used when SSH auto-heal isn't available).
export function NuclearFixSnippets({ fixResult }: { fixResult: Record<string, unknown> }) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const fixes = fixResult.fixes as Record<string, ServerFix[]> || {};
  const total = (fixResult.totalFixes as number) || 0;
  const cats = (fixResult.categories as number) || 0;

  function copySnippet(code: string, id: string) {
    navigator.clipboard.writeText(code);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-emerald-600 text-lg font-bold">⚡</span>
        <h3 className="font-bold text-gray-900">
          {total} ready-to-paste fix{total !== 1 ? "es" : ""} across {cats} categor{cats !== 1 ? "ies" : "y"}
        </h3>
      </div>
      <p className="text-xs text-gray-500 mb-4">Copy each snippet and apply it to your server config. No SSH credentials needed — paste and deploy.</p>
      <div className="space-y-5">
        {Object.entries(fixes).map(([category, fixList]) => (
          <div key={category}>
            <h4 className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">{category}</h4>
            <div className="space-y-3">
              {fixList.map((f, idx) => {
                const id = `nuclear-${category}-${idx}`;
                return (
                  <div key={id} className="rounded-lg border border-gray-200 overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
                      <div>
                        <span className="text-xs font-bold text-gray-800">{f.platform}</span>
                        <span className="text-xs text-gray-500 ml-2">{f.title}</span>
                      </div>
                      <button
                        onClick={() => copySnippet(f.code, id)}
                        className="text-xs px-3 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 font-medium transition-colors"
                      >
                        {copiedId === id ? "✓ Copied!" : "Copy"}
                      </button>
                    </div>
                    <pre className="p-3 text-xs font-mono text-gray-700 bg-white overflow-x-auto whitespace-pre-wrap">{f.code}</pre>
                    <p className="px-3 py-2 bg-amber-50 text-xs text-amber-700 border-t border-amber-200">
                      {f.instructions}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
