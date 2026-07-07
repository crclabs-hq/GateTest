"use client";

// Per-module PASS/FAIL/SKIP result cards for the repo scan tab.
export function ModuleResults({ modules }: { modules: Array<Record<string, unknown>> }) {
  return (
    <>
      {modules.map((mod) => {
        const status = mod.status as string;
        const details = (mod.details as string[]) || [];
        return (
          <div key={mod.name as string} className={`rounded-xl bg-white border shadow-sm p-4 ${status === "failed" ? "border-l-4 border-l-red-500 border-red-200" : status === "passed" ? "border-l-4 border-l-emerald-500 border-emerald-200" : "border-gray-200"}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                  status === "passed" ? "bg-emerald-100 text-emerald-700" : status === "failed" ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-500"
                }`}>
                  {status === "passed" ? "PASS" : status === "failed" ? "FAIL" : "SKIP"}
                </span>
                <span className="font-semibold text-sm text-gray-900">{mod.name as string}</span>
              </div>
              <div className="text-xs text-gray-400">
                {mod.checks as number} checks &middot; {mod.issues as number} issues &middot; {mod.duration as number}ms
              </div>
            </div>
            {details.length > 0 && (
              <ul className="mt-2 space-y-1">
                {details.map((d, i) => (
                  <li key={i} className="text-xs text-gray-600 font-mono pl-14">
                    &rarr; {d}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </>
  );
}
