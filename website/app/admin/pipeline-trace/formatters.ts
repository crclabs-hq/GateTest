/**
 * Pipeline Trace — small pure formatters extracted from the page.tsx
 * client component to keep the page under the 600-line size budget enforced
 * by tests/pipeline-trace-page.test.js. No React, no state — safe to import
 * from either the admin page or anywhere else that wants the same display
 * formatting.
 */

// Human-readable age. null → em-dash; <1 → "just now"; minutes / hours / days.
export function humanAge(minutes: number | null): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) {
    return "—";
  }
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} hr`;
  return `${Math.round(minutes / 1440)} days`;
}

// Colour-class the CI conclusion / deploy state strings (same palette as status dots).
export function conclusionClass(value: string | null | undefined): string {
  if (!value) return "text-gray-500";
  const v = String(value).toLowerCase();
  if (v === "success" || v === "succeeded") return "text-emerald-700";
  if (
    v === "failure" ||
    v === "failed" ||
    v === "error" ||
    v === "cancelled" ||
    v === "timed_out"
  ) {
    return "text-red-700";
  }
  if (v === "in_progress" || v === "pending" || v === "queued" || v === "running") {
    return "text-amber-700";
  }
  return "text-gray-700";
}
