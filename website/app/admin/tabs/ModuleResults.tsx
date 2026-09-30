"use client";

// Per-module PASS / FAIL / NOT CHECKED result cards for the repo scan tab.
// Anything that is neither passed nor failed (skipped, error, timed out) is
// "not checked" — never shown as a pass (doctrine #1).
export function moduleVerdict(status: string): { word: string; badge: string; edge: string } {
  if (status === "passed") return { word: "PASS", badge: "ok", edge: "border-l-4 border-l-success" };
  if (status === "failed") return { word: "FAIL", badge: "bad", edge: "border-l-4 border-l-danger" };
  return { word: "NOT CHECKED", badge: "muted", edge: "" };
}

export function ModuleResults({ modules }: { modules: Array<Record<string, unknown>> }) {
  return (
    <>
      {modules.map((mod) => {
        const status = mod.status as string;
        const details = (mod.details as string[]) || [];
        const verdict = moduleVerdict(status);
        return (
          <div key={mod.name as string} className={`rounded-xl bg-white border border-gray-200 shadow-sm p-4 ${verdict.edge}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className={`gt-admin-badge ${verdict.badge}`}>{verdict.word}</span>
                <span className="font-semibold text-sm text-gray-900">{mod.name as string}</span>
              </div>
              <div className="text-xs text-gray-500">
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
