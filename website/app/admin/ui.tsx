"use client";

/**
 * Admin UI kit — the shared, accessible, token-styled primitives the admin
 * console shell is built from (the stats bar and the tab strip), matching
 * the site's teal design system (var(--accent) etc.).
 *
 * Everything here is presentational + accessible: real focus rings and
 * role="tab"/aria-selected on the tab bar with arrow-key navigation.
 */

import { useRef, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------
export function StatCard({ label, value, tone }: { label: string; value: ReactNode; tone?: "accent" | "danger" }) {
  const color =
    tone === "accent" ? "text-[var(--accent)]" : tone === "danger" ? "text-[var(--danger)]" : "text-[var(--foreground)]";
  return (
    <div className="rounded-[var(--radius-lg)] bg-[var(--surface-solid)] border border-[var(--border)] shadow-[var(--shadow-sm)] p-4 text-center">
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-[var(--muted)] mt-0.5">{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accessible tabs
// ---------------------------------------------------------------------------
export interface TabDef {
  id: string;
  label: string;
  danger?: boolean;
  /**
   * Problem state for this section, surfaced as a badge on the tab itself so
   * the operator sees it without opening the tab. `danger` above is a static
   * styling flag (Forensic is permanently red); this is live state.
   */
  status?: "error" | "warn";
  /** Number shown inside the badge. Omit for a bare dot. */
  count?: number;
  /** Plain-English reason — becomes the tooltip and the screen-reader text. */
  statusLabel?: string;
}

/**
 * The badge rendered on a tab that is reporting a problem. Colour alone must
 * never be the signal (WCAG 1.4.1), so the count/dot carries a text
 * alternative and the severity word is spelled out for assistive tech.
 */
function TabStatusBadge({ status, count, label }: { status: "error" | "warn"; count?: number; label?: string }) {
  const isError = status === "error";
  const tone = isError
    ? "bg-[var(--danger)]/12 text-[var(--danger)] ring-[var(--danger)]/30"
    : "bg-amber-500/12 text-amber-700 ring-amber-500/30";
  const word = isError ? "error" : "warning";
  return (
    <span
      className={`ml-1.5 inline-flex items-center justify-center rounded-full ring-1 tabular-nums ${tone} ${
        typeof count === "number" ? "min-w-[1.25rem] px-1.5 h-5 text-[11px] font-bold" : "w-2 h-2"
      }`}
      title={label || word}
    >
      {typeof count === "number" ? (
        <>
          <span aria-hidden>{count > 99 ? "99+" : count}</span>
          <span className="sr-only">{` — ${count} ${word}${count === 1 ? "" : "s"}${label ? `: ${label}` : ""}`}</span>
        </>
      ) : (
        <span className="sr-only">{` — ${word}${label ? `: ${label}` : ""}`}</span>
      )}
    </span>
  );
}

export function AdminTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  function onKeyDown(e: React.KeyboardEvent) {
    const i = tabs.findIndex((t) => t.id === active);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length;
      onChange(tabs[next].id);
      refs.current[tabs[next].id]?.focus();
    }
  }
  return (
    <div role="tablist" aria-label="Admin sections" onKeyDown={onKeyDown} className="flex gap-1 mb-6 border-b border-[var(--border)] overflow-x-auto">
      {tabs.map((t) => {
        const selected = active === t.id;
        return (
          <button
            key={t.id}
            ref={(el) => { refs.current[t.id] = el; }}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40 rounded-t ${
              selected
                ? t.danger
                  ? "border-[var(--danger)] text-[var(--danger)] font-bold"
                  : "border-[var(--accent)] text-[var(--foreground)]"
                : `border-transparent hover:text-[var(--foreground)] ${t.danger ? "text-[var(--danger)]/70" : "text-[var(--muted)]"}`
            }`}
          >
            {t.label}
            {t.status && <TabStatusBadge status={t.status} count={t.count} label={t.statusLabel} />}
          </button>
        );
      })}
    </div>
  );
}
